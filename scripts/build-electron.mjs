#!/usr/bin/env node
/* eslint-disable no-console */
import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const distDir = path.join(projectRoot, "dist");
const electronOutDir = path.join(distDir, "electron");
const backendOutFile = path.join(distDir, "src", "server.cjs");

const pkg = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf-8")
);

// Edition + team-mode secret injection. See `src/config.ts` for the
// declared constants these values replace. We default edition to "personal"
// and the secrets to "" so accidentally running `pnpm run build` without
// any env still produces a valid (personal-only) bundle.
const EDITION = (process.env.REUNION_EDITION || "personal").trim();
if (EDITION !== "personal" && EDITION !== "team") {
  console.error(
    `REUNION_EDITION must be "personal" or "team" (got "${EDITION}")`
  );
  process.exit(1);
}
const RAW_PROD_URL = (process.env.REUNION_BUILD_INGEST_URL || "").trim();
const RAW_PROD_TOKEN = (process.env.REUNION_BUILD_INGEST_TOKEN || "").trim();
// For personal edition we deliberately wipe the secrets even if the env
// happened to be set, so leaked dev shells can't accidentally bake a real
// token into a personal-edition .dmg.
const PROD_URL = EDITION === "team" ? RAW_PROD_URL : "";
const PROD_TOKEN = EDITION === "team" ? RAW_PROD_TOKEN : "";

if (EDITION === "team" && (!PROD_URL || !PROD_TOKEN)) {
  console.warn(
    "[build] REUNION_EDITION=team but REUNION_BUILD_INGEST_URL/TOKEN is empty; team mode in this bundle will fail to connect."
  );
}

const sharedDefines = {
  __REUNION_EDITION__: JSON.stringify(EDITION),
  __REUNION_PROD_INGEST_URL__: JSON.stringify(PROD_URL),
  __REUNION_PROD_INGEST_TOKEN__: JSON.stringify(PROD_TOKEN),
};

// External packages stay outside the bundle and are resolved at runtime via
// node_modules. Electron and the ESM-only sindre packages MUST be external,
// the rest is for safety.
const externals = [
  "electron",
  "fix-path",
  "shell-path",
  "strip-ansi",
  ...Object.keys(pkg.dependencies ?? {}),
];
const uniqueExternals = Array.from(new Set(externals));

async function clean() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(electronOutDir, { recursive: true });
  await mkdir(path.dirname(backendOutFile), { recursive: true });
}

const esmBanner = [
  "import { createRequire as __reunionCreateRequire } from 'node:module';",
  "import { fileURLToPath as __reunionFileURLToPath } from 'node:url';",
  "import { dirname as __reunionDirname } from 'node:path';",
  "const require = __reunionCreateRequire(import.meta.url);",
  "const __filename = __reunionFileURLToPath(import.meta.url);",
  "const __dirname = __reunionDirname(__filename);",
].join("\n");

async function bundleElectronMain() {
  await build({
    entryPoints: [path.join(projectRoot, "electron", "main.ts")],
    outfile: path.join(electronOutDir, "main.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: false,
    minify: false,
    external: uniqueExternals,
    logLevel: "info",
    banner: { js: esmBanner },
    define: sharedDefines,
  });
}

async function copyBootstrap() {
  // bootstrap.cjs MUST stay un-bundled CommonJS so it runs synchronously
  // and can inject REUNION_* env vars before main.js is loaded.
  await copyFile(
    path.join(projectRoot, "electron", "bootstrap.cjs"),
    path.join(electronOutDir, "bootstrap.cjs")
  );
}

async function bundleBackendStandalone() {
  // Keeps `pnpm start` working as a CLI server outside Electron.
  await build({
    entryPoints: [path.join(projectRoot, "src", "server.ts")],
    outfile: backendOutFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: false,
    minify: false,
    external: uniqueExternals,
    logLevel: "warning",
    define: sharedDefines,
  });
}

async function main() {
  await clean();
  await Promise.all([
    bundleElectronMain(),
    copyBootstrap(),
    bundleBackendStandalone(),
  ]);
  await writeFile(
    path.join(distDir, "BUILD_INFO.json"),
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        version: pkg.version,
        edition: EDITION,
        // Only echo the URL (which is not a secret on its own) to make
        // post-mortem easier; never echo the token.
        teamIngestUrl: PROD_URL || null,
      },
      null,
      2
    )
  );
  console.log(`✓ electron + backend bundles ready in dist/ (edition=${EDITION})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
