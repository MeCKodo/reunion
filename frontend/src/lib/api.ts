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
