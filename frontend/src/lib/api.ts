import type {
  RepoOption,
  SessionAnnotation,
  SessionDetail,
  SearchResult,
  SourceFilter,
  SourceSummary,
  TagSummary,
} from "./types";

export type SearchParams = {
  query: string;
  days: string;
  repo: string;
  source?: SourceFilter;
  limit?: number;
};

export type SearchResponse = {
  results: SearchResult[];
  count: number;
};

export async function fetchSearch(params: SearchParams): Promise<SearchResponse> {
  const u = new URL("/api/search", window.location.origin);
  u.searchParams.set("q", params.query);
  u.searchParams.set("days", params.days);
  u.searchParams.set("repo", params.repo === "all" ? "" : params.repo);
  if (params.source && params.source !== "all") {
    u.searchParams.set("source", params.source);
  }
  u.searchParams.set("limit", String(params.limit ?? 300));

  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
  const data = await res.json();
  return {
    results: (data.results || []) as SearchResult[],
    count: data.count ?? 0,
  };
}

export async function fetchSession(sessionKey: string): Promise<SessionDetail> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionKey)}`);
  if (!res.ok) throw new Error(`Failed to load session: HTTP ${res.status}`);
  return (await res.json()) as SessionDetail;
}

export type DeleteSessionResponse = {
  ok: boolean;
  session_key: string;
  removed_paths: string[];
  missing_paths: string[];
  error?: string;
};

export async function deleteSession(sessionKey: string): Promise<DeleteSessionResponse> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionKey)}`, {
    method: "DELETE",
  });
  let data: DeleteSessionResponse | null = null;
  try {
    data = (await res.json()) as DeleteSessionResponse;
  } catch {
    data = null;
  }
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `Delete failed: HTTP ${res.status}`);
  }
  return data;
}

export async function fetchRepos(): Promise<RepoOption[]> {
  const res = await fetch("/api/repos");
  if (!res.ok) throw new Error(`Repos fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.repos || []) as RepoOption[];
}

export async function fetchSources(): Promise<SourceSummary[]> {
  const res = await fetch("/api/sources");
  if (!res.ok) throw new Error(`Sources fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.sources || []) as SourceSummary[];
}

export type AnnotationsResponse = {
  annotations: Record<string, SessionAnnotation>;
  tags: TagSummary[];
};

export async function fetchAnnotations(): Promise<AnnotationsResponse> {
  const res = await fetch("/api/annotations");
  if (!res.ok) throw new Error(`Annotations fetch failed: HTTP ${res.status}`);
  return (await res.json()) as AnnotationsResponse;
}

export type AnnotationPatch = {
  starred?: boolean;
  tags?: string[];
  notes?: string;
};

export type AnnotationUpdateResponse = {
  ok: boolean;
  annotation: SessionAnnotation | null;
  tags?: TagSummary[];
};

