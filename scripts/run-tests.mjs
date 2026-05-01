// Tiny test launcher that walks `test/` for `*.test.ts` files and hands them
// off to tsx in --test mode. Node 20's built-in test runner doesn't expand
// globs and won't recurse for .ts files on its own, so we do the discovery
// ourselves to keep `pnpm test` portable across CI / local shells.

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(REPO_ROOT, "test");

async function* walk(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(abs);
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      yield abs;
    }
  }
}

async function main() {
  const files = [];
  for await (const file of walk(TEST_DIR)) files.push(file);
  files.sort();

  if (files.length === 0) {
    console.error("no test files found under test/");
    process.exit(0);
  }

  const extra = process.argv.slice(2);
  const reporterFlags = extra.length > 0 ? extra : ["--test-reporter=spec"];

  const child = spawn(
    "npx",
    ["tsx", "--test", ...reporterFlags, ...files],
    { cwd: REPO_ROOT, stdio: "inherit" }
  );

  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", (err) => {
    console.error(err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
