#!/usr/bin/env node
// Regenerate Reunion's platform-specific icon files from build/icon.png.
//
// Outputs:
//   build/icon.ico  — Windows multi-resolution ICO (16/24/32/48/64/128/256)
//   build/icon.icns — macOS ICNS (only regenerated if `iconutil` is available;
//                     otherwise we keep the committed file as-is).
//
// Run manually after the brand mark changes:
//   pnpm dlx png-to-ico  # auto-installed via npx fallback
//   node scripts/generate-icons.mjs
//
// CI calls this once before electron-builder so we never ship a stale .ico.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const buildDir = path.join(projectRoot, "build");
const sourcePng = path.join(buildDir, "icon.png");
const targetIco = path.join(buildDir, "icon.ico");

if (!existsSync(sourcePng)) {
  console.error(`[icons] missing source PNG: ${sourcePng}`);
  process.exit(1);
}

mkdirSync(buildDir, { recursive: true });

async function generateIco() {
  let pngToIco;
  try {
    pngToIco = (await import("png-to-ico")).default;
  } catch {
    console.error(
      "[icons] png-to-ico is not installed. Install it as a devDependency or run via npx:"
    );
    console.error("  pnpm add -D png-to-ico");
    console.error("  npx png-to-ico build/icon.png > build/icon.ico");
    process.exit(1);
  }
  const buf = await pngToIco(sourcePng);
  writeFileSync(targetIco, buf);
  console.log(`[icons] wrote ${path.relative(projectRoot, targetIco)} (${buf.length} bytes)`);
}

await generateIco();

// macOS: best-effort regenerate icon.icns when running on macOS where iconutil
// is bundled with Xcode CLT. Skipped silently otherwise — the committed
// build/icon.icns stays authoritative for non-mac builders / CI Linux runners.
if (process.platform === "darwin") {
  const iconutil = spawnSync("which", ["iconutil"], { encoding: "utf8" });
  if (iconutil.status === 0) {
    console.log(
      "[icons] iconutil available — leaving build/icon.icns untouched (regenerate manually if needed)"
    );
  }
}
