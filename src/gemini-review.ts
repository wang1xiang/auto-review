import { HttpsProxyAgent } from 'https-proxy-agent';
import * as https from 'node:https';

export interface ReviewComment {
  file: string;
  line_number?: number;
  severity: 'critical' | 'warning' | 'suggestion' | 'nitpick';
  category: 'bug' | 'security' | 'performance' | 'style' | 'maintainability' | 'test';
  comment: string;
  suggestion?: string;
}

export interface ReviewResult {
  summary: string;
  overall_verdict: 'approved' | 'needs_changes' | 'minor_suggestions';
  comments: ReviewComment[];
}

const REVIEW_SYSTEM_PROMPT = `你是一个资深高级软件工程师，正在进行代码审查。你必须全程使用中文进行回复。

审查以下代码 diff。对于发现的每个问题：
1. 指出文件和大致行号
2. 分类严重程度：critical（必须修复）、warning（应该修复）、suggestion（建议）、nitpick（细节）
3. 分类问题类型：bug、security、performance、style（代码风格）、maintainability（可维护性）、test（测试）
4. 用中文清晰说明问题
5. 给出具体的中文修复建议（含代码示例）

附加规则：
- 关注正确性、安全性和可维护性
- 除非严重影响可读性，否则不要只评论格式
- 如果 diff 没问题，请直接说「代码看起来没问题」
- 不要标记明显是有意设计的决策
- 你必须全程使用中文，包括 summary、comment 和 suggestion 字段
- 要具体、可操作`;

const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: '代码变更的中文概述' },
    overall_verdict: { type: 'STRING', enum: ['approved', 'needs_changes', 'minor_suggestions'] },
    comments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          file: { type: 'STRING', description: '文件路径' },
          line_number: { type: 'INTEGER', description: '行号' },
          severity: { type: 'STRING', enum: ['critical', 'warning', 'suggestion', 'nitpick'] },
          category: { type: 'STRING', enum: ['bug', 'security', 'performance', 'style', 'maintainability', 'test'] },
          comment: { type: 'STRING', description: '用中文描述问题' },
          suggestion: { type: 'STRING', description: '用中文给出修复建议' },
        },
        required: ['file', 'severity', 'category', 'comment'],
      },
    },
  },
  required: ['summary', 'overall_verdict', 'comments'],
};

function httpsPostJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;

    const req = https.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        agent,
        timeout: 120_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          } else {
            try {
              resolve(JSON.parse(data) as Record<string, unknown>);
            } catch {
              reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
            }
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

export async function reviewDiff(
  diffText: string,
  apiKey: string,
  model = 'gemini-2.5-flash-lite',
): Promise<ReviewResult> {
  if (!diffText.trim()) {
    return { summary: '没有变更需要审查。', overall_verdict: 'approved', comments: [] };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const prompt = `请用中文审查以下代码 diff，并输出结构化的 JSON 反馈。

\`\`\`diff
${diffText}
\`\`\``;

  const payload = {
    system_instruction: { parts: [{ text: REVIEW_SYSTEM_PROMPT }] },
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: REVIEW_SCHEMA,
    },
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await httpsPostJson(url, payload);
      const text = (data.candidates as Array<{ content: { parts: Array<{ text: string }> } }>)[0]
        .content.parts[0].text;
      return JSON.parse(text) as ReviewResult;
    } catch (e: unknown) {
      lastError = e;
      if (attempt < 3) {
        const wait = 3 * attempt;
        console.warn(`Gemini 调用失败 (第 ${attempt}/3 次)，${wait} 秒后重试: ${e}`);
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
  }

  console.error(`Gemini API 调用 3 次均失败: ${lastError}`);
  throw new Error(`调用 Gemini API 失败: ${lastError}`);
}

export function formatReviewSummary(review: ReviewResult): string {
  const lines: string[] = [];

  const verdictEmoji: Record<string, string> = {
    approved: '✅',
    needs_changes: '🔍',
    minor_suggestions: '💡',
  };
  const emoji = verdictEmoji[review.overall_verdict] || '📋';

  lines.push(`## ${emoji} 自动审查摘要\n`);
  lines.push(review.summary);
  lines.push(`\n\n**结论**: \`${review.overall_verdict}\``);

  if (review.comments.length > 0) {
    lines.push(`\n\n### 发现问题 (${review.comments.length})\n`);
    for (const [i, c] of review.comments.entries()) {
      const severityBadge: Record<string, string> = {
        critical: '🔴',
        warning: '🟡',
        suggestion: '🔵',
        nitpick: '⚪',
      };
      const badge = severityBadge[c.severity] || '⚪';
      const location = `\`${c.file}\`${c.line_number ? ` (第 ${c.line_number} 行)` : ''}`;
      lines.push(`${i + 1}. ${badge} **[${c.severity}]** [${c.category}] ${location}\n   ${c.comment}`);
      if (c.suggestion) {
        lines.push(`\n   **建议**: ${c.suggestion}`);
      }
      lines.push('');
    }
  } else {
    lines.push('\n\n未发现任何问题，代码看起来不错！');
  }

  lines.push('\n---\n*此审查由 Gemini AI 自动生成。*');
  return lines.join('\n');
}

export function formatFixPrompt(review: ReviewResult): string {
  const fixable = review.comments.filter((c) => c.severity === 'critical' || c.severity === 'warning');
  if (fixable.length === 0) {
    return '未发现需要自动修复的问题。';
  }

  const lines = [
    '你正在修复代码审查中发现的问题。',
    '',
    '以下是自动审查发现的问题列表，请逐个修复。',
    '',
    '## 待修复问题',
    '',
  ];

  for (const [i, c] of fixable.entries()) {
    const location = `\`${c.file}\`${c.line_number ? ` (第 ${c.line_number} 行)` : ''}`;
    lines.push(`### 问题 ${i + 1}: [${c.severity}] ${c.category} - ${location}`);
    lines.push(c.comment);
    if (c.suggestion) {
      lines.push(`建议修复: ${c.suggestion}`);
    }
    lines.push('');
  }

  lines.push(
    '## 操作说明',
    '1. 阅读每个涉及的文件',
    '2. 使用 Edit 工具进行修复',
    '3. 不要修改未提及的文件',
    '4. 修复后运行现有测试验证',
    '5. 完成后输出修复摘要',
  );

  return lines.join('\n');
}
