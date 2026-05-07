// Top-level data-source abstraction. Reunion historically read directly from
// the on-machine adapters; team mode adds a remote source (the `ingest` Go
// service backed by MySQL). This module defines the contract both implementations
// satisfy so `http-server.ts` can stay agnostic of where session data comes from.
//
// Personal mode is implemented by `LocalDataProvider` (wraps the existing
// `index-store` + adapters with no behaviour change). Team mode is implemented
// by `RemoteDataProvider`, which runs HTTP calls inside the Reunion main
// process — the renderer never sees the bearer token and we sidestep ingest
// CORS entirely.

import type {
  AppMode,
  DetailedTranscript,
  ProviderCapabilities,
  Session,
  SessionAnnotation,
} from "../types.js";

/**
 * Filter passed to `listSessions`. Local provider treats `q` as a full-text
 * search over `Session.content`; remote provider sends `q` to ingest as a
 * project-or-repo `LIKE`. `from` / `to` are unix seconds (consistent with
 * `Session.startedAt`); the local provider may also accept the legacy `days`
 * form via the `days` shortcut.
 */
export type ProviderListFilter = {
  q?: string;
  repo?: string;
  source?: string;
  /** AI client name (`claude_code` / `cursor`); only meaningful for remote. */
  aiClient?: string;
  /** Model name; only meaningful for remote. */
  model?: string;
  from?: number;
  to?: number;
  /** Convenience for "last N days"; ignored when `from`/`to` are set. */
  days?: number;
  page?: number;
  pageSize?: number;
};

/**
 * One row in a search / list response. Local mode populates `messageHits` /
 * `snippet` because we have full-text search; remote mode leaves them empty
 * (the `q` parameter only matched project / repo names).
 */
export type SessionSearchHit = {
  session: Session;
  /** HTML snippet around the first match, with `<mark>` tags. */
  snippet?: string;
  matchCount?: number;
  messageHits?: Array<{
    segmentIndex: number;
    role: string;
    ts: number;
    preview: string;
  }>;
  annotation?: SessionAnnotation;
};

/**
 * Result for `listSessions` — same as a search response but without `q`. We
 * keep one shape so the front-end list / search components can render
 * identically.
 */
export type SessionListResult = {
  count: number;
  results: SessionSearchHit[];
  /**
   * Echo of the resolved page / pageSize / window. Useful for remote mode
   * where the server has the authoritative defaults.
   */
  page?: number;
  pageSize?: number;
  from?: number;
  to?: number;
};

/**
 * Aggregate metrics surfaced on a session detail. Local mode leaves all
 * remote-only fields undefined.
 */
export type SessionMetrics = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheHitRate?: number;
  promptCount?: number;
  assistantTurns?: number;
  toolCallsTotal?: number;
  totalDurationSec?: number;
  versionCount?: number;
  truncated?: boolean;
};

/** Detail-page payload returned by `getSessionDetail`. */
export type SessionDetailPayload = {
  session: Session;
  detail: DetailedTranscript;
  /** Optional team-mode aggregates; undefined for local. */
  metrics?: SessionMetrics;
  /** Last upload time (remote only). Local mode uses `session.updatedAt`. */
  lastUploadTime?: number;
  /**
   * Hint codes the UI may surface as banners. Examples:
   *   - "no_conversations_layer" — remote session with no sampled events.
   *   - "truncated"               — remote session hit MaxDetailRows.
   */
  hint?: string;
  /** Subagent timelines (local only; remote currently always returns []). */
  subagents: Array<{
    sessionId: string;
    title: string;
    filePath?: string;
    startedAt: number;
    updatedAt: number;
    sizeBytes: number;
    rawContent: string;
    content: string;
    events: DetailedTranscript["events"];
  }>;
};

export type RepoSummary = {
  repo: string;
  source?: string;
  sessionCount?: number;
  lastUpdatedAt?: number;
  repoPath?: string;
};

/**
 * Provider contract. The provider owns: list / detail queries, search,
 * repo dropdown, and capability flags. Anything destructive (delete,
 * download, AI tagging, …) lives outside this interface and is gated by
 * `capabilities`.
 */
export interface DataSourceProvider {
  readonly mode: AppMode;
  readonly capabilities: ProviderCapabilities;

  /** Eagerly load the session catalog. May be a no-op for remote. */
  warmup?(): Promise<void>;

  listSessions(filter: ProviderListFilter): Promise<SessionListResult>;
  searchSessions(filter: ProviderListFilter): Promise<SessionListResult>;

  /** `null` if the session key isn't recognised by this provider. */
  getSessionDetail(sessionKey: string): Promise<SessionDetailPayload | null>;

  /** Repo dropdown / sidebar feed. */
  listRepos(): Promise<RepoSummary[]>;
}
