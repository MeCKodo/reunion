# 团队模式本地联调

reunion 默认从本机 Cursor / Claude Code / Codex 文件读取（个人模式）。团队模式
切换为远端 ingest API。本文档描述如何在本机搭一套环境，验证团队模式的
列表、详情、capability gating 行为。

---

## 前置：起一个本地 ingest

参见 [`../../ai_coding_ingest/docs/dev.md`](../../ai_coding_ingest/docs/dev.md)，
跑通到 `./scripts/dev-seed.sh` 输出 `seeded=5`。

---

## 启动 reunion serve / Electron

团队模式的 `baseUrl` + `token` 不再让用户手填，按运行环境分多条路径：

| 场景 | baseUrl / token 来源 |
| --- | --- |
| 生产团队版 `.dmg` 双击 (`isPackaged=true`, `REUNION_EDITION=team`) | `scripts/build-electron.mjs` 在打包时通过 `REUNION_BUILD_INGEST_URL` / `REUNION_BUILD_INGEST_TOKEN` 经 esbuild `define` 注入到 bundle。线上真实 URL 当前为 `https://chh7v1pv.sg-fn.bytedance.net`（token 服务端不校验）|
| 生产个人版 `.dmg` 双击 (`REUNION_EDITION=personal`) | bundle 里 token 为空字符串；后端 `/api/mode` 直接 403 拒绝切团队 |
| dev `pnpm run electron`（`isPackaged=false`） | `electron/bootstrap.cjs` 自动注入 `http://127.0.0.1:8080` + `local-test-token`，**无需手动 export** |
| dev `pnpm run serve`（CLI，没 Electron） | 必须显式 export `REUNION_TEAM_INGEST_URL` / `REUNION_TEAM_INGEST_TOKEN`；同时如果只想测个人版 UI，可 `REUNION_EDITION=personal pnpm run serve` |
| dev shell 已 export 这两个 env | 始终保留 shell 值，bootstrap.cjs 不会覆盖（用于指向 staging） |

> 默认所有 `pnpm run serve` / `pnpm test` 走 `team` edition（保留团队功能可达）；
> 如需在 dev 下验证个人版隐藏 UI 的行为，加 `REUNION_EDITION=personal`。

### Electron 调试

```bash
fnm use 20
pnpm run build && electron .          # 等价于 pnpm run electron
```

bootstrap.cjs 会自动判断 `app.isPackaged` 决定连本地还是生产，所以双击
启动也好、Spotlight 也好都能直接点切团队。**这是 2026-05-01 fix 的重点**——
之前 Finder 启动的 Electron 因为 launchd 不继承 shell env，会落回 https
占位符并报 "fetch failed"。

### CLI（仅 reunion serve、无 Electron 主进程）

```bash
fnm use 20
REUNION_DATA_DIR=/tmp/reunion-team-test/data \
REUNION_TEAM_INGEST_URL=http://127.0.0.1:8080 \
REUNION_TEAM_INGEST_TOKEN=local-test-token \
  pnpm run serve --port 9888
```

CLI 没法用 `app.isPackaged` 自动判断，所以这两个 env 仍然必传，否则切团
队会去打 `https://ingest.team-version.local`（占位符）502。

`REUNION_DATA_DIR` 隔离 dev 数据，避免覆盖本机已安装 desktop app
(`~/Library/Application Support/Reunion/...`) 的 `app-mode.json` / 个人版索引。

启动成功打印：

```
reunion running: http://127.0.0.1:9888
mode:        personal
source roots:
  cursor:      /Users/.../.cursor/projects
  ...
```

---

## 切换到团队模式

```bash
curl -sS -X POST http://127.0.0.1:9888/api/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"team"}' \
  | jq
```

`ok=true, mode=team` 表示已切换。后端会用进程启动时的内置 baseUrl + token
做一次 trial `GET /repos`，失败 502 不持久化。

> POST body 只需要 `{mode}`，不再接受 `teamConfig`。旧版客户端如果还在传
> `teamConfig` 会被静默忽略（向后兼容）。

切换成功后：

```bash
# 列表（来自 ingest 聚合）
curl -sS "http://127.0.0.1:9888/api/search?limit=10" \
  | jq '[.results[] | {session_key, source, repo, session_id, provider}]'

# 详情（multi-version 已合并）
curl -sS "http://127.0.0.1:9888/api/session/team%3Aclaude-code%3Asess-claude-1" \
  | jq '{session_id, source, provider, event_count: (.events|length), metrics, hint}'
```

`session_key` 在团队模式下都带 `team:` 前缀，避免与本地 `<source>:<repo>:<sessionId>`
键冲突。

切回个人模式：

```bash
curl -sS -X POST http://127.0.0.1:9888/api/mode \
  -H "Content-Type: application/json" -d '{"mode":"personal"}'
```

---

## 验证 capability gating

