import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_SOURCE_ROOTS, INDEX_FILE } from "./config";
import { ensureDataDir } from "./lib/fs";
import { normalizeTs } from "./lib/text";
import { createAdapters, findAdapter } from "./sources";
import type { SourceAdapter } from "./sources";
import { parseTranscript } from "./transcript";
import type {
  ComposerMeta,
  IndexData,
  ReindexStats,
  Session,
  SourceId,
  SourceRoots,
  TranscriptFileEntry,
} from "./types";

let inMemoryIndex: IndexData | null = null;
let isRefreshingIndex = false;

export class ReindexBusyError extends Error {
  constructor() {
    super("reindex already in progress");
    this.name = "ReindexBusyError";
  }
}

export function getInMemoryIndex(): IndexData | null {
  return inMemoryIndex;
}

export function isReindexBusy(): boolean {
  return isRefreshingIndex;
}

export function resolveSourceRoots(roots: SourceRoots): SourceRoots {
  return {
    cursor: path.resolve(roots.cursor),
    claudeCode: path.resolve(roots.claudeCode),
    codex: path.resolve(roots.codex),
  };
}

type SourceScanResult = {
  source: SourceId;
  entries: TranscriptFileEntry[];
  elapsedMs: number;
};

async function scanAdapter(adapter: SourceAdapter): Promise<SourceScanResult> {
  const started = Date.now();
  const entries = await adapter.collectTranscriptFiles();
  return {
    source: adapter.id,
    entries,
    elapsedMs: Date.now() - started,
  };
}

