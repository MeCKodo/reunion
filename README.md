# Cursor Chat Explorer v1.0 (TypeScript)

聚合本机 Cursor 会话数据，跨 repo 检索、阅读、定位和导出，面向团队内部会话资产化。

## Repo
- GitHub: [MeCKodo/mvp-chat-explorer](https://github.com/MeCKodo/mvp-chat-explorer)
- Branch: `main`

## Data Sources
默认读取 `~/.cursor/projects/*/agent-transcripts`，支持两种格式：
- 旧格式: `agent-transcripts/*.txt`
- 新格式: `agent-transcripts/<session-id>/<session-id>.jsonl`

同时读取 Cursor 本地 `workspaceStorage` 的 composer 元数据（标题、创建/更新时间）用于增强展示。

## Run
```bash
cd '/Users/bytedance/Documents/Obsidian Vault/30_Projects/Cursor对话资产化项目/mvp-chat-explorer'
npm install
npm run serve
```

访问：
- `http://127.0.0.1:8765`

可选命令：
- `npm run index`: 手动重建索引
- `npm run build`: 编译后端 TypeScript
- `npm run build:frontend`: 构建前端静态资源

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
