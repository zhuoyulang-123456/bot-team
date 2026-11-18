#!/usr/bin/env bash
# macOS 一键安装脚本：从 GitHub Releases 拉取最新版 DMG、安装到 /Applications 并清除隔离与重签，避免 Gatekeeper 误报「已损坏」。
set -euo pipefail

REPO="${BOT_TEAM_REPO:-zhuoyulang-123456/bot-team}"
APP_NAME="Bot Team.app"
DEST_DIR="/Applications"
if [ ! -w "$DEST_DIR" ]; then
  DEST_DIR="$HOME/Applications"
  mkdir -p "$DEST_DIR"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) TARGET_ARCH="arm64" ;;
  x86_64) TARGET_ARCH="x64" ;;
  *)
    echo "Unsupported macOS architecture: $ARCH" >&2
    exit 1
    ;;
esac

echo "正在查询 ${REPO} 最新版本 (${TARGET_ARCH})..."
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
DMG_URL="$(
  curl -fsSL "$API_URL" | python3 -c '
import json, re, sys
data = json.load(sys.stdin)
arch = sys.argv[1]
pat = re.compile(rf"^Bot-Team-.*-{re.escape(arch)}\.dmg$")
for asset in data.get("assets", []):
    if pat.match(asset.get("name", "")):
        print(asset["browser_download_url"])
        break
' "$TARGET_ARCH"
)"

if [ -z "$DMG_URL" ]; then
  echo "未在最新 Release 中找到适用于 ${TARGET_ARCH} 的 .dmg 安装包。" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
MOUNT_DIR=""
cleanup() {
  if [ -n "$MOUNT_DIR" ] && [ -d "$MOUNT_DIR" ]; then
    hdiutil detach "$MOUNT_DIR" -quiet || hdiutil detach "$MOUNT_DIR" -force -quiet || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

DMG_PATH="${TMP_DIR}/Bot-Team-${TARGET_ARCH}.dmg"
echo "正在下载: ${DMG_URL}"
curl -fL --progress-bar -o "$DMG_PATH" "$DMG_URL"

MOUNT_DIR="${TMP_DIR}/mnt"
mkdir -p "$MOUNT_DIR"
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_DIR" -nobrowse -quiet

SRC_APP="${MOUNT_DIR}/${APP_NAME}"
if [ ! -d "$SRC_APP" ]; then
  echo "镜像中未找到 ${APP_NAME}" >&2
  exit 1
fi

DEST_APP="${DEST_DIR}/${APP_NAME}"
echo "正在安装到: ${DEST_APP}"
rm -rf "$DEST_APP"
ditto "$SRC_APP" "$DEST_APP"

# 清除可能存在的文件隔离属性并补齐本机 ad-hoc 签名，避免新版 macOS 误报“已损坏”
xattr -cr "$DEST_APP"
codesign --force --deep --sign - "$DEST_APP" >/dev/null 2>&1 || true

echo "安装完成！现在可以直接打开 ${DEST_APP}"
