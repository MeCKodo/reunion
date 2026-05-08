#!/usr/bin/env bash
# Reunion 本地全栈开发一键脚本（你日常 dev 用）
#
# 做的事：
#   pnpm dev [--no-build]   = bash scripts/dev.sh up [--no-build]
#       1. 自动起 OrbStack/Docker daemon（如没在跑）
#       2. docker compose up -d ai_coding_ingest 的 MySQL（如未起）+ wait healthy
#       3. 后台 go run ./cmd/server-dev/（如 :8080 不通）
#          日志写 /tmp/reunion-dev-ingest.log
#       4. 把 ai_coding_collector hook 切到 --preset=local
#          （hook 上报到 http://127.0.0.1:8080）
#       5. pnpm run build（默认每次都 build；--no-build 跳过加快冷启动）
#       6. 前台跑 Electron，--user-data-dir 用独立 dev scratch 目录避免抢
#          已安装 desktop Reunion App 的 single-instance lock
#       关闭 Electron 窗口后脚本退出。后台的 ingest + MySQL 不会自动停，
#       hook 也不会自动切回 prod —— 跑 `pnpm dev:down` 才收摊。
#
#   pnpm dev:down [--wipe] [--tag=server|frontend|client]
#       = bash scripts/dev.sh down [--wipe] [--tag=...]
#       1. pkill go run ./cmd/server-dev/
#       2. docker compose down（默认保留 volume；--wipe 才 down -v 清数据）
#       3. 把 hook 切回 --preset=prod --tag=...
#          tag 默认从 ~/.{claude,cursor}/analytics/config.json 读 clientTag
#          字段；找不到才需要显式传 --tag。
#
# 设计权衡：
# - 退出时不自动 cleanup（trap 不可靠：正常关窗 ok，kill -9 / 系统重启失效）。
#   显式 dev:down 比"以为切回了 prod 实际还在 local"更可控。
# - ingest server 用 nohup 后台跑而不是 docker，因为它依赖 code.byted.org/*
#   私有包，进容器要折腾一堆东西。host-side go run 最简单。
# - Electron 而不是 pnpm run serve：用户主战场是 desktop UI；想浏览器 UI 时
#   仍然可以另开终端跑 `REUNION_TEAM_INGEST_URL=http://127.0.0.1:8080
#   pnpm run serve --port 9888`。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INGEST_DIR="$(cd "$REPO_ROOT/../ai_coding_ingest" && pwd)"
COLLECTOR_DIR="$(cd "$REPO_ROOT/../ai_coding_collector" && pwd)"
INGEST="http://127.0.0.1:8080"
TOKEN="local-test-token"
INGEST_LOG="/tmp/reunion-dev-ingest.log"
BUILD_LOG="/tmp/reunion-dev-build.log"
# Persistent across `pnpm dev` runs so app-mode.json / window state stick.
# 不放到 mkdtemp 是因为开发体验 — 每次都新建 user-data-dir 会让你每次启动都
# 是空白状态，体验拉胯。/tmp 重启清空一次也够。
DEV_USERDATA_DIR="/tmp/reunion-dev-userdata"
DEV_DATA_DIR="/tmp/reunion-team-test/data"

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_RED=$'\033[31m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_RED=""
fi
step() { printf "%s[dev]%s %s\n" "$C_BLUE" "$C_RESET" "$1"; }
ok()   { printf "%s[dev]%s %s%s%s\n" "$C_BLUE" "$C_RESET" "$C_GREEN" "$1" "$C_RESET"; }
warn() { printf "%s[dev]%s %s%s%s\n" "$C_BLUE" "$C_RESET" "$C_YELLOW" "$1" "$C_RESET"; }
err()  { printf "%s[dev]%s %s%s%s\n" "$C_BLUE" "$C_RESET" "$C_RED" "$1" "$C_RESET" >&2; }

ingest_up() { curl -fsS -m 2 -H "Authorization: Bearer $TOKEN" "$INGEST/repos" >/dev/null 2>&1; }

ensure_docker_daemon() {
  # daemon 通就直接返回。`docker info` 是确认 daemon 可达的标准做法
  # （`docker ps` 也行，但 info 输出更短）。
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  # 探测 OrbStack / Docker Desktop 是否安装，挑一个 open
  local app=""
  if [[ -d "/Applications/OrbStack.app" ]]; then
    app="OrbStack"
  elif [[ -d "/Applications/Docker.app" ]]; then
    app="Docker"
  fi
  if [[ -z "$app" ]]; then
    err "Docker daemon 不可达，且 /Applications 下没找到 OrbStack.app / Docker.app。请先启动 Docker 再重试。"
    exit 1
  fi
  step "Docker daemon 没在跑，自动启动 $app.app..."
  open -a "$app" || { err "open -a $app 失败"; exit 1; }
  step "等 $app daemon 起来 (最多 60s)..."
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && { ok "$app daemon ready"; return 0; }
    sleep 2
  done
  err "$app 60s 内没能起来。手动打开 $app App 后再跑 pnpm dev。"
  exit 1
}

