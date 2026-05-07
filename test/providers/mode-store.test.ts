import "../_env.js";
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";

import {
  applyMode,
  getStoredMode,
  loadActiveProvider,
  teamWiring,
  __testing__,
} from "../../src/providers/mode-store.js";
import { LocalDataProvider } from "../../src/providers/local.js";
import { RemoteDataProvider } from "../../src/providers/remote.js";
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

describe("providers/mode-store (built-in team wiring)", () => {
  beforeEach(async () => {
    await rmIgnore(__testing__.APP_MODE_FILE);
    await rmIgnore(__testing__.LEGACY_TEAM_CONFIG_FILE);
  });

  it("defaults to personal mode when no files exist", async () => {
    const stored = await getStoredMode();
    assert.equal(stored.mode, "personal");

    const state = await loadActiveProvider(FAKE_ROOTS);
    assert.equal(state.mode, "personal");
    assert.ok(state.provider instanceof LocalDataProvider);
    assert.equal(state.teamConfigPresent, false);
  });

  it("teamWiring() exposes the env-overridden URL but not the token", () => {
    const wiring = teamWiring();
    // _env.ts pins this to http://127.0.0.1:1
    assert.equal(wiring.baseUrl, "http://127.0.0.1:1");
    assert.equal(wiring.tokenConfigured, true);
    // Sanity: the result has no `token` field at all so we can't accidentally
    // leak it via /api/mode.
    assert.equal((wiring as Record<string, unknown>).token, undefined);
  });

  it("applyMode personal persists and returns LocalDataProvider", async () => {
    const result = await applyMode({ mode: "personal" }, FAKE_ROOTS);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mode, "personal");
      assert.ok(result.provider instanceof LocalDataProvider);
      assert.equal(result.teamConfigPresent, false);
    }
    assert.equal((await getStoredMode()).mode, "personal");
  });

  it("applyMode team returns 502 when ingest unreachable, never persists team", async () => {
    const result = await applyMode({ mode: "team" }, FAKE_ROOTS);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 502);
    // The trial failed, so the toggle must not flip on disk.
    assert.equal((await getStoredMode()).mode, "personal");
  });

  it("loadActiveProvider treats stored team mode as authoritative (lazy provider, no trial)", async () => {
    // Simulate a previous successful switch — we wrote app-mode.json on a day
    // when ingest was up. On startup we must NOT block on a health check; we
    // just hand back a RemoteDataProvider and let the first request decide.
    await fsp.writeFile(__testing__.APP_MODE_FILE, JSON.stringify({ mode: "team" }));
    const state = await loadActiveProvider(FAKE_ROOTS);
    assert.equal(state.mode, "team");
    assert.ok(state.provider instanceof RemoteDataProvider);
    assert.equal(state.teamConfigPresent, true);
  });

  it("invalid mode string in app-mode.json falls back to personal", async () => {
    await fsp.writeFile(
      __testing__.APP_MODE_FILE,
      JSON.stringify({ mode: "ULTRA-MEGA-MODE" })
    );
    const state = await loadActiveProvider(FAKE_ROOTS);
    assert.equal(state.mode, "personal");
  });

  it("legacy team-config.json is left in place but no longer consumed", async () => {
    await fsp.writeFile(
      __testing__.LEGACY_TEAM_CONFIG_FILE,
      JSON.stringify({ baseUrl: "https://stale.example.com", token: "old-secret" })
    );
    const state = await loadActiveProvider(FAKE_ROOTS);
    // We don't read it, so it has zero effect on the resolved mode.
    assert.equal(state.mode, "personal");
    // We also don't delete it — that's the user's call.
    const stillThere = await fsp.readFile(__testing__.LEGACY_TEAM_CONFIG_FILE, "utf-8");
    assert.match(stillThere, /stale\.example\.com/);
  });

  after(async () => {
    await rmIgnore(__testing__.APP_MODE_FILE);
    await rmIgnore(__testing__.LEGACY_TEAM_CONFIG_FILE);
  });
});
