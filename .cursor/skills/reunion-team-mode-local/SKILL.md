---
name: reunion-team-mode-local
description: Spin up an end-to-end local stack for reunion-gitlab "team mode" — OrbStack/Docker MySQL 8.0 + ingest dev server + 5 seed fixtures + reunion serve — and run the layered automation suite (contract assertions via curl/jq + Playwright renderer E2E against headless Chromium) so the team-mode read path can be verified without touching production. Also wires the `ai_coding_collector` hook one-liner (`./install.sh --preset=local`) for a real Claude/Cursor → dev ingest data flow. Use when the user says they want to test/debug team mode, switch reunion to remote ingest, validate the multi-session aggregation API, run E2E or Playwright tests against reunion, smoke-test the GET /sessions or GET /repos contract, run fixtures through the real POST /sessions path, configure collector hooks against the local dev stack, simulate a collector → ingest → reunion flow on their Mac, or share the collector setup with a coworker. Triggers include "本地测试团队版", "测试 reunion 团队模式", "跑一遍 E2E", "Playwright 团队模式", "起一套 ingest 本地环境", "ingest dev server", "team mode 调试", "OrbStack mysql ingest", "reunion 团队模式跑不通", "dev-smoke.sh", "一键配置 collector", "collector preset", "install.sh --preset", "把 hook 配到本地".
---

# reunion 团队模式本地联调

把 `ai_coding_collector` / `ai_coding_ingest` / `reunion-gitlab` 三个仓库串起来，
在本机用 OrbStack 拉一份隔离的 MySQL，灌入 5 条 fixture，启动 ingest dev server
和 reunion 后端，然后切 reunion 到团队模式验证整条读路径。

整个流程**只读 / 完全本机**：与生产 RDS 无关，token 是 `local-test-token`，
端口默认 3306（MySQL）、8080（ingest）、9888（reunion）。

## 何时使用

- 用户在 reunion-gitlab 工作区让你"测试"或"调试"团队版／远端模式；
- 修改了 ingest 的读 API（`internal/handler/http.go` / `internal/store/query.go`）想冒烟验证；
- 修改了 reunion 的 `src/providers/{remote,mode-store}.ts` 想验证联调；
- 验证多版本 session 合并、cursor 缺 tool_result 的 banner 行为、capability gating；
- 给同事新机器搭测试环境。

不要为下面这些场景启用本 skill：

- 想读"已经存在"的本地 ai 会话（reunion 个人模式默认就能干，不需要 ingest）。
- 想验证 production ingest（`cmd/server` 依赖内网包，无法 host 直跑）。

## 仓库与端口

```
~/workspaces/ai_coding_ingest         ingest dev server :8080  + MySQL :3306 (容器)
~/workspaces/reunion-gitlab           reunion serve :9888 / Electron app
~/workspaces/ai_coding_collector      仅"用真实 collector 跑一段"才需要
```

如果用户的工作区路径不一样，先 `pwd` / `ls` 找出实际路径再代入。

> 线上团队 ingest URL 当前为 `https://chh7v1pv.sg-fn.bytedance.net`（公司内网 / VPN
> 才可达，token 服务端不校验）。本 skill 跑的是本机 :8080 的 dev 替代品。

> **常用快捷方式**：reunion-gitlab 自带 `pnpm dev` / `pnpm dev:down`（见
> `scripts/dev.sh`），把下面的"标准流程"压缩成两条命令，含 hook 切 local /
> 切回 prod。本 skill 的手工步骤适合你想精确控制单步 / 排查异常时使用。

## 标准流程

### 1. 起 MySQL

```bash
cd ai_coding_ingest
docker compose -f docker-compose.dev.yml up -d
```

等 healthcheck 变 healthy（5 秒级）：

```bash
for i in $(seq 1 12); do
  s=$(docker inspect --format='{{.State.Health.Status}}' reunion-ingest-mysql 2>/dev/null)
  echo "[$i] $s"; [[ "$s" == "healthy" ]] && break; sleep 3
done
```

### 2. 起 ingest dev server

```bash
go run ./cmd/server-dev/
```

后台跑（用 `block_until_ms: 0` 起来，再 await `listening`）。
启动成功 stdout 会包含 `ingest dev server listening :8080`。

