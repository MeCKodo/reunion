// RemoteDataProvider — fetches session data from the team-mode `ingest` HTTP
// API (see `ai_coding_ingest/docs/contract.md` §"读接口"). All requests run
// inside Reunion's main process so the bearer token never leaves Node and we
// don't need CORS on the ingest side.
//
// Capability flags are deliberately conservative: anything that mutates local
// disk or runs an LLM is disabled. The frontend hides the corresponding UI by
// reading `capabilities` over `GET /api/mode`.

import { TEAM_REPO_HOST_ALLOWLIST } from "../config.js";
import {
  buildContentFromEvents,
  mapRemoteEventsToTimeline,
  type RemoteEvent,
} from "./remote-mapper.js";
import type {
  ProviderCapabilities,
  Session,
  SourceId,
  TimelineEvent,
} from "../types.js";
import type {
  DataSourceProvider,
  ProviderListFilter,
  RepoSummary,
  SessionDetailPayload,
  SessionListResult,
  SessionMetrics,
  SessionSearchHit,
} from "./types.js";

const REMOTE_CAPABILITIES: ProviderCapabilities = {
  annotations: false,
  aiTagging: false,
  smartExport: false,
  deleteSession: false,
  downloadJsonl: false,
  openLocalFile: false,
  subagents: false,
  // Detail returns sampled events; UI must show the "回放可能不完整" banner.
  fullTranscript: false,
  // Search degrades to project/repo LIKE on ingest.
  fullTextSearch: false,
};

const DEFAULT_LIST_PAGE_SIZE = 50;
const MAX_LIST_PAGE_SIZE = 200;
const DEFAULT_LIST_WINDOW_SEC = 30 * 24 * 60 * 60;

export type RemoteProviderConfig = {
  baseUrl: string;
  token: string;
  /** Optional — defaults to global fetch. Lets tests inject a stub. */
  fetchFn?: typeof fetch;
  /** Network timeout in ms. Defaults to 15s. */
  timeoutMs?: number;
};

export class RemoteAuthError extends Error {
  constructor(message = "remote ingest rejected the bearer token") {
    super(message);
    this.name = "RemoteAuthError";
  }
}

export class RemoteUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteUnreachableError";
  }
}

/**
 * Map the wire-level `aiClient` field to Reunion's `SourceId`. The ingest
 * server only knows `claude_code` / `cursor`; future Codex support over
 * ingest can be added when the collector starts uploading those.
 */
function aiClientToSource(value: string | undefined): SourceId {
  switch (value) {
    case "cursor":
      return "cursor";
    case "claude_code":
      return "claude-code";
    default:
      return "claude-code";
  }
}

/**
 * Extract the host portion of a git remote URL. Mirrors the helper of the
 * same shape in ai_coding_collector / src/core/gitHelpers.ts; we keep a
 * second copy here so the renderer doesn't take a runtime dep on the
 * collector. Returns `null` when the URL is empty or unparseable.
 *
 * Exported for unit testing — callers in this file should prefer
 * `passesRepoHostAllowlist`.
 */
