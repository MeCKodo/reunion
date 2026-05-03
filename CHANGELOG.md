# Changelog

> 所有版本变更记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
> 版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **Windows 打包支持**：electron-builder 新增 `win:` 目标，同时产出 NSIS 安装包（per-user，不需要管理员）和 portable exe；`pnpm run dist:win` / `dist:win:x64` / `dist:all` 一键出包；`build/icon.ico` 由 `pnpm run build:icons` 从 `build/icon.png` 自动生成。
- **Windows 一键安装/卸载脚本**：`scripts/install.ps1`、`scripts/uninstall.ps1` 走 `iwr | iex` 模式，自动检测架构、解 SmartScreen Mark-of-the-Web、per-user 静默安装到 `%LOCALAPPDATA%\Programs\Reunion`。`REUNION_PORTABLE=1` 走 portable 模式落到桌面。
- **跨平台 CI 流水线**：`.github/workflows/release.yml` 在 macOS + Windows runner 上并行打包，tag push（`v*`）后自动创建 GitHub Release 并上传所有产物 + 安装/卸载脚本。
- **`FIRST_OPEN_WINDOWS.md`**：给 Windows 同事看的安装、SmartScreen 处理、数据/日志路径、cursor-agent / codex 配置说明。

### Changed

- **`scripts/release.sh`**：自动检测 `release/` 下的 Windows 产物（NSIS / portable）一并上传，release notes 同时包含 macOS + Windows 安装命令；新增 `--no-win` 参数可强制跳过 Windows 上传。
- **`src/config.ts`**：`HOME` 改用 `os.homedir()`（兼容 Windows 没有 `$HOME` 的情况）；`CURSOR_WORKSPACE_STORAGE` 按 `process.platform` 分支，Windows 走 `%APPDATA%\Cursor\User\workspaceStorage`，Linux 走 `$XDG_CONFIG_HOME/Cursor/User/workspaceStorage`。

## [0.2.2]

### Added

- **会话 JSONL 下载**：会话头部新增「More 」操作菜单，整合复制 session_id / 下载原始 JSONL transcript / 删除会话三项；后端新增 `GET /api/session/:sessionKey/jsonl`（仅允许 .jsonl + 仅在配置的 Cursor / Claude / Codex roots 下，防越权读取）。把 transcript 直接发给维护者排查问题再也不用手动翻 `~/.cursor` / `~/.claude` / `~/.codex`。
- **AI Tagger：清空 tag 视为隐式重打**：用户手动删光某条会话的 tag 后，下次批量打标会重新跑该条；之前需要去 Advanced 里勾「Include already tagged」才行。前端「AI Tag (N)」按钮上的数字与后端实际跑的列表完全对齐。

### Changed

- **Cursor 模型菜单收敛到 GPT-5.5 / Opus 4.6 / Opus 4.7 系列**：cursor-agent CLI 暴露的 ~96 个模型缩到 19 个，过滤前缀维护在 `src/ai/cursor/models-allowlist.ts`，未来加家族只需追加一行；CLI 默认 `composer-2-fast` 被过滤掉时自动把 `gpt-5.5-medium` 提升为新默认。Router 在 spawn 时还会再 substitute 一次，杜绝旧 `settings.defaultModel` 或硬编码 id 绕过白名单。

### Fixed

- **cursor-agent Workspace Trust 阻塞**：cursor-agent `--print` 模式新增的「Workspace Trust Required」检查会让从 Finder/Dock 启动的打包应用（cwd = `/`）所有 AI 调用全部失败。所有 spawn 现在统一传 `--trust` + 稳定 cwd（`CURSOR_AGENT_CWD` > `REUNION_DATA_DIR` > `os.homedir()`）。
- **批量打标 cli-config.json 并发竞态**：cursor-agent 每次启动都原子重写 `~/.cursor/cli-config.json`，并发 spawn 会撞出 `ENOENT: rename '.tmp' → 'cli-config.json'` 和 `Unexpected end of JSON input` 两种失败。新增进程内 spawn stagger 锁（默认 150ms 间隔，可由 `CURSOR_SPAWN_STAGGER_MS` 调整）让 spawn 时刻错峰；transient 重试拓宽识别 + `RETRY_MAX` 1 → 2 兜底。
- **Trust 错误不再浪费 retry**：识别为 `looksTrustBlocked()` 后立即 hard-fail，给用户一条 actionable 的提示而不是原始 stderr。

