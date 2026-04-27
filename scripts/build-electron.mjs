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
      { builtAt: new Date().toISOString(), version: pkg.version },
      null,
      2
    )
  );
  console.log("✓ electron + backend bundles ready in dist/");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