export async function buildIndex(
  rootsInput: SourceRoots,
  prevIndex?: IndexData | null
): Promise<ReindexStats> {
  const roots = resolveSourceRoots(rootsInput);
  const startedAt = Date.now();
  const adapters = createAdapters(roots);

  const scans = await Promise.all(adapters.map((adapter) => scanAdapter(adapter)));

  const prevSessionsByKey = new Map<string, Session>();
  const sameRoots =
    prevIndex &&
    prevIndex.sourceRoots &&
    prevIndex.sourceRoots.cursor === roots.cursor &&
    prevIndex.sourceRoots.claudeCode === roots.claudeCode &&
    prevIndex.sourceRoots.codex === roots.codex;

  if (sameRoots && prevIndex) {
    for (const session of prevIndex.sessions) {
      prevSessionsByKey.set(session.sessionKey, session);
    }
  }

  const allEntries: TranscriptFileEntry[] = scans.flatMap((scan) => scan.entries);
  const reusableKeys = new Set<string>();
  let totalChanged = 0;
  const changedBySource = new Map<SourceId, number>();

  for (const entry of allEntries) {
    const prev = prevSessionsByKey.get(entry.sessionKey);
    if (
      prev &&
      prev.source === entry.source &&
      prev.mtimeMs === entry.mtimeMs &&
      prev.filePath === entry.filePath &&
      prev.sizeBytes === entry.size &&
      Array.isArray(prev.segments)
    ) {
      reusableKeys.add(entry.sessionKey);
      continue;
    }
    totalChanged += 1;
    changedBySource.set(entry.source, (changedBySource.get(entry.source) || 0) + 1);
  }

  const liveKeys = new Set(allEntries.map((entry) => entry.sessionKey));
  let removedCount = 0;
  for (const key of prevSessionsByKey.keys()) {
    if (!liveKeys.has(key)) removedCount += 1;
  }

  const metadataByAdapter = new Map<SourceId, Map<string, ComposerMeta>>();
  await Promise.all(
    adapters.map(async (adapter) => {
      if (!adapter.loadMetadata) return;
      const changed = changedBySource.get(adapter.id) || 0;
      const needMetadata = changed > 0 || !sameRoots;
      if (!needMetadata) return;
      try {
        const meta = await adapter.loadMetadata();
        metadataByAdapter.set(adapter.id, meta);
      } catch {
        // ignore metadata failures; they are non-fatal
      }
    })
  );

  const adapterById = new Map<SourceId, SourceAdapter>(adapters.map((adapter) => [adapter.id, adapter]));

  const sessions: Session[] = [];
  await Promise.all(
    allEntries.map(async (entry) => {
      try {
        if (reusableKeys.has(entry.sessionKey)) {
          const prev = prevSessionsByKey.get(entry.sessionKey)!;
          sessions.push(prev);
          return;
        }
        const adapter = adapterById.get(entry.source);
        if (!adapter) return;

        const content = await adapter.readTranscriptContent(entry.filePath);
        const meta = metadataByAdapter.get(entry.source)?.get(entry.sessionId);
        const mtimeSec = Math.floor(entry.mtimeMs / 1000);
        const fallbackStart = Math.floor(entry.birthtimeMs / 1000);
        const startedTs = normalizeTs(meta?.createdAt, fallbackStart);
        const updatedTs = normalizeTs(meta?.lastUpdatedAt, mtimeSec);
        const sStart = Math.min(startedTs, updatedTs);
        const sEnd = Math.max(startedTs, updatedTs);
        const segments = parseTranscript(content, sStart, sEnd);
        const title = meta?.title?.trim() || adapter.deriveTitle(content);

        sessions.push({
          source: entry.source,
          sessionKey: entry.sessionKey,
          sessionId: entry.sessionId,
          repo: entry.repo,
          repoPath: entry.repoPath,
          title,
          filePath: entry.filePath,
          startedAt: sStart,
          updatedAt: sEnd,
          sizeBytes: entry.size,
          mtimeMs: entry.mtimeMs,
          content,
          segments,
        });
      } catch {
        // Skip unreadable files.
      }
    })
  );

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);

  const indexData: IndexData = {
    sourceRoots: roots,
    generatedAt: Math.floor(Date.now() / 1000),
    sessions,
  };

  inMemoryIndex = indexData;

  const noChange =
    sameRoots && totalChanged === 0 && removedCount === 0 && prevIndex!.sessions.length === sessions.length;
  if (!noChange) {
    await ensureDataDir();
    await fs.writeFile(INDEX_FILE, JSON.stringify(indexData), "utf-8");
  }

  const bySource = scans.map((scan) => {
    const sessionsForSource = sessions.filter((session) => session.source === scan.source).length;
    return {
      source: scan.source,
      files_found: scan.entries.length,
      sessions_indexed: sessionsForSource,
      elapsed_ms: scan.elapsedMs,
    };
  });

  return {
    source_roots: roots,
    files_found: allEntries.length,
    sessions_indexed: sessions.length,
    elapsed_ms: Date.now() - startedAt,
    by_source: bySource,
  };
}

function isLegacyIndex(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return true;
  const parsed = raw as Partial<IndexData> & { sourceRoot?: string };
  if (!parsed.sourceRoots) return true;
  if (!Array.isArray(parsed.sessions)) return true;
  if (parsed.sessions.length === 0) return false;
  const first = parsed.sessions[0];
  if (!first || typeof first !== "object") return true;
  if (typeof (first as Session).source !== "string") return true;
  if (typeof (first as Session).mtimeMs !== "number") return true;
  if (!Array.isArray((first as Session).segments)) return true;
  return false;
}

export async function loadIndex(): Promise<IndexData> {
  if (inMemoryIndex) return inMemoryIndex;

  try {
    const raw = await fs.readFile(INDEX_FILE, "utf-8");
    const parsed = JSON.parse(raw) as IndexData;

    if (isLegacyIndex(parsed)) {
      const stats = await buildIndex(DEFAULT_SOURCE_ROOTS, null);
      if (!inMemoryIndex) throw new Error(`index rebuild failed: ${JSON.stringify(stats)}`);
      return inMemoryIndex;
    }

    parsed.sessions = parsed.sessions.map((session) => ({
      ...session,
      startedAt: session.startedAt || session.updatedAt,
      title: session.title || "Untitled session",
      segments: Array.isArray(session.segments) ? session.segments : [],
    }));
    inMemoryIndex = parsed;
    return parsed;
  } catch {
    const stats = await buildIndex(DEFAULT_SOURCE_ROOTS, null);
    if (!inMemoryIndex) throw new Error(`index build failed: ${JSON.stringify(stats)}`);
    return inMemoryIndex;
  }
}

