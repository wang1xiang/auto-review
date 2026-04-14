# 自动审查 (Auto-Review)

自动代码审查工作流：**Gemini 审查 MR diff → Claude Code 自动修复问题 → 最多循环 N 轮 → 人类最终决定是否合并**。

[English README](README.md)

## 架构

```
┌──────────────┐     webhook      ┌──────────────────┐
│   GitLab     │ ────────────────>│  webhook_server    │
│  (MR opened) │                  │     (Flask)       │
└──────────────┘                  └────────┬─────────┘
                                          │
                                          ▼
                                   ┌──────────────┐
                                   │   runner.py   │
                                   │  (orchestrator)│
                                   └──┬─────────┬──┘
                                      │         │
                    ┌─────────────────┘         └─────────────────┐
                    ▼                                             ▼
            ┌───────────────┐                          ┌──────────────────┐
            │ gitlab_client  │                          │   gemini_review   │
            │  .get_mr_diffs()│                         │   .review(diff)   │
            └───────┬───────┘                          └────────┬─────────┘
                    │                                          │
                    ▼                                          ▼
            [MR diff]                               [ReviewResult]
                                                              │
                                              ┌───────────────┼──────────────┐
                                              ▼               ▼              ▼
                                     post to GitLab     claude_fix.fix   update state
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
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

### 2. 配置

```bash
cp .env.example .env
# 编辑 .env，填入以下配置：
# - GITLAB_URL: GitLab 地址（如 https://git.qmpoa.com/）
# - GITLAB_TOKEN: Private Token（需要 api 权限）
# - GITLAB_PROJECT_ID: 项目 ID 或 URL 编码路径
# - GEMINI_API_KEY: Google AI Studio API Key
# - GEMINI_MODEL: 审查模型（默认 gemini-2.5-flash）
# - CLAUDE_WORK_DIR: 本地 Git 仓库路径（Claude 修复用）
```

### 3. 测试连接

```bash
python -m src.runner
```

该命令会测试 GitLab 连接并处理所有开放的 MR。

### 4. 启动 Webhook 监听

```bash
./scripts/start_listener.sh
```

### 5. 配置 GitLab Webhook

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

### 手动审查（指定 MR）

```bash
./scripts/run_review.sh <MR_IID>
```

### 处理所有开放 MR

```bash
python -m src.runner
```

### 启动 Webhook 监听

```bash
./scripts/start_listener.sh
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
| `GITLAB_PROJECT_ID` | - | 项目 ID 或 URL 编码路径 |
| `GEMINI_API_KEY` | - | Google AI Studio API Key |
| `GEMINI_MODEL` | `gemini-2.5-flash` | 审查模型 |
| `CLAUDE_WORK_DIR` | - | 本地 Git 仓库路径 |
| `MAX_REVIEW_ROUNDS` | `2` | 最大审查-修复循环轮数 |
| `WEBHOOK_PORT` | `8080` | Webhook 服务端口 |
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
│   ├── config.py            # 配置加载
│   ├── gitlab_client.py     # GitLab API 封装
│   ├── gemini_review.py     # Gemini 审查引擎
│   ├── claude_fix.py        # Claude Code 修复引擎
│   ├── runner.py            # 主循环（审查→修复）
│   └── webhook_server.py    # Flask Webhook 端点
├── scripts/
│   ├── run_review.sh        # 手动触发审查
│   └── start_listener.sh    # 启动 Webhook 监听
└── tests/fixtures/
    ├── mr_webhook.json      # Webhook 示例
    └── mr_diff_sample.json  # MR diff 示例
```

## 技术栈

- **语言**: Python 3.10+
- **Webhook 服务**: Flask
- **GitLab API**: requests + python-gitlab
- **Gemini API**: google-genai SDK（结构化 JSON 输出）
- **Claude Code**: `claude -p` 非交互模式 + `--permission-mode acceptEdits`