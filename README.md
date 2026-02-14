# Cursor Chat Explorer MVP (TypeScript)

最小可用版本：聚合本机 Cursor agent transcripts，并提供跨 repo 检索与预览。

## 数据源
默认读取：
- `~/.cursor/projects/*/agent-transcripts/*.txt`

## 安装依赖
```bash
cd '/Users/bytedance/Documents/Obsidian Vault/30_Projects/Cursor对话资产化项目/mvp-chat-explorer'
npm install
```

## 启动
```bash
npm run index
npm run serve
```

打开：
- `http://127.0.0.1:8765`

## 功能
- 全 repo 会话列表
- 关键词检索（中英文）
- repo 过滤
- 查看完整会话文本
- 一键重建索引

## 说明
- 当前 MVP 只索引 `agent-transcripts`。
- 索引文件位于 `data/chat_index.json`。
- 后续可补充 `workspaceStorage` 等来源以提升覆盖率。
