# 发布清单

每次发版按这个顺序走，避免把没测过的包发出去。

## 1. 准备

- [ ] `package.json` 的 `version` 改成新版本（例如 `0.1.1`）
- [ ] `CHANGELOG.md` 加一段
- [ ] `npm run check` 通过
- [ ] 用一份**全新数据目录**启动，确认：欢迎向导 → 环境检查 → 创建第一个 Bot → 自动领导 / 私聊 → 发一句话
- [ ] 用**现有数据**启动，确认 Bot / 群聊 / 用量都还在，`setupDone` 迁移正常
- [ ] 手动验证受影响的界面（本次改了哪里就点哪里）

## 2. 构建未签名包

```bash
npm run dist:all
```

产物：

- `release/Bot-Team-<version>-arm64.dmg`
- `release/Bot-Team-<version>-x64.dmg`
- 对应的 `.zip` 和 `.blockmap`

检查：

- [ ] 两个 DMG 都能挂载
- [ ] 拖进 `/Applications` 后能启动
- [ ] 没有残留 `--remote-debugging-port`
- [ ] `state.json` 权限是 `600`
- [ ] 图标是新图标（`build/icon.icns`）

算一下 SHA256，发 Release 时附上：

```bash
shasum -a 256 release/Bot-Team-<version>-*.dmg
```

## 3. 提交 & 打 tag

```bash
git add .
git commit -m "release: v<version>"
git tag v<version>
git push origin main
git push origin v<version>
```

GitHub Actions 会：

1. 跑语法检查
2. 在 macOS runner 构建 arm64 + x64
3. 把 dmg / zip 上传到 Release

> 没有配签名 secrets 时，产物是未签名包，Release 说明里要写清右键打开 / `xattr` 方法。

## 4. Release 说明模板

```markdown
## Bot Team v<version>

> macOS 13+ · Apple Silicon / Intel · **当前为未签名版本**

首次打开如果被 Gatekeeper 拦截：
右键 App →「打开」，或执行
`xattr -dr com.apple.quarantine "/Applications/Bot Team.app"`

### 新增
- ...

### 修复
- ...

### 已知限制
- macOS only；Windows / Linux 暂不支持
- ChatGPT / Claude / Antigravity / WorkBuddy / Qoder 需要本机安装对应 CLI
- Claude / WorkBuddy 没有官方剩余额度接口

### 校验
`SHA256: ...`
```

## 5. 以后有 Apple 开发者账号时

- 按 README「签名与公证」准备好 `Developer ID Application` 证书和 `BT_NOTARY`
- `APPLE_KEYCHAIN_PROFILE=BT_NOTARY npm run dist`
- 用 `codesign --verify`、`spctl -a -vvv -t install`、`xcrun stapler validate` 验证
- 在 CI 配 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`
