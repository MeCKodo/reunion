#!/usr/bin/env bash
# Reunion 发版脚本（你本人用）
#
# 做的事：
#   1. 检查 git working tree 干净 / gh 已登录 / 在正确分支
#   2. 依次构建两个 edition × 两个 arch 的 DMG（团队版 + 个人版）
#   3. 创建 GitLab Release（tag = v{package.json.version}）
#   4. 上传 4 份 DMG + install.sh + uninstall.sh + FIRST_OPEN.md
#   5. 输出"群里发这条"的一行命令模板
#
# 团队版 secret 来自 ~/.reunion/release.env（chmod 600），格式：
#   export REUNION_BUILD_INGEST_URL="https://chh7v1pv.sg-fn.tiktok-row.net"
#   export REUNION_BUILD_INGEST_TOKEN="..."   # 当前 ingest 不校验 token，留任意非空值即可
# 没有这个文件时只能构建个人版（仍可发版）。
#
# 用法：
#   bash scripts/release.sh           # 用 package.json 当前 version
#   bash scripts/release.sh 0.1.1     # 临时指定版本号（不改 package.json）
#   bash scripts/release.sh --bump patch    # 自动 bump patch（0.1.0 -> 0.1.1）
#   bash scripts/release.sh --draft   # 创建草稿 release，不公开
#   bash scripts/release.sh --skip-build    # 复用 release/ 现有产物
#   bash scripts/release.sh --personal-only # 只构建并发布个人版（无团队 secret 时也可用）

set -euo pipefail

cd "$(dirname "$0")/.."

# 团队版 secret 注入。release.env 不进 git；不存在也不报错（之后会按
# --personal-only / 缺 secret 时的逻辑处理）。
if [[ -f "$HOME/.reunion/release.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/.reunion/release.env"
  set +a
fi

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""
fi
step() { printf "\n%s▸%s %s%s%s\n" "$C_BLUE" "$C_RESET" "$C_BOLD" "$1" "$C_RESET"; }
ok()   { printf "%s✓%s %s\n" "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf "%s!%s %s\n" "$C_YELLOW" "$C_RESET" "$1" >&2; }
err()  { printf "%s✗%s %s\n" "$C_RED" "$C_RESET" "$1" >&2; }
hint() { printf "  %s%s%s\n" "$C_DIM" "$1" "$C_RESET"; }

# ---------- 解析参数 ----------
DRAFT=0
SKIP_BUILD=0
PERSONAL_ONLY=0
EXPLICIT_VERSION=""
BUMP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --draft) DRAFT=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --personal-only) PERSONAL_ONLY=1; shift ;;
    --bump) BUMP="${2:-patch}"; shift 2 ;;
    --help|-h)
      sed -n '2,28p' "$0"
      exit 0 ;;
    -*)
      err "未知参数：$1"; exit 1 ;;
    *)
      EXPLICIT_VERSION="$1"; shift ;;
  esac
done

# 决定本次要构建哪些 edition。团队版需要 ingest URL+TOKEN；缺一不可时
# 自动降级到个人版-only 并提示，避免误把空 token 打进 team-edition 包。
BUILD_TEAM=1
if [[ "$PERSONAL_ONLY" -eq 1 ]]; then
  BUILD_TEAM=0
fi
if [[ "$BUILD_TEAM" -eq 1 ]]; then
  if [[ -z "${REUNION_BUILD_INGEST_URL:-}" || -z "${REUNION_BUILD_INGEST_TOKEN:-}" ]]; then
    warn "未检测到 REUNION_BUILD_INGEST_URL / REUNION_BUILD_INGEST_TOKEN（建议放到 ~/.reunion/release.env）"
    warn "本次只发布【个人版】。如需发布团队版，请补全 secret 后重跑。"
    BUILD_TEAM=0
  fi
fi

# ---------- 前置检查 ----------
GITLAB_HOST="${REUNION_GITLAB_HOST:-code.byted.org}"
GITLAB_PROJECT="${REUNION_REPO:-i18n_fe/reunion}"
GITLAB_API="https://${GITLAB_HOST}/api/v4/projects/$(printf '%s' "$GITLAB_PROJECT" | sed 's|/|%2F|g')"

