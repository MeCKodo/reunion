#!/usr/bin/env bash
# Logue 一键安装脚本（macOS only）
#
# 用法（同事拷到终端跑这一行）：
#   curl -fsSL https://github.com/MeCKodo/Logue/releases/latest/download/install.sh | bash
#
# 也支持安装指定版本：
#   LOGUE_VERSION=v0.1.0 curl -fsSL https://github.com/MeCKodo/Logue/releases/latest/download/install.sh | bash
#
# 脚本做的事：
#   1. 检测 Mac 架构（Apple Silicon / Intel）
#   2. 从 GitHub Releases 下载对应 DMG
#   3. 挂载、拷贝 Logue.app 到 /Applications
#   4. xattr -cr 清除 quarantine（自动过 Gatekeeper）
#   5. 卸载 DMG、清理临时文件
#   6. 提示用户首次启动方式

set -euo pipefail

# ---------- 配色 ----------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""
fi

step() { printf "%s▸%s %s%s%s\n" "$C_BLUE" "$C_RESET" "$C_BOLD" "$1" "$C_RESET"; }
ok()   { printf "%s✓%s %s\n" "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf "%s!%s %s\n" "$C_YELLOW" "$C_RESET" "$1" >&2; }
err()  { printf "%s✗%s %s\n" "$C_RED" "$C_RESET" "$1" >&2; }
hint() { printf "  %s%s%s\n" "$C_DIM" "$1" "$C_RESET"; }

# ---------- 配置 ----------
GITHUB_REPO="${LOGUE_REPO:-MeCKodo/Logue}"
APP_NAME="Logue"
APP_BUNDLE="${APP_NAME}.app"
INSTALL_DIR="/Applications"
TMP_DIR="$(mktemp -d -t logue-install)"
trap 'rm -rf "$TMP_DIR"; [[ -n "${MOUNTED_VOLUME:-}" ]] && hdiutil detach "$MOUNTED_VOLUME" -quiet 2>/dev/null || true' EXIT

# ---------- 前置检查 ----------
printf "\n%s%sLogue 安装器%s %s(%s)%s\n\n" "$C_BOLD" "$C_CYAN" "$C_RESET" "$C_DIM" "$GITHUB_REPO" "$C_RESET"

if [[ "$(uname -s)" != "Darwin" ]]; then
  err "本脚本仅支持 macOS（当前系统：$(uname -s)）。"
  exit 1
fi

# macOS 12+ 检查（Logue 编译时设的最低版本）
MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
if [[ "$MACOS_MAJOR" -lt 12 ]]; then
  err "需要 macOS 12 (Monterey) 或更新版本。当前：$(sw_vers -productVersion)"
  exit 1
fi

for cmd in curl hdiutil ditto xattr; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "缺少必需命令：$cmd"
    exit 1
  fi
done

# ---------- 架构检测 ----------
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)
    DMG_SUFFIX="-arm64.dmg"
    ARCH_LABEL="Apple Silicon (M-series)"
    ;;
  x86_64)
    DMG_SUFFIX=".dmg"
    ARCH_LABEL="Intel"
    ;;
  *)
    err "不支持的架构：$ARCH"
    exit 1
    ;;
esac

step "检测到 ${ARCH_LABEL}"

# ---------- 解析下载 URL ----------
LOGUE_VERSION="${LOGUE_VERSION:-latest}"
if [[ "$LOGUE_VERSION" == "latest" ]]; then
  REL_URL="https://github.com/${GITHUB_REPO}/releases/latest/download"
else
  REL_URL="https://github.com/${GITHUB_REPO}/releases/download/${LOGUE_VERSION}"
fi

# 探测最新版本的实际版本号（用于打印 + 文件名）
if [[ "$LOGUE_VERSION" == "latest" ]]; then
  step "查询最新版本..."
  RESOLVED_VERSION="$(curl -fsSL -o /dev/null -w "%{url_effective}" \
    "https://github.com/${GITHUB_REPO}/releases/latest" 2>/dev/null \
    | sed -E 's|.*/tag/||' || true)"
  if [[ -n "$RESOLVED_VERSION" ]]; then
    ok "最新版本：${RESOLVED_VERSION}"
  else
    warn "无法解析最新版本号，仍尝试下载（latest 重定向）"
    RESOLVED_VERSION="latest"
  fi
else
  RESOLVED_VERSION="$LOGUE_VERSION"
fi