cmd_up() {
  local skip_build=0
  [[ "${1:-}" == "--no-build" ]] && skip_build=1

  # --- 0. 前置 ---
  [[ -d "$INGEST_DIR" ]] || { err "找不到 $INGEST_DIR，请确保 ai_coding_ingest 与 reunion-gitlab 同级"; exit 1; }
  [[ -d "$COLLECTOR_DIR" ]] || { err "找不到 $COLLECTOR_DIR，请确保 ai_coding_collector 与 reunion-gitlab 同级"; exit 1; }
  command -v docker >/dev/null 2>&1 || { err "需要 docker（OrbStack / Docker Desktop）"; exit 1; }
  command -v go >/dev/null 2>&1 || { err "需要 go（用于跑 ingest dev server）"; exit 1; }
  ensure_docker_daemon

  # --- 1. MySQL ---
  if docker ps --format '{{.Names}}' | grep -q '^reunion-ingest-mysql$'; then
    step "MySQL 已在跑"
  else
    step "starting MySQL (docker compose up -d)..."
    (cd "$INGEST_DIR" && docker compose -f docker-compose.dev.yml up -d >/dev/null)
  fi
  step "waiting MySQL healthy..."
  for _ in $(seq 1 30); do
    s="$(docker inspect --format='{{.State.Health.Status}}' reunion-ingest-mysql 2>/dev/null || echo missing)"
    [[ "$s" == "healthy" ]] && break
    sleep 2
  done
  [[ "$s" == "healthy" ]] || { err "MySQL 没在 60s 内 healthy"; exit 1; }
  ok "MySQL healthy"

  # --- 2. ingest server ---
  if ingest_up; then
    step "ingest 已在跑 (:8080)"
  else
    step "starting ingest server (nohup go run, 日志: $INGEST_LOG)..."
    (cd "$INGEST_DIR" && nohup go run ./cmd/server-dev/ >"$INGEST_LOG" 2>&1 &)
    for _ in $(seq 1 40); do
      ingest_up && break
      sleep 1
    done
    if ! ingest_up; then
      err "ingest /repos 探测失败，最近日志："
      tail -15 "$INGEST_LOG" | sed 's/^/   /' >&2
      echo >&2
      # 最常见原因：MySQL volume 是老 schema 但 ingest 代码引用了新列。
      # docker-compose 的 init scripts 只在 empty volume 第一次启动时跑，
      # 后续 compose up 不会重新建表，所以加了新列的 migration 在本机失效。
      if grep -q -E 'Unknown column|doesn'\''t exist' "$INGEST_LOG"; then
        warn "看起来是 MySQL schema 没跟上 ingest 代码（最常见：volume 是旧的）。"
        warn "推荐修复：pnpm dev:down --wipe && pnpm dev"
        warn "（--wipe 会清空 MySQL volume，让 sql/dev-init/ 重新跑出最新 schema）"
      fi
      exit 1
    fi
  fi
  ok "ingest up @ $INGEST"

  # --- 3. hook → local ---
  step "switching ai_coding_collector hooks to --preset=local..."
  (cd "$COLLECTOR_DIR" && ./install.sh --preset=local --no-health-check >/dev/null) \
    || { err "install.sh --preset=local 失败"; exit 1; }
  ok "hook → http://127.0.0.1:8080  (config.json apiEndpoint patched)"

  # --- 3b. seed fixtures (idempotent — POST /sessions returns 409 on dupe) ---
  # 没有这步，刚 wipe 完 MySQL 是空的，切团队模式 UI 会一片空白；
  # dev-seed.sh 灌 5 条样例 session，让你立刻能点开看效果。
  if [[ -x "$INGEST_DIR/scripts/dev-seed.sh" ]]; then
    step "seeding 5 fixtures (idempotent — 重复跑会显示 already=N)..."
    (cd "$INGEST_DIR" && ./scripts/dev-seed.sh 2>&1 | tail -1 | sed 's/^/   /')
  fi

  # --- 4. build (frontend dist + electron bundle) ---
  if (( skip_build )); then
    if [[ ! -f "$REPO_ROOT/dist/electron/bootstrap.cjs" || ! -d "$REPO_ROOT/frontend/dist" ]]; then
      err "--no-build 跳过了构建，但 dist/electron/bootstrap.cjs 或 frontend/dist 不存在。先跑一次 'pnpm dev'（不带 --no-build）出产物。"
      exit 1
    fi
    step "skip build (--no-build)"
  else
    step "building electron + frontend bundles (~30s, 日志: $BUILD_LOG)..."
    (cd "$REPO_ROOT" && REUNION_EDITION=team pnpm run build >"$BUILD_LOG" 2>&1) \
      || { err "build 失败，看 $BUILD_LOG"; exit 1; }
    ok "build done"
  fi

  # --- 5. electron (前台) ---
  trap 'echo; warn "Electron 已退出。MySQL + ingest 仍在后台运行，hook 仍指向本地。"; warn "收摊请跑：pnpm dev:down"' EXIT

  mkdir -p "$DEV_USERDATA_DIR" "$DEV_DATA_DIR"

  printf "\n%s%s===============================%s\n" "$C_GREEN" "$C_BOLD" "$C_RESET"
  printf "%s%s reunion ready %s\n" "$C_GREEN" "$C_BOLD" "$C_RESET"
  printf "  electron : (前台启动中 — 看见窗口即 ready)\n"
  printf "  hook     : http://127.0.0.1:8080  (--preset=local)\n"
  printf "  app data : %s\n" "$DEV_DATA_DIR"
  printf "  user data: %s (避开 desktop App 的 single-instance lock)\n" "$DEV_USERDATA_DIR"
  printf "  ingest   : tail -f %s\n" "$INGEST_LOG"
  printf "  build    : tail -f %s\n" "$BUILD_LOG"
  printf "%s%s===============================%s\n\n" "$C_GREEN" "$C_BOLD" "$C_RESET"

  cd "$REPO_ROOT"
  # 直接 spawn electron 不走 `pnpm run electron`，因为后者会再 build 一次。
  # `--user-data-dir=` 是 Chromium 标准 flag，Electron 透传给 Chromium。
  REUNION_DATA_DIR="$DEV_DATA_DIR" \
    REUNION_TEAM_INGEST_URL="$INGEST" \
    REUNION_TEAM_INGEST_TOKEN="$TOKEN" \
    REUNION_EDITION="team" \
    pnpm exec electron . --user-data-dir="$DEV_USERDATA_DIR"
}

