# Reunion (mvp-chat-explorer)

> 和过去的 AI 对话重逢。聚合本机 Cursor / Claude Code / Codex 会话数据，跨 repo 检索、阅读、定位和导出，面向团队内部会话资产化。

## Quick Start

```bash
fnm use 20
pnpm install
pnpm run serve   # http://127.0.0.1:9765 — 个人模式，不依赖任何外部服务
```

### 全栈本地开发（推荐 dev 循环）

需要同 repo 同级目录有 `ai_coding_ingest` 与 `ai_coding_collector`：

```bash
pnpm dev              # 一键起整套：(自动启 OrbStack →) MySQL + ingest + 切 hook 到 local
                      # + pnpm run build + Electron 前台启动（独立 user-data-dir，不抢 desktop App 锁）
                      # 期间 Cursor/Claude 的 hook 自动上报到本机 :8080，dev Electron 实时看到刚跑的会话
pnpm dev -- --no-build  # 复用上次 dist/ 跳过 build，加快冷启动（改了代码就别加这个）
pnpm dev:down         # 收摊：停 ingest + docker compose down + 切 hook 回线上
                      # 加 --wipe 顺手 docker compose down -v 清 MySQL volume
```

`pnpm dev` 会改 `~/.{claude,cursor}/analytics/config.json` 的 `apiEndpoint` 指向本机；`pnpm dev:down` 会通过 `install.sh --preset=prod` 切回线上 ingest（`https://chh7v1pv.sg-fn.tiktok-row.net`）。**关闭 Electron 窗口或 Ctrl+C 不会自动 cleanup**——后台 ingest + MySQL 仍在跑，hook 仍指本地；记得跑一次 `pnpm dev:down`。详见 [scripts/dev.sh](scripts/dev.sh) 顶部注释。

> 想用浏览器访问 UI？dev 期间另开终端跑：
> `REUNION_TEAM_INGEST_URL=http://127.0.0.1:8080 REUNION_TEAM_INGEST_TOKEN=local-test-token pnpm run serve --port 9888`

其他命令：
- `pnpm run index` — 手动重建索引
- `pnpm test` — 跑后端单元 + 端到端测试（基于 `node:test` + tsx，详见 `test/`）
- `pnpm run build` — 同时构建前端 + 后端
- `pnpm run build:frontend` — 仅构建前端静态资源 (Vite)
- `pnpm run build:backend` — 仅打包后端 + Electron 主进程 (esbuild)
- `pnpm start` — 用编译后的 JS 启动服务
- `pnpm run electron` — 本地启动 Electron App
- `pnpm run electron` / `electron:team` — 本地启动 Electron App（团队版 UI）
- `pnpm run electron:personal` — 本地启动 Electron App（个人版 UI，验证 ModeSwitcher 不显示）
- `pnpm run dist:mac` — 出 macOS DMG（团队版，等价于 `dist:mac:team`）
- `pnpm run dist:mac:personal` — 出个人版 DMG（无团队功能、bundle 不含 ingest token）

### Editions

`REUNION_EDITION` 在构建期决定一份 bundle 是「团队版」(`team`) 还是「个人版」(`personal`)：

- 团队版：`ModeSwitcher` 可见，可在 personal/team 模式间切换；构建时通过 `REUNION_BUILD_INGEST_URL` / `REUNION_BUILD_INGEST_TOKEN` env 把团队 ingest 的 baseUrl + token 经 esbuild `define` 注入到 bundle。
- 个人版：`ModeSwitcher` 始终隐藏；后端 `/api/mode` 拒绝切换到 team（HTTP 403），且 bundle 内 token 字段为空字符串（`build-electron.mjs` 强制清空，杜绝把真 secret 打进个人版的可能）。

发版机：把 secret 放到 `~/.reunion/release.env`（chmod 600），格式：

```bash
export REUNION_BUILD_INGEST_URL="https://chh7v1pv.sg-fn.tiktok-row.net"
export REUNION_BUILD_INGEST_TOKEN="..."   # 当前 ingest 不校验 token，留任意非空值即可
```

`scripts/release.sh` 启动时会 source 这个文件，自动构建两个 edition × 两个 arch 共 4 份 DMG 并上传到 GitLab Release。仅需个人版时加 `--personal-only`。

## 项目结构

```
src/server.ts              # 后端：Node.js HTTP 服务（无框架）
src/http-server.ts         # 路由分发；将 /api/ai/* 委派给 src/ai/http-handlers
src/export.ts              # Smart Rules / Smart Skill 生成；走 src/ai/router
src/routes/tasks.ts        # 后台任务路由（Task Center SSE）
src/ai/                    # ── AI provider 集成（v0.2.0）
  router.ts                #   provider 路由：openai-bearer / cursor-cli
  settings.ts              #   {defaultProvider, defaultOpenAiAccountId, defaultModel}
  http-handlers.ts         #   /api/ai/* 路由（accounts CRUD + SSE login + run + tag）
  tagger.ts                #   AI 自动打标签 prompt 模板
  tag-runner.ts            #   批量打标签并发池 + SSE 进度推送
  cli-spawn.ts             #   通用 spawn helper（runAndCapture / runWithUrlExtraction）
  openai/                  #   多账号 ChatGPT OAuth（每个账号独立 codex-home）
    auth.ts                #     auth.json 读写 + token refresh（vendor agent-meter）
    accounts.ts            #     openai-accounts.json + codex-homes/<id>/
    codex-login.ts         #     spawn `codex login` → SSE 流式登录
    bearer-client.ts       #     调 chatgpt.com/backend-api/codex/responses，stream
    usage.ts               #     调 chatgpt.com/backend-api/wham/usage 拿 plan + quota
  cursor/                  #   单账号 Cursor Agent（token 在 macOS Keychain）
    status.ts              #     spawn `cursor-agent status/about/login/logout`
    run.ts                 #     spawn `cursor-agent --print` 一次性 prompt
frontend/                  # 前端：React SPA (Vite)
  dist/                    #   Vite 构建产物（必须存在才能正确服务）
  src/i18n/                #   国际化配置（i18next，中/英双语）
  src/lib/task-center.tsx  #   前端任务中心状态管理
  src/components/settings/SettingsDialog.tsx  # AI providers 管理界面
  src/components/task-center/TaskCenter.tsx   # 后台任务进度 UI
  src/components/sidebar/AiTaggerButton.tsx   # AI 批量打标签入口
  src/components/sidebar/TagFilterPopover.tsx # 标签筛选弹窗
static/index.html           # 旧版纯 HTML 前端（回退方案，含国际化）
data/
  chat_index.json          # 会话索引文件（运行时生成）
  ai/                      # ── AI provider 数据（v0.2.0）
    openai-accounts.json   #   多账号元数据（不含 token）
    codex-homes/<id>/      #   每个 ChatGPT 账号独立 CODEX_HOME（codex 自管 auth.json）
    settings.json          #   defaultProvider / defaultOpenAiAccountId / defaultModel
```

