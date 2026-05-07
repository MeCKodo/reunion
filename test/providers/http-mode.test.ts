// End-to-end coverage for /api/mode, plus capability-based 403s in team mode.
// Spins up a real http-server with empty source roots so the personal-mode
// pipeline still boots cleanly even though there are no transcripts to read.
import "../_env.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { runServe, type ServerHandle, __testing__ } from "../../src/http-server.js";
import { fetchJson, mkTmpDir, rmDir } from "../_helpers.js";
import type { SourceRoots } from "../../src/types.js";
import { LocalDataProvider } from "../../src/providers/local.js";
import { RemoteDataProvider } from "../../src/providers/remote.js";
import type {
  DataSourceProvider,
  ProviderListFilter,
  RepoSummary,
  SessionListResult,
} from "../../src/providers/types.js";

let baseUrl = "";
let handle: ServerHandle | null = null;
let scratch = "";
let roots: SourceRoots;

async function startServer(): Promise<{ handle: ServerHandle; baseUrl: string }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = 31000 + Math.floor(Math.random() * 10000);
    try {
      const h = await runServe("127.0.0.1", port, roots);
      return { handle: h, baseUrl: `http://127.0.0.1:${port}` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
      throw err;
    }
  }
  throw new Error("could not allocate a port");
}

before(async () => {
  scratch = mkTmpDir("reunion-mode");
  roots = {
    cursor: path.join(scratch, "cursor"),
    claudeCode: path.join(scratch, "claude"),
    codex: path.join(scratch, "codex"),
  };
  await fsp.mkdir(roots.cursor, { recursive: true });
  await fsp.mkdir(roots.claudeCode, { recursive: true });
  await fsp.mkdir(roots.codex, { recursive: true });

  const started = await startServer();
  handle = started.handle;
  baseUrl = started.baseUrl;
});

after(async () => {
  if (handle) await handle.close();
  await rmDir(scratch);
});

describe("/api/mode (GET)", () => {
  it("reports personal mode by default with all capabilities enabled", async () => {
    const { status, body } = await fetchJson<{
      ok: boolean;
      mode: string;
      capabilities: Record<string, boolean>;
      team_config_present: boolean;
    }>(baseUrl, "/api/mode");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.mode, "personal");
    assert.equal(body.capabilities.deleteSession, true);
    assert.equal(body.capabilities.fullTextSearch, true);
    assert.equal(body.capabilities.openLocalFile, true);
  });
});

describe("/api/mode (POST) — input validation", () => {
  it("rejects unknown mode strings", async () => {
    const { status, body } = await fetchJson<{ ok: boolean; error: string }>(
      baseUrl,
      "/api/mode",
      { method: "POST", body: { mode: "yolo" } }
    );
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /mode/);
  });

  it("ignores teamConfig from old clients (forward-compat)", async () => {
    // Pre-built-wiring clients used to send {mode:"team", teamConfig:{...}}.
    // The body's extra field must not 400; it just gets dropped. We assert
    // the request fails 502 (ingest unreachable in tests, see _env.ts) — the
    // important thing is that we got *past* the body parser and into the
    // applyMode trial path.
    const { status } = await fetchJson<unknown>(baseUrl, "/api/mode", {
      method: "POST",
      body: {
        mode: "team",
        teamConfig: { baseUrl: "ignored", token: "ignored" },
      },
    });
    assert.equal(status, 502);
  });

  it("team-mode flip returns 502 when ingest is unreachable", async () => {
    // _env.ts pinned REUNION_TEAM_INGEST_URL to a deliberately-unbound port
    // so the trial fetch refuses connection.
    const { status, body } = await fetchJson<{ ok: boolean; error: string }>(
      baseUrl,
      "/api/mode",
      { method: "POST", body: { mode: "team" } }
    );
    assert.equal(status, 502);
    assert.equal(body.ok, false);
  });
});

