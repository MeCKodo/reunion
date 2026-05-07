// Side-effect module: must be imported FIRST in every test file, before any
// `src/...` import. We override the data/static dirs that `src/config.ts`
// resolves at import time so tests never read or write the user's real
// `data/` / `frontend/dist/` folders.
//
// Each test file runs in its own subprocess (`node --test` default), so a
// per-process unique tmpdir is enough — no cross-file leakage and no manual
// reset of in-memory caches.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `reunion-test-${stamp}-`));

const DATA_DIR = path.join(TEST_ROOT, "data");
const FRONTEND_DIST = path.join(TEST_ROOT, "frontend-dist");
const LEGACY_STATIC = path.join(TEST_ROOT, "static");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(FRONTEND_DIST, { recursive: true });
fs.mkdirSync(LEGACY_STATIC, { recursive: true });

process.env.REUNION_DATA_DIR = DATA_DIR;
process.env.REUNION_FRONTEND_DIST_DIR = FRONTEND_DIST;
process.env.REUNION_LEGACY_STATIC_DIR = LEGACY_STATIC;

// Team-mode wiring is compile-time in production but env-overridable in dev /
// tests. We point at a deliberately-unbound port so any test that calls
// `applyMode({mode:"team"})` triggers RemoteUnreachableError (502) instead of
// either hanging or — worse — talking to whatever real ingest the developer
// might have running on :8080 from the smoke-test stack.
if (!process.env.REUNION_TEAM_INGEST_URL) {
  process.env.REUNION_TEAM_INGEST_URL = "http://127.0.0.1:1";
}
if (!process.env.REUNION_TEAM_INGEST_TOKEN) {
  process.env.REUNION_TEAM_INGEST_TOKEN = "test-secret";
}

// Edition default for tests: `team`, because the bulk of the suite assumes
// the team-mode code path is reachable. The dedicated
// `mode-store.personal-edition.test.ts` file overrides this BEFORE this
// module is imported to exercise the personal-edition gate.
if (!process.env.REUNION_EDITION) {
  process.env.REUNION_EDITION = "team";
}

// Disable the team-mode repo host allowlist by default in tests. Existing
// suites use placeholder remotes (example.com, github.com, "git@a") that
// would otherwise be filtered out by the production default. Tests that
// specifically exercise the allowlist set this env var explicitly via
// `before` hooks.
if (!process.env.REUNION_TEAM_REPO_HOST_ALLOWLIST) {
  process.env.REUNION_TEAM_REPO_HOST_ALLOWLIST = "";
}

export const TEST_DIRS = {
  root: TEST_ROOT,
  data: DATA_DIR,
  frontendDist: FRONTEND_DIST,
  legacyStatic: LEGACY_STATIC,
};