## 架构要点

- **后端**：纯 `node:http`，无 Express/Koa，单文件 `src/server.ts`，用 `tsx` 直接运行
- **前端**：React SPA，Vite 构建，产物在 `frontend/dist/`
- **桌面端**：Electron 41 + electron-builder 打 macOS DMG（参见 `electron/`、`scripts/build-electron.mjs`）
- **服务优先级**：先尝试 `frontend/dist/`，不存在则回退到 `static/index.html`
- **数据源**（三家 Agent 并列）：
  - Cursor：`~/.cursor/projects/*/agent-transcripts/`（旧 `*.txt` + 新 `<session-id>/<session-id>.jsonl`）
  - Claude Code：`~/.claude/projects/`
  - Codex CLI：`~/.codex/sessions/`
- 额外读取 Cursor `workspaceStorage` 的 composer 元数据（标题、创建/更新时间）

## 数据/日志路径（运行时）

| 模式 | 数据 | 日志 |
| --- | --- | --- |
| 开发模式（`pnpm run serve`） | `data/`（项目根目录） | stdout |
| 打包后（`Reunion.app`） | `~/Library/Application Support/Reunion/data/` | `~/Library/Logs/Reunion/main.log` |

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/repos` | 获取所有 repo 列表 |
| GET | `/api/search?q=&days=30&repo=&limit=100` | 全文检索会话 |
| GET | `/api/session/:sessionKey` | 获取单个会话详情与内容 |
| GET | `/api/session/:sessionKey/jsonl` | 以附件形式下载原始 JSONL transcript（前端 More 菜单使用） |
| POST | `/api/reindex` | 重建索引 |
| POST | `/api/open-file/:sessionKey` | 用系统默认应用打开原始 transcript |
| GET | `/api/export/:sessionKey?type=rules\|skill&mode=smart\|basic&provider=&accountId=` | 导出 RULES.md 或 SKILL.md（provider/accountId 可省，默认走 settings） |
| GET | `/api/ai/accounts` | 返回 `{settings, openai:{accounts,defaultAccountId}, cursor}` snapshot |
| PUT | `/api/ai/settings` | 更新默认 provider / OpenAI 账号 / 模型 |
| POST | `/api/ai/openai/login` (SSE) | 触发 `codex login`，SSE 流 `url` → `success` |
| POST | `/api/ai/openai/accounts/:id/default` | 设为默认 OpenAI 账号 |
| POST | `/api/ai/openai/accounts/:id/refresh` | 重新读 plan / 双窗口 quota |
| DELETE | `/api/ai/openai/accounts/:id` | 删除账号 + 清理 codex-home |
| POST | `/api/ai/cursor/login` (SSE) | 触发 `cursor-agent login`（NO_OPEN_BROWSER） |
| POST | `/api/ai/cursor/logout` | `cursor-agent logout` |
| POST | `/api/ai/run` (SSE) | 流式跑 prompt：body `{prompt, provider?, accountId?, model?, instructions?}` |
| POST | `/api/ai/tag-sessions` (SSE) | 批量 AI 打标签：body `{sessionKeys, provider?, accountId?, model?}`，SSE 推送 progress/done |

## 关键约定

- `sessionKey` 格式：`{repo}:{sessionId}`
- 消息时间戳是估算值（基于会话开始/结束时间插值）
- 索引在 `serve` 启动时自动加载，缺失时自动构建
- Smart 导出走 `src/ai/router.ts`：默认 provider 由 `data/ai/settings.json` 决定，未配置时回退到 `cursor-agent`
- AI provider 不持有 raw token：OpenAI 走 `codex` 在 `data/ai/codex-homes/<id>/auth.json`，Cursor 走 macOS Keychain
- 环境变量：`CURSOR_AGENT_CMD` 覆盖 cursor-agent 路径，`CODEX_CMD` 覆盖 codex 路径
- 前端 `frontend/dist/` 必须存在，否则会回退到旧版 HTML 界面
- 打包时通过 `REUNION_DATA_DIR` / `REUNION_FRONTEND_DIST_DIR` 注入运行时路径（详见 `electron/bootstrap.cjs`）

## 文档索引

- [`README.md`](./README.md) — 产品介绍 + 安装
- [`CHANGELOG.md`](./CHANGELOG.md) — 版本变更记录
- [`FIRST_OPEN.md`](./FIRST_OPEN.md) — 同事拿到 DMG 后的安装/卸载/排错说明
- [`electron-builder.yml`](./electron-builder.yml) — 打包配置（含未来升级付费签名的注释）
