import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// browse: list directories under a given path for the picker UI.
// ---------------------------------------------------------------------------
//
// Frontend cannot enumerate the user's filesystem on its own (browsers don't
// expose absolute paths from <input webkitdirectory>), so the UI walks the
// tree by issuing list requests against this endpoint. We only reveal
// directories — files are filtered out — and add a `parent` field so the UI
// can render a "go up" affordance.
//
// Scope: anything under the user's home dir, plus root volumes on macOS.
// We deliberately *do not* sandbox the caller into a single subtree — the
// whole point is to let the user pick any project root they own. We do strip
// noisy hidden directories (.git, node_modules, …) to keep the picker small.

export interface FsListEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  hidden: boolean;
}

export interface FsListResult {
  path: string;
  parent: string | null;
  entries: FsListEntry[];
}

const HIDDEN_BLOCKLIST = new Set([
  // macOS-specific noise we never want to expose as candidate repos.
  ".Trash",
  ".cache",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".DocumentRevisions-V100",
  ".Spotlight-V100",
  ".fseventsd",
  ".TemporaryItems",
  ".vscode-server",
  // these are huge and almost never the directory the user wants to write to.
  "node_modules",
  "Library",
]);

function isHiddenName(name: string): boolean {
  return name.startsWith(".") || HIDDEN_BLOCKLIST.has(name);
}

async function dirHasGit(absPath: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(absPath, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve `requested` to an absolute path. Empty string / undefined falls
 * back to the user's home directory, which is the most useful default for
 * picking a repo root. Tilde and `~/...` are expanded for callers passing
 * raw user input.
 */
export function resolveBrowsePath(requested: string | null | undefined): string {
  const home = os.homedir();
  if (!requested || !requested.trim()) return home;
  const trimmed = requested.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return path.resolve(home, trimmed.slice(2));
  return path.resolve(trimmed);
}

export async function listDirectory(absPath: string): Promise<FsListResult> {
  const stats = await fs.stat(absPath);
  if (!stats.isDirectory()) {
    throw new Error(`not a directory: ${absPath}`);
  }
  const dirents = await fs.readdir(absPath, { withFileTypes: true });
  const dirs = dirents.filter((d) => d.isDirectory() || d.isSymbolicLink());

  const entries: FsListEntry[] = [];
  for (const d of dirs) {
    const childPath = path.join(absPath, d.name);
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        const target = await fs.stat(childPath);
        isDir = target.isDirectory();
      } catch {
        // dangling symlink — skip
        continue;
      }
    }
    if (!isDir) continue;
    const hidden = isHiddenName(d.name);
    entries.push({
      name: d.name,
      path: childPath,
      isGitRepo: await dirHasGit(childPath),
      hidden,
    });
  }

  // Folders that ARE git repos float to the top, then alphabetical.
  // Hidden entries sink unless the caller wants them; we still return them
  // so the UI can offer a "show hidden" toggle without round-tripping.
  entries.sort((a, b) => {
    if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
    if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parent = path.dirname(absPath);
  return {
    path: absPath,
    parent: parent === absPath ? null : parent,
    entries,
  };
}

/**
 * Helper exposed to API layer: returns home shortcut + common bookmarks
 * the frontend can show as quick chips.
 */
export interface FsBookmarks {
  home: string;
  workspaces: string[];
}

export async function listBookmarks(): Promise<FsBookmarks> {
  const home = os.homedir();
  const candidates = [
    path.join(home, "workspaces"),
    path.join(home, "work"),
    path.join(home, "code"),
    path.join(home, "src"),
    path.join(home, "Documents"),
    path.join(home, "Desktop"),
    path.join(home, "Developer"),
  ];
  const workspaces: string[] = [];
  for (const candidate of candidates) {
    try {
      const st = await fs.stat(candidate);
      if (st.isDirectory()) workspaces.push(candidate);
    } catch {
      // ignore
    }
  }
  return { home, workspaces };
}
