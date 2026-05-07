// Verifies the personal-edition gate in `applyMode`. `getEdition()` reads
// process.env on every call so we just flip the env around the test bodies
// (no special module-load order required, no per-file subprocess needed).

import "../_env.js";
import { describe, it, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";

import {
  applyMode,
  __testing__,
} from "../../src/providers/mode-store.js";
import { getEdition } from "../../src/config.js";
import type { SourceRoots } from "../../src/types.js";

const FAKE_ROOTS: SourceRoots = {
  cursor: "/tmp/fake/cursor",
  claudeCode: "/tmp/fake/claude",
  codex: "/tmp/fake/codex",
};

async function rmIgnore(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

describe("providers/mode-store (personal edition gate)", () => {
  // Save & restore the surrounding env so this file doesn't leak edition
  // state to other test files that run in the same process.
  const PRIOR_EDITION = process.env.REUNION_EDITION;

  before(() => {
    process.env.REUNION_EDITION = "personal";
  });
  after(() => {
    if (PRIOR_EDITION === undefined) {
      delete process.env.REUNION_EDITION;
    } else {
      process.env.REUNION_EDITION = PRIOR_EDITION;
    }
  });
  beforeEach(async () => {
    await rmIgnore(__testing__.APP_MODE_FILE);
  });

  it("sanity: this file actually runs in personal edition", () => {
    assert.equal(getEdition(), "personal");
  });

  it("applyMode team is rejected with 403 BEFORE any network attempt", async () => {
    // Important: we point REUNION_TEAM_INGEST_URL at 127.0.0.1:1 in _env.ts,
    // which would normally yield a 502. If we get 403 here it means the
    // edition gate fired first — exactly what we want for a personal build.
    const result = await applyMode({ mode: "team" }, FAKE_ROOTS);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.match(result.error, /edition/i);
    }
    // The persisted mode must be untouched.
    const stored = await fsp
      .readFile(__testing__.APP_MODE_FILE, "utf-8")
      .catch(() => "");
    assert.equal(stored, "");
  });

  it("applyMode personal still works in personal edition", async () => {
    const result = await applyMode({ mode: "personal" }, FAKE_ROOTS);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.mode, "personal");
  });
});
