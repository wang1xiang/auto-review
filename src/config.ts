import { z } from 'zod';

const configSchema = z.object({
  gitlabUrl: z.string().url(),
  gitlabToken: z.string(),
  gitlabProjectId: z.string(),
  geminiApiKey: z.string(),
  geminiModel: z.string().default('gemini-2.5-flash-lite'),
  claudeWorkDir: z.string(),
  maxReviewRounds: z.coerce.number().default(2),
  webhookPort: z.coerce.number().default(8081),
  logLevel: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const result = configSchema.safeParse({
    gitlabUrl: process.env.GITLAB_URL,
    gitlabToken: process.env.GITLAB_TOKEN,
    gitlabProjectId: process.env.GITLAB_PROJECT_ID,
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite',
    claudeWorkDir: process.env.CLAUDE_WORK_DIR,
    maxReviewRounds: process.env.MAX_REVIEW_ROUNDS ?? 2,
    webhookPort: process.env.WEBHOOK_PORT ?? 8081,
    logLevel: process.env.LOG_LEVEL ?? 'INFO',
  });

  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n  ');
    throw new Error(`配置校验失败:\n  ${missing}\n\n请检查 .env 文件`);
  }

  return result.data;
}
