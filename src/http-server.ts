import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import {
  ANNOTATION_NOTES_MAX,
  LEGACY_STATIC_FILE,
  REINDEX_INTERVAL_MS,
} from "./config";
import { ensureDataDir } from "./lib/fs";
import { html, json, readJsonBody, serveSpaOrAsset } from "./lib/http";
import { openFileInSystem } from "./lib/system";
import { sanitizeFileName, toAsciiFileName } from "./lib/text";
import {
  buildIndex,
  getAdapterById,
  getInMemoryIndex,
  getRepos,
  getSourceSummaries,
  isReindexBusy,
  loadIndex,
  ReindexBusyError,
  removeSessionFromIndex,
  safeReindex,
  safeReindexNoThrow,
} from "./index-store";
import {
  buildTagSummary,
  isAnnotationEmpty,
  loadAnnotations,
  migrateAnnotationKeys,
  normalizeTags,
  projectAnnotation,
  saveAnnotations,
} from "./annotations";
import { resolveAssetPath, streamAsset } from "./lib/asset";
import {
  deleteSessionFiles,
  DeletePathOutsideRootError,
} from "./lib/delete-session";
import { searchSessions } from "./search";
import { generateExportMarkdown } from "./export";
import {
  extractPrompts,
  filterPrompts,
  serializePromptEntry,
  sortPrompts,
  type PromptEntry,
  type PromptFilter,
} from "./prompts";
import {
  clusterPromptsJaccard,
  findSimilarJaccard,
  serializeCluster,
} from "./prompt-similarity";
import {
  clusterFromEmbedding,
  findSimilarFromEmbedding,
  getServiceState as getEmbeddingsServiceState,
  triggerInit as triggerEmbeddingsInit,
  triggerRebuild as triggerEmbeddingsRebuild,
  type EmbeddingCluster,
} from "./embeddings-service";
import type {
  DetailedTranscript,
  ExportKind,
  ExportMode,
  Session,
  SessionAnnotation,
  SourceId,
  SourceRoots,
} from "./types";

type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  roots: SourceRoots;
};

// ---------------------------------------------------------------------------
// helpers shared across routes
// ---------------------------------------------------------------------------

function serializeEvents(events: DetailedTranscript["events"]) {
  return events.map((event) => ({
    event_id: event.eventId,
    category: event.category,
    role: event.role,
    kind: event.kind,
    content_type: event.contentType,
    text: event.text,
    ts: event.ts,
    legacy_segment_index: event.legacySegmentIndex,
    tool_name: event.toolName,
    tool_input: event.toolInput,
    tool_call_id: event.toolCallId,
    is_error: event.isError,
  }));
}

async function loadDetailsForSession(session: Session): Promise<DetailedTranscript> {
  const adapter = getAdapterById(session.source);
  if (!adapter) {
    throw new Error(`no adapter registered for source ${session.source}`);
  }
  return adapter.loadDetailedTranscript(
    session.filePath,
    session.startedAt,
    session.updatedAt,
    `main:${session.sessionId}`
  );
}

