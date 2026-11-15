# Changelog

## 0.1.3 — 2026-11-16

依赖安全升级，无功能变更。

- SheetJS (`xlsx`) 0.18.5 → 0.20.3（修复原型污染与 ReDoS），并同步更新 `public/vendor/xlsx.full.min.js`
- 通过 `overrides` 将 `minimatch`、`uuid`、`echarts` 提升到已修复版本，`npm audit` 归零
- 打包链路在 macOS 上实测通过（arm64 打包完整跑通）

## 0.1.2 — 2026-11-16

体验与可靠性修复，重点是「新成员用不了」「回复答非所问」「技能像空壳」。

### 会话与成员

- 新建 Bot 不再并入已有私聊：私聊永远是两个人的对话，每个 Bot 都会自动获得自己的私聊
- 旧数据里「一个私聊挂多个 Bot」的脏数据在启动时自动拆开，并把 `lastChatId` 修正到各自会话
- 领导用 `@@CREATE BOT` 建的成员也会立即拥有私聊；打开任何 Bot 都不会再跳到别人的对话框

### 回复质量与速度

- 修复 Windows 下 CLI 包装器截断多行参数导致模型只看得到提示词第一行的问题：CodeBuddy / Qoder / Claude Code / Codex 的长提示词改走 stdin
- CodeBuddy 改用流式输出（`stream-json` + 部分消息），思考过程实时可见
- 直连 API 后端改走 SSE 流式，并解析 `reasoning_content` / `thinking`
- 直连 API 支持图片多模态（OpenAI `image_url` / Anthropic `image` 块），模型不支持时自动去图重试
- 工具调用轮数默认 40 → 200，可在 Bot 设置里调整；跑满上限时请求模型说明已完成/未完成，不再输出固定文案

### CLI 兼容

- 按 `--help` 探测参数能力，`--attachment`、`--effort` 只在目标 CLI 支持时才追加
- 过滤 Git Bash 检测、npm 弃用告警等无害 stderr，只显示真正的错误
- CodeBuddy 的 NDJSON 错误事件不再被吞掉，会话失效可触发自动重跑

### 技能

- 预设岗位引用的自研技能随安装包分发，首次启动释放到 `~/.agents/skills`
- 技能管理新增「缺失技能」区块：可一键安装的给按钮，需要手动导入的写明路径
- 修复技能目录名与 `SKILL.md` 中 `name` 不一致导致的误报缺失、勾选状态丢失

### 工程

- 新增 `scripts/test-win-fixes.mjs` 回归脚本（自带 mock API，可选真实 CLI 场景）
- 新增 `scripts/smoke-win.ps1` Windows 服务端冒烟

## 0.1.1 — 2026-11-14

- Windows x64 支持与打包、CI 冒烟
- 流程可靠性：异常/停滞自动上报、并行汇合防死锁、看门狗
- 侧边栏 Bot 分组与拖拽归组

## 0.1.0 — 2026-11-12

首个开源版本。

- 本地多 Bot 工作台：私聊、群聊、项目、转交、持续运行、工作流
- 七种后端：OpenCode / Codex (ChatGPT) / Claude Code / Antigravity / WorkBuddy / Qoder / 自定义 API
- 首次启动环境检查向导：检测本机 CLI、创建第一个 Bot
- 用量中心：按天/模型/CLI/渠道/Bot/项目统计
- 余额与额度：DeepSeek / Kimi / GLM / MiniMax / MiMo / OpenCode Go / ChatGPT / Qoder / Antigravity
- 页面翻译、文件查看/编辑、浏览器、视频转写、语音、技能
- macOS 桌面版：arm64 + x64 构建、可选签名/公证
- 网络代理：自动检测 macOS 系统代理，支持 HTTP(S) 代理与直连模式
