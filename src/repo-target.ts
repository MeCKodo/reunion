import { promises as fs } from "node:fs";
import path from "node:path";
import { AI_REPO_MAPPINGS_FILE, AI_DATA_DIR } from "./config";
import { atomicWriteFile, tryReadFile } from "./lib/fs";
import type { Session, SourceId } from "./types";

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/**
 * Result of trying to figure out the real on-disk repository root for a
 * session. `path` may be omitted when we have nothing useful to suggest, in
 * which case the UI falls back to the directory picker.
 */
export interface RepoTarget {
  path?: string;
  /** how `path` was inferred */
  source: "mapping" | "session" | "decoded" | "none";
  /** convenience flag for `path` existing on disk and being a directory */
  exists: boolean;
  /** convenience flag for `path` containing a `.git` entry (file or dir) */
  isGitRepo: boolean;
}

interface ResolveOpts {
  /** override stored mapping for the session.repo bucket */
  override?: string;
}

async function statSafe(p: string): Promise<{ isDir: boolean; isFile: boolean } | null> {
  try {
    const st = await fs.stat(p);
    return { isDir: st.isDirectory(), isFile: st.isFile() };
  } catch {
    return null;
  }
}

async function inspect(p: string): Promise<{ exists: boolean; isGitRepo: boolean }> {
  const st = await statSafe(p);
  if (!st || !st.isDir) return { exists: false, isGitRepo: false };
  const gitEntry = await statSafe(path.join(p, ".git"));
  return { exists: true, isGitRepo: !!gitEntry };
}

/**
 * Decode a Cursor "flattened" project directory name like
 * `Users-bytedance-workspaces-mvp-chat-explorer` back into an absolute
 * filesystem path (`/Users/bytedance/workspaces/mvp-chat-explorer`).
 *
 * Cursor concatenates path segments with `-`, so a real directory called
 * `mvp-chat-explorer` becomes ambiguous (could be `/Users/.../mvp/chat/explorer`
 * or `/Users/.../mvp-chat-explorer`). We try the longest viable match first
 * and back off, returning the first candidate that actually exists. Returns
 * null when nothing on disk matches — the caller should let the user pick.
 *
 * Only attempted on POSIX-style absolute paths starting with `/Users/`,
 * `/home/`, or similar prefixes. Windows-shaped names (`C--Users-...`) are
 * deliberately not handled here; callers fall back to a directory picker.
 */
async function decodeCursorProjectDir(projectDir: string): Promise<string | null> {
  if (!projectDir) return null;
  const parts = projectDir.split("-");
  if (parts.length < 2) return null;

  const knownTopLevel = ["Users", "home", "tmp", "opt", "Volumes"];
  if (!knownTopLevel.includes(parts[0])) {
    // Bail on anything that doesn't look like a POSIX-style flattened path.
    // Cursor on Linux uses lowercase `home-...`. Windows tends to start with
    // a drive letter token (`C--Users-...`) which we cannot reliably round
    // trip without ambiguity, so we skip it.
    return null;
  }

  // Try every partition between segments (greedy → minimal). Each take of
  // N segments is tried with `-` joiner first (`mvp-chat-explorer` → real
  // dirname `mvp-chat-explorer`), then with space joiner as a fallback,
  // because Cursor flattens both `-` and ` ` into the same `-` separator
  // when bucketing project dirs (`Obsidian Vault` ↔ `Obsidian-Vault`).
  async function attempt(remainingIdx: number, accumulated: string): Promise<string | null> {
    const stillExists = await statSafe(accumulated);
    if (!stillExists || !stillExists.isDir) return null;
    if (remainingIdx >= parts.length) return accumulated;

    for (let take = parts.length - remainingIdx; take >= 1; take -= 1) {
      const segs = parts.slice(remainingIdx, remainingIdx + take);
      const joinerCandidates = take === 1 ? [""] : ["-", " "];
      for (const joiner of joinerCandidates) {
        const slice = joiner === "" ? segs[0] : segs.join(joiner);
        const next = path.join(accumulated, slice);
        const result = await attempt(remainingIdx + take, next);
        if (result) return result;
      }
    }
    return null;
  }

  const root = "/" + parts[0];
  return attempt(1, root);
}

export async function resolveRepoTarget(
  session: Session,
  opts: ResolveOpts = {}
): Promise<RepoTarget> {
  // Caller can short-circuit if the user picked a path in this session.
  if (opts.override && opts.override.trim()) {
    const probe = await inspect(opts.override);
    return { path: opts.override, source: "mapping", ...probe };
  }

  // Persisted mapping wins next — it's the user's last confirmed answer for
  // this `repo` bucket label, shared across all sessions in that bucket.
  const stored = await readRepoMapping(session.repo);
  if (stored) {
    const probe = await inspect(stored);
    if (probe.exists) {
      return { path: stored, source: "mapping", ...probe };
    }
    // Stored path no longer exists; fall through but don't error.
  }

  // Codex / Claude Code carry the real cwd directly. Cursor stores a
  // flattened project dir under `~/.cursor/projects/`, which is the
  // transcript cache, not the repo. Decoding takes another step.
  if (session.source !== "cursor" && session.repoPath) {
    const probe = await inspect(session.repoPath);
    if (probe.exists) {
      return { path: session.repoPath, source: "session", ...probe };
    }
  }

  if (session.source === "cursor") {
    const decoded = await decodeCursorProjectDir(session.repo);
    if (decoded) {
      const probe = await inspect(decoded);
      return { path: decoded, source: "decoded", ...probe };
    }
  }

  return { source: "none", exists: false, isGitRepo: false };
}

// ---------------------------------------------------------------------------
// mappings persistence
// ---------------------------------------------------------------------------

interface RepoMappingsFile {
  version: number;
  mappings: Record<string, { path: string; updatedAt: number; source?: SourceId }>;
}

const FILE_VERSION = 1;

async function loadRepoMappingsFile(): Promise<RepoMappingsFile> {
  const buffer = await tryReadFile(AI_REPO_MAPPINGS_FILE);
  if (!buffer) {
    return { version: FILE_VERSION, mappings: {} };
  }
  try {
    const parsed = JSON.parse(buffer.toString("utf-8")) as RepoMappingsFile;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.mappings !== "object") {
      return { version: FILE_VERSION, mappings: {} };
    }
    return { version: FILE_VERSION, mappings: parsed.mappings || {} };
  } catch {
    return { version: FILE_VERSION, mappings: {} };
  }
}

export async function readRepoMapping(repoLabel: string): Promise<string | null> {
  if (!repoLabel) return null;
  const data = await loadRepoMappingsFile();
  return data.mappings[repoLabel]?.path || null;
}

export async function setRepoMapping(
  repoLabel: string,
  realPath: string,
  source?: SourceId
): Promise<void> {
  if (!repoLabel || !realPath) return;
  await fs.mkdir(AI_DATA_DIR, { recursive: true });
  const data = await loadRepoMappingsFile();
  data.mappings[repoLabel] = {
    path: realPath,
    updatedAt: Date.now(),
    source,
  };
  await atomicWriteFile(AI_REPO_MAPPINGS_FILE, JSON.stringify(data, null, 2));
}