if ! command -v curl >/dev/null 2>&1; then
  err "缺少 curl 命令"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  warn "Git 工作区不干净（有未提交修改）。继续可能让 release 与代码不一致。"
  read -r -p "确定继续？[y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || exit 1
fi

# ---------- 决定版本号 ----------
CURRENT_VERSION="$(node -p "require('./package.json').version")"
if [[ -n "$EXPLICIT_VERSION" ]]; then
  NEW_VERSION="${EXPLICIT_VERSION#v}"
elif [[ -n "$BUMP" ]]; then
  case "$BUMP" in
    patch|minor|major) ;;
    *) err "--bump 只接受 patch/minor/major"; exit 1 ;;
  esac
  step "bump $BUMP: $CURRENT_VERSION -> ?"
  NEW_VERSION="$(node -e "
    const v=require('./package.json').version.split('.').map(Number);
    const i={major:0,minor:1,patch:2}['$BUMP'];
    v[i]++; for(let j=i+1;j<3;j++) v[j]=0;
    console.log(v.join('.'));
  ")"
  step "  新版本：$NEW_VERSION"
  npm version "$NEW_VERSION" --no-git-tag-version >/dev/null
  ok "package.json 已更新为 $NEW_VERSION"
else
  NEW_VERSION="$CURRENT_VERSION"
fi

TAG="v${NEW_VERSION}"

# 检查 tag 是否已存在
EXISTING_REL="$(curl -fsSL "${GITLAB_API}/releases/${TAG}" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tag_name',''))" 2>/dev/null || true)"
if [[ "$EXISTING_REL" == "$TAG" ]]; then
  err "Release ${TAG} 已存在于 ${GITLAB_PROJECT} 。"
  printf "  或者用新版本号：bash scripts/release.sh --bump patch\n"
  exit 1
fi

# ---------- 构建 ----------
# 由于 electron-builder 用了 `artifactName: ${productName}-${version}-${arch}.${ext}`，
# 两个 edition 的 DMG 文件名都带 arch 后缀，且 productName 不同所以不会冲突。
TEAM_DMG_ARM64="release/Reunion Lemon8-${NEW_VERSION}-arm64.dmg"
TEAM_DMG_X64="release/Reunion Lemon8-${NEW_VERSION}-x64.dmg"
PERSONAL_DMG_ARM64="release/Reunion-${NEW_VERSION}-arm64.dmg"
PERSONAL_DMG_X64="release/Reunion-${NEW_VERSION}-x64.dmg"

EXPECTED_DMGS=("$PERSONAL_DMG_ARM64" "$PERSONAL_DMG_X64")
if [[ "$BUILD_TEAM" -eq 1 ]]; then
  EXPECTED_DMGS=("$TEAM_DMG_ARM64" "$TEAM_DMG_X64" "${EXPECTED_DMGS[@]}")
fi

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  step "跳过构建（--skip-build）"
  for f in "${EXPECTED_DMGS[@]}"; do
    if [[ ! -f "$f" ]]; then
      err "找不到 $f，请去掉 --skip-build 重新构建"
      exit 1
    fi
  done
else
  rm -rf release dist
  if [[ "$BUILD_TEAM" -eq 1 ]]; then
    step "构建团队版 DMG（arm64 + x64）"
    pnpm run dist:mac:team
    # 把团队版产物挪到子目录，避免下一轮 electron-builder 清空 release/ 时被删
    mkdir -p release/_team
    mv "$TEAM_DMG_ARM64" "release/_team/$(basename "$TEAM_DMG_ARM64")"
    mv "$TEAM_DMG_X64"   "release/_team/$(basename "$TEAM_DMG_X64")"
  fi

  step "构建个人版 DMG（arm64 + x64）"
  rm -rf dist  # 强制重打 bundle，避免 esbuild 缓存让 personal 用上 team 的 define
  pnpm run dist:mac:personal

  if [[ "$BUILD_TEAM" -eq 1 ]]; then
    # 把团队版搬回 release/ 顶层，统一上传逻辑
    mv "release/_team/$(basename "$TEAM_DMG_ARM64")" "$TEAM_DMG_ARM64"
    mv "release/_team/$(basename "$TEAM_DMG_X64")"   "$TEAM_DMG_X64"
    rmdir release/_team
  fi