**OrbStack 网络坑（一次性）：** 如果第一次 ping MySQL 报
`Access denied for user 'root'@'localhost'`，是 OrbStack 把宿主机连接的源 IP
解析成了容器内 localhost，撞 caching_sha2_password 协商。dev DSN 已经默认用
`reunion-ingest-mysql.orb.local`（容器 hostname → docker bridge gateway）规避；
若仍失败，可以一次性修：

```bash
docker exec reunion-ingest-mysql mysql -uroot -proot -e "
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'root';
ALTER USER 'root'@'%'         IDENTIFIED WITH mysql_native_password BY 'root';
FLUSH PRIVILEGES;"
```

### 3. 灌 fixture

```bash
./scripts/dev-seed.sh
```

期望最后一行是 `seeded=5 already=0 failed=0`。重复跑会得 `already=5`（409 容错）。

5 个 fixture 的设计意图：

| 文件 | session_id | 验证点 |
| --- | --- | --- |
| `01-...claude-1-v1.json` + `02-...claude-1-v2.json` | sess-claude-1 | 多版本 SUM 合并 → versionCount=2 |
| `03-...cursor-1.json` | sess-cursor-1 | aiClient=cursor，`agent_thought`，无 `tool_result` |
| `04-...claude-2.json` | sess-claude-2 | 不同 repo（验证 GET /repos 多 repo） |
| `05-...claude-3-long.json` | sess-claude-3 | 较长会话（42 events） |

### 4. 后端冒烟（curl）

```bash
TOKEN=local-test-token
curl -sS -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8080/sessions?from=2026-04-01T00:00:00Z&to=2026-05-30T00:00:00Z" \
  | jq '{returned: (.items|length), items: [.items[] | {sessionId, projectName, versionCount}]}'

curl -sS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8080/repos" | jq

curl -sS -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8080/sessions/sess-claude-1" \
  | jq '{versionCount, eventCount: (.events|length), totalDurationSec, inputTokens}'
```

期望:
- 返回 4 条会话（v1+v2 合并），`versionCount=2` 在 sess-claude-1 上；
- 2 个 repo（`reunion-gitlab.git` 和 `ai_coding_ingest.git`）；
- sess-claude-1 detail 里 events=11、totalDurationSec=3300、inputTokens=20000。

### 5. 起 reunion serve（仅 renderer 测试需要）

只跑 Electron e2e 时这一步**可以跳过**——electron 项目会自己 spawn
electron binary，用同进程内的 HTTP server。如果想做 contract smoke 或
renderer E2E，则继续。

```bash
cd ../reunion-gitlab
fnm use 20
REUNION_DATA_DIR=/tmp/reunion-team-test/data \
REUNION_TEAM_INGEST_URL=http://127.0.0.1:8080 \
REUNION_TEAM_INGEST_TOKEN=local-test-token \
  pnpm run serve --port 9888
```

要点：

- `REUNION_DATA_DIR` 隔离 dev 数据，避免覆盖已装 desktop app 的 `app-mode.json`。
- CLI（`pnpm run serve`）没法用 `app.isPackaged` 自动判断，所以这两个
  env 必传；不传会落到编译时占位符 `https://ingest.team-version.local` → 502。
- Electron dev 启动（`pnpm run electron`）则不需要这两个 env：
  `electron/bootstrap.cjs` 看 `app.isPackaged === false` 自动指本机 ingest。
- 端口 9888 经验上较空闲；占用时 `lsof -nP -iTCP:9888 -sTCP:LISTEN` 看占用方。

### 6. 切团队模式

```bash
curl -sS -X POST http://127.0.0.1:9888/api/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"team"}' \
  | jq
```

期望 `{"ok":true,"mode":"team","capabilities":{...全部 false},"team_config_present":true}`。

> POST body **只**接受 `{mode}`，不再传 `teamConfig`。reunion 会用进
> 程启动时的内置 baseUrl + token 做 trial fetch；502 通常意味着步骤 5
> 的两个 env 没传或者 ingest 没起。
>
> 旧版客户端如果还在传 `teamConfig` 字段会被静默忽略（向后兼容），不
> 会 400。

