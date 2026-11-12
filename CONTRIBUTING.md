# 贡献指南

Bot Team 是一个本地优先的多 Bot 工作台。欢迎提交 Issue 和 Pull Request。

## 开发环境

- macOS 13+（当前主要支持 macOS；Windows / Linux 还不是一等公民）
- Node.js 22+
- 可选：`opencode`、`codex`、`claude`、`agy`、`codebuddy`、`qoderclicn`，按你要调试的后端安装

```bash
cd bot-team
npm install
npm run desktop     # Electron 窗口
npm start           # 纯服务端，打开 http://127.0.0.1:4820
```

桌面版数据在 `~/Library/Application Support/Bot Team/`；命令行版数据在项目下的 `data/`、`bots/`。两者互不影响。**不要把 `data/`、`bots/`、`.remember/` 提交到仓库**，里面有 API Key 和聊天记录。

## 代码结构

- `server.mjs`：HTTP API、SSE、调度
- `lib/agents.mjs`：各 CLI 后端运行器（opencode / codex / claude / agy / codebuddy / qoder / custom）
- `lib/orchestrator.mjs`：群聊回合、转交、上下文
- `lib/store.mjs`：数据模型、默认值、迁移
- `lib/usage.mjs`：用量统计、余额查询
- `public/app.js`、`public/styles.css`：桌面界面
- `electron/main.mjs`：Electron 主进程

## 修改约定

1. 保持现有的无框架 vanilla JS + ESM 风格，不引入前端构建步骤。
2. 新增后端时，同时更新：
   - `lib/agents.mjs` 的 `RUNNERS`
   - `public/app.js` 的后端下拉、来源映射
   - `server.mjs` 的模型列表/登录提示
   - README 的「模型后端」表
3. 新增余额渠道时，更新 `lib/usage.mjs` 的 `PROVIDER_DEFS`、`fetchBalances()` 和 UI 的「连接 API 账号」。
4. 涉及磁盘写入、命令执行、Key 存储的改动，先看 `SECURITY.md`。
5. 不要提交真实的 `state.json`、聊天记录、API Key、截图里的个人信息。

## 提交 PR 前

```bash
npm run check       # 语法检查
npm run desktop     # 至少手动走一遍受影响的界面
```

PR 描述请写清：

- 改了什么、为什么
- 影响的平台/后端
- 手动验证步骤和结果
- 有没有改数据结构（需要迁移吗）

## Commit 信息

用简短的中文或英文都可以，建议格式：

```
fix: 修复 GitHub 首页卡片不翻译
feat: 增加 OpenAI Responses 自定义后端
docs: 补充 agy 安装说明
```

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
