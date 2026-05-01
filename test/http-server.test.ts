import "./_env.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { runServe, type ServerHandle } from "../src/http-server.js";
import type { SourceRoots } from "../src/types.js";
import { fetchJson, fetchRaw, mkTmpDir, rmDir } from "./_helpers.js";

interface ServerCtx {
  baseUrl: string;
  handle: ServerHandle;
  roots: SourceRoots;
  cleanup: () => Promise<void>;
}

interface Fixture {
  cursorTxtKey: string;
  cursorJsonlKey: string;
  claudeKey: string;
  codexKey: string;
}

async function buildFixture(): Promise<{
  roots: SourceRoots;
  fixture: Fixture;
  cleanup: () => Promise<void>;
}> {
  const scratch = mkTmpDir("reunion-http");
  const cursorRoot = path.join(scratch, "cursor");
  const claudeRoot = path.join(scratch, "claude");
  const codexRoot = path.join(scratch, "codex");

  // -------------------------------------------------------------------------
  // Cursor — both layouts
  // -------------------------------------------------------------------------
  const cursorProj = path.join(cursorRoot, "demo-project", "agent-transcripts");
  await fsp.mkdir(cursorProj, { recursive: true });
  const cursorTxt = path.join(cursorProj, "sess-cursor-old.txt");
  await fsp.writeFile(
    cursorTxt,
    "user:\nplan refactor\n\nassistant:\nbreak it into 3 steps"
  );

  const cursorJsonlDir = path.join(cursorProj, "sess-cursor-new");
  await fsp.mkdir(cursorJsonlDir, { recursive: true });
  const cursorJsonl = path.join(cursorJsonlDir, "sess-cursor-new.jsonl");
  await fsp.writeFile(
    cursorJsonl,
    [
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "build authentication" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "use middleware" }] },
      }),
    ].join("\n")
  );

  // -------------------------------------------------------------------------
  // Claude Code
  // -------------------------------------------------------------------------
  const claudeProj = path.join(claudeRoot, "claude-proj");
  await fsp.mkdir(claudeProj, { recursive: true });
  const claudeFile = path.join(claudeProj, "sess-claude.jsonl");
  await fsp.writeFile(
    claudeFile,
    [
      JSON.stringify({
        type: "user",
        cwd: "/Users/test/repos/my-app",
        message: { role: "user", content: [{ type: "text", text: "ask claude refactor" }] },
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "assistant",
        cwd: "/Users/test/repos/my-app",
        message: { role: "assistant", content: [{ type: "text", text: "claude reply" }] },
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
    ].join("\n")
  );

  // -------------------------------------------------------------------------
  // Codex
  // -------------------------------------------------------------------------
  const codexDay = path.join(codexRoot, "2026", "05", "01");
  await fsp.mkdir(codexDay, { recursive: true });
  const codexFile = path.join(codexDay, "sess-codex.jsonl");
  await fsp.writeFile(
    codexFile,
    [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-05-01T10:00:00.000Z",
        payload: {
          id: "sess-codex",
          cwd: "/Users/test/repos/codex-proj",
          timestamp: "2026-05-01T10:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-01T10:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "text", text: "codex first task" }],
        },
      }),
    ].join("\n")
  );

  // -------------------------------------------------------------------------
  // Asset fixture (image inside cursor root) for /api/asset
  // -------------------------------------------------------------------------
  const tinyPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9V4mF6kAAAAASUVORK5CYII=";
  await fsp.writeFile(
    path.join(cursorRoot, "demo-project", "tiny.png"),
    Buffer.from(tinyPngBase64, "base64")
  );

  const fixture: Fixture = {
    cursorTxtKey: "cursor:demo-project:sess-cursor-old",
    cursorJsonlKey: "cursor:demo-project:sess-cursor-new",
    claudeKey: "claude-code:my-app:sess-claude",
    codexKey: "codex:codex-proj:sess-codex",
  };

  return {
    roots: { cursor: cursorRoot, claudeCode: claudeRoot, codex: codexRoot },
    fixture,
    cleanup: () => rmDir(scratch),
  };
}

async function startServer(roots: SourceRoots): Promise<{
  handle: ServerHandle;
  baseUrl: string;
}> {
  // port=0 lets the OS pick a free one — but our runServe takes a numeric
  // port directly. We retry on EADDRINUSE; cheap and good enough for tests.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = 30000 + Math.floor(Math.random() * 10000);
    try {
      const handle = await runServe("127.0.0.1", port, roots);
      return { handle, baseUrl: `http://127.0.0.1:${port}` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
      throw err;
    }
  }
  throw new Error("could not allocate a free test port after 5 attempts");
}

let ctx: ServerCtx;
let fixture: Fixture;

