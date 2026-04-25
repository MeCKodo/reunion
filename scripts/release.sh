#!/usr/bin/env bash
# Logue 发版脚本（你本人用）
#
# 做的事：
#   1. 检查 git working tree 干净 / gh 已登录 / 在正确分支
#   2. 跑 pnpm run dist:mac 构建两个架构的 DMG
#   3. 创建 GitHub Release（tag = v{package.json.version}）
#   4. 上传 DMG（arm64 + x64）+ install.sh + uninstall.sh + FIRST_OPEN.md
#   5. 输出"群里发这条"的一行命令模板
#
# 用法：
#   bash scripts/release.sh           # 用 package.json 当前 version
#   bash scripts/release.sh 0.1.1     # 临时指定版本号（不改 package.json）
#   bash scripts/release.sh --bump patch    # 自动 bump patch（0.1.0 -> 0.1.1）
#   bash scripts/release.sh --draft   # 创建草稿 release，不公开
#   bash scripts/release.sh --skip-build    # 复用 release/ 现有产物，跳过 dist:mac

set -euo pipefail

cd "$(dirname "$0")/.."

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
EXPLICIT_VERSION=""
BUMP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --draft) DRAFT=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --bump) BUMP="${2:-patch}"; shift 2 ;;
    --help|-h)
      sed -n '2,18p' "$0"
      exit 0 ;;
    -*)
      err "未知参数：$1"; exit 1 ;;
    *)
      EXPLICIT_VERSION="$1"; shift ;;
  esac
done

# ---------- 前置检查 ----------
GITHUB_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
if [[ -z "$GITHUB_REPO" ]]; then
  err "gh CLI 未登录或未在 git 仓库内。请先 \`gh auth login\`。"
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
if gh release view "$TAG" --repo "$GITHUB_REPO" >/dev/null 2>&1; then
  err "Release ${TAG} 已存在于 ${GITHUB_REPO} 。"
  printf "  想覆盖？先删：gh release delete %s --yes --repo %s\n" "$TAG" "$GITHUB_REPO"
  printf "  或者用新版本号：bash scripts/release.sh --bump patch\n"
  exit 1
fi

# ---------- 构建 ----------
DMG_ARM64="release/Logue-${NEW_VERSION}-arm64.dmg"
DMG_X64="release/Logue-${NEW_VERSION}.dmg"

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  step "跳过构建（--skip-build）"
  for f in "$DMG_ARM64" "$DMG_X64"; do
    if [[ ! -f "$f" ]]; then
      err "找不到 $f，请去掉 --skip-build 重新构建"
      exit 1
    fi
  done
else
  step "构建 macOS DMG（arm64 + x64）"
  rm -rf release dist
  pnpm run dist:mac
fi

for f in "$DMG_ARM64" "$DMG_X64" scripts/install.sh scripts/uninstall.sh FIRST_OPEN.md; do
  if [[ ! -f "$f" ]]; then
    err "缺少文件：$f"
    exit 1
  fi
done
ok "所有上传文件就绪"

# ---------- 生成 Release notes ----------
PREV_TAG="$(gh release list --repo "$GITHUB_REPO" --limit 1 --json tagName -q '.[0].tagName' 2>/dev/null || true)"
NOTES_FILE="$(mktemp -t logue-release-notes)"
{
  echo "## Logue ${TAG}"
  echo
  echo "macOS 桌面 App，聚合本地 Cursor / Claude Code / Codex 对话历史。"
  echo
  echo "### 一行命令安装"
  echo
  echo '```bash'
  echo "curl -fsSL https://github.com/${GITHUB_REPO}/releases/download/${TAG}/install.sh | bash"
  echo '```'
  echo
  echo "### 下载"
  echo
  echo "- **Apple Silicon (M1/M2/M3/M4)**: \`Logue-${NEW_VERSION}-arm64.dmg\`"
  echo "- **Intel**: \`Logue-${NEW_VERSION}.dmg\`"
  echo
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
#      避免一次 create 全部上传时让人误以为卡死。GitHub Releases 单文件 100MB 走国内
#      网络通常需要 5~7 分钟，正常现象。
step "创建 GitHub Release ${TAG}（先传小文件）"
GH_FLAGS=(--repo "$GITHUB_REPO" --title "Logue ${TAG}" --notes-file "$NOTES_FILE")
if [[ "$DRAFT" -eq 1 ]]; then
  GH_FLAGS+=(--draft)
fi

gh release create "$TAG" "${GH_FLAGS[@]}" \
  "scripts/install.sh#install.sh" \
  "scripts/uninstall.sh#uninstall.sh" \
  "FIRST_OPEN.md#FIRST_OPEN.md"

rm -f "$NOTES_FILE"

upload_dmg() {
  local file="$1"
  local label="$2"
  local size
  size="$(du -h "$file" | awk '{print $1}')"
  step "上传 ${label} (${size})"
  hint "  文件: ${file}"
  hint "  ↑ 100MB 级 DMG 在国内一般 5-8 分钟，进度条由 gh CLI 控制（无进度条不代表卡住）"
  local start_ts end_ts elapsed
  start_ts="$(date +%s)"
  if ! gh release upload "$TAG" "${file}#${label}" --repo "$GITHUB_REPO" --clobber; then
    err "上传失败：${file}"
    err "Release 已创建但 DMG 缺失。可手动 retry："
    printf "  gh release upload %s %s#%s --repo %s --clobber\n" "$TAG" "$file" "$label" "$GITHUB_REPO"
    exit 1
  fi
  end_ts="$(date +%s)"
  elapsed=$((end_ts - start_ts))
  ok "上传完成（${elapsed}s）"
}

upload_dmg "$DMG_ARM64" "Logue ${NEW_VERSION} (Apple Silicon)"
upload_dmg "$DMG_X64"   "Logue ${NEW_VERSION} (Intel)"

# ---------- 完成 ----------
RELEASE_URL="https://github.com/${GITHUB_REPO}/releases/tag/${TAG}"
INSTALL_CMD="curl -fsSL https://github.com/${GITHUB_REPO}/releases/latest/download/install.sh | bash"

printf "\n%s%s═══════════════════════════════════════════════%s\n" "$C_GREEN" "$C_BOLD" "$C_RESET"
printf "%s%s发布成功！%s\n" "$C_GREEN" "$C_BOLD" "$C_RESET"
printf "%s%s═══════════════════════════════════════════════%s\n\n" "$C_GREEN" "$C_BOLD" "$C_RESET"

printf "  %sRelease:%s %s\n\n" "$C_BOLD" "$C_RESET" "$RELEASE_URL"

printf "  %s群里发这条 → 同事一行装好%s\n" "$C_BOLD" "$C_RESET"
printf "  %s---------------------------------%s\n" "$C_DIM" "$C_RESET"
printf "  %s%s%s\n" "$C_CYAN" "$INSTALL_CMD" "$C_RESET"
printf "  %s---------------------------------%s\n\n" "$C_DIM" "$C_RESET"

printf "  %s卸载命令：%s\n" "$C_DIM" "$C_RESET"
printf "  %scurl -fsSL https://github.com/${GITHUB_REPO}/releases/latest/download/uninstall.sh | bash%s\n\n" "$C_DIM" "$C_RESET"
