# 安全策略

## 报告漏洞

请不要在公开 Issue 里贴出可利用细节、API Key、聊天记录或个人信息。

优先使用 GitHub 的 **Security → Report a vulnerability**（私有安全公告）联系维护者；如果仓库还没开启该功能，请先开一个不含敏感信息的 Issue，说明「需要私下联系」。

我们会在 7 天内确认收到，并尽快给出修复计划。

## 本项目的安全边界

Bot Team 是一个本地工具，设计上会：

- 在 `127.0.0.1` 启动 HTTP 服务（桌面版随机端口；命令行版默认 `0.0.0.0`，但非本机请求需要 `bt_token`）
- 读取本机的 CLI 登录态、文件、剪贴板/浏览器 Cookie（仅在对应功能使用时）
- 以 Bot 配置的权限执行 shell 命令、读写文件
- 把 API Key 保存在本机 `data/state.json`（桌面版为 `~/Library/Application Support/Bot Team/data/state.json`）

因此：

1. **不要把你的 `data/`、`bots/`、`.remember/`、日志或手机端带 token 的链接发到公开渠道。**
2. 如果你把手机端地址/tunnel 分享给别人，对方可以在 token 有效期内操作你的 Bot。
3. 给 Bot 开 `full` 权限前，确认它运行的目录和命令是可控的。
4. 第三方 CLI（Codex / Claude Code / Antigravity / WorkBuddy / Qoder）的登录态由它们自己管理，Bot Team 只调用本机命令，不上传这些凭据。

## 已知限制

- API Key 目前是明文存在本机 `state.json`，文件权限会尽量收紧到 `0600`，但没有做系统钥匙串加密。多人共用一台电脑时请使用独立 macOS 账号。
- 余额查询使用的是各服务商的非公开/半公开接口（ChatGPT 用量、GLM 账户、MiMo Cookie 等），可能随官方改版失效；这不是安全漏洞，但会影响显示。
- 本项目会执行模型生成的命令。默认权限是 `workspace`；改成 `full` 前请阅读 Bot 的权限设置。

## 支持版本

当前只维护 `main` 分支的最新版本。旧版本的问题请先升级再复现。
