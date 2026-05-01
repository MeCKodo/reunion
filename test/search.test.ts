import "./_env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { searchSessions } from "../src/search.js";
import type { ParsedSegment, Session, SessionAnnotation } from "../src/types.js";
import { buildSession, buildIndexData } from "./_helpers.js";

function withSegments(session: Session, segments: ParsedSegment[]): Session {
  const content = segments
    .flatMap((seg) => [`${seg.role}:`, seg.text, ""])
    .join("\n")
    .trim();
  return { ...session, content, segments };
}

const NOW = Math.floor(Date.now() / 1000);

const sessionA = withSegments(
  buildSession({
    source: "cursor",
    repo: "alpha",
    sessionId: "a1",
    title: "Alpha refactor plan",
    startedAt: NOW - 60,
    updatedAt: NOW - 30,
  }),
  [
    { index: 0, role: "user", text: "How do I refactor the auth flow?", ts: NOW - 60 },
    { index: 1, role: "assistant", text: "Use middleware refactor here.", ts: NOW - 30 },
  ]
);

const sessionB = withSegments(
  buildSession({
    source: "claude-code",
    repo: "alpha",
    sessionId: "b1",
    title: "Alpha bugfix",
    startedAt: NOW - 4 * 24 * 3600,
    updatedAt: NOW - 4 * 24 * 3600,
  }),
  [
    { index: 0, role: "user", text: "Fix the login bug.", ts: NOW - 4 * 24 * 3600 },
    { index: 1, role: "assistant", text: "Patched the validation step.", ts: NOW - 4 * 24 * 3600 },
  ]
);

const sessionC = withSegments(
  buildSession({
    source: "codex",
    repo: "beta",
    sessionId: "c1",
    title: "Beta migration",
    startedAt: NOW - 50 * 24 * 3600,
    updatedAt: NOW - 50 * 24 * 3600,
  }),
  [
    { index: 0, role: "user", text: "Run a database migration.", ts: NOW - 50 * 24 * 3600 },
    { index: 1, role: "assistant", text: "Migration complete with refactor cleanup.", ts: NOW - 50 * 24 * 3600 },
  ]
);

const indexData = buildIndexData([sessionA, sessionB, sessionC]);
const annotations: Record<string, SessionAnnotation> = {};

describe("search/searchSessions — empty query path", () => {
  it("returns all sessions sliced by limit when query is blank", () => {
    const out = searchSessions(indexData, "", "", 100, 0, annotations, "");
    assert.equal(out.length, 3);
    assert.equal(out[0].match_count, 0);
    // ordering follows the sessions array (no reorder when query is blank)
    assert.equal(out[0].session_key, sessionA.sessionKey);
  });

  it("respects repo filter", () => {
    const out = searchSessions(indexData, "", "alpha", 100, 0, annotations, "");
    assert.equal(out.length, 2);
    for (const item of out) assert.equal(item.repo, "alpha");
  });

  it("respects source filter", () => {
    const out = searchSessions(indexData, "", "", 100, 0, annotations, "codex");
    assert.equal(out.length, 1);
    assert.equal(out[0].session_key, sessionC.sessionKey);
  });

  it("respects days filter (only sessions newer than now-N days)", () => {
    const out = searchSessions(indexData, "", "", 100, 1, annotations, "");
    assert.equal(out.length, 1);
    assert.equal(out[0].session_key, sessionA.sessionKey);
  });
});

describe("search/searchSessions — query ranking + matching", () => {
  it("returns only matching sessions, ordered by match_count desc", () => {
    const out = searchSessions(indexData, "refactor", "", 100, 0, annotations, "");
    const keys = out.map((item) => item.session_key);
    // sessionA mentions "refactor" twice (user+assistant), sessionC once.
    assert.deepEqual(keys, [sessionA.sessionKey, sessionC.sessionKey]);
    assert.equal(out[0].match_count, 2);
    assert.equal(out[1].match_count, 1);
  });

  it("requires every token to be present (AND semantics)", () => {
    const out = searchSessions(indexData, "refactor migration", "", 100, 0, annotations, "");
    assert.equal(out.length, 1);
    assert.equal(out[0].session_key, sessionC.sessionKey);
  });

  it("applies repo + days + query filters together", () => {
    const out = searchSessions(indexData, "refactor", "alpha", 100, 1, annotations, "");
    assert.equal(out.length, 1);
    assert.equal(out[0].session_key, sessionA.sessionKey);
  });

  it("returns empty result when nothing matches", () => {
    const out = searchSessions(indexData, "zzz-nope", "", 100, 0, annotations, "");
    assert.deepEqual(out, []);
  });

  it("includes a snippet with <mark> highlighting on the matched token", () => {
    const out = searchSessions(indexData, "refactor", "", 100, 0, annotations, "");
    const snippet = out[0].snippet;
    assert.match(snippet, /<mark class="hit-mark">refactor<\/mark>/i);
    // message_hits are limited to 5 items
    assert.ok(out[0].message_hits.length <= 5);
  });
});

describe("search/searchSessions — annotations projection", () => {
  it("merges annotations into each result via projectAnnotation", () => {
    const ann: Record<string, SessionAnnotation> = {
      [sessionA.sessionKey]: {
        updatedAt: NOW,
        starred: true,
        tags: ["foo"],
        notes: "bar",
      },
    };
    const out = searchSessions(indexData, "", "", 100, 0, ann, "");
    const first = out.find((item) => item.session_key === sessionA.sessionKey)!;
    assert.equal(first.starred, true);
    assert.deepEqual(first.tags, ["foo"]);
    assert.equal(first.notes, "bar");
  });
});
