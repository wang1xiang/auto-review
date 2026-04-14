import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { formatFixPrompt, type ReviewResult } from './gemini-review.js';

const execAsync = promisify(exec);

export interface FixResult {
  success: boolean;
  changed: boolean;
  error?: string;
}

async function getModifiedFiles(workDir: string): Promise<Set<string>> {
  try {
    const { stdout } = await execAsync('git diff --name-only', { cwd: workDir, timeout: 10_000 });
    const files = stdout.trim().split('\n').filter(Boolean);
    return new Set(files);
  } catch {
    return new Set();
  }
}

export async function fixIssues(
  workDir: string,
  review: ReviewResult,
  mrIid: number,
): Promise<FixResult> {
  const prompt = formatFixPrompt(review);
  if (prompt.includes('未发现需要自动修复')) {
    return { success: true, changed: false };
  }

  console.log(`开始 Claude Code 修复 MR !${mrIid}...`);

  const beforeChanges = await getModifiedFiles(workDir);

  try {
    await execAsync(
      `claude -p "${prompt.replace(/"/g, '\\"')}" --permission-mode acceptEdits --allowed-tools "Read Edit Bash" --output-format json --no-session-persistence`,
      { cwd: workDir, timeout: 600_000 },
    );
    console.log('Claude Code 修复完成。');
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`Claude Code 执行失败: ${error}`);
    return { success: false, changed: false, error };
  }

  const afterChanges = await getModifiedFiles(workDir);
  const newOrModified = new Set([...afterChanges].filter((f) => !beforeChanges.has(f)));

  if (newOrModified.size === 0) {
    console.log('Claude Code 未修改任何文件。');
    return { success: true, changed: false };
  }

  console.log(`修改的文件: ${[...newOrModified].sort().join(', ')}`);

  try {
    await execAsync('git add -A', { cwd: workDir, timeout: 30_000 });
    await execAsync(`git commit -m "auto-fix: 修复 MR !${mrIid} 审查问题"`, { cwd: workDir, timeout: 30_000 });
    await execAsync('git push', { cwd: workDir, timeout: 60_000 });
    console.log('修复已提交并推送。');
    return { success: true, changed: true };
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`Git 操作失败: ${error}`);
    return { success: false, changed: false, error: `Git 操作失败: ${error}` };
  }
}
