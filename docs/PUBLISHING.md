# 发布到 GitHub：仓库设置与冷启动

这份文档给第一次开源用，不涉及代码。

## 1. 创建仓库

```bash
cd bot-team
git init
git add .
git commit -m "Initial open-source release"
gh repo create zhuoyulang-123456/bot-team --public --source=. --remote=origin --push
```

如果仓库名不叫 `bot-team`，同步修改：

- `package.json` 的 `repository` / `homepage` / `bugs`
- `README.md` 的 Releases 链接
- `.github/ISSUE_TEMPLATE/config.yml`

## 2. 仓库信息

**Description（英文，GitHub 搜索会用到）：**

> Local-first multi-agent workspace for macOS: group chats, handoffs, files, workflows, and 7 model backends (ChatGPT/Codex, Claude, OpenCode, Antigravity, WorkBuddy, Qoder, custom API).

**Topics：**

```
ai
ai-agents
multi-agent
electron
macos
chatgpt
codex
claude
opencode
antigravity
llm
productivity
```

**Social preview：**

上传 `docs/screenshots/social-preview.png`（1280×640）。

**功能开关：**

- Issues：开
- Discussions：开（安装/配置问题放这里）
- Actions：开
- Wiki：可不开

## 3. 第一次 Release

按 [RELEASE.md](../RELEASE.md) 走。Release 说明顶部一定写：

- macOS 13+
- 未签名，右键打开 / `xattr`
- 需要哪些 CLI
- Claude / WorkBuddy 余额限制

## 4. 冷启动文案

### 中文（V2EX / 小红书 / 即刻）

> 开源了一个本地多 Bot 工作台：Bot Team。
>
> 不是单个聊天窗口，而是给每个 Bot 配后端、记忆、工作区，拉群、派活、转交、跑工作流。支持 ChatGPT/Codex、Claude Code、OpenCode、Antigravity、WorkBuddy、Qoder 和自定义 API。
>
> macOS 桌面版，数据都在本机。当前未签名，首次打开需要右键。
>
> GitHub：https://github.com/zhuoyulang-123456/bot-team
>
> 适合：一个人带多个 AI 干活、需要 AI 读写本地文件/表格/PDF 的人。

### English（X / Reddit / HN）

> I open-sourced Bot Team — a local-first multi-agent workspace for macOS.
>
> Each bot has its own backend, memory and workspace. Put them in group chats, hand off tasks, run workflows, and let them read/write real files.
>
> Backends: ChatGPT/Codex, Claude Code, OpenCode, Antigravity, WorkBuddy, Qoder, any OpenAI/Anthropic-compatible API.
>
> macOS only for now. Unsigned build (right-click to open). MIT.
>
> https://github.com/zhuoyulang-123456/bot-team

## 5. 涨星的实际建议

1. **先自己用一周**，把最疼的 3 个问题修掉再发；第一波用户看到的是完成度，不是功能列表。
2. **README 第一屏要有截图 + 一句话 + 安装方式**；现在已经放了主界面和欢迎页。
3. **英文 README 很重要**；`README.en.md` 已准备好，GitHub 默认展示中文，顶部有语言切换。
4. **发帖要选对地方**：V2EX「分享创造」、小红书 AI 工具、X 的 AI 工具圈、Reddit r/LocalLLaMA（注意不要硬广）、HN Show HN（英文、诚实写限制）。
5. **回应每个 Issue**，哪怕是「暂不支持」；star 很多时候来自“作者会回”。
6. **标 good first issue**，让别人有参与感。
7. **不要刷 star / 买 star**，会被封号，也会毁掉你找实习时的信誉。
8. **实习面试时讲清楚取舍**：为什么本地优先、为什么七种后端、余额接口哪些拿不到、怎么处理 API Key 和权限——这些比 star 数更能打动人。

## 6. 不要提交的东西

- `data/`、`bots/`、`groups/`、`.remember/`
- `release/` 里的 DMG（用 Release 上传，不进 git）
- `state.json`、日志、截图里的账号/Key/聊天记录
- 证书 `.p12`、`.p8`、App 专用密码
