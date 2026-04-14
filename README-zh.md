# 自动审查 (Auto-Review)

自动代码审查工作流：**Gemini 审查 MR diff → Claude Code 自动修复问题 → 最多循环 N 轮 → 人类最终决定是否合并**。

[English README](README.md)

## 架构

```
┌──────────────┐     webhook      ┌──────────────────┐
│   GitLab     │ ────────────────>│  webhook-server    │
│  (MR opened) │                  │     (Express)      │
└──────────────┘                  └────────┬─────────┘
                                          │
                                          ▼
                                   ┌──────────────┐
                                   │   runner.ts   │
                                   │  (orchestrator)│
                                   └──┬─────────┬──┘
                                      │         │
                    ┌─────────────────┘         └─────────────────┐
                    ▼                                             ▼
            ┌───────────────┐                          ┌──────────────────┐
            │ gitlab-client  │                          │   gemini-review   │
            │  .getMrDiffText()│                        │   .reviewDiff()   │
            └───────┬───────┘                          └────────┬─────────┘
                    │                                          │
                    ▼                                          ▼
            [MR diff]                               [ReviewResult]
                                                              │
                                              ┌───────────────┼──────────────┐
                                              ▼               ▼              ▼
                                     post to GitLab     claude-fix.fix   update state
                                     (review comment)   (if not approved)
                                                              │
                                                              ▼
                                                    [git add/commit/push]
                                                              │
                                                              ▼
                                                    GitLab sends MR update webhook
                                                              │
                                                              ▼
                                                    runner processes -> re-review
                                                              │
                                                    (loop until approved or max rounds)
```

## 安装

### 1. 克隆并安装依赖

```bash
cd projects/auto-review
npm install
```

### 2. 配置

```bash
cp .env.example .env
# 编辑 .env，填入以下配置：
# - GITLAB_URL: GitLab 地址（如 https://git.qmpoa.com/）
# - GITLAB_TOKEN: Private Token（需要 api 权限）
# - GITLAB_PROJECT_ID: 项目 ID
# - GEMINI_API_KEY: Google AI Studio API Key
# - GEMINI_MODEL: 审查模型（默认 gemini-2.5-flash-lite）
# - CLAUDE_WORK_DIR: 本地 Git 仓库路径（Claude 修复用）
# - HTTPS_PROXY: 代理地址（如 http://127.0.0.1:7897）
```

### 3. 构建

```bash
npm run build
```

开发阶段可以不构建，直接用 tsx 运行：

```bash
npm run dev review
npm run dev listener
```

### 4. 测试连接

```bash
npm run review
```

该命令会测试 GitLab 连接并处理所有开放的 MR。

### 5. 启动 Webhook 监听

```bash
npm run start:listener
```

### 6. 配置 GitLab Webhook

在 GitLab 项目中：**Settings > Webhooks**

- **URL**: `http://<你的机器IP>:8080/webhook`
- **触发事件**: 勾选 "Merge request events"
- **Secret token**: V1 留空
- 点击 "Add webhook"

如果机器在内网，可以用 `ngrok` 暴露端口：
```bash
ngrok http 8080
```
然后将 ngrok 生成的 URL 填入 Webhook。

## 使用

### 手动审查（处理所有开放 MR）

```bash
npm run review
```

### 启动 Webhook 监听

```bash
npm run start:listener
```

### 开发模式（无需构建）

```bash
npm run dev           # 等同于 review
npm run dev review    # 审查模式
npm run dev listener  # 监听模式
```

## 工作流程

1. 开发者创建 MR（或向已有 MR 推送新提交）
2. GitLab 发送 webhook 事件到监听服务
3. **Gemini** 审查 MR diff 并在 GitLab 发布审查摘要
4. 如果发现问题（critical/warning 级别），**Claude Code** 自动修复
5. Claude 提交并推送修复，触发 MR 更新 webhook
6. 循环重复（最多 `MAX_REVIEW_ROUNDS` 轮，默认 2）
7. 人类审查最终状态并决定是否合并

## 配置项

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GITLAB_URL` | - | GitLab 地址 |
| `GITLAB_TOKEN` | - | Private Token（api 权限） |
| `GITLAB_PROJECT_ID` | - | 项目 ID |
| `GEMINI_API_KEY` | - | Google AI Studio API Key |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | 审查模型 |
| `CLAUDE_WORK_DIR` | - | 本地 Git 仓库路径 |
| `MAX_REVIEW_ROUNDS` | `2` | 最大审查-修复循环轮数 |
| `WEBHOOK_PORT` | `8080` | Webhook 服务端口 |
| `HTTPS_PROXY` | - | 代理地址（需要代理时必填） |
| `HTTP_PROXY` | - | 代理地址（需要代理时必填） |
| `LOG_LEVEL` | `INFO` | 日志级别 |

## V1 限制

- 审查评论以单条总结发布（非行内评论）
- Webhook 未做 HMAC 校验
- 使用 JSON 文件存储状态（非数据库）
- 串行处理 MR
- 暂不支持 Docker

## 项目结构

```
auto-review/
├── src/
│   ├── config.ts            # 配置加载（Zod 校验）
│   ├── gitlab-client.ts     # GitLab API 封装
│   ├── gemini-review.ts     # Gemini 审查引擎
│   ├── claude-fix.ts        # Claude Code 修复引擎
│   ├── runner.ts            # 主循环（审查→修复）
│   ├── webhook-server.ts    # Express Webhook 端点
│   └── index.ts             # CLI 入口
├── scripts/
│   ├── run_review.sh        # 手动触发审查
│   └── start_listener.sh    # 启动 Webhook 监听
└── .env                     # 配置文件（不提交）
```

## 技术栈

- **运行环境**: Node.js 18+
- **语言**: TypeScript
- **Webhook 服务**: Express
- **GitLab API**: 自定义客户端（https-proxy-agent 支持代理）
- **Gemini API**: 直接 HTTPS POST，结构化 JSON 输出
- **Claude Code**: `claude -p` 非交互模式 + `--permission-mode acceptEdits`