export async function safeReindex(roots: SourceRoots): Promise<ReindexStats> {
  if (isRefreshingIndex) throw new ReindexBusyError();
  isRefreshingIndex = true;
  try {
    return await buildIndex(roots, inMemoryIndex);
  } finally {
    isRefreshingIndex = false;
  }
}

/**
 * Drop a session from both the in-memory index and the persisted
 * `chat_index.json`. Returns the removed session for callers that need to
 * clean up sibling state (annotations, open detail panes, …). Safe to call
 * with an unknown key — returns `null` in that case.
 *
 * The persisted index is rewritten only when something actually changed,
 * matching the rest of `buildIndex`'s minimal-write behavior.
 */
export async function removeSessionFromIndex(sessionKey: string): Promise<Session | null> {
  if (!inMemoryIndex) {
    await loadIndex();
  }
  const current = inMemoryIndex;
  if (!current) return null;

  const idx = current.sessions.findIndex((session) => session.sessionKey === sessionKey);
  if (idx < 0) return null;

  const [removed] = current.sessions.splice(idx, 1);
  current.generatedAt = Math.floor(Date.now() / 1000);

  await ensureDataDir();
  await fs.writeFile(INDEX_FILE, JSON.stringify(current), "utf-8");

  return removed;
}

export async function safeReindexNoThrow(roots: SourceRoots): Promise<ReindexStats | null> {
  if (isRefreshingIndex) return null;
  return await safeReindex(roots);
}

export function getAdapterById(sourceId: SourceId): SourceAdapter | undefined {
  const roots = inMemoryIndex?.sourceRoots || DEFAULT_SOURCE_ROOTS;
  const adapters = createAdapters(resolveSourceRoots(roots));
  return findAdapter(adapters, sourceId);
}

export function getRepos(indexData: IndexData) {
  const map = new Map<string, { source: SourceId; session_count: number; last_updated_at: number; repo_path?: string }>();
  for (const session of indexData.sessions) {
    const key = `${session.source}:${session.repo}`;
    const curr = map.get(key);
    if (!curr) {
      map.set(key, {
        source: session.source,
        session_count: 1,
        last_updated_at: session.updatedAt,
        repo_path: session.repoPath,
      });
    } else {
      curr.session_count += 1;
      curr.last_updated_at = Math.max(curr.last_updated_at, session.updatedAt);
      if (!curr.repo_path && session.repoPath) curr.repo_path = session.repoPath;
    }
  }

  return Array.from(map.entries())
    .map(([key, value]) => {
      const [, ...rest] = key.split(":");
      const repo = rest.join(":");
      return { repo, ...value };
    })
    .sort((a, b) => {
      if (b.session_count !== a.session_count) return b.session_count - a.session_count;
      return a.repo.localeCompare(b.repo);
    });
}

export function getSourceSummaries(indexData: IndexData) {
  const counts = new Map<SourceId, { session_count: number; last_updated_at: number }>();
  for (const session of indexData.sessions) {
    const curr = counts.get(session.source);
    if (!curr) {
      counts.set(session.source, { session_count: 1, last_updated_at: session.updatedAt });
    } else {
      curr.session_count += 1;
      curr.last_updated_at = Math.max(curr.last_updated_at, session.updatedAt);
    }
  }
  const displayNameById: Record<SourceId, string> = {
    cursor: "Cursor",
    "claude-code": "Claude Code",
    codex: "Codex",
  };
  const order: SourceId[] = ["cursor", "claude-code", "codex"];
  return order.map((id) => ({
    id,
    display_name: displayNameById[id],
    session_count: counts.get(id)?.session_count || 0,
    last_updated_at: counts.get(id)?.last_updated_at || 0,
  }));
}
