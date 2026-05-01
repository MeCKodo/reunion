import "./_env.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  readRepoMapping,
  resolveRepoTarget,
  setRepoMapping,
} from "../src/repo-target.js";
import { AI_REPO_MAPPINGS_FILE } from "../src/config.js";
import { buildSession, mkTmpDir, rmDir } from "./_helpers.js";

const scratch = mkTmpDir("reunion-repo");
after(async () => {
  await rmDir(scratch);
  await fsp.rm(AI_REPO_MAPPINGS_FILE, { force: true });
});

describe("repo-target/resolveRepoTarget", () => {
  it("uses the override when provided, regardless of mappings", async () => {
    const dir = path.join(scratch, "override-repo");
    await fsp.mkdir(dir, { recursive: true });
    const session = buildSession({ source: "codex", repo: "x", repoPath: dir });
    const out = await resolveRepoTarget(session, { override: dir });
    assert.equal(out.path, dir);
    assert.equal(out.source, "mapping");
    assert.equal(out.exists, true);
  });

  it("uses session.repoPath for non-cursor sources when it exists on disk", async () => {
    const repoPath = path.join(scratch, "real-codex-repo");
    await fsp.mkdir(repoPath, { recursive: true });
    const session = buildSession({
      source: "codex",
      repo: "real-codex-repo",
      repoPath,
    });
    const out = await resolveRepoTarget(session);
    assert.equal(out.path, repoPath);
    assert.equal(out.source, "session");
  });

  it("returns source='none' when no signal exists for cursor and decoder fails", async () => {
    const session = buildSession({
      source: "cursor",
      repo: "Volumes-not-real-zzz-projectXYZ",
    });
    const out = await resolveRepoTarget(session);
    assert.equal(out.source, "none");
    assert.equal(out.exists, false);
  });

  it("prefers a stored mapping over session.repoPath", async () => {
    const stored = path.join(scratch, "stored-mapping");
    const repoPath = path.join(scratch, "session-only");
    await fsp.mkdir(stored, { recursive: true });
    await fsp.mkdir(repoPath, { recursive: true });

    await setRepoMapping("alpha-repo", stored, "codex");

    const session = buildSession({
      source: "codex",
      repo: "alpha-repo",
      repoPath,
    });
    const out = await resolveRepoTarget(session);
    assert.equal(out.path, stored);
    assert.equal(out.source, "mapping");
    assert.equal(out.isGitRepo, false);

    // Mapping persistence round-trip.
    assert.equal(await readRepoMapping("alpha-repo"), stored);
  });

  it("flags isGitRepo when the resolved dir contains .git", async () => {
    const repoPath = path.join(scratch, "git-repo");
    await fsp.mkdir(path.join(repoPath, ".git"), { recursive: true });
    const session = buildSession({
      source: "codex",
      repo: "git-repo",
      repoPath,
    });
    const out = await resolveRepoTarget(session);
    assert.equal(out.isGitRepo, true);
  });
});

describe("repo-target/readRepoMapping", () => {
  it("returns null for unknown labels", async () => {
    assert.equal(await readRepoMapping(""), null);
    assert.equal(await readRepoMapping("never-set"), null);
  });
});
