// LocalDataProvider — wraps the existing on-disk pipeline (`index-store` +
// per-source adapters + annotations) without changing semantics. It exists so
// the rest of `http-server.ts` can talk to a single provider interface
// regardless of mode. All capability flags are `true`: personal mode owns the
// transcript files and is allowed to do anything.

import {
  buildIndex,
  getAdapterById,
  getInMemoryIndex,
  getRepos,
  getSourceSummaries,
  loadIndex,
} from "../index-store.js";
import { loadAnnotations, projectAnnotation } from "../annotations.js";
import { searchSessions } from "../search.js";
import type {
  DetailedTranscript,
  ProviderCapabilities,
  Session,
  SourceRoots,
  SubagentSessionDetail,
} from "../types.js";
import type {
  DataSourceProvider,
  ProviderListFilter,
  RepoSummary,
  SessionDetailPayload,
  SessionListResult,
  SessionSearchHit,
} from "./types.js";

const LOCAL_CAPABILITIES: ProviderCapabilities = {
  annotations: true,
  aiTagging: true,
  smartExport: true,
  deleteSession: true,
  downloadJsonl: true,
  openLocalFile: true,
  subagents: true,
  fullTranscript: true,
  fullTextSearch: true,
};

function buildHitFromSession(
  session: Session,
  annotations: Awaited<ReturnType<typeof loadAnnotations>>
): SessionSearchHit {
  return {
    session,
    annotation: annotations[session.sessionKey],
  };
}

async function loadDetailsForSession(session: Session): Promise<DetailedTranscript> {
  const adapter = getAdapterById(session.source);
  if (!adapter) {
    throw new Error(`no adapter registered for source ${session.source}`);
  }
  if (!session.filePath) {
    // Defensive — local sessions always have a filePath; this guards against
    // a stale chat_index.json that was hand-edited.
    throw new Error(`local session ${session.sessionKey} missing filePath`);
  }
  return adapter.loadDetailedTranscript(
    session.filePath,
    session.startedAt,
    session.updatedAt,
    `main:${session.sessionId}`
  );
}

async function loadSubagentsForSession(
  session: Session
): Promise<SubagentSessionDetail[]> {
  const adapter = getAdapterById(session.source);
  if (!adapter || !adapter.loadSubagentSessions) return [];
  return adapter.loadSubagentSessions(session);
}

export class LocalDataProvider implements DataSourceProvider {
  readonly mode = "personal" as const;
  readonly capabilities = LOCAL_CAPABILITIES;
  readonly roots: SourceRoots;

  constructor(roots: SourceRoots) {
    this.roots = roots;
  }

  async warmup(): Promise<void> {
    // Mirror the previous startup path: load (or build) the index and let the
    // background reindex catch up later in http-server.ts.
    await loadIndex();
    try {
      await buildIndex(this.roots, getInMemoryIndex());
    } catch (error) {
      // buildIndex already logs; non-fatal.
      console.error("provider warmup: incremental index failed:", error);
    }
  }

  async listSessions(filter: ProviderListFilter): Promise<SessionListResult> {
    return this.searchSessions({ ...filter, q: "" });
  }

  async searchSessions(filter: ProviderListFilter): Promise<SessionListResult> {
    const indexData = await loadIndex();
    const annotations = await loadAnnotations();

    const limit = clampInt(filter.pageSize, 1, 500, 100);
    const days = filter.days != null ? Math.max(0, filter.days) : 0;

    const results = searchSessions(
      indexData,
      filter.q || "",
      filter.repo || "",
      limit,
      days,
      annotations,
      filter.source || ""
    );

    return {
      count: results.length,
      results: results.map((row) => ({
        session: indexData.sessions.find((s) => s.sessionKey === row.session_key)!,
        snippet: row.snippet,
        matchCount: row.match_count,
        messageHits: row.message_hits.map((h) => ({
          segmentIndex: h.segment_index,
          role: h.role,
          ts: h.ts,
          preview: h.preview,
        })),
        annotation: annotations[row.session_key],
      })),
      page: filter.page ?? 1,
      pageSize: limit,
    };
  }

  async getSessionDetail(sessionKey: string): Promise<SessionDetailPayload | null> {
    const indexData = await loadIndex();
    const session = indexData.sessions.find((item) => item.sessionKey === sessionKey);
    if (!session) return null;
    const annotations = await loadAnnotations();
    const detailed = await loadDetailsForSession(session);
    const subagents = await loadSubagentsForSession(session);
    return {
      session: {
        ...session,
        ...projectAnnotation(annotations, session.sessionKey),
      },
      detail: detailed,
      subagents: subagents.map((subagent) => ({
        sessionId: subagent.sessionId,
        title: subagent.title,
        filePath: subagent.filePath,
        startedAt: subagent.startedAt,
        updatedAt: subagent.updatedAt,
        sizeBytes: subagent.sizeBytes,
        rawContent: subagent.rawContent,
        content: subagent.content,
        events: subagent.events,
      })),
    };
  }

  async listRepos(): Promise<RepoSummary[]> {
    const indexData = await loadIndex();
    return getRepos(indexData).map((row) => ({
      repo: row.repo,
      source: row.source,
      sessionCount: row.session_count,
      lastUpdatedAt: row.last_updated_at,
      repoPath: row.repo_path,
    }));
  }

  /** Convenience used by the http server to populate the source summary tab. */
  async listSources() {
    const indexData = await loadIndex();
    return getSourceSummaries(indexData);
  }

  // Re-export the helpers above so http-server can keep using the same code
  // paths it had before (delete / download / open use the underlying
  // index-store directly because they are local-only).
  static buildHitFromSession = buildHitFromSession;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || Number.isNaN(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return Math.floor(value);
}