export function extractGitHost(remoteUrl: string | undefined | null): string | null {
  if (!remoteUrl) return null;
  const url = remoteUrl.trim();
  if (!url) return null;
  const sshMatch = /^[^@\s]+@([^:\s]+):/.exec(url);
  if (sshMatch?.[1]) return sshMatch[1].toLowerCase();
  try {
    const parsed = new URL(url.replace(/^git\+/i, ""));
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Defensive client-side gate: when a non-empty allowlist is provided we
 * drop sessions whose git remote host doesn't match. Rows with no usable
 * remote URL fail open (kept) when the allowlist is empty, fail closed
 * (dropped) otherwise — keeping noise out of the team-mode sidebar even if
 * the upstream collector hasn't been upgraded yet.
 *
 * Exported with an explicit `allowlist` arg so unit tests can exercise it
 * without mucking with the singleton in `config.ts`.
 */
export function isRowAllowedByHosts(
  gitRepo: string | undefined | null,
  allowlist: ReadonlyArray<string>
): boolean {
  if (allowlist.length === 0) return true;
  const host = extractGitHost(gitRepo);
  if (!host) return false;
  return allowlist.includes(host);
}

function passesRepoHostAllowlist(row: ListRow): boolean {
  return isRowAllowedByHosts(row.gitRepo, TEAM_REPO_HOST_ALLOWLIST);
}

/** Strip `.git` suffix and pull the trailing `<owner>/<repo>` from a git URL. */
function deriveRepoLabel(gitRepo: string | undefined, projectName: string | undefined): string {
  const repo = (gitRepo || "").trim();
  if (!repo) return (projectName || "(unknown)").trim() || "(unknown)";
  const cleaned = repo.replace(/\.git$/i, "");
  const slashIdx = cleaned.lastIndexOf("/");
  const colonIdx = cleaned.lastIndexOf(":");
  const sep = Math.max(slashIdx, colonIdx);
  if (sep < 0) return cleaned;
  return cleaned.slice(sep + 1);
}

/** Convert the ingest aggregated row into a Reunion `Session`. */
function rowToSession(row: ListRow): Session {
  const source = aiClientToSource(row.aiClient);
  const sessionId = row.sessionId;
  // Use a `team:` prefix so remote keys never collide with local
  // `<source>:<repo>:<sessionId>` keys; this is also how the http-server
  // dispatches detail requests back to the right provider.
  const sessionKey = `team:${source}:${sessionId}`;
  const repo = deriveRepoLabel(row.gitRepo, row.projectName);
  const startedAt = row.sessionStart ? Math.floor(new Date(row.sessionStart).getTime() / 1000) : 0;
  const lastCreatedSec = row.lastCreatedAt ? Math.floor(new Date(row.lastCreatedAt).getTime() / 1000) : 0;
  const updatedAt = lastCreatedSec || startedAt;
  const title = formatRemoteTitle(row, lastCreatedSec || startedAt);

  return {
    source,
    sessionKey,
    sessionId,
    repo,
    repoPath: undefined,
    title,
    filePath: undefined,
    provider: "remote",
    // Surface clientTag to the renderer so the row chip + sidebar filter
    // both have something to look at. Empty / missing string is preserved
    // verbatim so the UI can route those sessions to the "未分类" bucket
    // without having to special-case undefined-vs-"" elsewhere.
    clientTag: typeof row.clientTag === "string" ? row.clientTag : undefined,
    startedAt: startedAt || updatedAt,
    updatedAt,
    sizeBytes: 0,
    mtimeMs: updatedAt * 1000,
    content: "",
    segments: [],
  };
}

function formatRemoteTitle(row: ListRow, tsSec: number): string {
  // Prefer the ingest-provided chatTitle (truncated first user message).
  // The repo name is already shown in the sidebar's group header, so we
  // intentionally avoid prefixing it again — this row is "what was this
  // chat *about*", not "which repo".
  const chatTitle = (row.chatTitle ?? "").trim();
  if (chatTitle) return chatTitle;
  const ts = tsSec > 0 ? new Date(tsSec * 1000).toLocaleString() : "";
  if (ts) return ts;
  // Final fallback: project name. Reached only when ingest returns neither
  // chatTitle nor a usable timestamp (legacy data, malformed rows).
  return (row.projectName || "").trim() || "(no project)";
}

// ---------- ingest wire types (subset of the contract) ----------

type ListRow = {
  sessionId: string;
  aiClient: string;
  clientVersion: string;
  projectName: string;
  gitRepo: string;
  gitBranch: string;
  model: string;
  /** Optional: ingest ≥ 2026-05-07 returns this; older deployments omit. */
  chatTitle?: string;
  /** Optional: ingest ≥ 2026-05-08 returns this; older deployments omit. */
  clientTag?: string;
  sessionStart?: string;
  sessionEnd?: string;
  lastCreatedAt: string;
  totalDurationSec: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheHitRate: number;
  promptCount: number;
  assistantTurns: number;
  toolCallsTotal: number;
  versionCount: number;
};

type ListResponse = {
  items: ListRow[];
  page: number;
  pageSize: number;
  from: string;
  to: string;
};

type DetailResponse = ListRow & {
  lastUploadTime?: string;
  truncated?: boolean;
  hint?: string;
  events: RemoteEvent[];
};

type ReposResponse = {
  items: string[];
  from: string;
  to: string;
};

// ----------------------------------------------------------------

export class RemoteDataProvider implements DataSourceProvider {
  readonly mode = "team" as const;
  readonly capabilities = REMOTE_CAPABILITIES;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: RemoteProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.fetchFn = config.fetchFn || fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  // No work to do at warmup — list query lazily populates a session.
  async warmup(): Promise<void> {}

  async listSessions(filter: ProviderListFilter): Promise<SessionListResult> {
    return this.fetchList(filter);
  }

  async searchSessions(filter: ProviderListFilter): Promise<SessionListResult> {
    return this.fetchList(filter);
  }

  async getSessionDetail(sessionKey: string): Promise<SessionDetailPayload | null> {
    const sessionId = parseRemoteSessionKey(sessionKey);
    if (!sessionId) return null;

    const json = await this.requestJson<DetailResponse>(`/sessions/${encodeURIComponent(sessionId)}`);
    const session = rowToSession(json);
    const events: TimelineEvent[] = mapRemoteEventsToTimeline(json.events ?? [], json.sessionId);
    const content = buildContentFromEvents(events);

    const metrics: SessionMetrics = {
      inputTokens: json.inputTokens,
      outputTokens: json.outputTokens,
      cacheReadTokens: json.cacheReadTokens,
      cacheCreationTokens: json.cacheCreationTokens,
      cacheHitRate: json.cacheHitRate,
      promptCount: json.promptCount,
      assistantTurns: json.assistantTurns,
      toolCallsTotal: json.toolCallsTotal,
      totalDurationSec: json.totalDurationSec,
      versionCount: json.versionCount,
      truncated: Boolean(json.truncated),
    };

    return {
      session: { ...session, content },
      detail: {
        rawContent: content,
        content,
        events,
        // Remote events have no aiService.generations alignment data so the
        // UI must treat all timestamps as estimates.
        clockAlignment: undefined,
      },
      metrics,
      lastUploadTime: json.lastUploadTime
        ? Math.floor(new Date(json.lastUploadTime).getTime() / 1000)
        : undefined,
      hint: json.hint || (json.truncated ? "truncated" : undefined),
      // Remote provider has no subagent feed yet; the contract intentionally
      // doesn't expose Cursor sidechain / Claude /sub-agent splits.
      subagents: [],
    };
  }

  async listRepos(filter?: Pick<ProviderListFilter, "clientTag">): Promise<RepoSummary[]> {
    const params: Record<string, string | undefined> = {
      tag: normalizeClientTagParam(filter?.clientTag),
    };
    const url = this.buildUrl("/repos", params);
    const json = await this.fetchJson<ReposResponse>(url);
    return (json.items || [])
      .filter((repoUrl) => passesRepoHostAllowlist({ gitRepo: repoUrl } as ListRow))
      .map((repo) => ({
        repo,
        sessionCount: undefined,
        lastUpdatedAt: undefined,
      }));
  }

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------

  private async fetchList(filter: ProviderListFilter): Promise<SessionListResult> {
    const params: Record<string, string | undefined> = {
      repo: filter.repo,
      aiClient: filter.aiClient,
      model: filter.model,
      tag: normalizeClientTagParam(filter.clientTag),
      q: filter.q,
      from: secondsToIso(filter.from),
      to: secondsToIso(filter.to),
      page: filter.page != null ? String(filter.page) : undefined,
      pageSize:
        filter.pageSize != null
          ? String(Math.min(filter.pageSize, MAX_LIST_PAGE_SIZE))
          : String(DEFAULT_LIST_PAGE_SIZE),
    };
    // If the caller passed `days` instead of `from`/`to`, expand it locally so
    // the server still gets explicit RFC3339 bounds.
    if ((filter.days ?? 0) > 0 && !filter.from && !filter.to) {
      const now = Math.floor(Date.now() / 1000);
      params.to = secondsToIso(now);
      params.from = secondsToIso(now - filter.days! * 24 * 60 * 60);
    }
    if (!params.from && !params.to) {
      const now = Math.floor(Date.now() / 1000);
      params.to = secondsToIso(now);
      params.from = secondsToIso(now - DEFAULT_LIST_WINDOW_SEC);
    }

    const url = this.buildUrl("/sessions", params);
    const json = await this.fetchJson<ListResponse>(url);

    const hits: SessionSearchHit[] = (json.items || [])
      .filter(passesRepoHostAllowlist)
      .map((row) => {
        const session = rowToSession(row);
        return { session };
      });

    return {
      count: hits.length,
      results: hits,
      page: json.page,
      pageSize: json.pageSize,
      from: json.from ? Math.floor(new Date(json.from).getTime() / 1000) : undefined,
      to: json.to ? Math.floor(new Date(json.to).getTime() / 1000) : undefined,
    };
  }

  private async requestJson<T>(pathSegment: string): Promise<T> {
    return this.fetchJson<T>(this.buildUrl(pathSegment, {}));
  }

  private buildUrl(pathSegment: string, params: Record<string, string | undefined>): string {
    const url = new URL(this.baseUrl + pathSegment);
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === "") continue;
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchFn(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
        signal: ctrl.signal,
      });
    } catch (error) {
      throw new RemoteUnreachableError(`remote request failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 401) {
      throw new RemoteAuthError();
    }
    if (resp.status === 404) {
      // Translate to a structured error so callers can map it to HTTP 404.
      const text = await resp.text().catch(() => "");
      throw new RemoteNotFoundError(text || `not found: ${url}`);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`remote responded with ${resp.status}: ${text}`);
    }
    return (await resp.json()) as T;
  }
}

export class RemoteNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteNotFoundError";
  }
}

/** Returns the bare session UUID for a remote sessionKey, or null. */
export function parseRemoteSessionKey(sessionKey: string): string | null {
  if (!sessionKey.startsWith("team:")) return null;
  const rest = sessionKey.slice("team:".length);
  // Format is `team:<source>:<sessionId>`. Split on the FIRST colon only so a
  // sessionId containing colons (shouldn't happen for UUIDs but be defensive)
  // round-trips intact.
  const idx = rest.indexOf(":");
  if (idx < 0) return null;
  return rest.slice(idx + 1);
}

function secondsToIso(seconds: number | undefined): string | undefined {
  if (seconds == null || seconds === 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Normalise the optional `clientTag` filter into the wire-level value
 * ingest expects on `?tag=`:
 *   - `undefined` / `""`     → no filter (return undefined; `buildUrl`
 *                              will drop the query parameter entirely)
 *   - `"__none__"`            → un-tagged-only (passed through verbatim;
 *                              ingest's three-way switch interprets
 *                              this sentinel)
 *   - any other non-empty val → exact-match filter (e.g. `"server"`)
 *
 * Trimming guards against UI components emitting `" server "` from a
 * mis-bound input event.
 */
function normalizeClientTagParam(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
