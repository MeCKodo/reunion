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

process.env.REUNION_DATA_DIR = dataDir;
process.env.REUNION_FRONTEND_DIST_DIR = frontendDistDir;
process.env.REUNION_BOOTSTRAPPED = "1";

const mainUrl = require("node:url").pathToFileURL(
  path.join(__dirname, "main.js")
).href;

import(mainUrl).catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[reunion] failed to load main.js:", error);
  app.exit(1);
});