before(async () => {
  const built = await buildFixture();
  fixture = built.fixture;
  const { handle, baseUrl } = await startServer(built.roots);
  ctx = {
    baseUrl,
    handle,
    roots: built.roots,
    cleanup: built.cleanup,
  };
});

after(async () => {
  await ctx.handle.close();
  await ctx.cleanup();
});

describe("http-server: GET /api/repos", () => {
  it("returns one row per (source, repo) bucket present in the index", async () => {
    const { status, body } = await fetchJson<{
      repos: Array<{ source: string; repo: string; session_count: number }>;
    }>(ctx.baseUrl, "/api/repos");
    assert.equal(status, 200);
    const repos = body.repos;
    const cursorDemo = repos.find(
      (r) => r.source === "cursor" && r.repo === "demo-project"
    );
    assert.ok(cursorDemo, `expected cursor:demo-project in repos: ${JSON.stringify(repos)}`);
    assert.equal(cursorDemo.session_count, 2);
    assert.ok(repos.find((r) => r.source === "claude-code" && r.repo === "my-app"));
    assert.ok(repos.find((r) => r.source === "codex" && r.repo === "codex-proj"));
  });
});

describe("http-server: GET /api/sources", () => {
  it("returns one row per known source id", async () => {
    const { status, body } = await fetchJson<{
      sources: Array<{ id: string; session_count: number }>;
    }>(ctx.baseUrl, "/api/sources");
    assert.equal(status, 200);
    const ids = body.sources.map((s) => s.id);
    assert.deepEqual(ids, ["cursor", "claude-code", "codex"]);
    const cursor = body.sources.find((s) => s.id === "cursor")!;
    assert.equal(cursor.session_count, 2);
  });
});

describe("http-server: GET /api/search", () => {
  it("returns all sessions when query is blank, respecting limit", async () => {
    const { status, body } = await fetchJson<{
      count: number;
      results: Array<{ session_key: string }>;
    }>(ctx.baseUrl, "/api/search?limit=10");
    assert.equal(status, 200);
    assert.ok(body.count >= 4);
  });

  it("filters by query token (matches refactor across sources)", async () => {
    const { status, body } = await fetchJson<{
      count: number;
      results: Array<{ session_key: string; match_count: number }>;
    }>(ctx.baseUrl, "/api/search?q=refactor");
    assert.equal(status, 200);
    const keys = body.results.map((r) => r.session_key);
    assert.ok(keys.includes(fixture.cursorTxtKey));
    assert.ok(keys.includes(fixture.claudeKey));
  });

  it("filters by source", async () => {
    const { status, body } = await fetchJson<{
      results: Array<{ session_key: string; source: string }>;
    }>(ctx.baseUrl, "/api/search?source=codex");
    assert.equal(status, 200);
    for (const item of body.results) {
      assert.equal(item.source, "codex");
    }
  });

  it("filters by repo", async () => {
    const { status, body } = await fetchJson<{
      results: Array<{ repo: string }>;
    }>(ctx.baseUrl, "/api/search?repo=demo-project");
    assert.equal(status, 200);
    for (const item of body.results) assert.equal(item.repo, "demo-project");
  });
});

describe("http-server: GET /api/session/:sessionKey", () => {
  it("returns the detailed session payload for a known cursor session", async () => {
    const { status, body } = await fetchJson<{
      session_key: string;
      events: Array<{ kind: string; text: string }>;
      content: string;
    }>(
      ctx.baseUrl,
      `/api/session/${encodeURIComponent(fixture.cursorJsonlKey)}`
    );
    assert.equal(status, 200);
    assert.equal(body.session_key, fixture.cursorJsonlKey);
    assert.ok(body.events.length >= 2);
    assert.match(body.content, /authentication/);
  });

  it("404s on unknown sessionKey", async () => {
    const { status, body } = await fetchJson<{ error: string }>(
      ctx.baseUrl,
      "/api/session/cursor:does-not-exist:nope"
    );
    assert.equal(status, 404);
    assert.match(body.error, /not found/);
  });
});

describe("http-server: GET /api/session/:sessionKey/jsonl", () => {
  it("streams the raw jsonl with a download disposition", async () => {
    const { status, text, headers } = await fetchRaw(
      ctx.baseUrl,
      `/api/session/${encodeURIComponent(fixture.cursorJsonlKey)}/jsonl`
    );
    assert.equal(status, 200);
    assert.equal(headers["content-type"], "application/x-ndjson; charset=utf-8");
    assert.match(headers["content-disposition"] || "", /attachment/);
    assert.match(text, /authentication/);
  });

  it("415 when the underlying file is not a jsonl (txt session)", async () => {
    const { status, body } = await fetchJson<{ error: string }>(
      ctx.baseUrl,
      `/api/session/${encodeURIComponent(fixture.cursorTxtKey)}/jsonl`
    );
    assert.equal(status, 415);
  });
});

