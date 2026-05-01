import "../_env.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  deleteSessionFiles,
  DeletePathOutsideRootError,
} from "../../src/lib/delete-session.js";
import type { Session, SourceRoots } from "../../src/types.js";
import { buildSession, mkTmpDir, rmDir } from "../_helpers.js";

const scratch = mkTmpDir("reunion-del");
after(async () => rmDir(scratch));

function makeRoots(): SourceRoots {
  return {
    cursor: path.join(scratch, "cursor"),
    claudeCode: path.join(scratch, "claude"),
    codex: path.join(scratch, "codex"),
  };
}

describe("lib/delete-session/cursor", () => {
  it("nukes the whole <sessionId>/ directory for new jsonl layout", async () => {
    const roots = makeRoots();
    const projectDir = path.join(roots.cursor, "demo-project", "agent-transcripts");
    const sessionDir = path.join(projectDir, "sess-A");
    await fsp.mkdir(sessionDir, { recursive: true });
    const main = path.join(sessionDir, "sess-A.jsonl");
    const sub = path.join(sessionDir, "subagents", "agent-1.jsonl");
    await fsp.mkdir(path.dirname(sub), { recursive: true });
    await fsp.writeFile(main, "main");
    await fsp.writeFile(sub, "sub");

    const session = buildSession({
      source: "cursor",
      repo: "demo-project",
      sessionId: "sess-A",
      filePath: main,
    });
    const out = await deleteSessionFiles(session, roots);
    assert.deepEqual(out.removedPaths, [sessionDir]);
    assert.deepEqual(out.missingPaths, []);
    await assert.rejects(fsp.access(main));
    await assert.rejects(fsp.access(sub));
  });

  it("only deletes the .txt file for legacy cursor layout", async () => {
    const roots = makeRoots();
    const txtDir = path.join(roots.cursor, "legacy", "agent-transcripts");
    await fsp.mkdir(txtDir, { recursive: true });
    const main = path.join(txtDir, "sess-B.txt");
    const sibling = path.join(txtDir, "sess-C.txt");
    await fsp.writeFile(main, "to-delete");
    await fsp.writeFile(sibling, "keep-me");

    const session = buildSession({
      source: "cursor",
      repo: "legacy",
      sessionId: "sess-B",
      filePath: main,
    });
    const out = await deleteSessionFiles(session, roots);
    assert.deepEqual(out.removedPaths, [main]);
    await assert.rejects(fsp.access(main));
    // Sibling untouched.
    assert.equal(await fsp.readFile(sibling, "utf-8"), "keep-me");
  });
});

describe("lib/delete-session/claude-code", () => {
  it("removes both the main jsonl and the matching sidechain dir", async () => {
    const roots = makeRoots();
    const projectDir = path.join(roots.claudeCode, "claude-proj");
    await fsp.mkdir(projectDir, { recursive: true });
    const main = path.join(projectDir, "sess-D.jsonl");
    const sidechain = path.join(projectDir, "sess-D");
    await fsp.writeFile(main, "main");
    await fsp.mkdir(path.join(sidechain, "subagents"), { recursive: true });
    await fsp.writeFile(path.join(sidechain, "subagents", "x.jsonl"), "sub");

    const session = buildSession({
      source: "claude-code",
      repo: "claude-proj",
      sessionId: "sess-D",
      filePath: main,
    });
    const out = await deleteSessionFiles(session, roots);
    assert.deepEqual(out.removedPaths.sort(), [main, sidechain].sort());
    assert.deepEqual(out.missingPaths, []);
    await assert.rejects(fsp.access(main));
    await assert.rejects(fsp.access(sidechain));
  });

  it("reports missing paths instead of throwing when a candidate doesn't exist", async () => {
    const roots = makeRoots();
    const projectDir = path.join(roots.claudeCode, "claude-empty");
    await fsp.mkdir(projectDir, { recursive: true });
    const main = path.join(projectDir, "sess-E.jsonl");
    // intentionally don't create main or sidechain

    const session = buildSession({
      source: "claude-code",
      repo: "claude-empty",
      sessionId: "sess-E",
      filePath: main,
    });
    const out = await deleteSessionFiles(session, roots);
    assert.deepEqual(out.removedPaths, []);
    assert.equal(out.missingPaths.length, 2);
  });
});

describe("lib/delete-session/codex", () => {
  it("removes only the codex jsonl file", async () => {
    const roots = makeRoots();
    const dayDir = path.join(roots.codex, "2026", "05", "01");
    await fsp.mkdir(dayDir, { recursive: true });
    const main = path.join(dayDir, "sess-F.jsonl");
    await fsp.writeFile(main, "codex-content");

    const session = buildSession({
      source: "codex",
      repo: "codex-proj",
      sessionId: "sess-F",
      filePath: main,
    });
    const out = await deleteSessionFiles(session, roots);
    assert.deepEqual(out.removedPaths, [main]);
    await assert.rejects(fsp.access(main));
  });
});

describe("lib/delete-session/path safety", () => {
  it("refuses to delete files outside the configured source root", async () => {
    const roots = makeRoots();
    const otherDir = path.join(scratch, "outside");
    await fsp.mkdir(otherDir, { recursive: true });
    const main = path.join(otherDir, "sneaky.jsonl");
    await fsp.writeFile(main, "should not delete");

    const session = buildSession({
      source: "codex",
      repo: "x",
      sessionId: "y",
      filePath: main,
    });

    await assert.rejects(
      () => deleteSessionFiles(session, roots),
      (err: unknown) => err instanceof DeletePathOutsideRootError
    );
    // file untouched
    assert.equal(await fsp.readFile(main, "utf-8"), "should not delete");
  });

  it("refuses targets equal to the root itself", async () => {
    const roots = makeRoots();
    await fsp.mkdir(roots.codex, { recursive: true });
    const session = buildSession({
      source: "codex",
      repo: "x",
      sessionId: "y",
      filePath: roots.codex,
    });
    await assert.rejects(
      () => deleteSessionFiles(session, roots),
      (err: unknown) => err instanceof DeletePathOutsideRootError
    );
  });
});