切回 personal:
```bash
curl -sS -X POST http://127.0.0.1:9888/api/mode \
  -H "Content-Type: application/json" -d '{"mode":"personal"}'
```

### 7. 验证 reunion 团队模式数据

```bash
# 列表（reunion 透传 ingest 聚合）
curl -sS "http://127.0.0.1:9888/api/search?limit=10" \
  | jq '[.results[] | {session_key, source, repo, session_id, provider}]'

# 注意：详情路由是 /api/session/{key}（单数），key 是 "team:<source>:<sessionId>"
curl -sS "http://127.0.0.1:9888/api/session/team%3Aclaude-code%3Asess-claude-1" \
  | jq '{event_count: (.events|length), metrics, hint}'
```

期望:
- 4 条结果，每条 `session_key` 以 `team:` 开头，`provider="remote"`；
- sess-claude-1 详情 11 个 events，`metrics.versionCount=2`。

### 8. 验证 capability gating

团队模式下写操作必须 403:

```bash
curl -sS -X DELETE -w "\n%{http_code}\n" \
  "http://127.0.0.1:9888/api/session/team%3Aclaude-code%3Asess-claude-1"
curl -sS -X POST -w "\n%{http_code}\n" http://127.0.0.1:9888/api/reindex
```

每条都应得 `403 {"ok":false,"error":"not supported in team mode","mode":"team"}`。

### 9. （可选）Electron UI

```bash
pnpm run electron
```

不需要任何 env：bootstrap.cjs 看 `app.isPackaged === false` 会自动注入
`REUNION_TEAM_INGEST_URL=http://127.0.0.1:8080` 和 `REUNION_TEAM_INGEST_TOKEN=local-test-token`。
进入后 sidebar 顶部有 `Personal/Team` 徽标按钮——**单击切换**，不再有
配置弹窗。详情页顶部应显示 SessionBanner（"team mode" 提示）。

> 用户已经在跑桌面 Reunion app 时，dev `pnpm run electron` 会因为同名
> single-instance lock 直接退出。要么先关掉旧 app，要么 pass
> `--user-data-dir=/tmp/reunion-dev-userdata`（playwright e2e 就是这么做的）。

## E2E 测试

走完上面 1-7 步后，本地栈已就绪。这时**不要靠手点验证**，跑三层自动化。
全套 ~50 秒，闭环验证后端契约 + UI 渲染 + Electron 启动路径。

### 层 1：契约断言（必跑，~1 秒）

```bash
cd ~/workspaces/ai_coding_ingest
./scripts/dev-smoke.sh
```

期望 `pass=21 fail=0 skip=0`。覆盖：

- ingest 直连：`GET /sessions` 4 条，sess-claude-1 versionCount=2，详情 events=11、totalDurationSec=3300、inputTokens=20000、promptCount=5；`/repos` 2 条；cursor 缺 tool_result；
- reunion 透传：mode=team、capabilities 全 false、search 4 条且 provider 全 remote、key 都带 `team:` 前缀、详情 events=11、metrics.versionCount=2；DELETE / POST reindex 都 403。

reunion 没起会自动 skip 那 12 条，只跑 ingest 直连的 9 条，**不会失败**。

### 层 2：renderer Playwright（~10 秒）

```bash
cd ~/workspaces/reunion-gitlab
./e2e/run.sh --project=renderer
```

驱动 headless Chromium 走真实 UI：

1. 团队 badge 渲染；
2. 列表 ≥ 3 条 reunion-gitlab 仓库的 session；
3. 点开一条，看到 SessionBanner 和 fixture 文本；
4. capability gating：reindex 按钮 / 已收藏 chip 在团队模式下 0 命中；
5. **sanity**：临时切个人模式，确认 reindex 按钮 selector 在那时确实能命中 1 个——避免"selector 写错了导致负向断言永远过"的假阳性。

不覆盖 Electron main 路径，所以接着跑层 3。

### 层 3：Electron-driven Playwright（~30 秒）

```bash
cd ~/workspaces/reunion-gitlab
pnpm run build           # 必须先 build 出 dist/electron/bootstrap.cjs
./e2e/run.sh --project=electron
```

