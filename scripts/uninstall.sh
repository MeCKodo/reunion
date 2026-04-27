#!/usr/bin/env bash
# Reunion 一键卸载脚本（macOS only）
#
# 用法：
#   curl -fsSL https://github.com/MeCKodo/reunion/releases/latest/download/uninstall.sh | bash
#
# 默认：删除 /Applications/Reunion.app
# 可选：传 --purge 一并删除数据 + 日志

set -euo pipefail

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

step() { printf "%s▸%s %s\n" "$C_BLUE" "$C_RESET" "$1"; }
ok()   { printf "%s✓%s %s\n" "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf "%s!%s %s\n" "$C_YELLOW" "$C_RESET" "$1"; }
err()  { printf "%s✗%s %s\n" "$C_RED" "$C_RESET" "$1" >&2; }

APP_NAME="Reunion"
APP_BUNDLE="${APP_NAME}.app"
APP_PATH="/Applications/${APP_BUNDLE}"
DATA_DIR="${HOME}/Library/Application Support/${APP_NAME}"
LOG_DIR="${HOME}/Library/Logs/${APP_NAME}"

PURGE_DATA=0
for arg in "$@"; do
  case "$arg" in
    --purge|-p) PURGE_DATA=1 ;;
    --help|-h)
      echo "用法: bash uninstall.sh [--purge]"
      echo "  --purge  连同数据和日志一起删除"
      exit 0
      ;;
  esac
done

printf "\n%s%sReunion 卸载器%s\n\n" "$C_BOLD" "$C_RED" "$C_RESET"

if pgrep -f "${APP_BUNDLE}/Contents/MacOS" >/dev/null 2>&1; then
  step "${APP_BUNDLE} 正在运行，先优雅退出..."
  osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
  sleep 2
  pkill -f "${APP_BUNDLE}/Contents/MacOS" 2>/dev/null || true
fi

if [[ -d "$APP_PATH" ]]; then
  step "删除 ${APP_PATH}"
  rm -rf "$APP_PATH" || {
    err "删除失败，可能需要管理员权限"
    printf "    sudo rm -rf %q\n" "$APP_PATH"
    exit 1
  }
  ok "App 已删除"
else
  warn "未找到 ${APP_PATH}（可能已经卸载？）"
fi

if [[ "$PURGE_DATA" -eq 1 ]]; then
  for d in "$DATA_DIR" "$LOG_DIR"; do
    if [[ -d "$d" ]]; then
      step "删除 $d"
      rm -rf "$d"
      ok "已删除"
    fi
  done
else
  remaining=()
  for d in "$DATA_DIR" "$LOG_DIR"; do
    [[ -d "$d" ]] && remaining+=("$d")
  done
  if [[ ${#remaining[@]} -gt 0 ]]; then
    printf "\n%s保留了你的数据和日志：%s\n" "$C_DIM" "$C_RESET"
    for d in "${remaining[@]}"; do
      printf "  %s%s%s\n" "$C_DIM" "$d" "$C_RESET"
    done
    printf "\n%s想一并删除？跑：%s\n" "$C_DIM" "$C_RESET"
    printf "  rm -rf"
    for d in "${remaining[@]}"; do
      printf " %q" "$d"
    done
    printf "\n"
  fi
fi

printf "\n%s%s卸载完成%s\n\n" "$C_GREEN" "$C_BOLD" "$C_RESET"
