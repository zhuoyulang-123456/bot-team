# Bot Team 0.1.9 → 0.1.11 更新说明（Windows 端）

> 日期：2026-11-17　范围：Windows 桌面版　版本：0.1.9 / 0.1.10 / 0.1.11
> 说明：本文只描述功能与修复，不包含任何账号、项目、会话或模型偏好信息。

---

## 一、0.1.9 — 补齐 Windows 原生能力

此前很多功能只在 macOS 上可用，Windows 上直接返回"暂不支持"。这一版把能落地的都补上了，桌面端行为不变（默认仍只监听 `127.0.0.1`）。

### 1. OpenCode 历史用量同步

- 改用 Node 内置 `node:sqlite`，Windows 上不再需要外部 `sqlite3` 可执行文件
- 兼容 OpenCode 2.x 的新表结构（`session_v2` + `session_message`），旧版 `message` 表继续支持
- 统一路径比较（Windows 不区分大小写、OpenCode 存的是正斜杠）

### 2. Antigravity 配额与账号

- 读取 `%APPDATA%\Antigravity\app_storage.json` 与本地 hub（`~/.gemini/antigravity/daemon`）
- 额度卡片与 macOS 一致：账号邮箱 + 各额度窗口
- `agy` 多账号登录改用独立控制台窗口，同时切换 `HOME` 与 `USERPROFILE`，多账号互不干扰

### 3. 文件预览与文档处理

- 缩略图：调用 Windows Shell 缩略图接口生成 PNG（图片 / PDF / Office），失败时对图片走 GDI+ 缩放兜底
- 纯白空图会被识别并回退成图标，不再显示一张白纸
- `.doc` / `.rtf` / `.odt` 文本提取：优先 Word COM，其次 LibreOffice headless
- 文档编辑器「保存为 .docx」在 Windows 可用（Word COM，缺失时回退 LibreOffice）

### 4. 一键打开 App / 系统设置

- Antigravity / WorkBuddy / Qoder 按常见安装目录定位 exe 并启动
- 系统设置跳转映射到 `ms-settings:`（含代理设置）

### 5. 局域网访问（新增设置）

- 设置页新增「允许局域网访问」开关，默认关闭（只监听 `127.0.0.1`）
- 开启并重启后绑定 `0.0.0.0`，手机可用局域网地址访问（远程请求仍需访问令牌）
- 未开启时设置页会明确提示局域网地址当前不可用，不再给出打不开的链接
- 桌面端新增「重启 Bot Team」入口，让端口绑定等设置立即生效

### 6. 安装与文案

- NSIS 安装包在覆盖升级前自动关闭正在运行的旧版 `Bot Team.exe`，避免文件占用导致安装失败
- Windows 下不再出现「访达」「完全磁盘访问权限」等 macOS 专有说法
- 隐藏 Windows 上不可用的「从浏览器读取 MiMo 登录态」入口

### 7. 过程中修掉的两个坑

- Windows PowerShell 5.1 读无 BOM 的 UTF-8 脚本会按本地代码页解析，中文注释可能吞掉换行导致脚本损坏 → 内置 PowerShell 脚本统一带 BOM 写出
- Word 对 `a.docx.bt-123.docx` 这类多重扩展名会静默不保存 → 临时文件改为目标目录内的单扩展名文件

---

## 二、0.1.10 — WorkBuddy 无返回 + 计费偏差

### 1. WorkBuddy「没有返回内容（exit 0）」

**根因**：Windows 上 npm 全局装的 `codebuddy` 是 `.cmd` 批处理，提示词作为命令行参数传入时会被 cmd 截断多行、中文按 GBK 变成乱码，模型收到的是残缺的 `?????`，回复内容拿不到正文，最终报成"没有返回内容（exit 0）"。

**修复**：

- 直接调用 npm 包里的 JS 入口（`node …\bin\codebuddy`），绕开 `.cmd`
- 提示词统一走 stdin（`--input-format text`）
- 会话在 CLI 侧失效（换机、清理缓存）时自动开新会话重试，不再直接抛 `No conversation found`

**实测**：多行中文提示词、多轮 `--resume`、失效会话自动重试均正常。

### 2. 计费偏差（用户看到 4 块、控制台 5 毛）

审查后发现 5 个问题叠加：

1. **缓存被重复计费**：OpenAI 风格接口的 `input_tokens` 已包含缓存命中部分，旧代码又按全价算一遍输入、再额外算一遍缓存
2. **自定义 API 一律按"国产模型通用价"估**：没有地方能填真实单价
3. **订阅渠道消耗被排除在合计之外**：WorkBuddy / Qoder / Codex 的消耗永远显示 0
4. **WorkBuddy 积分是猜的**：写死 31,874 tokens = 1 积分，而 CLI 其实会返回真实积分
5. **价格表正则 bug**：`gpt-6.1-*`、`gpt-5.6-*` 全部匹配不到，落到高价兜底

**修复**：

- 缓存命中部分先扣除再按缓存价计费
- 设置页新增「自定义 API 单价」（元 / 百万 tokens，按模型名填输入 / 输出 / 缓存价）
- WorkBuddy 直接记录 CLI 返回的真实积分；拿不到真实积分时才退回 token 单价
- 「合计估算」默认包含订阅折算，可随时关掉
- 修正带点号模型名的价格匹配

**验证**：一笔 10 万输入（其中 8 万缓存）+ 1 万输出，按 DeepSeek 价从 ¥0.25 降到 ¥0.0616；WorkBuddy 一轮真实调用记录到 0.7 积分（非估算），并正确计入合计。

---

## 三、0.1.11 — 按官方价目表重做价格表

按各厂商官方价目表（核对日 2026-11-17）重写内置价格表，覆盖：

- DeepSeek：保持官方人民币价与峰谷规则（Flash 2/8/0.04，Pro 9/27/0.3，高峰价）
- OpenAI：GPT-6.1 Sol / Terra、GPT-6 Astra / Luna / Sol、GPT-5.6 系列、GPT-5.3 Codex
- Anthropic：Fable / Mythos、Opus 5.5、Sonnet 5 / 5.5 / 4.x、Haiku 5.5 / 4.5
- Google：Gemini 4 Carbon / Argon / Hydrogen、Gemini 3.8 Flash
- 智谱：GLM-5.3 / 5.3-Flash / 5.3-FlashX
- 月之暗面：Kimi K3 / K3.1 Pro / K2.7-Code 系列
- MiniMax：M3.1 Flash、M3
- 阿里云百炼：Qwen4 Max、Qwen3.8 Max、Qwen3 Coder Flash
- 小米 MiMo：V2.6 Pro / Flash
- 腾讯混元：Hy4 Flash / Hy4 / Hy3
- Mistral：Large 4、Medium 3.5、Small 4、Codestral

同时修正 `glm-5.3-flashx` 被 `glm-5.3-flash` 抢先匹配的问题。

---

## 四、当前状态

- 三个版本均已在 Windows 实机打包、安装、启动验证
- `npm run check` 全部通过
- 代码已提交到仓库 `main` 分支
- 价格表核对明细另见 `docs/pricing-reference.md`

## 五、已知未验证项

- GitHub Copilot CLI：本机未登录（`No authentication information found`），参数已按 `--help` 核对，真实对话未实测
- 局域网访问：已实测绑定 `0.0.0.0` 并从局域网地址访问，未在真机手机上做完整回归
