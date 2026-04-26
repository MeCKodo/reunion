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
import type {
  DetailedTranscript,
  ExportKind,
  ExportMode,
  Session,
  SessionAnnotation,
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
