# Tests

后端测试套件，跑通可作为重构（refactor）的安全网。基于 Node 内置的 `node:test`
+ `tsx` 加载器，**零额外依赖**。

## 运行

```bash
pnpm test          # 跑全部用例（spec reporter）
pnpm test --      # 透传额外参数到 node --test
```

## 布局

```
test/
  _env.ts                    # 测试入口：覆盖 REUNION_DATA_DIR / FRONTEND_DIST_DIR / LEGACY_STATIC_DIR
                             # 到独立 tmpdir。所有测试文件 import "_env.js" 必须放第一行。
  _helpers.ts                # mock req/res、fixture 构造器、fetch 包装、tmpdir 助手
  lib/*.test.ts              # src/lib/* 纯函数 / 安全边界
  sources/*.test.ts          # src/sources/* 各 Agent 适配器（基于 fixture jsonl）
  routes/*.test.ts           # src/routes/* + src/tasks.ts 路由层
  annotations.test.ts        # src/annotations.ts
  transcript.test.ts         # src/transcript.ts
  search.test.ts             # src/search.ts（在内存索引上运行）
  repo-target.test.ts        # src/repo-target.ts（含 cursor 项目目录解码）
  index-store.test.ts        # src/index-store.ts（含 buildIndex 真实 fs e2e）
  http-server.test.ts        # 端到端跑 runServe()，对真实 HTTP 接口断言
```

## 关键约定

- **隔离**：每个 `*.test.ts` 在独立子进程中跑（`node --test` 默认行为），所以
  `index-store` / `annotations` 这类有 module-level 缓存的模块不会跨文件污染。
- **DATA_DIR**：`_env.ts` 在 `import` 阶段就把 `REUNION_DATA_DIR` 指向了
  `/tmp/reunion-test-<pid>-...`，**任何 `src/...` 的 import 必须放在 `_env.js`
  之后**，否则 `src/config.ts` 会读到生产路径。
- **文件 fixture**：所有真实 fs 测试都在 `os.tmpdir()` 下创建临时目录，并在
  `after()` 钩子里清理。
- **HTTP e2e**：`test/http-server.test.ts` 起一个真实 `runServe()` 实例，端口
  随机重试，调用 `fetch()` 直击 API。新增/重构 HTTP 路由时优先在这里加用例。

## 不覆盖的范围（刻意）

- `src/ai/**` —— 涉及 spawn 外部 CLI（codex / cursor-agent）和真实网络请求。
  这部分只在端到端基本路径用 `mode=basic` 绕过 AI 跑了一次（`tasks.test.ts`
  里的 happy path 验证 `runExportTask` 不会因为 mode=basic 触发 AI）。
  如果需要测试 AI router，建议为 `runAi` 加一个 stub-able 注入点。
- 前端 React 组件 —— 不在本套件范围内。