fi

for f in "${EXPECTED_DMGS[@]}" scripts/install.sh scripts/uninstall.sh FIRST_OPEN.md; do
  if [[ ! -f "$f" ]]; then
    err "缺少文件：$f"
    exit 1
  fi
done
ok "所有上传文件就绪"

# ---------- 生成 Release notes ----------
PREV_TAG="$(curl -fsSL "${GITLAB_API}/releases" 2>/dev/null \
  | python3 -c "import sys,json; r=json.load(sys.stdin); print(r[0]['tag_name'] if r else '')" 2>/dev/null || true)"
NOTES_FILE="$(mktemp -t reunion-release-notes)"
{
  echo "## Reunion ${TAG}"
  echo
  echo "macOS 桌面 App，聚合本地 Cursor / Claude Code / Codex 对话历史。"
  echo
  echo "### 一行命令安装"
  echo
  echo '```bash'
  echo "curl -fsSL https://${GITLAB_HOST}/${GITLAB_PROJECT}/-/raw/main/scripts/install.sh | bash"
  echo '```'
  echo
  echo "### 下载"
  echo
  if [[ "$BUILD_TEAM" -eq 1 ]]; then
    echo "**团队版（部门内部用，可切换团队/个人模式）**"
    echo
    echo "- Apple Silicon (M1/M2/M3/M4): \`Reunion Lemon8-${NEW_VERSION}-arm64.dmg\`"
    echo "- Intel: \`Reunion Lemon8-${NEW_VERSION}-x64.dmg\`"
    echo
  fi
  echo "**个人版（外部分发，仅本地数据源）**"
  echo
  echo "- Apple Silicon (M1/M2/M3/M4): \`Reunion-${NEW_VERSION}-arm64.dmg\`"
  echo "- Intel: \`Reunion-${NEW_VERSION}-x64.dmg\`"
  echo
  if [[ "$BUILD_TEAM" -eq 1 ]]; then
    echo "两版可并存安装（不同 appId / Dock 名）。如不确定选哪个，先装团队版。"
    echo
  fi
  echo "### 系统要求"
  echo
  echo "- macOS 12 (Monterey) 或更新版本"
  echo
  if [[ -n "$PREV_TAG" && "$PREV_TAG" != "$TAG" ]]; then
    echo "### Changes since ${PREV_TAG}"
    echo
    git log --pretty=format:'- %s' "${PREV_TAG}..HEAD" -- . ':(exclude)release' ':(exclude)dist' 2>/dev/null \
      | head -30 \
      || echo "(无 commit 历史)"
  fi
} > "$NOTES_FILE"

# ---------- 创建 git tag（仅当 working tree 干净时）----------
if [[ -z "$(git status --porcelain)" ]]; then
  if ! git rev-parse "$TAG" >/dev/null 2>&1; then
    step "创建本地 git tag $TAG"
    git tag -a "$TAG" -m "Release $TAG"
    git push origin "$TAG" || warn "git tag push 失败（可能没远端权限），不影响 Release 创建"
  fi
fi

# ---------- 创建 Release + 上传 ----------
# 拆两步走：
#   1) 创建 release，先传几个 KB 级别的小文件（install.sh / uninstall.sh / FIRST_OPEN.md），秒级完成
#   2) 大 DMG 单独 upload，每个给一行明确的"开始上传 + 实际耗时"反馈，
#      避免一次 create 全部上传时让人误以为卡死。大文件上传通常需要几分钟，正常现象。
step "创建 GitLab Release ${TAG}"

RELEASE_NOTES="$(cat "$NOTES_FILE")"
rm -f "$NOTES_FILE"