# DMG 文件名格式：Logue-{version}{suffix}
# 例如：Logue-0.1.0-arm64.dmg / Logue-0.1.0.dmg
VERSION_NUM="${RESOLVED_VERSION#v}"
DMG_NAME="${APP_NAME}-${VERSION_NUM}${DMG_SUFFIX}"
DMG_URL="${REL_URL}/${DMG_NAME}"
DMG_PATH="${TMP_DIR}/${DMG_NAME}"

# ---------- 下载 ----------
step "下载 ${DMG_NAME}"
hint "$DMG_URL"
if ! curl -fL --progress-bar -o "$DMG_PATH" "$DMG_URL"; then
  err "下载失败。请检查："
  hint "1) 网络是否能访问 github.com"
  hint "2) Release 是否存在：https://github.com/${GITHUB_REPO}/releases"
  hint "3) 文件名是否对得上：${DMG_NAME}"
  exit 1
fi
DMG_SIZE="$(du -h "$DMG_PATH" | awk '{print $1}')"
ok "已下载（${DMG_SIZE}）"

# ---------- 挂载 ----------
# 注意：hdiutil 加 -quiet 时不会打印 mount table，导致解析不到挂载点。
# 这里故意不加 -quiet，把 stdout 留给我们 awk 解析。
step "挂载 DMG"
MOUNT_OUTPUT="$(hdiutil attach "$DMG_PATH" -nobrowse -readonly 2>&1)"
# hdiutil attach 的 mount table 行格式（用 tab 分隔）：
#   /dev/disk4s1<TAB>Apple_HFS<TAB>/Volumes/Logue 0.1.0
# 取第一行包含 /Volumes/ 的最后一字段，再 trim 前导空格。
MOUNTED_VOLUME="$(echo "$MOUNT_OUTPUT" | awk -F '\t' '/\/Volumes\// {sub(/^ +/, "", $NF); print $NF; exit}')"
if [[ -z "$MOUNTED_VOLUME" || ! -d "$MOUNTED_VOLUME" ]]; then
  err "挂载失败：未找到挂载点"
  echo "$MOUNT_OUTPUT" >&2
  exit 1
fi
ok "已挂载到 ${MOUNTED_VOLUME}"

if [[ ! -d "${MOUNTED_VOLUME}/${APP_BUNDLE}" ]]; then
  err "DMG 内未找到 ${APP_BUNDLE}"
  ls -la "$MOUNTED_VOLUME" >&2
  exit 1
fi

# ---------- 关闭已运行实例 ----------
if pgrep -f "${APP_BUNDLE}/Contents/MacOS" >/dev/null 2>&1; then
  step "检测到 Logue 正在运行，先优雅退出..."
  osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
  sleep 2
  pkill -f "${APP_BUNDLE}/Contents/MacOS" 2>/dev/null || true
fi

# ---------- 拷贝到 /Applications ----------
TARGET="${INSTALL_DIR}/${APP_BUNDLE}"
if [[ -d "$TARGET" ]]; then
  step "覆盖已安装的旧版本"
  rm -rf "$TARGET" || {
    err "无法删除旧版本（可能需要管理员权限）"
    hint "尝试：sudo rm -rf \"$TARGET\""
    exit 1
  }
fi

step "拷贝到 ${INSTALL_DIR}"
ditto "${MOUNTED_VOLUME}/${APP_BUNDLE}" "$TARGET"
ok "已拷贝"

# ---------- 卸载 DMG ----------
hdiutil detach "$MOUNTED_VOLUME" -quiet || true
MOUNTED_VOLUME=""

# ---------- 清除 quarantine（关键，避免 Gatekeeper 弹窗）----------
step "清除 quarantine 标记（自动过 Gatekeeper）"
xattr -cr "$TARGET" 2>/dev/null || true
ok "完成"

# ---------- 完成 ----------
printf "\n%s%s安装成功！%s\n\n" "$C_GREEN" "$C_BOLD" "$C_RESET"
printf "  %s打开 App：%s\n" "$C_BOLD" "$C_RESET"
printf "    open -a \"${APP_NAME}\"\n\n"
printf "  %s或在 Launchpad 搜索 \"${APP_NAME}\"%s\n\n" "$C_DIM" "$C_RESET"
printf "  %s卸载（一行）：%s\n" "$C_BOLD" "$C_RESET"
printf "    curl -fsSL https://github.com/${GITHUB_REPO}/releases/latest/download/uninstall.sh | bash\n\n"
printf "  %s数据/日志位置：%s\n" "$C_DIM" "$C_RESET"
printf "    %s~/Library/Application Support/${APP_NAME}/%s\n" "$C_DIM" "$C_RESET"
printf "    %s~/Library/Logs/${APP_NAME}/%s\n\n" "$C_DIM" "$C_RESET"
