// Shared cwd resolver for every `cursor-agent` invocation Reunion makes.
//
// Why this exists:
//   When Reunion is launched as a packaged macOS app from Finder/Dock the
//   Electron main process inherits cwd `/`. Spawning cursor-agent from there
//   triggers its workspace-trust gate ("Workspace Trust Required …") and
//   makes batch tagging fail for every session. Even commands that don't
//   read workspace files (status/login/list-models) still inherit the cwd
//   from the parent process, which feels brittle, so we give the whole CLI
//   family one stable, user-owned home as cwd.
//
// Resolution order:
//   1. CURSOR_AGENT_CWD                  — explicit override for power users
//   2. REUNION_DATA_DIR                  — set by electron/bootstrap.cjs;
//                                          always inside ~/Library/Application
//                                          Support/Reunion when packaged
//   3. os.homedir()                      — last-resort fallback that should
//                                          always exist and be user-owned

import os from "node:os";
import { existsSync, statSync } from "node:fs";

let cached: string | null = null;

export function getCursorSpawnCwd(): string {
  if (cached) return cached;
  const candidates = [
    process.env.CURSOR_AGENT_CWD,
    process.env.REUNION_DATA_DIR,
    os.homedir(),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        cached = candidate;
        return candidate;
      }
    } catch {
      // unreadable path → try the next candidate
    }
  }
  // Should be unreachable on any sane macOS install but stay defensive.
  cached = "/";
  return cached;
}

/** Test seam — drop the memoised cwd so a follow-up call re-evaluates. */
export function resetCursorSpawnCwdCacheForTests(): void {
  cached = null;
}
