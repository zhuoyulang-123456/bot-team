#!/bin/bash
# 检查这台 Mac 是否具备签名 / 公证条件。不会打印任何密钥。
set -u
ok=0
bad=0

line() { printf '%s\n' "$1"; }
check_ok() { line "  ✅ $1"; ok=$((ok + 1)); }
check_bad() { line "  ❌ $1"; bad=$((bad + 1)); }

line "== 签名身份 =="
ids="$(security find-identity -v -p codesigning 2>/dev/null | grep -E 'Developer ID Application|Apple Development' || true)"
if [ -n "$ids" ]; then
  printf '%s\n' "$ids" | sed 's/^/  /'
  if printf '%s\n' "$ids" | grep -q 'Developer ID Application'; then
    check_ok "找到 Developer ID Application 证书"
  else
    check_bad "只有 Apple Development 证书；发布 dmg 需要 Developer ID Application"
  fi
else
  check_bad "没有可用的代码签名证书"
fi

line "== notarytool =="
if xcrun --find notarytool >/dev/null 2>&1; then
  check_ok "$(xcrun notarytool --version 2>/dev/null | head -1)"
else
  check_bad "找不到 notarytool（需要 Xcode Command Line Tools 15+）"
fi

line "== 凭据 =="
if [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  check_ok "APPLE_KEYCHAIN_PROFILE=$APPLE_KEYCHAIN_PROFILE"
elif [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ]; then
  check_ok "App Store Connect API Key 已设置"
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  check_ok "Apple ID + App 专用密码 + Team ID 已设置"
else
  check_bad "没有公证凭据（推荐用 notarytool store-credentials 存 Keychain profile）"
fi

line ""
line "通过：$ok 项，缺失：$bad 项"
if [ "$bad" -gt 0 ]; then
  line "按 README 的「签名与公证」准备后，再运行：APPLE_KEYCHAIN_PROFILE=BT_NOTARY npm run dist"
  exit 1
fi
line "可以直接运行：APPLE_KEYCHAIN_PROFILE=BT_NOTARY npm run dist"
