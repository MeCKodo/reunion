# Logue (mvp-chat-explorer)

聚合本机 Cursor 会话数据，跨 repo 检索、阅读、定位和导出，面向团队内部会话资产化。

## Quick Start

```bash
npm install
npm run serve   # http://127.0.0.1:9765
```

其他命令：
- `npm run index` — 手动重建索引
- `npm run build` — 编译后端 TypeScript (`tsc`)
- `npm run build:frontend` — 构建前端静态资源 (Vite)
- `npm start` — 用编译后的 JS 启动服务

## 项目结构

```
src/server.ts              # 后端：Node.js HTTP 服务（无框架）
frontend/                  # 前端：React SPA (Vite)
  dist/                    #   Vite 构建产物（必须存在才能正确服务）
static/index.html           # 旧版纯 HTML 前端（回退方案）
data/
  chat_index.json          # 会话索引文件（运行时生成）
```

## 架构要点

- **后端**：纯 `node:http`，无 Express/Koa，单文件 `src/server.ts`，用 `tsx` 直接运行
- **前端**：React SPA，Vite 构建，产物在 `frontend/dist/`
- **服务优先级**：先尝试 `frontend/dist/`，不存在则回退到 `static/index.html`
- **数据源**：`~/.cursor/projects/*/agent-transcripts/`
  - 旧格式：`*.txt`
  - 新格式：`<session-id>/<session-id>.jsonl`
- 额外读取 Cursor `workspaceStorage` 的 composer 元数据（标题、创建/更新时间）

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/repos` | 获取所有 repo 列表 |
| GET | `/api/search?q=&days=30&repo=&limit=100` | 全文检索会话 |
| GET | `/api/session/:sessionKey` | 获取单个会话详情与内容 |
| POST | `/api/reindex` | 重建索引 |
| POST | `/api/open-file/:sessionKey` | 用系统默认应用打开原始 transcript |
| GET | `/api/export/:sessionKey?type=rules\|skill&mode=smart\|basic` | 导出 RULES.md 或 SKILL.md |

## 关键约定

- `sessionKey` 格式：`{repo}:{sessionId}`
- 消息时间戳是估算值（基于会话开始/结束时间插值）
- 索引在 `serve` 启动时自动加载，缺失时自动构建
- Smart 导出依赖 `cursor-agent` 命令（环境变量 `CURSOR_AGENT_CMD` 可覆盖）
- 前端 `frontend/dist/` 必须存在，否则会回退到旧版 HTML 界面

## Native 依赖与双架构 DMG

Prompts 视图的 embedding 走 `@huggingface/transformers` + `onnxruntime-node`，本地状态库走 `better-sqlite3`，都是 native 模块。打包时的注意事项：

- `electron-builder` 默认 `npmRebuild: true`，会用 `@electron/rebuild` 把 `better-sqlite3` 按 Electron 的 ABI 重新编译。dual-arch DMG（`pnpm dist:mac`）会分别针对 arm64 / x64 各跑一遍，没问题。
- `onnxruntime-node 1.24+` 的 npm tarball **没有** `darwin/x64` 预编译二进制（[microsoft/onnxruntime#27961](https://github.com/microsoft/onnxruntime/issues/27961)）。x64 DMG 启动后调用 embedding 会缺 `bin/napi-v6/darwin/x64/onnxruntime_binding.node`。
- 我们在 `src/embeddings.ts:getPlatformUnsupportedReason()` 提前检测 `darwin/x64`，把 `EmbedderState.status` 直接设成 `unsupported`，前端 `EmbeddingStatusBanner` 走 "Lite mode" 文案；`/api/prompts/:hash/similar` 与 `/api/prompts/clusters?method=embedding` 自动 fallback 到 Jaccard 并标 `fallback: "embedding-unavailable"`。
- 验证 fallback：临时 `Object.defineProperty(process, 'arch', { value: 'x64' })` 后启动 `pnpm exec tsx src/server.ts serve --port 9789`，对 `/api/embeddings/status`、`/api/embeddings/init`、`/api/prompts/:hash/similar?method=auto` 三个路由分别 curl，确认 `status=unsupported`、`POST /init` 返回 409、similar 返回 jaccard + `fallback` 标记。
- 如果以后 onnxruntime-node 修复了 darwin/x64 prebuild（追踪 PR [microsoft/onnxruntime#27968](https://github.com/microsoft/onnxruntime/pull/27968)），把版本升上去 + 删除 `getPlatformUnsupportedReason` 即可启用 Intel Mac 的 smart clustering。
