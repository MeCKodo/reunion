import type {
  EmbeddingsState,
  PromptCluster,
  PromptEntry,
  PromptSimilarResponse,
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

export async function fetchExport(
  sessionKey: string,
  kind: ExportKind,
  fallbackName: string
): Promise<ExportBlobResult> {
  const u = new URL(`/api/export/${encodeURIComponent(sessionKey)}`, window.location.origin);
  u.searchParams.set("type", kind);
  u.searchParams.set("mode", "smart");
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

export type PromptListParams = {
  source?: SourceFilter;
  repo?: string;
  query?: string;
  minOccurrences?: number;
  limit?: number;
  sinceTs?: number;
};

export type PromptListResponse = {
  total: number;
  limit: number;
  prompts: PromptEntry[];
};

function applyPromptFilterParams(u: URL, params: PromptListParams) {
  if (params.source && params.source !== "all") u.searchParams.set("source", params.source);
  if (params.repo && params.repo !== "all") u.searchParams.set("repo", params.repo);
  if (params.query) u.searchParams.set("q", params.query);
  if (typeof params.minOccurrences === "number") {
    u.searchParams.set("min_occurrences", String(Math.max(1, params.minOccurrences)));
  }
  if (typeof params.sinceTs === "number" && params.sinceTs > 0) {
    u.searchParams.set("since_ts", String(params.sinceTs));
  }
}

export async function fetchPrompts(params: PromptListParams = {}): Promise<PromptListResponse> {
  const u = new URL("/api/prompts", window.location.origin);
  applyPromptFilterParams(u, params);
  if (typeof params.limit === "number") u.searchParams.set("limit", String(params.limit));
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`Prompts fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  return {
    total: data.total ?? 0,
    limit: data.limit ?? 0,
    prompts: (data.prompts || []) as PromptEntry[],
  };
}

export async function fetchPromptDetail(promptHash: string): Promise<PromptEntry> {
  const res = await fetch(`/api/prompts/${encodeURIComponent(promptHash)}`);
  if (!res.ok) throw new Error(`Prompt detail failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.prompt as PromptEntry;
}

export type PromptClustersResponse = {
  method: "jaccard" | "embedding";
  threshold: number;
  cluster_count: number;
  clusters: PromptCluster[];
};

export async function fetchPromptClusters(
  params: PromptListParams & { method?: "jaccard" | "embedding"; threshold?: number } = {}
): Promise<PromptClustersResponse> {
  const u = new URL("/api/prompts/clusters", window.location.origin);
  applyPromptFilterParams(u, params);
  if (params.method) u.searchParams.set("method", params.method);
  if (typeof params.threshold === "number") {
    u.searchParams.set("threshold", String(params.threshold));
  }
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`Prompt clusters failed: HTTP ${res.status}`);
  const data = await res.json();
  return {
    method: data.method,
    threshold: data.threshold ?? 0,
    cluster_count: data.cluster_count ?? 0,
    clusters: (data.clusters || []) as PromptCluster[],
  };
}

export async function fetchSimilarPrompts(
  promptHash: string,
  options: { k?: number; threshold?: number; method?: "auto" | "jaccard" | "embedding" } = {}
): Promise<PromptSimilarResponse> {
  const u = new URL(`/api/prompts/${encodeURIComponent(promptHash)}/similar`, window.location.origin);
  if (typeof options.k === "number") u.searchParams.set("k", String(options.k));
  if (typeof options.threshold === "number") u.searchParams.set("threshold", String(options.threshold));
  if (options.method) u.searchParams.set("method", options.method);
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`Similar prompts failed: HTTP ${res.status}`);
  return (await res.json()) as PromptSimilarResponse;
}

export async function fetchEmbeddingsStatus(): Promise<EmbeddingsState> {
  const res = await fetch("/api/embeddings/status");
  if (!res.ok) throw new Error(`Embeddings status failed: HTTP ${res.status}`);
  return (await res.json()) as EmbeddingsState;
}

export async function postEmbeddingsInit(): Promise<EmbeddingsState> {
  const res = await fetch("/api/embeddings/init", { method: "POST" });
  if (!res.ok && res.status !== 202) {
    throw new Error(`Embeddings init failed: HTTP ${res.status}`);
  }
  return (await res.json()) as EmbeddingsState;
}

export async function postEmbeddingsRebuild(): Promise<EmbeddingsState> {
  const res = await fetch("/api/embeddings/rebuild", { method: "POST" });
  if (!res.ok && res.status !== 202) {
    throw new Error(`Embeddings rebuild failed: HTTP ${res.status}`);
  }
  return (await res.json()) as EmbeddingsState;
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