describe("http-server: GET /api/asset", () => {
  it("rejects missing path with 400", async () => {
    const { status } = await fetchJson(ctx.baseUrl, "/api/asset");
    assert.equal(status, 400);
  });
  it("rejects non-image extensions with 415", async () => {
    const target = path.join(ctx.roots.cursor, "demo-project", "agent-transcripts", "sess-cursor-old.txt");
    const { status } = await fetchJson(
      ctx.baseUrl,
      `/api/asset?path=${encodeURIComponent(target)}`
    );
    assert.equal(status, 415);
  });
  it("rejects paths outside any allowed root with 403", async () => {
    const { status } = await fetchJson(ctx.baseUrl, "/api/asset?path=/tmp/anywhere/x.png");
    assert.equal(status, 403);
  });
  it("streams a real png that lives inside the cursor root", async () => {
    const target = path.join(ctx.roots.cursor, "demo-project", "tiny.png");
    const { status, headers } = await fetchRaw(
      ctx.baseUrl,
      `/api/asset?path=${encodeURIComponent(target)}`
    );
    assert.equal(status, 200);
    assert.equal(headers["content-type"], "image/png");
    assert.match(headers["cache-control"] || "", /max-age/);
  });
});

describe("http-server: GET /api/fs/list", () => {
  it("returns a directory listing for the user's home by default", async () => {
    const { status, body } = await fetchJson<{
      ok: boolean;
      path: string;
      entries: unknown[];
      bookmarks: { home: string };
    }>(ctx.baseUrl, "/api/fs/list");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.entries));
    assert.ok(typeof body.bookmarks.home === "string");
  });
});

describe("http-server: annotations CRUD", () => {
  it("starts with no annotations + empty tag summary", async () => {
    const { status, body } = await fetchJson<{
      annotations: Record<string, unknown>;
      tags: unknown[];
    }>(ctx.baseUrl, "/api/annotations");
    assert.equal(status, 200);
    assert.deepEqual(body.tags, []);
  });

  it("PUT creates a new annotation; subsequent GET surfaces it + tag summary", async () => {
    const { status: putStatus, body: putBody } = await fetchJson<{
      ok: boolean;
      annotation: { tags: string[]; starred?: boolean; notes?: string };
      tags: Array<{ tag: string; count: number }>;
    }>(
      ctx.baseUrl,
      `/api/annotations/${encodeURIComponent(fixture.cursorJsonlKey)}`,
      {
        method: "PUT",
        body: { starred: true, tags: ["Foo", "bar"], notes: "  pinned  " },
      }
    );
    assert.equal(putStatus, 200);
    assert.equal(putBody.ok, true);
    assert.equal(putBody.annotation.starred, true);
    assert.deepEqual(putBody.annotation.tags, ["foo", "bar"]);
    assert.equal(putBody.annotation.notes, "  pinned  ");

    const { body: listBody } = await fetchJson<{
      annotations: Record<string, { tags: string[] }>;
      tags: Array<{ tag: string; count: number }>;
    }>(ctx.baseUrl, "/api/annotations");
    assert.deepEqual(listBody.annotations[fixture.cursorJsonlKey].tags, [
      "foo",
      "bar",
    ]);
    const tagNames = listBody.tags.map((t) => t.tag).sort();
    assert.deepEqual(tagNames, ["bar", "foo"]);
  });

  it("PUT with empty payload removes the annotation", async () => {
    const { status, body } = await fetchJson<{
      ok: boolean;
      annotation: unknown;
    }>(
      ctx.baseUrl,
      `/api/annotations/${encodeURIComponent(fixture.cursorJsonlKey)}`,
      {
        method: "PUT",
        body: { starred: false, tags: [], notes: "" },
      }
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.annotation, null);
  });

  it("DELETE removes any remaining annotation (idempotent)", async () => {
    const { status, body } = await fetchJson<{ ok: boolean }>(
      ctx.baseUrl,
      `/api/annotations/${encodeURIComponent(fixture.claudeKey)}`,
      { method: "DELETE" }
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });
});

describe("http-server: POST /api/reindex", () => {
  it("returns ok + stats counting all fixture files", async () => {
    const { status, body } = await fetchJson<{
      ok: boolean;
      stats: { files_found: number; sessions_indexed: number };
    }>(ctx.baseUrl, "/api/reindex", { method: "POST" });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.stats.files_found >= 4);
    assert.ok(body.stats.sessions_indexed >= 4);
  });
});