## [0.2.1]

### Changed

- 简化 macOS App 图标背板

## [0.2.0]

### Added

- **AI provider 集成**：Settings 对话框（侧边栏齿轮入口）统一管理 OpenAI / Cursor 两路 AI
  - **OpenAI / ChatGPT 多账号**：spawn `codex login` 在独立 `CODEX_HOME` 下完成 OAuth，token 由 codex 自管，每账号互不干扰
  - 显示 plan（Free / Plus / Pro / Team / Enterprise）+ 双窗口剩余配额进度条 + 重新登录 / 设为默认 / 移除 / 刷新
  - **Cursor Agent 单账号**：spawn `cursor-agent login`（`NO_OPEN_BROWSER=1`），token 落 macOS Keychain
  - 默认 provider 单选，影响 Smart Export 和后续 Ask AI
- 后端 `src/ai/` 模块：`router.ts` 统一入口，`openai/bearer-client.ts` 调 `chatgpt.com/backend-api/codex/responses` 流式拿结果，`cli-spawn.ts` 通用 spawn helper（带 OAuth URL 抽取）
- 新 API：`/api/ai/accounts`、`/api/ai/settings`、`/api/ai/openai/login`（SSE）、`/api/ai/openai/accounts/:id/{default,refresh}`、`/api/ai/cursor/{login,logout}`、`/api/ai/run`（SSE）

### Changed

- **Smart Rules / Smart Skill 真接通**：`ExportActions` 移除 "Coming soon"，按钮直接触发 `fetchExport`，调用通过 `src/ai/router.ts` 路由到 OpenAI 或 Cursor
- `src/export.ts`：`runCursorAgent` 抽到 `src/ai/cursor/run.ts`，`generateExportMarkdown` 改走 `runAiToString`，可按账号 / provider 透传

### Notes

- Reunion 自身不存任何 AI token：OpenAI 走 codex 管的 `auth.json`（在 `data/ai/codex-homes/<id>/`），Cursor 走系统 Keychain
- 不强制配置 AI provider 也能用基础浏览功能；未配置时默认走 cursor-agent，与 v0.1.x 行为一致

## [0.1.1]

### Added

- macOS DMG 一键发版脚本 `scripts/release.sh`（封装 `dist:mac` + `gh release create`）
- `install.sh` 一行命令安装：自动下载对应架构 DMG + 拖到 `/Applications` + `xattr -cr` 清 quarantine
- `scripts/after-pack.cjs` electron-builder 钩子，对整个 `.app` 做 ad-hoc 重签名，解决 Apple Silicon 拒签

### Changed

- DMG 改为分别打 arm64 + x64 两个独立包（替代之前的 universal merge，extraResources 比对更稳）
- macOS 交通灯按钮不再遮挡 sidebar 标题（`titleBarStyle: 'hiddenInset'` + 前端 70px 安全区）

### Fixed

- `process.cwd()` 在打包后指向只读 `app.asar` 的问题（通过 `bootstrap.cjs` 注入 `REUNION_DATA_DIR`）
- `spawn('cursor-agent', ...)` 在 Electron 下找不到命令的 PATH 问题（`fix-path` 处理）

## [0.1.0]

### Added

- macOS 原生桌面 App（Electron 41）首版
- 内嵌 Node.js HTTP server + React SPA（Vite 构建）
- 跨 repo 聚合 Cursor / Claude Code / Codex 三家 Agent 的本地会话
- 全文检索 + 会话内角色筛选（All / User / Agent）
- Conversation / Raw 双视图、命中片段预览
- 一键打开原始 transcript 文件
- Smart Rules / Smart Skill 导出（基于 `cursor-agent`）
- 时间过滤（7/30/60/90 天）+ 项目筛选

[Unreleased]: https://github.com/MeCKodo/reunion/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/MeCKodo/reunion/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/MeCKodo/reunion/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/MeCKodo/reunion/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/MeCKodo/reunion/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MeCKodo/reunion/releases/tag/v0.1.0