export async function putAnnotation(
  sessionKey: string,
  patch: AnnotationPatch
): Promise<AnnotationUpdateResponse> {
  const res = await fetch(`/api/annotations/${encodeURIComponent(sessionKey)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AnnotationUpdateResponse;
}

export type ReindexResponse = {
  ok: boolean;
  stats: { sessions_indexed: number };
  error?: string;
};

export async function postReindex(): Promise<ReindexResponse> {
  const res = await fetch("/api/reindex", { method: "POST" });
  const data = (await res.json()) as ReindexResponse;
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "reindex failed");
  }
  return data;
}

export type OpenFileResponse = {
  ok: boolean;
  action: string;
  error?: string;
};

export async function postOpenFile(sessionKey: string): Promise<OpenFileResponse> {
  const res = await fetch(`/api/open-file/${encodeURIComponent(sessionKey)}`, { method: "POST" });
  const data = (await res.json()) as OpenFileResponse;
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "open failed");
  }
  return data;
}

export type ExportKind = "rules" | "skill";

export type ExportBlobResult = {
  blob: Blob;
  mode: string;
  warning: string;
  filename: string;
};

function parseFilenameFromContentDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = header.match(/filename="([^"]+)"/i);
  return match?.[1] || fallback;
}

export type ExportProvider = "openai" | "cursor";

export type ExportOptions = {
  provider?: ExportProvider;
  accountId?: string;
};

export async function fetchExport(
  sessionKey: string,
  kind: ExportKind,
  fallbackName: string,
  options: ExportOptions = {}
): Promise<ExportBlobResult> {
  const u = new URL(`/api/export/${encodeURIComponent(sessionKey)}`, window.location.origin);
  u.searchParams.set("type", kind);
  u.searchParams.set("mode", "smart");
  if (options.provider) u.searchParams.set("provider", options.provider);
  if (options.accountId) u.searchParams.set("accountId", options.accountId);
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  const blob = await res.blob();
  const mode = res.headers.get("X-Export-Mode") || "basic";
  const warning = res.headers.get("X-Export-Warning");
  const decodedWarning = warning ? decodeURIComponent(warning) : "";
  const filename = parseFilenameFromContentDisposition(
    res.headers.get("Content-Disposition"),
    fallbackName
  );
  return { blob, mode, warning: decodedWarning, filename };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Smart Export: write-to-repo flow
// ---------------------------------------------------------------------------

export interface ExportTarget {
  ok: boolean;
  repo: {
    path: string | null;
    source: "mapping" | "session" | "decoded" | "none";
    exists: boolean;
    isGitRepo: boolean;
  };
  relativePath: string;
  absolutePath: string | null;
  fileExists: boolean;
  slug: string;
}

export async function fetchExportTarget(
  sessionKey: string,
  kind: ExportKind,
  overridePath?: string
): Promise<ExportTarget> {
  const u = new URL(
    `/api/export/target/${encodeURIComponent(sessionKey)}`,
    window.location.origin
  );
  u.searchParams.set("kind", kind);
  if (overridePath) u.searchParams.set("path", overridePath);
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`Target preview failed: HTTP ${res.status}`);
  return (await res.json()) as ExportTarget;
}

export interface FsListResponse {
  ok: boolean;
  path: string;
  parent: string | null;
  entries: Array<{
    name: string;
    path: string;
    isGitRepo: boolean;
    hidden: boolean;
  }>;
  bookmarks: { home: string; workspaces: string[] };
  error?: string;
}

export async function fetchFsList(absPath?: string): Promise<FsListResponse> {
  const u = new URL("/api/fs/list", window.location.origin);
  if (absPath) u.searchParams.set("path", absPath);
  const res = await fetch(u.toString());
  const data = (await res.json()) as FsListResponse;
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `List failed: HTTP ${res.status}`);
  }
  return data;
}

export interface ExportWriteRequest {
  sessionKey: string;
  kind: ExportKind;
  targetDir: string;
  relativePath?: string;
  overwrite?: boolean;
  rememberMapping?: boolean;
  provider?: ExportProvider;
  accountId?: string;
}

export interface ExportWriteResponse {
  ok: boolean;
  absolutePath: string;
  relativePath: string;
  targetDir: string;
  mode: "smart" | "basic";
  warning?: string;
  overwritten: boolean;
  bytes: number;
  error?: string;
}

export async function postExportWrite(
  body: ExportWriteRequest
): Promise<ExportWriteResponse> {
  const res = await fetch("/api/export/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Default mode is `smart` to match the user-facing label of the buttons.
    body: JSON.stringify({ mode: "smart", ...body }),
  });
  const data = (await res.json()) as ExportWriteResponse;
  if (res.status === 409) {
    // Surface the "file exists" case as a distinct typed error so the UI can
    // offer "Overwrite" without translating opaque HTTP codes.
    const err = new Error("file already exists") as Error & {
      code?: string;
      absolutePath?: string;
    };
    err.code = "EEXIST";
    err.absolutePath = (data as { absolutePath?: string }).absolutePath;
    throw err;
  }
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Write failed: HTTP ${res.status}`);
  }
  return data;
}