describe("http-server: POST /api/open-path", () => {
  it("rejects missing path with 400", async () => {
    const { status, body } = await fetchJson<{ ok: boolean; error: string }>(
      ctx.baseUrl,
      "/api/open-path",
      { method: "POST", body: {} }
    );
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});

describe("http-server: GET /api/export/:sessionKey (basic)", () => {
  it("downloads a basic RULES.md for a known session (no AI runs)", async () => {
    const { status, text, headers } = await fetchRaw(
      ctx.baseUrl,
      `/api/export/${encodeURIComponent(fixture.cursorJsonlKey)}?type=rules&mode=basic`
    );
    assert.equal(status, 200);
    assert.equal(headers["content-type"], "text/markdown; charset=utf-8");
    assert.match(headers["content-disposition"] || "", /attachment/);
    assert.equal(headers["x-export-mode"], "basic");
    assert.match(text, /^# .* Rules/);
    assert.match(text, /## Objective/);
  });

  it("downloads a basic SKILL.md when type=skill", async () => {
    const { status, text, headers } = await fetchRaw(
      ctx.baseUrl,
      `/api/export/${encodeURIComponent(fixture.cursorJsonlKey)}?type=skill&mode=basic`
    );
    assert.equal(status, 200);
    assert.equal(headers["x-export-mode"], "basic");
    assert.match(text, /^---/);
    assert.match(text, /## Workflow/);
  });

  it("404s on unknown sessionKey", async () => {
    const { status } = await fetchJson(
      ctx.baseUrl,
      "/api/export/cursor:nope:nope?type=rules&mode=basic"
    );
    assert.equal(status, 404);
  });
});

describe("http-server: GET /api/export/target/:sessionKey", () => {
  it("returns the suggested .cursor/rules path with slug + repo info", async () => {
    const { status, body } = await fetchJson<{
      ok: boolean;
      slug: string;
      relativePath: string;
      repo: { exists: boolean };
      fileExists: boolean;
    }>(
      ctx.baseUrl,
      `/api/export/target/${encodeURIComponent(fixture.codexKey)}?kind=rules`
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.match(body.relativePath, /^\.cursor\/rules\/.*\.mdc$/);
    assert.equal(body.fileExists, false);
  });

  it("returns the .claude/skills path when kind=skill", async () => {
    const { body } = await fetchJson<{ relativePath: string }>(
      ctx.baseUrl,
      `/api/export/target/${encodeURIComponent(fixture.codexKey)}?kind=skill`
    );
    assert.match(body.relativePath, /^\.claude\/skills\/.*\/SKILL\.md$/);
  });
});

describe("http-server: 404 fallback", () => {
  it("returns 404 JSON for an unknown /api route", async () => {
    const { status, body } = await fetchJson<{ error: string }>(
      ctx.baseUrl,
      "/api/totally-unknown"
    );
    assert.equal(status, 404);
    assert.equal(body.error, "not found");
  });

  it("returns the static index html (or fallback 404) for non-API GETs", async () => {
    const { status, text } = await fetchRaw(ctx.baseUrl, "/some-route");
    // The test env points FRONTEND_DIST_DIR at an empty tempdir, so we end up
    // in the "index.html not found" branch (404) — that's the documented
    // fallback. We only assert that the dispatcher didn't 500.
    assert.ok(status === 200 || status === 404, `unexpected status ${status}`);
    if (status === 404) assert.match(text, /index\.html not found/);
  });
});

describe("http-server: DELETE /api/session/:sessionKey", () => {
  it("removes the underlying file and drops the session from the index", async () => {
    // Use the cursor jsonl session — `deleteSessionFiles()` for that layout
    // wipes the entire <sessionId>/ directory, which we created in the
    // fixture above.
    const targetKey = fixture.cursorJsonlKey;
    const { status, body } = await fetchJson<{
      ok: boolean;
      removed_paths: string[];
    }>(ctx.baseUrl, `/api/session/${encodeURIComponent(targetKey)}`, {
      method: "DELETE",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.removed_paths.length >= 1);

    // Subsequent GET should now 404.
    const { status: detailStatus } = await fetchJson(
      ctx.baseUrl,
      `/api/session/${encodeURIComponent(targetKey)}`
    );
    assert.equal(detailStatus, 404);

    // Repos endpoint should reflect the new count too.
    const { body: reposBody } = await fetchJson<{
      repos: Array<{ source: string; repo: string; session_count: number }>;
    }>(ctx.baseUrl, "/api/repos");
    const cursorDemo = reposBody.repos.find(
      (r) => r.source === "cursor" && r.repo === "demo-project"
    );
    assert.equal(cursorDemo?.session_count, 1);
  });
});
