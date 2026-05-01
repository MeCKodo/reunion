import "./_env.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  buildIndex,
  getRepos,
  getSourceSummaries,
  loadIndex,
  removeSessionFromIndex,
  resolveSourceRoots,
} from "../src/index-store.js";
import { INDEX_FILE } from "../src/config.js";
import { buildIndexData, buildSession, mkTmpDir, rmDir } from "./_helpers.js";

const scratch = mkTmpDir("reunion-index");
after(async () => {
  await rmDir(scratch);
  await fsp.rm(INDEX_FILE, { force: true });
});

describe("index-store/resolveSourceRoots", () => {
  it("returns absolute paths for every root", () => {
    const out = resolveSourceRoots({
      cursor: "./relA",
      claudeCode: "./relB",
      codex: "./relC",
    });
    assert.ok(path.isAbsolute(out.cursor));
    assert.ok(path.isAbsolute(out.claudeCode));
    assert.ok(path.isAbsolute(out.codex));
  });
});

describe("index-store/getRepos + getSourceSummaries", () => {
  const indexData = buildIndexData([
    buildSession({ source: "cursor", repo: "alpha", sessionId: "1", updatedAt: 100 }),
    buildSession({ source: "cursor", repo: "alpha", sessionId: "2", updatedAt: 300 }),
    buildSession({ source: "claude-code", repo: "beta", sessionId: "3", updatedAt: 200 }),
    buildSession({ source: "codex", repo: "alpha", sessionId: "4", updatedAt: 250 }),
  ]);

  it("groups sessions by source+repo and reports counts / latest update", () => {
    const repos = getRepos(indexData);
    const alphaCursor = repos.find((r) => r.source === "cursor" && r.repo === "alpha")!;
    assert.equal(alphaCursor.session_count, 2);
    assert.equal(alphaCursor.last_updated_at, 300);

    const beta = repos.find((r) => r.repo === "beta")!;
    assert.equal(beta.source, "claude-code");
    assert.equal(beta.session_count, 1);
  });

  it("sorts repos by session_count desc then name asc", () => {
    const repos = getRepos(indexData);
    // alpha-cursor has 2 sessions, others have 1 — alpha-cursor first.
    assert.equal(repos[0].repo, "alpha");
    assert.equal(repos[0].source, "cursor");
  });

  it("returns one row per known source in fixed order, with counts", () => {
    const summaries = getSourceSummaries(indexData);
    assert.deepEqual(
      summaries.map((s) => s.id),
      ["cursor", "claude-code", "codex"]
    );
    assert.deepEqual(
      summaries.map((s) => s.session_count),
      [2, 1, 1]
    );
  });

  it("zeroes out counts for sources that have no sessions", () => {
    const empty = buildIndexData([buildSession({ source: "cursor" })]);
    const summaries = getSourceSummaries(empty);
    assert.equal(summaries.find((s) => s.id === "cursor")!.session_count, 1);
    assert.equal(summaries.find((s) => s.id === "claude-code")!.session_count, 0);
    assert.equal(summaries.find((s) => s.id === "codex")!.session_count, 0);
  });
});

describe("index-store/buildIndex (e2e against tempfs)", () => {
  it("scans codex / claude / cursor fixtures and returns aggregated stats", async () => {
    const cursorRoot = path.join(scratch, "cursor");
    const claudeRoot = path.join(scratch, "claude");
    const codexRoot = path.join(scratch, "codex");

    // Cursor: legacy .txt layout
    const txtDir = path.join(cursorRoot, "demo-project", "agent-transcripts");
    await fsp.mkdir(txtDir, { recursive: true });
    await fsp.writeFile(
      path.join(txtDir, "sess-cursor.txt"),
      "user:\nfirst question\n\nassistant:\nfirst answer"
    );

    // Claude: <projectDir>/<sessionId>.jsonl
    const claudeProj = path.join(claudeRoot, "claude-proj");
    await fsp.mkdir(claudeProj, { recursive: true });
    const claudeRows = [
      {
        type: "user",
        cwd: "/Users/test/repos/claude-proj",
        message: { role: "user", content: [{ type: "text", text: "ask claude" }] },
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "assistant",
        cwd: "/Users/test/repos/claude-proj",
        message: { role: "assistant", content: [{ type: "text", text: "claude answer" }] },
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ];
    await fsp.writeFile(
      path.join(claudeProj, "sess-claude.jsonl"),
      claudeRows.map((r) => JSON.stringify(r)).join("\n")
    );

    // Codex: yyyy/mm/dd/<sessionId>.jsonl with a session_meta header row
    const codexDay = path.join(codexRoot, "2026", "05", "01");
    await fsp.mkdir(codexDay, { recursive: true });
    const codexRows = [
      {
        type: "session_meta",
        timestamp: "2026-05-01T10:00:00.000Z",
        payload: {
          id: "sess-codex",
          cwd: "/Users/test/repos/codex-proj",
          timestamp: "2026-05-01T10:00:00.000Z",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-05-01T10:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "text", text: "first codex question" }],
        },
      },
    ];
    await fsp.writeFile(
      path.join(codexDay, "sess-codex.jsonl"),
      codexRows.map((r) => JSON.stringify(r)).join("\n")
    );

    const stats = await buildIndex(
      { cursor: cursorRoot, claudeCode: claudeRoot, codex: codexRoot },
      null
    );

    assert.equal(stats.files_found, 3);
    assert.equal(stats.sessions_indexed, 3);
    const bySource = Object.fromEntries(
      stats.by_source.map((row) => [row.source, row.sessions_indexed])
    );
    assert.equal(bySource.cursor, 1);
    assert.equal(bySource["claude-code"], 1);
    assert.equal(bySource.codex, 1);

    // The persisted file should now exist and round-trip via loadIndex().
    const loaded = await loadIndex();
    assert.equal(loaded.sessions.length, 3);
    const codexSession = loaded.sessions.find((s) => s.source === "codex")!;
    assert.equal(codexSession.sessionId, "sess-codex");
    assert.equal(codexSession.repo, "codex-proj");
  });

  it("removeSessionFromIndex drops a single session and rewrites the file", async () => {
    const before = await loadIndex();
    const startLen = before.sessions.length;
    const target = before.sessions.find((s) => s.source === "claude-code")!;
    assert.ok(target, `expected at least one claude-code session, sessions=${JSON.stringify(before.sessions.map((s) => [s.source, s.sessionId]))}`);
    const removed = await removeSessionFromIndex(target.sessionKey);
    assert.equal(removed?.sessionKey, target.sessionKey);

    const after = await loadIndex();
    assert.equal(
      after.sessions.find((s) => s.sessionKey === target.sessionKey),
      undefined
    );
    assert.equal(after.sessions.length, startLen - 1);
  });

  it("removeSessionFromIndex returns null for unknown keys (no-op)", async () => {
    const removed = await removeSessionFromIndex("does-not-exist");
    assert.equal(removed, null);
  });
});