团队模式禁掉所有写操作（标注、删除、reindex、AI 标签等）。

```bash
# 应返回 403
curl -sS -X DELETE \
  "http://127.0.0.1:9888/api/session/team%3Aclaude-code%3Asess-claude-1" -w "\n%{http_code}\n"

curl -sS -X POST http://127.0.0.1:9888/api/reindex -w "\n%{http_code}\n"
```

期望:
```
{"ok":false,"error":"not supported in team mode","mode":"team"}
403
```

---

## 用 Electron 桌面端测试

```bash
pnpm run electron
```

bootstrap.cjs 会自动指向本机 ingest:8080，所以 dev 双击不需要任何 env。
进入 app 后，左上角 sidebar header 的徽标按钮（`Personal` / `Team`）
是单击切换：点一下就走 trial 切团队，再点一下回个人。**不再有配置弹窗**。
详情页顶部会出现 SessionBanner 表示当前数据来源。

---

## 持久化文件

`/tmp/reunion-team-test/data/` 下：

```
app-mode.json         {"mode":"team"}                        # 仅记录 toggle
team-config.json      旧版残留，新版本不读                   # 可手工删
chat_index.json       仅个人模式构建/使用
annotations.json      仅个人模式
```

新版本不再写 `team-config.json`，团队连接信息（baseUrl + token）一律来
自进程 env / 编译时常量。已升级用户的旧 `team-config.json` 留在原地不
影响行为，也可手动删。

---

## 后端冒烟全脚本

```bash
set -e
cd ../ai_coding_ingest
docker compose -f docker-compose.dev.yml up -d
sleep 5
go run ./cmd/server-dev/ &  # 或开新终端
INGEST_PID=$!
sleep 4
./scripts/dev-seed.sh
cd ../reunion-gitlab
REUNION_DATA_DIR=/tmp/reunion-team-test/data \
REUNION_TEAM_INGEST_URL=http://127.0.0.1:8080 \
REUNION_TEAM_INGEST_TOKEN=local-test-token \
  pnpm run serve --port 9888 &
SERVE_PID=$!
sleep 4
curl -sS -X POST http://127.0.0.1:9888/api/mode \
  -H 'Content-Type: application/json' \
  -d '{"mode":"team"}' \
  | jq
curl -sS "http://127.0.0.1:9888/api/search?limit=10" \
  | jq '[.results[] | {session_key, repo, session_id, source}]'
kill $SERVE_PID $INGEST_PID
```

---

## 自动化验证

三层互补的自动化，跑前先把上面的 dev 栈起好：

```bash
# 层 1：契约断言（~1 秒，覆盖 ingest 直连 + reunion 透传）
cd ../ai_coding_ingest && ./scripts/dev-smoke.sh

# 层 2+3：Playwright renderer + Electron E2E（~50 秒）
cd ../reunion-gitlab && ./e2e/run.sh
```

`./e2e/run.sh` 默认两层都跑：

- **renderer 项目**（5 测试，~10 秒）：headless Chromium 直连 `pnpm run serve` :9888，验证 UI 流程 + capability gating。
- **electron 项目**（3 测试，~30 秒）：Playwright 启真实 Electron 二进制（`dist/electron/bootstrap.cjs`），用一份**清掉 `REUNION_TEAM_*` env** 的环境跑，等于复刻"用户从 Finder 双击 .app"的场景。验证 bootstrap.cjs 的 `isPackaged` 自动注入路径，包括"shell 已 export 时不被覆盖"。

参数：

```bash
./e2e/run.sh                          # 两个项目都跑
./e2e/run.sh --start                  # 起整套栈（mysql + ingest + reunion serve + build）
./e2e/run.sh --project=renderer       # 仅 renderer
./e2e/run.sh --project=electron       # 仅 electron（不需要 reunion serve）
./e2e/run.sh --headed                 # 看浏览器
./e2e/run.sh team-mode.spec.ts:42     # 过滤
```

具体覆盖范围见 [`../e2e/team-mode.spec.ts`](../e2e/team-mode.spec.ts)、
[`../e2e/electron-app.spec.ts`](../e2e/electron-app.spec.ts) 和
[`../../ai_coding_ingest/scripts/dev-smoke.sh`](../../ai_coding_ingest/scripts/dev-smoke.sh)。

> Electron 项目跑的时候会 launch 真实 Electron 二进制 + 用独立 user-data-dir，
> 所以**不会**和你已有的桌面 Reunion app 抢 single-instance lock。

## 已知限制

- 团队模式当前没有 sessionId 跨页面深链。
- `truncated`/`sampled` banner 在 fixture 里不会触发，需要手工 INSERT >10000 条 row 才会出现，详见 ingest 文档。
- `missing_tool_results` banner 当前由 reunion 前端基于 `aiClient === 'cursor'` 推断，未挂在 hint 字段上。
