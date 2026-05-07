"use strict";
/* eslint-disable */
// CommonJS bootstrap for Reunion's Electron main process.
//
// This file is intentionally CJS so it can run synchronously and inject
// REUNION_* env vars BEFORE the ESM `main.js` bundle is evaluated.
// Once the env vars are in place we hand control to `main.js`, which is the
// real entry point.

const { app } = require("electron");
const path = require("node:path");

const isPackaged = app.isPackaged;
// dist/electron/bootstrap.cjs -> projectRoot in dev is two levels up.
const devProjectRoot = path.resolve(__dirname, "..", "..");

const dataDir = isPackaged
  ? path.join(app.getPath("userData"), "data")
  : path.join(devProjectRoot, "data");

const frontendDistDir = isPackaged
  ? path.join(process.resourcesPath, "frontend", "dist")
  : path.join(devProjectRoot, "frontend", "dist");

// Honor any pre-set value (e.g. from an E2E harness or a power-user shell
// override) before falling back to the path we computed above.
process.env.REUNION_DATA_DIR = process.env.REUNION_DATA_DIR || dataDir;
process.env.REUNION_FRONTEND_DIST_DIR =
  process.env.REUNION_FRONTEND_DIST_DIR || frontendDistDir;
process.env.REUNION_BOOTSTRAPPED = "1";

// Team-mode wiring auto-selection.
//
// Production .dmg: isPackaged=true. We do nothing here and let
// `src/config.ts` resolve `TEAM_INGEST_URL`/`TEAM_INGEST_TOKEN` from its
// compile-time defaults (PROD_INGEST_URL / PROD_INGEST_TOKEN).
//
// Dev (`pnpm run electron`, double-click .app from a local build, or
// Spotlight from a dev workspace): isPackaged=false. The shell env is NOT
// inherited when launched from Finder, so we have to default sensibly here.
// We point at the local ingest dev server (`docker-compose.dev.yml` +
// `cmd/server-dev`) which is what every Reunion engineer runs anyway. A
// developer that has already exported these env vars in their shell wins
// (e.g. CI, or pointing at a staging cluster).
if (!isPackaged) {
  if (!process.env.REUNION_TEAM_INGEST_URL) {
    process.env.REUNION_TEAM_INGEST_URL = "http://127.0.0.1:8080";
  }
  if (!process.env.REUNION_TEAM_INGEST_TOKEN) {
    process.env.REUNION_TEAM_INGEST_TOKEN = "local-test-token";
  }
}

const mainUrl = require("node:url").pathToFileURL(
  path.join(__dirname, "main.js")
).href;

import(mainUrl).catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[reunion] failed to load main.js:", error);
  app.exit(1);
});
