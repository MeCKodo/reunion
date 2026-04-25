# Logue v0.1 (TypeScript + Electron)

聚合本机 Cursor / Claude Code / Codex 会话数据，跨 repo 检索、阅读、定位和导出，面向团队内部会话资产化。

## Repo
- GitHub: [MeCKodo/Logue](https://github.com/MeCKodo/Logue)
- Branch: `main`

## Data Sources
默认读取：
- Cursor: `~/.cursor/projects/*/agent-transcripts`（含旧 `*.txt` 与新 `<session-id>/<session-id>.jsonl` 两种格式）
- Claude Code: `~/.claude/projects`
- Codex: `~/.codex/sessions`

同时读取 Cursor 本地 `workspaceStorage` 的 composer 元数据（标题、创建/更新时间）用于增强展示。

## Run（开发模式）
```bash
fnm use 20
pnpm install
pnpm run serve
```

访问：
- `http://127.0.0.1:9765`

可选命令：
- `pnpm run index`: 手动重建索引
- `pnpm run build:frontend`: 构建前端静态资源
- `pnpm run build:backend`: 用 esbuild 打包后端 + Electron 主进程
- `pnpm run build`: 同时跑前端 + 后端构建
- `pnpm run electron`: 本地启动 Electron App（构建 + 启动）

## 打包与分发（macOS DMG）

### 一键发版（推荐）

每次想给同事发新版本，只需要一行：

```bash
fnm use 20
pnpm run release:patch    # 0.1.0 -> 0.1.1，自动构建 + 上传 GitHub Release
```

支持的快捷命令：
- `pnpm run release` —— 用 `package.json` 当前版本号发版
- `pnpm run release:patch` —— bump patch 后发版（推荐日常用）
- `pnpm run release:minor` —— bump minor 后发版
- `pnpm run release:draft` —— 创建草稿 Release，不公开

底层是 [`scripts/release.sh`](scripts/release.sh)，做的事：
1. 检查 git 工作区干净 / `gh` 已登录
2. `pnpm run dist:mac` 出 arm64 + x64 两个 DMG（约 2 分钟）
3. 调 `gh release create` 把 DMG + `install.sh` + `uninstall.sh` + `FIRST_OPEN.md` 上传到 GitHub Release
4. 自动生成 release notes（含 commits since 上一个 tag）
5. 终端打印「群里发这条」一行命令模板

发版完成后，**同事只需复制这一行**：

```bash
curl -fsSL https://github.com/MeCKodo/Logue/releases/latest/download/install.sh | bash
```

会自动下载对应架构 DMG、装到 `/Applications`、`xattr` 清 quarantine 自动过 Gatekeeper。

### 仅出包不发版

如果只想本地出 DMG（不上传 GitHub）：

```bash
pnpm run dist:mac          # 同时打 arm64 + x64
# 单架构：
# pnpm run dist:mac:arm64
# pnpm run dist:mac:x64
```

产物在 `release/` 目录：
- `Logue-0.1.0-arm64.dmg` —— Apple Silicon
- `Logue-0.1.0.dmg` —— Intel Mac
- 同名 `*-mac.zip` 是给 `electron-updater` 增量更新用的（暂未启用）

### 签名策略

- 当前用免费 ad-hoc 签名（electron-builder + 自定义 `scripts/after-pack.cjs` 钩子）
- `install.sh` 自动跑 `xattr -cr` 清 quarantine，**同事不会看到 Gatekeeper 弹窗**
- 手动安装 DMG 的场景，用户首次打开需要走一次「系统设置 → 隐私与安全性 → 仍要打开」，详见 [`FIRST_OPEN.md`](./FIRST_OPEN.md)
- 升级到付费签名 + Apple 公证只需改 `electron-builder.yml` 几行（注释里有完整模板），CI 上加 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` 环境变量即可

### 关键文件

- [`scripts/release.sh`](scripts/release.sh) —— 一键发版（构建 + GitHub Release）
- [`scripts/install.sh`](scripts/install.sh) —— 同事的一行安装脚本
- [`scripts/uninstall.sh`](scripts/uninstall.sh) —— 同事的一行卸载脚本
- [`electron/main.ts`](electron/main.ts) —— Electron 主进程，启动内嵌 HTTP server + 创建窗口 + 菜单栏
- [`electron/bootstrap.cjs`](electron/bootstrap.cjs) —— CommonJS 启动器，负责在 ESM 主进程加载前注入 `LOGUE_DATA_DIR` 等环境变量
- [`scripts/build-electron.mjs`](scripts/build-electron.mjs) —— esbuild 配置，把 `electron/main.ts` 和 `src/server.ts` 分别打到 `dist/electron/main.js` 与 `dist/src/server.cjs`
- [`scripts/after-pack.cjs`](scripts/after-pack.cjs) —— electron-builder 钩子，对整个 `.app` 跑 `codesign --deep --force --sign -` 完成 ad-hoc 重签名
- [`electron-builder.yml`](electron-builder.yml) —— 打包配置，已注释好升级付费签名的 diff
- [`build/icon.icns`](build/icon.icns) —— App 图标（从 `build/icon-source.svg` 用 `rsvg-convert + sips + iconutil` 生成）

### 已知坑（已解决）

1. **`process.cwd()` 在打包后只读** —— 通过环境变量在 `bootstrap.cjs` 注入正确路径，`src/config.ts` 读取覆盖
2. **`spawn('cursor-agent')` PATH 问题** —— `electron/main.ts` 顶部 `import 'fix-path'` 修复
3. **Apple Silicon Gatekeeper 拒绝 ad-hoc 仅签了主二进制的 .app** —— `scripts/after-pack.cjs` 对整个 `.app` 重签
4. **universal merge 的 mach-o 不一致** —— 改成分别打 arm64 + x64 两个 DMG（universal 对 extraResources 比对过严，arm64 + x64 单独包更稳）
5. **macOS 交通灯按钮遮挡 sidebar 标题** —— Electron `titleBarStyle: 'hiddenInset'` + 前端 sidebar 顶部加 70px 安全区（仅 macOS Electron 下生效，浏览器 dev 模式不受影响）

## Current Features (v1.0)
- 跨 repo 会话聚合与分组展示
- 项目筛选（All projects / 指定 repo）
- 时间过滤（最近 7/30/60/90 天）
- 全文关键词检索（中英文）
- 会话命中消息预览（展示命中片段与角色）
- Conversation / Raw 双视图
- 会话内角色筛选（All / User / Cursor）
- 顶部会话元数据展示（开始时间、时长）
- 一键打开原始 transcript 文件（Open）
- Smart Rules 导出（`/api/export/:sessionKey?type=rules&mode=smart`）
- Smart Skill 导出（`/api/export/:sessionKey?type=skill&mode=smart`）
- 回到顶部按钮
- 一键重建索引（Reindex）

## API Snapshot
- `GET /api/search?q=&days=30&repo=&limit=300`
- `GET /api/session/:sessionKey`
- `GET /api/repos`
- `POST /api/reindex`
- `POST /api/open-file/:sessionKey`
- `GET /api/export/:sessionKey?type=rules|skill&mode=smart`

## Index
- 索引文件: `data/chat_index.json`
- `serve` 启动时会自动尝试加载索引；索引缺失时会自动构建。

## Notes
- 消息级时间戳是基于会话开始/结束时间的插值估算（非 Cursor 原生逐条消息时间）。
- 当前仅聚合本机 Cursor 数据，不做团队统一采集（更符合隐私边界）。