启真实 Electron 二进制 + 独立 user-data-dir，**故意 scrub 掉 REUNION_TEAM_*
env**，复刻"用户从 Finder 双击 .app"的场景：

1. boot personal mode + 渲染 toggle；
2. 点 toggle 切团队，期望成功（这就是 2026-05-01 的 fix 验证：bootstrap.cjs
   按 `isPackaged=false` 自动注入了 dev ingest URL）；
3. 显式 export `REUNION_TEAM_INGEST_URL` 时，bootstrap.cjs 不覆盖（验证
   "shell 已注入则保留"的优先级）。

如果层 3 fail，可能原因：
- `dist/electron/bootstrap.cjs` 没 build（先 `pnpm run build`）；
- 用户已开了 `Reunion.app` 抢了 single-instance lock —— spec 里已经传
  `--user-data-dir` 隔离过，但确认 lock 取自 productName="Reunion"，可
  能仍冲突，必要时 `pkill -f "Reunion.app/Contents"`。

### 一把跑全套

```bash
cd ~/workspaces/reunion-gitlab
./e2e/run.sh --start         # 自动起 mysql + ingest + reunion serve + build
```

### 何时跑

- 改 `ai_coding_ingest/internal/{handler,store}/*.go` → 必须跑层 1；
- 改 `reunion-gitlab/src/providers/*.ts` 或 `src/http-server.ts` 路由 → 跑层 1+2；
- 改 `frontend/src/` 涉及团队模式 UI 的代码 → 跑层 1+2；
- 改 `electron/bootstrap.cjs` 或 `src/config.ts` 团队 env 解析逻辑 → 必须跑层 3；
- 准备发版或 PR review → 三层都跑。

## 排错

| 现象 | 原因 / 修法 |
| --- | --- |
| `Access denied for user 'root'@'localhost'` (启动 ingest) | OrbStack 网络。见步骤 2 的 ALTER USER。 |
| 413/500 灌 fixture | dev MySQL 还没初始化完 (`docker compose logs -f mysql` 等 "ready for connections")。 |
| reunion 切团队模式 401 | token 不匹配。检查 ingest 启动日志的 token 字段，以及 reunion 启动时的 `REUNION_TEAM_INGEST_TOKEN` env 是否一致。 |
| reunion 切团队模式 502，error 含 `ingest.team-version.local` | reunion 启动时没传 `REUNION_TEAM_INGEST_URL`，跑去打编译时占位符地址了。重启 reunion 时加上步骤 5 的两个 env。 |
| `/api/search` 返回 0 条 | `from`/`to` 默认最近 30 天；fixture 时间在 2026-04-30 附近，机器时钟若错乱会被滤掉。 |
| 9765 端口被占 | desktop app 在跑。换端口 9888 / 9876 / 9700 等，并 `lsof -nP -iTCP:<port>` 提前确认。 |
| `not found` on `/api/sessions/...` | reunion 路由是单数 `/api/session/{key}`，**不是** `/api/sessions/...`。 |

## 清理

```bash
# 仅停服务，保留数据下次复用
docker compose -f docker-compose.dev.yml down

# 彻底清掉（下次重灌 fixture）
docker compose -f docker-compose.dev.yml down -v
rm -rf /tmp/reunion-team-test
# 杀 dev server / reunion serve（看进程）
lsof -nP -iTCP:8080 -sTCP:LISTEN  # 找 server-dev pid
lsof -nP -iTCP:9888 -sTCP:LISTEN  # 找 node pid
```

## （可选）真 collector 数据

fixture 是构造的；想跑"真实采集"链路（hook → collector → dev ingest）的话，
collector 仓库的 `install.sh` 已经把整条路径压进了一个 preset：

```bash
cd ../ai_coding_collector
./install.sh --preset=local
```

`--preset=local` 等价于 `--api-endpoint=http://127.0.0.1:8080
--token=local-test-token --use-local-cli --enable`，会：

1. 拷贝 hook 脚本到 `~/.{claude,cursor}/hooks_script/`；
2. jq 合并 `~/.claude/settings.json` + `~/.cursor/hooks.json`（已有条目保留，
   `.bak.<时间戳>` 备份）；