export async function postOpenPath(
  absPath: string
): Promise<{ ok: boolean; action: "opened" | "revealed" }> {
  const res = await fetch("/api/open-path", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: absPath }),
  });
  const data = (await res.json()) as { ok?: boolean; action?: string; error?: string };
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Open failed: HTTP ${res.status}`);
  }
  return { ok: true, action: (data.action as "opened" | "revealed") || "opened" };
}

// ---------------------------------------------------------------------------
// AI accounts / settings / SSE flows
// ---------------------------------------------------------------------------

export type AiProvider = "openai" | "cursor";

export interface AiLastCheck {
  ok: boolean;
  planType: string | null;
  primaryUsedPercent: number | null;
  primaryRemainingPercent: number | null;
  primaryResetAt: string | null;
  secondaryUsedPercent: number | null;
  secondaryRemainingPercent: number | null;
  secondaryResetAt: string | null;
  creditsBalance: number | null;
  creditsUnlimited: boolean | null;
  checkedAt: string;
  error: string | null;
}

export interface AiOpenAiAccount {
  id: string;
  label: string;
  email: string | null;
  accountId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  lastCheck: AiLastCheck | null;
}

export interface AiCursorState {
  installed: boolean;
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
  warning: string | null;
}

export type AiReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type AiServiceTier = "fast" | "flex";

export interface AiSettingsView {
  defaultProvider: AiProvider;
  defaultOpenAiAccountId: string | null;
  defaultModel: string | null;
  defaultReasoningEffort: AiReasoningEffort | null;
  defaultServiceTier: AiServiceTier | null;
}

export interface AiAccountsSnapshot {
  settings: AiSettingsView;
  openai: {
    accounts: AiOpenAiAccount[];
    defaultAccountId: string | null;
  };
  cursor: AiCursorState;
}

export async function fetchAiAccounts(
  opts: { refresh?: boolean } = {}
): Promise<AiAccountsSnapshot> {
  const url = opts.refresh ? "/api/ai/accounts?refresh=1" : "/api/ai/accounts";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`AI accounts fetch failed: HTTP ${res.status}`);
  return (await res.json()) as AiAccountsSnapshot;
}

export async function updateAiSettings(patch: {
  provider?: AiProvider;
  openaiAccountId?: string;
  model?: string | null;
  reasoningEffort?: AiReasoningEffort | null;
  serviceTier?: AiServiceTier | null;
}): Promise<AiAccountsSnapshot> {
  const res = await fetch("/api/ai/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`AI settings update failed: HTTP ${res.status}`);
  return (await res.json()) as AiAccountsSnapshot;
}

export async function deleteOpenAiAccount(id: string): Promise<AiAccountsSnapshot> {
  const res = await fetch(`/api/ai/openai/accounts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  const data = (await res.json()) as { ok?: boolean; snapshot?: AiAccountsSnapshot; error?: string };
  if (!res.ok || !data.ok || !data.snapshot) {
    throw new Error(data.error || `Delete failed: HTTP ${res.status}`);
  }
  return data.snapshot;
}

export async function setDefaultOpenAiAccount(id: string): Promise<AiAccountsSnapshot> {
  const res = await fetch(
    `/api/ai/openai/accounts/${encodeURIComponent(id)}/default`,
    { method: "POST" }
  );
  const data = (await res.json()) as { ok?: boolean; snapshot?: AiAccountsSnapshot; error?: string };
  if (!res.ok || !data.ok || !data.snapshot) {
    throw new Error(data.error || `Set default failed: HTTP ${res.status}`);
  }
  return data.snapshot;
}

export async function refreshOpenAiAccount(id: string): Promise<AiAccountsSnapshot> {
  const res = await fetch(
    `/api/ai/openai/accounts/${encodeURIComponent(id)}/refresh`,
    { method: "POST" }
  );
  const data = (await res.json()) as { ok?: boolean; snapshot?: AiAccountsSnapshot; error?: string };
  if (!res.ok || !data.ok || !data.snapshot) {
    throw new Error(data.error || `Refresh failed: HTTP ${res.status}`);
  }
  return data.snapshot;
}

export async function logoutCursor(): Promise<AiAccountsSnapshot> {
  const res = await fetch("/api/ai/cursor/logout", { method: "POST" });
  const data = (await res.json()) as { ok?: boolean; snapshot?: AiAccountsSnapshot; error?: string };
  if (!res.ok || !data.ok || !data.snapshot) {
    throw new Error(data.error || `Logout failed: HTTP ${res.status}`);
  }
  return data.snapshot;
}

export interface AiModelOption {
  id: string;
  label: string;
  isDefault: boolean;
  /** OpenAI only: hint for whether reasoning effort applies to this model. */
  supportsReasoning?: boolean;
}

export interface AiModelsResponse {
  provider: AiProvider;
  models: AiModelOption[];
  /** OpenAI only: enums the user can pick from. Null for cursor. */
  capabilities?: {
    reasoningEfforts: AiReasoningEffort[];
    serviceTiers: AiServiceTier[];
  } | null;
  warning?: string;
}

export async function fetchAiModels(provider: AiProvider): Promise<AiModelsResponse> {
  const res = await fetch(`/api/ai/models?provider=${encodeURIComponent(provider)}`);
  if (!res.ok) throw new Error(`AI models fetch failed: HTTP ${res.status}`);
  return (await res.json()) as AiModelsResponse;
}