upload_to_gitlab() {
  local file="$1"
  local label="$2"
  local size
  size="$(du -h "$file" | awk '{print $1}')"
  step "上传 ${label} (${size})"
  hint "  文件: ${file}"
  local start_ts end_ts elapsed
  start_ts="$(date +%s)"
  UPLOAD_RESP="$(curl -fsSL --request POST --header "PRIVATE-TOKEN: ${GITLAB_TOKEN:-}" \
    --form "file=@${file}" "${GITLAB_API}/uploads" 2>/dev/null || true)"
  UPLOAD_URL="$(echo "$UPLOAD_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('full_path',''))" 2>/dev/null || true)"
  if [[ -z "$UPLOAD_URL" ]]; then
    err "上传失败：${file}"
    exit 1
  fi
  ASSET_LINKS+=("{\"name\":\"${label}\",\"url\":\"https://${GITLAB_HOST}${UPLOAD_URL}\"}")
  end_ts="$(date +%s)"
  elapsed=$((end_ts - start_ts))
  ok "上传完成（${elapsed}s）"
}

ASSET_LINKS=()
if [[ "$BUILD_TEAM" -eq 1 ]]; then
  upload_to_gitlab "$TEAM_DMG_ARM64" "Reunion Lemon8-${NEW_VERSION}-arm64.dmg"
  upload_to_gitlab "$TEAM_DMG_X64"   "Reunion Lemon8-${NEW_VERSION}-x64.dmg"
fi
upload_to_gitlab "$PERSONAL_DMG_ARM64" "Reunion-${NEW_VERSION}-arm64.dmg"
upload_to_gitlab "$PERSONAL_DMG_X64"   "Reunion-${NEW_VERSION}-x64.dmg"

LINKS_JSON="$(printf '[%s]' "$(IFS=,; echo "${ASSET_LINKS[*]}")")"

curl -fsSL --request POST \
  --header "PRIVATE-TOKEN: ${GITLAB_TOKEN:-}" \
  --header "Content-Type: application/json" \
  --data "$(python3 -c "
import json,sys
print(json.dumps({
    'tag_name': '${TAG}',
    'name': 'Reunion ${TAG}',
    'description': $(python3 -c "import json; print(json.dumps('''${RELEASE_NOTES}'''))"),
    'assets': {'links': json.loads('${LINKS_JSON}')}
}))
")" \
  "${GITLAB_API}/releases" >/dev/null 2>&1 || {
    err "创建 GitLab Release 失败，请检查 GITLAB_TOKEN 环境变量"
    exit 1
  }

# ---------- 完成 ----------
RELEASE_URL="https://${GITLAB_HOST}/${GITLAB_PROJECT}/-/releases/${TAG}"
INSTALL_CMD="curl -fsSL https://${GITLAB_HOST}/${GITLAB_PROJECT}/-/raw/main/scripts/install.sh | bash"

printf "\n%s%s═══════════════════════════════════════════════%s\n" "$C_GREEN" "$C_BOLD" "$C_RESET"
printf "%s%s发布成功！%s\n" "$C_GREEN" "$C_BOLD" "$C_RESET"
printf "%s%s═══════════════════════════════════════════════%s\n\n" "$C_GREEN" "$C_BOLD" "$C_RESET"

printf "  %sRelease:%s %s\n\n" "$C_BOLD" "$C_RESET" "$RELEASE_URL"

printf "  %s群里发这条 → 同事一行装好%s\n" "$C_BOLD" "$C_RESET"
printf "  %s---------------------------------%s\n" "$C_DIM" "$C_RESET"
printf "  %s%s%s\n" "$C_CYAN" "$INSTALL_CMD" "$C_RESET"
printf "  %s---------------------------------%s\n\n" "$C_DIM" "$C_RESET"

printf "  %s卸载命令：%s\n" "$C_DIM" "$C_RESET"
printf "  %scurl -fsSL https://${GITLAB_HOST}/${GITLAB_PROJECT}/-/raw/main/scripts/uninstall.sh | bash%s\n\n" "$C_DIM" "$C_RESET"