async function loadSubagentsForSession(session: Session) {
  const adapter = getAdapterById(session.source);
  if (!adapter || !adapter.loadSubagentSessions) return [];
  return adapter.loadSubagentSessions(session);
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------

async function handleStaticAsset(ctx: RouteContext): Promise<boolean> {
  if (ctx.req.method !== "GET" || ctx.url.pathname.startsWith("/api/")) return false;
  const served = await serveSpaOrAsset(ctx.url.pathname, ctx.res);
  if (served) return true;
  try {
    const page = await fs.readFile(LEGACY_STATIC_FILE, "utf-8");
    html(ctx.res, 200, page);
  } catch {
    html(ctx.res, 404, "index.html not found");
  }
  return true;
}

async function handleListRepos({ res }: RouteContext) {
  const indexData = await loadIndex();
  json(res, 200, { repos: getRepos(indexData) });
}

async function handleListSources({ res }: RouteContext) {
  const indexData = await loadIndex();
  json(res, 200, { sources: getSourceSummaries(indexData) });
}

async function handleSearch({ res, url }: RouteContext) {
  const indexData = await loadIndex();
  const annotations = await loadAnnotations();
  const query = url.searchParams.get("q") || "";
  const repo = url.searchParams.get("repo") || "";
  const source = url.searchParams.get("source") || "";
  const limit = Number.parseInt(url.searchParams.get("limit") || "100", 10);
  const days = Number.parseInt(url.searchParams.get("days") || "0", 10);
  const results = searchSessions(
    indexData,
    query,
    repo,
    Number.isNaN(limit) ? 100 : limit,
    Number.isNaN(days) ? 0 : days,
    annotations,
    source
  );
  json(res, 200, { count: results.length, results });
}

async function handleSessionDetail({ res, url }: RouteContext) {
  const indexData = await loadIndex();
  const annotations = await loadAnnotations();
  const sessionKey = decodeURIComponent(url.pathname.replace("/api/session/", ""));
  const session = indexData.sessions.find((item) => item.sessionKey === sessionKey);
  if (!session) {
    json(res, 404, { error: "session not found" });
    return;
  }
  const detailed = await loadDetailsForSession(session);
  const subagents = await loadSubagentsForSession(session);
  json(res, 200, {
    session_key: session.sessionKey,
    session_id: session.sessionId,
    source: session.source,
    repo: session.repo,
    repo_path: session.repoPath,
    title: session.title,
    file_path: session.filePath,
    started_at: session.startedAt,
    updated_at: session.updatedAt,
    duration_sec: Math.max(0, session.updatedAt - session.startedAt),
    size_bytes: session.sizeBytes,
    ...projectAnnotation(annotations, session.sessionKey),
    content: detailed.content,
    raw_content: detailed.rawContent,
    events: serializeEvents(detailed.events),
    clock_alignment: detailed.clockAlignment,
    subagents: subagents.map((subagent) => ({
      session_id: subagent.sessionId,
      title: subagent.title,
      file_path: subagent.filePath,
      started_at: subagent.startedAt,
      updated_at: subagent.updatedAt,
      duration_sec: Math.max(0, subagent.updatedAt - subagent.startedAt),
      size_bytes: subagent.sizeBytes,
      content: subagent.content,
      raw_content: subagent.rawContent,
      events: serializeEvents(subagent.events),
    })),
  });
}

async function handleDeleteSession({ res, url, roots }: RouteContext) {
  const indexData = await loadIndex();
  const sessionKey = decodeURIComponent(url.pathname.replace("/api/session/", ""));
  const session = indexData.sessions.find((item) => item.sessionKey === sessionKey);
  if (!session) {
    json(res, 404, { ok: false, error: "session not found" });
    return;
  }

  try {
    const { removedPaths, missingPaths } = await deleteSessionFiles(session, roots);
    await removeSessionFromIndex(sessionKey);

    const annotations = await loadAnnotations();
    if (sessionKey in annotations) {
      delete annotations[sessionKey];
      await saveAnnotations();
    }

    json(res, 200, {
      ok: true,
      session_key: sessionKey,
      removed_paths: removedPaths,
      missing_paths: missingPaths,
    });
  } catch (error) {
    if (error instanceof DeletePathOutsideRootError) {
      json(res, 400, { ok: false, error: error.message });
      return;
    }
    json(res, 500, { ok: false, error: String(error) });
  }
}

async function handleReindex({ res, roots }: RouteContext) {
  try {
    const stats = await safeReindex(roots);
    json(res, 200, { ok: true, stats });
  } catch (error) {
    if (error instanceof ReindexBusyError) {
      json(res, 429, { ok: false, error: error.message });
      return;
    }
    json(res, 500, { ok: false, error: String(error) });
  }
}

async function handleListAnnotations({ res }: RouteContext) {
  const annotations = await loadAnnotations();
  json(res, 200, { annotations, tags: buildTagSummary(annotations) });
}

async function handleUpdateAnnotation({ req, res, url }: RouteContext) {
  const sessionKey = decodeURIComponent(url.pathname.replace("/api/annotations/", ""));
  if (!sessionKey) {
    json(res, 400, { ok: false, error: "missing sessionKey" });
    return;
  }
  const patch = await readJsonBody<{ starred?: boolean; tags?: string[]; notes?: string }>(req, {});
  const annotations = await loadAnnotations();
  const prev = annotations[sessionKey];

  const starred = typeof patch.starred === "boolean" ? patch.starred : Boolean(prev?.starred);
  const tags = Array.isArray(patch.tags) ? normalizeTags(patch.tags) : prev?.tags || [];
  const notesRaw = typeof patch.notes === "string" ? patch.notes : prev?.notes || "";
  const notes = notesRaw.slice(0, ANNOTATION_NOTES_MAX);

  const next: SessionAnnotation = { updatedAt: Math.floor(Date.now() / 1000) };
  if (starred) next.starred = true;
  if (tags.length > 0) next.tags = tags;
  if (notes && notes.trim()) next.notes = notes;

  if (isAnnotationEmpty(next)) {
    if (sessionKey in annotations) {
      delete annotations[sessionKey];
      await saveAnnotations();
    }
    json(res, 200, { ok: true, annotation: null, tags: buildTagSummary(annotations) });
    return;
  }

  annotations[sessionKey] = next;
  await saveAnnotations();
  json(res, 200, { ok: true, annotation: next, tags: buildTagSummary(annotations) });
}

async function handleDeleteAnnotation({ res, url }: RouteContext) {
  const sessionKey = decodeURIComponent(url.pathname.replace("/api/annotations/", ""));
  const annotations = await loadAnnotations();
  if (sessionKey in annotations) {
    delete annotations[sessionKey];
    await saveAnnotations();
  }
  json(res, 200, { ok: true, tags: buildTagSummary(annotations) });
}

async function handleOpenFile({ res, url }: RouteContext) {
  const indexData = await loadIndex();
  const sessionKey = decodeURIComponent(url.pathname.replace("/api/open-file/", ""));
  const session = indexData.sessions.find((item) => item.sessionKey === sessionKey);
  if (!session) {
    json(res, 404, { ok: false, error: "session not found" });
    return;
  }
  try {
    const action = await openFileInSystem(session.filePath);
    json(res, 200, { ok: true, file_path: session.filePath, action });
  } catch (error) {
    json(res, 500, { ok: false, error: String(error) });
  }
}

async function handleAsset({ res, url, roots }: RouteContext) {
  const rawPath = url.searchParams.get("path") || "";
  const result = resolveAssetPath(rawPath, roots);
  if (!result.ok) {
    json(res, result.status, { ok: false, error: result.error });
    return;
  }
  try {
    await streamAsset(res, result.absPath, result.mime);
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    const status = code === "ENOENT" ? 404 : 500;
    json(res, status, { ok: false, error: String(error) });
  }
}

async function handleExport({ res, url }: RouteContext) {
  const indexData = await loadIndex();
  const sessionKey = decodeURIComponent(url.pathname.replace("/api/export/", ""));
  const session = indexData.sessions.find((item) => item.sessionKey === sessionKey);
  if (!session) {
    json(res, 404, { error: "session not found" });
    return;
  }
  const kind: ExportKind = (url.searchParams.get("type") || "rules").toLowerCase() === "skill" ? "skill" : "rules";
  const mode: ExportMode = (url.searchParams.get("mode") || "basic").toLowerCase() === "smart" ? "smart" : "basic";

  const safeTitle = sanitizeFileName(session.title || session.sessionId);
  const fileName = `${safeTitle}-${kind === "skill" ? "SKILL" : "RULES"}.md`;
  const generated = await generateExportMarkdown(session, kind, mode);
  const data = Buffer.from(generated.markdown, "utf-8");

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  const asciiName = toAsciiFileName(fileName);
  const utf8Name = encodeURIComponent(fileName);
  res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`);
  res.setHeader("X-Export-Mode", generated.mode);
  if (generated.warning) {
    res.setHeader("X-Export-Warning", encodeURIComponent(generated.warning.slice(0, 300)));
  }
  res.setHeader("Content-Length", String(data.length));
  res.end(data);
}

// ---------------------------------------------------------------------------
// prompts library
// ---------------------------------------------------------------------------

const ALLOWED_SOURCES: SourceId[] = ["cursor", "claude-code", "codex"];

function parseSourceParam(value: string | null): SourceId | "all" | undefined {
  if (!value) return undefined;
  if (value === "all") return "all";
  return ALLOWED_SOURCES.includes(value as SourceId) ? (value as SourceId) : undefined;
}

function buildPromptFilter(url: URL): PromptFilter {
  const minRaw = Number.parseInt(url.searchParams.get("min_occurrences") || "1", 10);
  const sinceRaw = Number.parseInt(url.searchParams.get("since_ts") || "0", 10);
  return {
    source: parseSourceParam(url.searchParams.get("source")),
    repo: url.searchParams.get("repo") || undefined,
    minOccurrences: Number.isNaN(minRaw) ? 1 : Math.max(1, minRaw),
    query: url.searchParams.get("q") || undefined,
    sinceTs: Number.isNaN(sinceRaw) ? 0 : Math.max(0, sinceRaw),
  };
}

async function handleListPrompts({ res, url }: RouteContext) {
  const indexData = await loadIndex();
  const all = extractPrompts(indexData);
  const filtered = sortPrompts(filterPrompts(all, buildPromptFilter(url)));
  const limit = Number.parseInt(url.searchParams.get("limit") || "500", 10);
  const safeLimit = Number.isNaN(limit) ? 500 : Math.max(1, Math.min(2000, limit));
  json(res, 200, {
    total: filtered.length,
    limit: safeLimit,
    prompts: filtered.slice(0, safeLimit).map((entry) => serializePromptEntry(entry)),
  });
}

async function handlePromptDetail({ res, url }: RouteContext) {
  const promptHash = decodeURIComponent(url.pathname.replace("/api/prompts/", "")).trim();
  if (!promptHash || promptHash.includes("/")) {
    json(res, 400, { error: "missing prompt hash" });
    return;
  }
  const indexData = await loadIndex();
  const entry = extractPrompts(indexData).find((item) => item.promptHash === promptHash);
  if (!entry) {
    json(res, 404, { error: "prompt not found" });
    return;
  }
  json(res, 200, { prompt: serializePromptEntry(entry, 200_000) });
}

async function handlePromptClusters({ res, url }: RouteContext) {
  const method = (url.searchParams.get("method") || "jaccard").toLowerCase();
  const indexData = await loadIndex();
  const all = extractPrompts(indexData);
  const filtered = filterPrompts(all, buildPromptFilter(url));
  const promptsByHash = new Map<string, PromptEntry>(filtered.map((entry) => [entry.promptHash, entry]));
  const serialize = (entry: PromptEntry) => serializePromptEntry(entry);

  if (method === "embedding") {
    const thresholdRaw = Number.parseFloat(url.searchParams.get("threshold") || "0.85");
    const threshold = Number.isFinite(thresholdRaw) ? Math.max(0, Math.min(1, thresholdRaw)) : 0.85;
    const embeddingClusters = await clusterFromEmbedding(filtered, { threshold });
    if (embeddingClusters) {
      json(res, 200, {
        method: "embedding" as const,
        threshold,
        cluster_count: embeddingClusters.length,
        clusters: embeddingClusters.map((cluster: EmbeddingCluster) =>
          serializeCluster(
            {
              clusterId: cluster.clusterId,
              leadPromptHash: cluster.leadHash,
              memberHashes: cluster.memberHashes,
              method: "embedding",
            },
            promptsByHash,
            serialize
          )
        ),
      });
      return;
    }
    // Embedding path unavailable (model not ready / no vectors yet) — fall
    // through to Jaccard so the UI keeps working with a clear `fallback` flag.
  }

  const thresholdRaw = Number.parseFloat(url.searchParams.get("threshold") || "0.6");
  const threshold = Number.isFinite(thresholdRaw) ? Math.max(0, Math.min(1, thresholdRaw)) : 0.6;
  const clusters = clusterPromptsJaccard(filtered, { threshold });
  const onlyMultis = clusters.filter((cluster) => cluster.memberHashes.length > 1);

  json(res, 200, {
    method: "jaccard" as const,
    threshold,
    cluster_count: onlyMultis.length,
    clusters: onlyMultis.map((cluster) => serializeCluster(cluster, promptsByHash, serialize)),
    fallback: method === "embedding" ? "embedding-unavailable" : undefined,
  });
}

async function handlePromptSimilar({ res, url }: RouteContext) {
  const remainder = url.pathname.replace("/api/prompts/", "");
  const [hashPart] = remainder.split("/");
  const promptHash = decodeURIComponent(hashPart || "").trim();
  if (!promptHash) {
    json(res, 400, { error: "missing prompt hash" });
    return;
  }
  const kRaw = Number.parseInt(url.searchParams.get("k") || "10", 10);
  const k = Number.isNaN(kRaw) ? 10 : Math.max(1, Math.min(50, kRaw));
  const requestedMethod = (url.searchParams.get("method") || "auto").toLowerCase();
  const useEmbedding = requestedMethod === "embedding" || requestedMethod === "auto";

  const indexData = await loadIndex();
  const all = extractPrompts(indexData);
  const target = all.find((entry) => entry.promptHash === promptHash);
  if (!target) {
    json(res, 404, { error: "prompt not found" });
    return;
  }
  const promptsByHash = new Map(all.map((entry) => [entry.promptHash, entry]));

  // Try embedding first when caller hasn't pinned method=jaccard.
  if (useEmbedding) {
    const embeddingThresholdRaw = Number.parseFloat(url.searchParams.get("threshold") || "0.6");
    const embeddingThreshold = Number.isFinite(embeddingThresholdRaw)
      ? Math.max(0, Math.min(1, embeddingThresholdRaw))
      : 0.6;
    const embeddingMatches = await findSimilarFromEmbedding(target, all, {
      topK: k,
      threshold: embeddingThreshold,
    });
    if (embeddingMatches) {
      json(res, 200, {
        method: "embedding" as const,
        threshold: embeddingThreshold,
        matches: embeddingMatches.map((match) => {
          const entry = promptsByHash.get(match.promptHash);
          return {
            score: match.score,
            prompt: entry ? serializePromptEntry(entry) : null,
          };
        }),
      });
      return;
    }
  }

  const jaccardThresholdRaw = Number.parseFloat(url.searchParams.get("threshold") || "0.4");
  const jaccardThreshold = Number.isFinite(jaccardThresholdRaw)
    ? Math.max(0, Math.min(1, jaccardThresholdRaw))
    : 0.4;
  const matches = findSimilarJaccard(target, all, { topK: k, threshold: jaccardThreshold });
  json(res, 200, {
    method: "jaccard" as const,
    threshold: jaccardThreshold,
    matches: matches.map((match) => {
      const entry = promptsByHash.get(match.promptHash);
      return {
        score: match.score,
        prompt: entry ? serializePromptEntry(entry) : null,
      };
    }),
    fallback: useEmbedding ? "embedding-unavailable" : undefined,
  });
}

// ---------------------------------------------------------------------------
// embeddings lifecycle
// ---------------------------------------------------------------------------

function serializeEmbeddingsState(state: Awaited<ReturnType<typeof getEmbeddingsServiceState>>) {
  return {
    embedder: {
      status: state.embedder.status,
      progress: state.embedder.progress,
      current_file: state.embedder.currentFile,
      error: state.embedder.error,
      ready_at: state.embedder.readyAt,
      unsupported: state.embedder.unsupported,
      unsupported_reason: state.embedder.unsupportedReason,
    },
    rebuild: {
      status: state.rebuild.status,
      processed: state.rebuild.processed,
      total: state.rebuild.total,
      error: state.rebuild.error,
      started_at: state.rebuild.startedAt,
      finished_at: state.rebuild.finishedAt,
    },
    stored_count: state.storedCount,
    model_id: state.modelId,
    dims: state.dims,
  };
}

async function handleEmbeddingsStatus({ res }: RouteContext) {
  const state = await getEmbeddingsServiceState();
  json(res, 200, serializeEmbeddingsState(state));
}

async function handleEmbeddingsInit({ res }: RouteContext) {
  const before = await getEmbeddingsServiceState();
  if (before.embedder.status === "unsupported") {
    // No point spinning up the pipeline on a platform we know lacks the
    // native binding. Surface 409 so the UI can render the existing reason
    // rather than treating this as a transient error.
    json(res, 409, serializeEmbeddingsState(before));
    return;
  }
  triggerEmbeddingsInit();
  const state = await getEmbeddingsServiceState();
  json(res, 202, serializeEmbeddingsState(state));
}

async function handleEmbeddingsRebuild({ res }: RouteContext) {
  const before = await getEmbeddingsServiceState();
  if (before.embedder.status === "unsupported") {
    json(res, 409, serializeEmbeddingsState(before));
    return;
  }
  const indexData = await loadIndex();
  const allPrompts = extractPrompts(indexData);
  triggerEmbeddingsRebuild(allPrompts);
  const state = await getEmbeddingsServiceState();
  json(res, 202, serializeEmbeddingsState(state));
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

async function dispatch(ctx: RouteContext): Promise<void> {
  if (await handleStaticAsset(ctx)) return;

  const { method } = ctx.req;
  const { pathname } = ctx.url;

  if (method === "GET" && pathname === "/api/repos") return handleListRepos(ctx);
  if (method === "GET" && pathname === "/api/sources") return handleListSources(ctx);
  if (method === "GET" && pathname === "/api/search") return handleSearch(ctx);
  if (method === "GET" && pathname.startsWith("/api/session/")) return handleSessionDetail(ctx);
  if (method === "DELETE" && pathname.startsWith("/api/session/")) return handleDeleteSession(ctx);
  if (method === "POST" && pathname === "/api/reindex") return handleReindex(ctx);
  if (method === "GET" && pathname === "/api/annotations") return handleListAnnotations(ctx);
  if (method === "PUT" && pathname.startsWith("/api/annotations/")) return handleUpdateAnnotation(ctx);
  if (method === "DELETE" && pathname.startsWith("/api/annotations/")) return handleDeleteAnnotation(ctx);
  if (method === "POST" && pathname.startsWith("/api/open-file/")) return handleOpenFile(ctx);
  if (method === "GET" && pathname === "/api/asset") return handleAsset(ctx);
  if (method === "GET" && pathname.startsWith("/api/export/")) return handleExport(ctx);
  // Prompts library — /clusters and /:hash/similar must be matched before the
  // bare "/api/prompts/:hash" detail route below.
  if (method === "GET" && pathname === "/api/prompts") return handleListPrompts(ctx);
  if (method === "GET" && pathname === "/api/prompts/clusters") return handlePromptClusters(ctx);
  if (method === "GET" && /^\/api\/prompts\/[^/]+\/similar$/.test(pathname)) return handlePromptSimilar(ctx);
  if (method === "GET" && pathname.startsWith("/api/prompts/")) return handlePromptDetail(ctx);
  // Embeddings lifecycle — POST endpoints kick off async work and return
  // immediately; the renderer polls /status to advance the banner.
  if (method === "GET" && pathname === "/api/embeddings/status") return handleEmbeddingsStatus(ctx);
  if (method === "POST" && pathname === "/api/embeddings/init") return handleEmbeddingsInit(ctx);
  if (method === "POST" && pathname === "/api/embeddings/rebuild") return handleEmbeddingsRebuild(ctx);

  json(ctx.res, 404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export type ServerHandle = {
  close: () => Promise<void>;
};

export async function runServe(
  host: string,
  port: number,
  roots: SourceRoots
): Promise<ServerHandle> {
  await ensureDataDir();
  const indexData = await loadIndex();
  const annotations = await loadAnnotations();
  await migrateAnnotationKeys(annotations, indexData.sessions);

  try {
    await buildIndex(roots, getInMemoryIndex());
    const refreshed = getInMemoryIndex();
    if (refreshed) {
      await migrateAnnotationKeys(await loadAnnotations(), refreshed.sessions);
    }
  } catch (error) {
    console.error("startup incremental index failed:", error);
  }

  const refreshIndex = async () => {
    if (isReindexBusy()) return;
    try {
      await safeReindexNoThrow(roots);
    } catch (error) {
      console.error("background reindex failed:", error);
    }
  };
  const reindexTimer = setInterval(refreshIndex, REINDEX_INTERVAL_MS);
  reindexTimer.unref();

  const server = createServer((req, res) => {
    const ctx: RouteContext = {
      req,
      res,
      url: new URL(req.url || "/", "http://127.0.0.1"),
      roots,
    };
    dispatch(ctx).catch((error) => {
      json(res, 500, { error: String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      console.log(`logue running: http://${host}:${port}`);
      console.log(`source roots:`);
      console.log(`  cursor:      ${roots.cursor}`);
      console.log(`  claude-code: ${roots.claudeCode}`);
      console.log(`  codex:       ${roots.codex}`);
      resolve();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(reindexTimer);
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
