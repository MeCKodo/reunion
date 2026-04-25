import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CURSOR_WORKSPACE_STORAGE } from "./config";

const execFileAsync = promisify(execFile);

/**
 * One row from Cursor's `aiService.generations` (per workspaceStorage db).
 * Cursor records a real epoch-ms timestamp every time the user submits a
 * prompt or applies an edit, but it does NOT carry a composerId / sessionId
 * — generations live at workspace scope. We later align them to a specific
 * session by time window + textDescription matching.
 */
export type CursorGeneration = {
  unixMs: number;
  type: string;
  textDescription?: string;
};

let cache: { loadedAt: number; entries: CursorGeneration[] } | null = null;
const CACHE_TTL_MS = 60_000;

export async function loadAllCursorGenerations(): Promise<CursorGeneration[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.entries;
  }

  let workspaceDirs: string[] = [];
  try {
    workspaceDirs = (
      await fs.readdir(CURSOR_WORKSPACE_STORAGE, { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(CURSOR_WORKSPACE_STORAGE, entry.name));
  } catch {
    cache = { loadedAt: Date.now(), entries: [] };
    return cache.entries;
  }

  const all: CursorGeneration[] = [];
  await Promise.all(
    workspaceDirs.map(async (dir) => {
      const dbPath = path.join(dir, "state.vscdb");
      try {
        await fs.access(dbPath);
      } catch {
        return;
      }
      let stdout = "";
      try {
        const result = await execFileAsync("sqlite3", [
          dbPath,
          "select value from ItemTable where key='aiService.generations';",
        ]);
        stdout = result.stdout.trim();
      } catch {
        return;
      }
      if (!stdout) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const unixMs =
          typeof row.unixMs === "number" && Number.isFinite(row.unixMs)
            ? row.unixMs
            : null;
        if (unixMs === null) continue;
        const type = typeof row.type === "string" ? row.type : "unknown";
        const textDescription =
          typeof row.textDescription === "string" ? row.textDescription : undefined;
        all.push({ unixMs, type, textDescription });
      }
    })
  );

  all.sort((a, b) => a.unixMs - b.unixMs);
  cache = { loadedAt: Date.now(), entries: all };
  return all;
}

export function invalidateGenerationCache(): void {
  cache = null;
}

/**
 * jsonl user messages get wrapped by Cursor with envelopes like
 * `<user_query>…</user_query>`, `<image_files>…</image_files>`, plus various
 * `<environment_context>` / `<system_reminder>` / `<attached_files>` blocks
 * appended by the IDE. SQLite stores the raw user text. To match them, strip
 * the envelopes and isolate the user_query payload when present.
 */
function stripEnvelopes(text: string): string {
  // Prefer the explicit user_query payload; everything else is IDE noise.
  const userQuery = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (userQuery) return userQuery[1];
  // Otherwise drop any wrapper-style tag block (<tag>…</tag>) and lone tags.
  return text
    .replace(/<([a-zA-Z_][\w-]*)>[\s\S]*?<\/\1>/g, " ")
    .replace(/<\/?[a-zA-Z_][\w-]*[^>]*>/g, " ");
}

function normalize(text: string): string {
  return stripEnvelopes(text)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Score a (userText, generationText) pair. Higher = more confident match.
 * Returns 0 when there's no plausible signal so the caller can reject it.
 */
function matchScore(userText: string, generationText: string): number {
  const a = normalize(userText);
  const b = normalize(generationText);
  if (!a || !b) return 0;
  if (a === b) return 1.0;
  // Exact prefix on either side handles cases where the recorded prompt is a
  // truncated preview of the full message (Cursor seems to truncate around
  // ~10kB) or vice versa.
  const head = 80;
  if (b.length >= head && a.startsWith(b.slice(0, head))) return 0.95;
  if (a.length >= head && b.startsWith(a.slice(0, head))) return 0.95;
  // Fall back to substring containment for long messages where the SQLite
  // record may have stripped trailing context.
  if (a.length >= 24 && b.includes(a.slice(0, Math.min(a.length, 200)))) return 0.8;
  if (b.length >= 24 && a.includes(b.slice(0, Math.min(b.length, 200)))) return 0.8;
  return 0;
}

const MATCH_FLOOR = 0.7;

/**
 * Given the user-message texts of a session in the order they appear in the
 * jsonl, return a parallel array of real epoch-second timestamps (or
 * undefined where no confident match exists).
 *
 * Both userTexts and the windowed generations are strictly time-ordered, so
 * any valid alignment must be a monotonic subset matching. We solve it as a
 * weighted longest-common-subsequence DP over (N user msgs × M gens), which
 * is much more robust than a greedy left-to-right scan when the same prompt
 * text appears multiple times (e.g. "Implement the plan…" sent twice).
 *
 * Complexity: O(N*M). Both N and M are typically a few dozen, so this is
 * effectively instant.
 */
export function alignUserTimestamps(
  userTexts: string[],
  sessionStartSec: number,
  sessionEndSec: number,
  generations: CursorGeneration[]
): Array<number | undefined> {
  const result: Array<number | undefined> = new Array(userTexts.length).fill(
    undefined
  );
  if (userTexts.length === 0 || generations.length === 0) return result;

  const bufferMs = 5 * 60_000;
  const startMs = sessionStartSec * 1000 - bufferMs;
  const endMs = sessionEndSec * 1000 + bufferMs;
  const window = generations.filter(
    (g) =>
      g.unixMs >= startMs &&
      g.unixMs <= endMs &&
      typeof g.textDescription === "string" &&
      g.textDescription.length > 0 &&
      // `apply` rows describe an edit being accepted, not the user's prompt;
      // their textDescription is a filename, never a chat message.
      g.type !== "apply"
  );
  if (window.length === 0) return result;

  const N = userTexts.length;
  const M = window.length;

  // Precompute pairwise scores. Scores below the floor are zero so the DP
  // can never pick them up (they degrade to "skip this pair").
  const score: number[][] = Array.from({ length: N }, () => new Array(M).fill(0));
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const s = matchScore(userTexts[i], window[j].textDescription || "");
      if (s >= MATCH_FLOOR) score[i][j] = s;
    }
  }

  // dp[i][j] = best total score using the first i user msgs and first j gens.
  // back[i][j] = "match" (took diagonal), "skipUser", or "skipGen" — used to
  // recover the actual pairing on the way back.
  const dp: number[][] = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0));
  type Move = "match" | "skipUser" | "skipGen";
  const back: Move[][] = Array.from({ length: N + 1 }, () => new Array<Move>(M + 1).fill("skipUser"));

  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      const skipUser = dp[i - 1][j];
      const skipGen = dp[i][j - 1];
      const pairScore = score[i - 1][j - 1];
      const matchOption = pairScore > 0 ? dp[i - 1][j - 1] + pairScore : -1;
      let best = skipUser;
      let move: Move = "skipUser";
      if (skipGen > best) {
        best = skipGen;
        move = "skipGen";
      }
      if (matchOption > best) {
        best = matchOption;
        move = "match";
      }
      dp[i][j] = best;
      back[i][j] = move;
    }
  }

  // Walk back from dp[N][M] to recover matched pairs.
  let i = N;
  let j = M;
  while (i > 0 && j > 0) {
    const move = back[i][j];
    if (move === "match") {
      result[i - 1] = Math.floor(window[j - 1].unixMs / 1000);
      i -= 1;
      j -= 1;
    } else if (move === "skipUser") {
      i -= 1;
    } else {
      j -= 1;
    }
  }

  return result;
}
