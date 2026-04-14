import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { GitLabClient } from './gitlab-client.js';
import { processAllOpenMrs, StateManager, runReviewFixCycle } from './runner.js';
import { createWebhookServer } from './webhook-server.js';

// Load .env
dotenv.config();

async function cmdReview() {
  const cfg = loadConfig();
  const client = new GitLabClient({
    baseUrl: cfg.gitlabUrl,
    token: cfg.gitlabToken,
    projectId: cfg.gitlabProjectId,
  });

  if (!(await client.testConnection())) {
    console.error('无法连接 GitLab，请检查配置。');
    process.exit(1);
  }

  await processAllOpenMrs(client, cfg);
}

async function cmdListener() {
  const cfg = loadConfig();
  const client = new GitLabClient({
    baseUrl: cfg.gitlabUrl,
    token: cfg.gitlabToken,
    projectId: cfg.gitlabProjectId,
  });

  if (!(await client.testConnection())) {
    console.error('无法连接 GitLab，请检查配置。');
    process.exit(1);
  }

  const state = new StateManager();
  const app = createWebhookServer(cfg, client, state);

  app.listen(cfg.webhookPort, () => {
    console.log(`\n自动审查监听器已启动，端口 ${cfg.webhookPort}`);
    console.log(`GitLab: ${cfg.gitlabUrl} / ${cfg.gitlabProjectId}`);
    console.log(`最大轮数: ${cfg.maxReviewRounds}`);
    console.log(`\n请在 GitLab Webhook 中配置:`);
    console.log(`  URL: http://<your-ip>:${cfg.webhookPort}/webhook`);
    console.log(`  事件: Merge request events (open, update, reopen)\n`);
  });
}

// Main
const command = process.argv[2] || 'review';

if (command === 'listener') {
  cmdListener().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (command === 'review') {
  cmdReview().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  console.log('用法:');
  console.log('  node dist/index.js review     - 审查所有开放 MR');
  console.log('  node dist/index.js listener   - 启动 Webhook 监听器');
}
