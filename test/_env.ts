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

export const TEST_DIRS = {
  root: TEST_ROOT,
  data: DATA_DIR,
  frontendDist: FRONTEND_DIST,
  legacyStatic: LEGACY_STATIC,
};
