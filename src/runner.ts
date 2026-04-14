import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Config } from './config.js';
import { GitLabClient } from './gitlab-client.js';
import { reviewDiff, formatReviewSummary, type ReviewResult } from './gemini-review.js';
import { fixIssues, type FixResult } from './claude-fix.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(__dirname, '..', 'state.json');

interface MrState {
  round: number;
  status: string;
}

export class StateManager {
  private state: Record<string, MrState> = {};
  private statePath: string;

  constructor(statePath = STATE_FILE) {
    this.statePath = statePath;
    this.state = this.load();
  }

  private load(): Record<string, MrState> {
    if (existsSync(this.statePath)) {
      try {
        return JSON.parse(readFileSync(this.statePath, 'utf-8'));
      } catch {
        console.warn('状态文件已损坏，重置。');
        return {};
      }
    }
    return {};
  }

  save() {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  getRound(mrIid: number): number {
    return this.state[String(mrIid)]?.round ?? 0;
  }

  incrementRound(mrIid: number) {
    const key = String(mrIid);
    if (!this.state[key]) this.state[key] = { round: 0, status: 'idle' };
    this.state[key].round++;
    this.state[key].status = 'reviewing';
    this.save();
  }

  setStatus(mrIid: number, status: string) {
    const key = String(mrIid);
    if (!this.state[key]) this.state[key] = { round: 0, status };
    this.state[key].status = status;
    this.save();
  }

  isProcessing(mrIid: number): boolean {
    const status = this.state[String(mrIid)]?.status;
    return status === 'reviewing' || status === 'fixing';
  }
}

async function reviewMr(
  client: GitLabClient,
  config: Config,
  mrIid: number,
): Promise<ReviewResult> {
  console.log(`审查 MR !${mrIid}...`);

  const diffText = await client.getMrDiffText(mrIid);
  if (!diffText.trim()) {
    console.log(`MR !${mrIid} 没有变更，跳过审查。`);
    return { summary: '未检测到变更。', overall_verdict: 'approved', comments: [] };
  }

  const review = await reviewDiff(diffText, config.geminiApiKey, config.geminiModel);

  const summary = formatReviewSummary(review);
  await client.postNote(mrIid, summary);
  console.log(
    `已发布审查结果 MR !${mrIid}: 结论=${review.overall_verdict}, 问题数=${review.comments.length}`,
  );

  return review;
}

export async function runReviewFixCycle(
  client: GitLabClient,
  config: Config,
  mrIid: number,
  state: StateManager,
) {
  if (state.isProcessing(mrIid)) {
    console.log(`MR !${mrIid} 正在处理中，跳过。`);
    return;
  }

  const currentRound = state.getRound(mrIid);
  if (currentRound >= config.maxReviewRounds) {
    console.log(`MR !${mrIid} 已达最大轮数 (${config.maxReviewRounds})，停止。`);
    await client.postNote(mrIid, `⏹️ 自动审查已停止: 已达最大 ${config.maxReviewRounds} 轮。`);
    state.setStatus(mrIid, 'max_rounds_reached');
    return;
  }

  // Step 1: Review
  state.incrementRound(mrIid);
  let review: ReviewResult;
  try {
    review = await reviewMr(client, config, mrIid);
  } catch (e: unknown) {
    console.error(`MR !${mrIid} 审查失败: ${e}`);
    state.setStatus(mrIid, 'failed');
    return;
  }

  if (
    review.overall_verdict === 'approved' ||
    !review.comments.some((c) => c.severity === 'critical' || c.severity === 'warning')
  ) {
    console.log(`MR !${mrIid} 第 ${state.getRound(mrIid)} 轮审查后通过。`);
    state.setStatus(mrIid, 'approved');
    return;
  }

  // Step 2: Fix
  state.setStatus(mrIid, 'fixing');
  let fixResult: FixResult;
  try {
    fixResult = await fixIssues(config.claudeWorkDir, review, mrIid);
  } catch (e: unknown) {
    console.error(`MR !${mrIid} 修复失败: ${e}`);
    await client.postNote(mrIid, `❌ 自动修复失败: ${e}`);
    state.setStatus(mrIid, 'failed');
    return;
  }

  if (!fixResult.success) {
    console.error(`MR !${mrIid} 修复失败: ${fixResult.error}`);
    await client.postNote(mrIid, `❌ 自动修复失败: ${fixResult.error}`);
    state.setStatus(mrIid, 'failed');
    return;
  }

  if (fixResult.changed) {
    console.log(`MR !${mrIid} 已修复并推送，等待 GitLab 触发重新审查。`);
    state.setStatus(mrIid, 'fixed_waiting_for_re_review');
  } else {
    console.log(`MR !${mrIid} Claude Code 未做修改，标记为完成。`);
    state.setStatus(mrIid, 'done');
  }
}

export async function processAllOpenMrs(client: GitLabClient, config: Config) {
  const state = new StateManager();

  const openMrs = await client.listOpenMrs();
  if (openMrs.length === 0) {
    console.log('没有开放的 MR。');
    return;
  }

  for (const mr of openMrs) {
    console.log(`处理 MR !${mr.iid}: ${mr.title}`);
    await runReviewFixCycle(client, config, mr.iid, state);
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log('所有开放 MR 已处理完毕。');
}