cmd_down() {
  local wipe=0
  local tag=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --wipe) wipe=1; shift ;;
      --tag=*) tag="${1#*=}"; shift ;;
      "") shift ;;
      *) err "未知参数：$1 (用法：pnpm dev:down [--wipe] [--tag=server|frontend|client])"; exit 2 ;;
    esac
  done

  # install.sh --preset=prod 强制要求 --tag。我们尽量复用 config.json 里
  # 已有的 clientTag（绝大多数情况：你之前装过 prod hook），用户没传 --tag
  # 又 config 里也没有时才报错。
  if [[ -z "$tag" ]]; then
    if command -v jq >/dev/null 2>&1; then
      tag="$(jq -r '.clientTag // ""' ~/.claude/analytics/config.json 2>/dev/null || true)"
      [[ -z "$tag" ]] && tag="$(jq -r '.clientTag // ""' ~/.cursor/analytics/config.json 2>/dev/null || true)"
    fi
  fi
  if [[ -z "$tag" ]]; then
    err "切回 prod 需要 --tag=server|frontend|client（你机器上 config.json 里也没有 clientTag）"
    err "重跑：pnpm dev:down --tag=frontend  (按你的角色挑一个)"
    exit 2
  fi

  step "killing ingest dev server (pkill go run cmd/server-dev)..."
  pkill -f 'cmd/server-dev' 2>/dev/null || true
  pkill -f 'exe/server-dev' 2>/dev/null || true   # `go run` 编出的二进制名
  sleep 1

  if (( wipe )); then
    step "docker compose down -v (清空 MySQL volume)..."
    (cd "$INGEST_DIR" && docker compose -f docker-compose.dev.yml down -v >/dev/null)
  else
    step "docker compose down (保留 volume，加 --wipe 清数据)..."
    (cd "$INGEST_DIR" && docker compose -f docker-compose.dev.yml down >/dev/null)
  fi

  step "switching hooks back to --preset=prod --tag=$tag..."
  (cd "$COLLECTOR_DIR" && ./install.sh --preset=prod --tag="$tag" --no-health-check >/dev/null) \
    || { err "install.sh --preset=prod --tag=$tag 失败"; exit 1; }

  ok "done. hook → 线上 ingest (https://chh7v1pv.sg-fn.tiktok-row.net), tag=$tag"
}

case "${1:-up}" in
  up)
    shift || true
    cmd_up "${1:-}"
    ;;
  down)
    shift || true
    cmd_down "$@"
    ;;
  -h|--help)
    sed -n '2,34p' "$0"
    ;;
  *)
    err "Usage: $0 [up [--no-build] | down [--wipe] [--tag=server|frontend|client]]"
    exit 2
    ;;
esac
