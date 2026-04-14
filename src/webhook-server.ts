import express from 'express';
import { type Config } from './config.js';
import { GitLabClient } from './gitlab-client.js';
import { runReviewFixCycle, type StateManager } from './runner.js';

export function createWebhookServer(
  config: Config,
  client: GitLabClient,
  state: StateManager,
) {
  const app = express();

  app.use(express.json());

  app.post('/webhook', async (req, res) => {
    const data = req.body;
    if (!data) return res.status(400).json({ error: 'invalid JSON' });

    const { object_kind, event_type } = data;
    console.log(`收到 webhook: object_kind=${object_kind}, event_type=${event_type}`);

    if (object_kind === 'merge_request') {
      const attributes = data.object_attributes || {};
      const action = attributes.action;
      const mrIid = attributes.iid;

      if (mrIid && ['open', 'update', 'reopen'].includes(action)) {
        console.log(`MR !${mrIid} 事件: ${action}`);
        // Fire and forget
        runReviewFixCycle(client, config, mrIid, state).catch((e) =>
          console.error(`处理 MR !${mrIid} 失败: ${e}`),
        );
        return res.json({ status: 'accepted' });
      }

      console.log(`忽略 MR 事件: action=${action}`);
      return res.json({ status: 'ignored' });
    }

    if (object_kind === 'note') {
      console.log('收到 note 事件 (V1 暂不处理)');
      return res.json({ status: 'ignored' });
    }

    console.log(`忽略 webhook: object_kind=${object_kind}`);
    return res.json({ status: 'ignored' });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