describe("team mode — capability-gated routes return 403", () => {
  before(() => {
    // Inject a fake remote provider so we can exercise dispatch without a
    // real ingest server. The fake never gets called for these routes
    // because they short-circuit on `rejectIfTeamMode`.
    __testing__.setActiveState({
      mode: "team",
      provider: new RemoteDataProvider({
        baseUrl: "https://ingest.example.com",
        token: "secret",
        fetchFn: (() => {
          throw new Error("should not be called");
        }) as typeof fetch,
      }),
      teamConfigPresent: true,
    });
  });

  after(() => {
    // Restore personal mode for any later test files / shared state.
    __testing__.setActiveState({
      mode: "personal",
      provider: new LocalDataProvider(roots),
      teamConfigPresent: false,
    });
  });

  it("DELETE /api/session/:key returns 403", async () => {
    const { status, body } = await fetchJson<{ ok: boolean; error: string }>(
      baseUrl,
      "/api/session/team:cursor:abc",
      { method: "DELETE" }
    );
    assert.equal(status, 403);
    assert.equal(body.ok, false);
    assert.match(body.error, /team mode/);
  });

  it("POST /api/reindex returns 403", async () => {
    const { status, body } = await fetchJson<{ ok: boolean }>(baseUrl, "/api/reindex", {
      method: "POST",
    });
    assert.equal(status, 403);
    assert.equal(body.ok, false);
  });

  it("GET /api/annotations returns 403", async () => {
    const { status, body } = await fetchJson<{ ok: boolean }>(baseUrl, "/api/annotations");
    assert.equal(status, 403);
    assert.equal(body.ok, false);
  });

  it("GET /api/asset returns 403", async () => {
    const { status, body } = await fetchJson<{ ok: boolean }>(
      baseUrl,
      "/api/asset?path=/tmp/foo.png"
    );
    assert.equal(status, 403);
    assert.equal(body.ok, false);
  });

  it("GET /api/mode reports team mode with conservative capabilities", async () => {
    const { status, body } = await fetchJson<{
      ok: boolean;
      mode: string;
      capabilities: Record<string, boolean>;
    }>(baseUrl, "/api/mode");
    assert.equal(status, 200);
    assert.equal(body.mode, "team");
    assert.equal(body.capabilities.deleteSession, false);
    assert.equal(body.capabilities.fullTextSearch, false);
    assert.equal(body.capabilities.annotations, false);
  });
});

describe("clientTag query parameter — http-server forwards ?tag= to provider", () => {
  // Spy provider records every filter it sees so we can assert exactly what
  // the route handler decoded. We use a plain object literal cast to the
  // provider interface (rather than mocking RemoteDataProvider) so the
  // assertions stay focused on the http-server -> provider boundary.
  type Capture = {
    listFilters: ProviderListFilter[];
    searchFilters: ProviderListFilter[];
    repoFilters: Array<Pick<ProviderListFilter, "clientTag"> | undefined>;
  };
  let capture: Capture;
  let spyProvider: DataSourceProvider;

  before(() => {
    capture = { listFilters: [], searchFilters: [], repoFilters: [] };
    const empty: SessionListResult = { count: 0, results: [] };
    spyProvider = {
      mode: "team",
      capabilities: {
        annotations: false,
        aiTagging: false,
        smartExport: false,
        deleteSession: false,
        downloadJsonl: false,
        openLocalFile: false,
        subagents: false,
        fullTranscript: true,
        fullTextSearch: false,
      },
      async listSessions(filter) {
        capture.listFilters.push(filter);
        return empty;
      },
      async searchSessions(filter) {
        capture.searchFilters.push(filter);
        return empty;
      },
      async getSessionDetail() {
        return null;
      },
      async listRepos(filter): Promise<RepoSummary[]> {
        capture.repoFilters.push(filter);
        return [];
      },
    };
    __testing__.setActiveState({
      mode: "team",
      provider: spyProvider,
      teamConfigPresent: true,
    });
  });

  after(() => {
    __testing__.setActiveState({
      mode: "personal",
      provider: new LocalDataProvider(roots),
      teamConfigPresent: false,
    });
  });

  it("GET /api/search?tag=server hands clientTag down into searchSessions", async () => {
    const { status } = await fetchJson<unknown>(
      baseUrl,
      "/api/search?q=&tag=server"
    );
    assert.equal(status, 200);
    const last = capture.searchFilters.at(-1);
    assert.ok(last, "search handler never reached the provider");
    assert.equal(last!.clientTag, "server");
  });

  it("GET /api/search without tag leaves clientTag undefined (does not coerce to '')", async () => {
    const { status } = await fetchJson<unknown>(baseUrl, "/api/search?q=");
    assert.equal(status, 200);
    const last = capture.searchFilters.at(-1);
    assert.ok(last);
    assert.equal(last!.clientTag, undefined);
  });

  it("GET /api/search?tag=__none__ passes the untagged sentinel through", async () => {
    const { status } = await fetchJson<unknown>(
      baseUrl,
      "/api/search?q=&tag=__none__"
    );
    assert.equal(status, 200);
    const last = capture.searchFilters.at(-1);
    assert.ok(last);
    assert.equal(last!.clientTag, "__none__");
  });

  it("GET /api/repos?tag=client narrows the project picker", async () => {
    const { status } = await fetchJson<unknown>(baseUrl, "/api/repos?tag=client");
    assert.equal(status, 200);
    const last = capture.repoFilters.at(-1);
    assert.ok(last, "repos handler never reached the provider");
    assert.equal(last!.clientTag, "client");
  });

  it("GET /api/repos without tag still calls listRepos (with empty filter)", async () => {
    const { status } = await fetchJson<unknown>(baseUrl, "/api/repos");
    assert.equal(status, 200);
    const last = capture.repoFilters.at(-1);
    // We currently always pass a filter object; assert clientTag is at least
    // empty/undefined rather than a literal string.
    assert.ok(last);
    assert.ok(last!.clientTag === undefined || last!.clientTag === "");
  });
});