// SSE login event type used for both providers (success payload differs by
// provider, so each helper exposes its own typed wrapper).
export type AiLoginEvent =
  | { type: "url"; url: string }
  | { type: "log"; text: string }
  | { type: "success"; snapshot: AiAccountsSnapshot }
  | { type: "error"; error: string };

async function* parseSseStream(
  res: Response,
  signal?: AbortSignal
): AsyncIterable<{ event: string; data: unknown }> {
  if (!res.ok || !res.body) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`SSE request failed: HTTP ${res.status}${detail ? ` – ${detail}` : ""}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const onAbort = () => {
    try {
      reader.cancel();
    } catch {
      // ignore
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const sep = buffer.indexOf("\n\n");
        if (sep === -1) break;
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const lines = frame.split("\n");
        let eventName = "message";
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventName = line.slice("event:".length).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).trim());
          }
        }
        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join("\n");
        let data: unknown = dataStr;
        try {
          data = JSON.parse(dataStr);
        } catch {
          // keep raw string
        }
        yield { event: eventName, data };
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function* startOpenAiLogin(
  options: { signal?: AbortSignal; label?: string; makeDefault?: boolean } = {}
): AsyncIterable<AiLoginEvent> {
  const u = new URL("/api/ai/openai/login", window.location.origin);
  if (options.label) u.searchParams.set("label", options.label);
  if (options.makeDefault) u.searchParams.set("makeDefault", "1");
  const res = await fetch(u.toString(), { method: "POST", signal: options.signal });
  for await (const frame of parseSseStream(res, options.signal)) {
    if (frame.event === "url") {
      const data = frame.data as { url?: string };
      if (data?.url) yield { type: "url", url: data.url };
    } else if (frame.event === "log") {
      const data = frame.data as { text?: string };
      if (data?.text) yield { type: "log", text: data.text };
    } else if (frame.event === "success") {
      const data = frame.data as { snapshot?: AiAccountsSnapshot };
      if (data?.snapshot) yield { type: "success", snapshot: data.snapshot };
    } else if (frame.event === "error") {
      const data = frame.data as { error?: string };
      yield { type: "error", error: data?.error || "OpenAI login failed" };
      return;
    } else if (frame.event === "end") {
      return;
    }
  }
}

export async function* startCursorLogin(
  options: { signal?: AbortSignal } = {}
): AsyncIterable<AiLoginEvent> {
  const res = await fetch("/api/ai/cursor/login", {
    method: "POST",
    signal: options.signal,
  });
  for await (const frame of parseSseStream(res, options.signal)) {
    if (frame.event === "url") {
      const data = frame.data as { url?: string };
      if (data?.url) yield { type: "url", url: data.url };
    } else if (frame.event === "log") {
      const data = frame.data as { text?: string };
      if (data?.text) yield { type: "log", text: data.text };
    } else if (frame.event === "success") {
      const data = frame.data as { snapshot?: AiAccountsSnapshot };
      if (data?.snapshot) yield { type: "success", snapshot: data.snapshot };
    } else if (frame.event === "error") {
      const data = frame.data as { error?: string };
      yield { type: "error", error: data?.error || "Cursor login failed" };
      return;
    } else if (frame.event === "end") {
      return;
    }
  }
}

export type AiRunEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; code?: string; error: string };

export interface AiRunRequest {
  prompt: string;
  provider?: AiProvider;
  accountId?: string;
  model?: string;
  instructions?: string;
  signal?: AbortSignal;
}

export async function* runAi(req: AiRunRequest): AsyncIterable<AiRunEvent> {
  const res = await fetch("/api/ai/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: req.prompt,
      provider: req.provider,
      accountId: req.accountId,
      model: req.model,
      instructions: req.instructions,
    }),
    signal: req.signal,
  });
  for await (const frame of parseSseStream(res, req.signal)) {
    if (frame.event === "delta") {
      const data = frame.data as { text?: string };
      if (data?.text) yield { type: "delta", text: data.text };
    } else if (frame.event === "done") {
      yield { type: "done" };
      return;
    } else if (frame.event === "error") {
      const data = frame.data as { error?: string; code?: string };
      yield { type: "error", code: data?.code, error: data?.error || "AI run failed" };
      return;
    } else if (frame.event === "end") {
      return;
    }
  }
}
