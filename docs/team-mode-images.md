# Team mode · 图片资源访问设计

## 背景

会话 transcript 里的 `<image_files>` 块用 **绝对路径** 引用本地缓存的截图：

```
<image_files>
1. /Users/foo/.cursor/projects/<encoded>/assets/image-<uuid>.png
</image_files>
```

这些路径是「事件发生时那台机器上的本地文件」。

- **个人版**：会话和图片在同一台机器，`/api/asset` 直接读盘即可。
- **团队版**：会话从 ingest 后端聚合而来，路径指向的可能是其他同事机器上的文件，本机上根本不存在。

## 现状（B 方案）

`src/http-server.ts#handleAsset` 在 team 模式下**不再统一拒绝**，而是把 `resolveAssetPath` 的允许根目录限缩到 `cursor` 一项（`{ cursorRootOnly: true }`）。

效果：

| 场景 | 结果 |
|------|------|
| 自己本机产生的会话 + 图片仍缓存在 `~/.cursor/projects/.../assets/` | 200，正常显示 |
| 自己本机产生的会话 + 图片已被清理 | 404 → 前端 `FallbackThumb` 卡片 |
| 同事机器产生的会话引用的本地路径 | 404 → `FallbackThumb` 卡片 |
| 任意非 cursor 根的本地路径（`/etc/passwd`、`~/.claude/...`） | 403/415 |

零基础设施成本。**只解决了一半问题**：跨机器看图仍然不可用。

## 长期方案（C） — ingest 端代为存图

让 collector 上报会话时把会话引用的本地图片一起打包到 ingest 后端的 blob 存储，并将 transcript 里的本地路径改写成 ingest 资源 URL。

### 数据流

```
[Cursor 本机]                [collector]                [ingest backend]              [reunion (team)]
transcript.jsonl    ─►  扫 <image_files>     ─►  POST /api/v1/assets    ─►   GET /api/v1/assets/<sha>
图片缓存 .png/.jpg       计算 sha256              对象存储 (S3/本地 fs)         Content-Type 嗅探后返回
                         POST /api/v1/sessions    返回 <sha> 引用
                         payload 里替换 path
                         为 reunion://asset/<sha>
```

### 改动点清单

#### `ai_coding_ingest`

- [ ] 新增 `client_assets` 表：`sha256 PRIMARY KEY, mime, byte_size, uploaded_at, last_seen_at`
- [ ] 新增 `POST /api/v1/assets` 接口：multipart/form-data，body 是图片字节；server 算 sha256，去重写 blob 存储 + 表，返回 `{ sha256 }`
- [ ] 新增 `GET /api/v1/assets/:sha256` 接口：流式返回图片，做 mime sniff（参见下文 reunion 端的 `sniffImageMime`，可直接复用算法）；命中 `If-None-Match` 走 304
- [ ] blob 存储：MVP 直接落本地磁盘 `data/assets/<sha[0:2]>/<sha>`；之后看体量再换 S3
- [ ] `POST /api/v1/sessions` payload 增加可选 `referenced_assets: [{sha256, original_path}]` 字段（仅做引用追踪，便于将来做 GC）

#### `ai_coding_collector`

- [ ] 上报前扫描 transcript 中的 `<image_files>` 块，提取本地绝对路径
- [ ] 对每个存在的本地图片：算 sha256，先 `HEAD /api/v1/assets/:sha`，未命中再 `POST /api/v1/assets` 上传
- [ ] 把 transcript 中的本地路径**就地替换**成 `reunion://asset/<sha256>`（保留原始路径写到 sidecar `<image_files_meta>` 里以便调试）
- [ ] 上报 session 时附带 `referenced_assets`

#### `reunion-gitlab`

- [ ] `frontend/src/lib/asset.ts#assetUrl()` 增加 `reunion://asset/<sha>` 形态分支：team 模式下重写为 `<ingestBaseUrl>/api/v1/assets/<sha>`，鉴权 header 跟现有 ingest 调用一致
- [ ] 个人版不受影响：本地 transcript 仍然用绝对路径，走 `/api/asset`
- [ ] 前端图片缓存：浏览器自带的 `Cache-Control: immutable` 已经够用，sha 就是天然 etag

### 需要回答的问题

1. **历史数据兼容**：方案 C 上线之前 ingest 已经收到的会话，其 transcript 里仍是绝对路径。是否需要 collector 重新扫一遍补传？或者前端把 team 模式下命中本机的部分继续走 B 方案，命中 ingest 资源的走 C 方案，两条路径并存？
2. **跨用户隔离**：`/api/v1/assets/:sha` 是否应做权限校验（只有看过引用此 sha 的会话的用户才能下载）？sha 本身是 unguessable，但严谨点应该按 `referenced_assets` 串联做 ACL。MVP 可先跳过，文档里标注。
3. **图片体积上限**：是否拒绝过大的截图（>5MB）？collector 端先做硬上限避免误传。
4. **mime 嗅探**：collector 上传时已经能嗅探，可以把 mime 一起发给 ingest，减少 ingest 端 stat 开销；但 ingest 仍应做一次校验防止伪造。

## 备注

B 方案的实现见提交：`src/lib/asset.ts` 的 `cursorRootOnly` 选项 + `src/http-server.ts#handleAsset` 的 `isTeamMode()` 判断。team 模式下 `/api/asset` 现在能成功返回 cursor 缓存目录下的图片。