3. 跑 `npm install && npm run build`，把 `debug.collectorCliPath` 写成
   `…/ai_coding_collector/dist/cli.js`，让 hook 跑工作区里的源码而不是 bnpm
   上的 `@lemon8/ai_coding_collector`；
4. 用配好的 token 打 `GET /repos`，期望 200。

> ⚠️ 同台机器上 `apiEndpoint` 是单值——collector **不会同时双写到本地和生产
> ingest**。要切回生产采集，重跑 `./install.sh --preset=prod --token=<TEAM>`
> 即可（同样原地合并、备份）。

装完重启 Claude Code / Cursor，跑一段对话，hook 自动 POST 到 dev server；
reunion 团队模式刷新即可看到新 session（`provider="remote"` + `team:` 前缀）。

调试日志:
```bash
tail -f ~/.claude/analytics/logs/*.log
tail -f ~/.cursor/analytics/logs/*.log
docker exec reunion-ingest-mysql mysql -uroot -proot ingest -e "
SELECT id, session_id, ai_client, jsonl_line_version, prompt_count, created_at
FROM client_ai_track ORDER BY id DESC LIMIT 10;"
```

`apiEndpoint` 字段被用户手工改过的话，重跑 `install.sh` 也只会按 CLI 传入的
字段做字段级 merge——`layers` / `extraHeaders` / `conversationMaxEvents` 等
其他自定义字段不会丢。

## 团队连接策略（本地 vs 生产）

reunion 不再让用户输入 baseUrl + token；分四个场景：

| 场景 | 解析顺序 |
| --- | --- |
| 生产 `.dmg` 双击 | `src/config.ts` 编译时 `PROD_INGEST_URL` / `PROD_INGEST_TOKEN` 直接生效（launchd env 没有 `REUNION_TEAM_*`，bootstrap.cjs 看 `isPackaged=true` 不注入）。 |
| dev `pnpm run electron` | `electron/bootstrap.cjs` 看 `isPackaged=false` 自动注入 `REUNION_TEAM_INGEST_URL=http://127.0.0.1:8080` + `REUNION_TEAM_INGEST_TOKEN=local-test-token`。 |
| dev `pnpm run serve`（CLI） | bootstrap.cjs 不参与，必须手动 export 这两个 env，否则落到生产占位符 502。 |
| dev shell 已 export 这两个 env | bootstrap.cjs 用 `||` 短路，保留 shell 值不覆盖（适合指 staging）。 |

持久化：只剩 `data/app-mode.json` 记录 toggle 当前位置（personal / team）。
旧版残留的 `data/team-config.json` 留在原地不读。

trial fetch 流程：用户点切团队 → 后端用进程启动时解析的 baseUrl + token
打 `GET /repos`，成功才把 `app-mode.json` 改成 team。失败 401/502 不持
久化，下一次启动还是 personal。

## 实现细节速查

完整文档见仓库内：

- `ai_coding_ingest/docs/dev.md`
- `ai_coding_ingest/docs/contract.md`（读 API 字段语义）
- `reunion-gitlab/docs/dev-team-mode.md`

新增/相关文件:

- `ai_coding_ingest/cmd/server-dev/main.go` — dev 入口
- `ai_coding_ingest/docker-compose.dev.yml` — MySQL 8.0
- `ai_coding_ingest/sql/dev-init/01_schema.sql` — 建表 + 索引
- `ai_coding_ingest/scripts/fixtures/*.json` — 5 条样本
- `ai_coding_ingest/scripts/dev-seed.sh` — 灌入脚本
- `reunion-gitlab/src/config.ts` — `TEAM_INGEST_URL` / `TEAM_INGEST_TOKEN`（编译时常量 + env override）
- `reunion-gitlab/electron/bootstrap.cjs` — `isPackaged=false` 时自动注入 dev ingest env
- `reunion-gitlab/src/providers/mode-store.ts` — applyMode 持久化
- `reunion-gitlab/src/providers/remote.ts` — 远端 provider
- `reunion-gitlab/src/providers/remote-mapper.ts` — events → TimelineEvent
- `reunion-gitlab/frontend/src/components/mode/ModeSwitcher.tsx` — 单击 toggle，无弹窗
- `reunion-gitlab/e2e/electron-app.spec.ts` — Electron-driven 验证 bootstrap.cjs 自动注入
