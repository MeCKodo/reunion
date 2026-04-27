# Changelog

> 所有版本变更记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
> 版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

[Unreleased]: https://github.com/MeCKodo/reunion/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/MeCKodo/reunion/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/MeCKodo/reunion/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MeCKodo/reunion/releases/tag/v0.1.0
