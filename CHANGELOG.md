# Changelog

## 0.1.11 — 2026-11-17

按各厂商官方价目表重做内置价格表（核对日 2026-11-17），修正用量中心估算与实际账单的偏差。

### 价格表

- DeepSeek：保持官方人民币价（Flash 输入 2 / 输出 8 / 缓存 0.04；Pro 输入 9 / 输出 27 / 缓存 0.3，高峰价，空闲时段减半）
- OpenAI：按官方美元价 × 汇率重算（GPT-6.1 Sol 2/10、GPT-6.1 Terra 1/5、GPT-6 Astra 10/50、GPT-6 Luna 0.1/0.5、GPT-5.3 Codex 1.75/14、GPT-5.6 Sol 4/20 等）
- Anthropic：补齐 Fable / Mythos、Opus 5.5、Sonnet 5 / 5.5、Haiku 5.5 等新档位
- Google：区分 Gemini 4 Carbon / Argon、Gemini 4 Hydrogen、Gemini 3.8 Flash
- 智谱：GLM-5.3 8/28/2、GLM-5.3-Flash 0.8/2.8/0.23、GLM-5.3-FlashX 2/7/0.57
- 月之暗面：Kimi K3 20/100/2、K3.1 Pro 22/110/2.2、K2.7-Code 系列
- MiniMax：M3.1 Flash 1/4/0.1、M3 2.1/8.4/0.42
- 阿里云百炼：Qwen4 Max、Qwen3.8 Max、Qwen3 Coder Flash
- 小米 MiMo：V2.6 Pro 3/6/0.025、V2.6 Flash 1/2/0.02
- 腾讯混元：Hy4 Flash 0.5/2/0.02、Hy4 6/18/0.3、Hy3 1/4/0.25
- Mistral：Large 4、Medium 3.5、Small 4、Codestral
- 修正 `glm-5.3-flashx` 被当成 `glm-5.3-flash` 匹配的问题

## 0.1.10 — 2026-11-17

修复 Windows 下 WorkBuddy 无返回、以及用量中心成本估算与实际账单偏差过大的问题。

### WorkBuddy / CodeBuddy

- Windows 上改为直接调用 npm 包里的 JS 入口（`node …/bin/codebuddy`），不再经 `.cmd` 批处理，提示词统一走 stdin：多行提示词不再被截断，中文不再变乱码，从而修复「没有返回内容（exit 0）」
- 解析 `usage_update` 的 `turnUsage.total`（用量与积分），WorkBuddy 现在能记录 CLI 返回的真实积分，而不是按一个猜出来的 token 比例折算
- 会话在 CLI 侧失效（如换机、清理缓存）时自动开新会话重试，不再把 `No conversation found` 直接抛给用户

### 用量与计费

- OpenAI 风格接口的 `input` 已包含缓存命中部分，成本计算改为扣除缓存后再按缓存价计费，避免缓存被按全价重复计算
- 新增「自定义 API 单价」设置（元 / 百万 tokens，按模型名填写）：自定义 API 后端不再回落到通用国产模型价，DeepSeek 等按量渠道可以按官方价精确估算
- 订阅渠道（WorkBuddy / Qoder 等）在拿不到真实积分时回落到 token 单价估算，不再显示 0 元；「合计估算」默认包含订阅折算
- 修正价格表里 `gpt-6.1` / `gpt-5.6` 等带点号的模型名匹配不到的问题
- 保存积分单价时只更新传进来的渠道，不再清掉另一个渠道的配置

## 0.1.9 — 2026-11-17

Windows 端补齐原本只在 macOS 上可用的能力，桌面端行为不变（默认仍只监听 127.0.0.1）。

### Windows 原生能力

- OpenCode 历史用量同步在 Windows 可用：改用 Node 内置 `node:sqlite`（无需外部 `sqlite3`），并兼容 OpenCode 2.x 的 `session_v2` / `session_message` 新表结构，旧版 `message` 表继续支持
- Antigravity 实时配额与账号识别在 Windows 可用：读取 `%APPDATA%\Antigravity\app_storage.json` 与本地 hub（`~/.gemini/antigravity/daemon`），额度卡片与 macOS 一致
- `agy` 多账号登录在 Windows 可用：用独立控制台窗口运行登录，同时切换 `HOME` 与 `USERPROFILE`，多账号 Bot 各自的 `.gemini` 互不干扰
- 文件预览在 Windows 可用：调用 Windows Shell 缩略图接口生成 PNG（图片 / PDF / Office），失败时对图片走 GDI+ 缩放兜底，不再提示「只支持 macOS」
- `.doc` / `.rtf` / `.odt` 文本提取在 Windows 可用：优先 Word COM，其次 LibreOffice headless，均不可用时给出明确提示
- 文档编辑器「保存为 .docx」在 Windows 可用（Word COM，缺失时回退 LibreOffice），临时文件改为目标目录内的单扩展名文件，避免 Word 静默不落盘
- 内置 PowerShell 辅助脚本统一以带 BOM 的 UTF-8 写出，避免 Windows PowerShell 5.1 按本地代码页解析导致脚本被破坏
- 「一键打开 Antigravity / WorkBuddy / Qoder」在 Windows 可用（按常见安装目录定位 exe），系统设置跳转映射到 `ms-settings:`
- 桌面端 PATH 补齐统一走 `lib/platform.mjs` 的目录表，Windows 漏配的 `agy`、`.kimi-code`、`.qoder-cn` 等目录一并补上

### 设置与安全

- 设置页新增「允许局域网访问」开关：默认只监听 `127.0.0.1`；开启并重启后绑定 `0.0.0.0`，手机可用局域网地址访问（远程请求仍需访问令牌）
- 未开启局域网访问时，设置页明确提示局域网地址当前不可用，避免给出打不开的链接
- 桌面端新增「重启 Bot Team」入口，用于让端口绑定等设置立即生效
- NSIS 安装包在覆盖升级前自动关闭正在运行的旧版 `Bot Team.exe`，避免文件占用导致安装失败

### 体验

- Windows 文案不再出现「访达」「完全磁盘访问权限」等 macOS 专有说法，改为「资源管理器」等对应表述
- Windows 上隐藏不可用的「从浏览器读取 MiMo 登录态」入口，引导使用 App 内登录或手动填写 Cookie

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
