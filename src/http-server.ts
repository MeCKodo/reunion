import { createServer } from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import {
  ANNOTATION_NOTES_MAX,
  getEdition,
  LEGACY_STATIC_FILE,
  REINDEX_INTERVAL_MS,
} from "./config";
import { ensureDataDir } from "./lib/fs";
import { html, json, readJsonBody, serveSpaOrAsset } from "./lib/http";
import { openFileInSystem } from "./lib/system";
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
import { dispatchAi } from "./ai/http-handlers";
import {
  handleExportTarget,
  handleExportWrite,
  handleExportDownload,
  handleFsList,
  handleOpenPath,
} from "./routes/export";
import {
  handleCreateTask,
  handleListTasks,
  handleTaskStream,
  handleGetTask,
} from "./routes/tasks";
import {
  applyMode,
  loadActiveProvider,
  type ActiveProviderState,
} from "./providers/mode-store";
import type { DataSourceProvider } from "./providers/types";
import type {
  AppMode,
  DetailedTranscript,
  ProviderCapabilities,
  Session,
  SessionAnnotation,
  SourceRoots,
} from "./types";
import type { RouteContext } from "./routes/types";

// ---------------------------------------------------------------------------
// Active-provider singleton state.
//
// `activeProvider` is owned by this module so we can swap it on `POST /api/mode`
// without bouncing the Node server. All read paths that go through a provider
// pull it from this slot via `getActiveProvider()`. Local-only mutating routes
// (delete / annotations / export / reindex) are gated by the provider's
// `capabilities`; the dispatcher rejects them with 403 in team mode.
// ---------------------------------------------------------------------------

let activeState: ActiveProviderState | null = null;

function getActiveProvider(): DataSourceProvider {
  if (!activeState) throw new Error("provider not initialised");
  return activeState.provider;
}

function getCapabilities(): ProviderCapabilities {
  return getActiveProvider().capabilities;
}

function isTeamMode(): boolean {
  return getActiveProvider().mode === "team";
}

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

function serializeSessionRow(
  session: Session,
  annotations: Record<string, SessionAnnotation> | undefined,
  extras: Record<string, unknown> = {}
) {
  return {
    session_key: session.sessionKey,
    session_id: session.sessionId,
    source: session.source,
    provider: session.provider,
    repo: session.repo,
    repo_path: session.repoPath,
    title: session.title,
    file_path: session.filePath,
    // `client_tag` mirrors ingest's column verbatim. Frontend renders a
    // chip when truthy and routes empty/undefined into the "未分类" bucket.
    client_tag: session.clientTag,
    started_at: session.startedAt,
    updated_at: session.updatedAt,
    duration_sec: Math.max(0, session.updatedAt - session.startedAt),
    size_bytes: session.sizeBytes,
    snippet: extras.snippet,
    match_count: extras.match_count,
    message_hits: extras.message_hits,
    ...(annotations ? projectAnnotation(annotations, session.sessionKey) : {}),
    ...extras,
  };
}

function rejectIfTeamMode(res: import("node:http").ServerResponse): boolean {
  if (isTeamMode()) {
    json(res, 403, {
      ok: false,
      error: "not supported in team mode",
      mode: "team",
    });
    return true;
  }
  return false;
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

async function handleListRepos({ res, url }: RouteContext) {
  // Mirrors `/api/search` — `?tag=server` flows through to the remote
  // provider as `?tag=server` on ingest's `GET /repos`. Local provider
  // ignores the param (every local session is the developer's own work).
  const tag = url.searchParams.get("tag") || undefined;
  const repos = await getActiveProvider().listRepos({ clientTag: tag });
  json(res, 200, {
    repos: repos.map((row) => ({
      repo: row.repo,
      source: row.source,
      session_count: row.sessionCount,
      last_updated_at: row.lastUpdatedAt,
      repo_path: row.repoPath,
    })),
  });
}

async function handleListSources({ res }: RouteContext) {
  if (isTeamMode()) {
    // Team mode has no on-disk source split; the frontend hides the source
    // tabs based on `capabilities.subagents` / mode anyway.
    json(res, 200, { sources: [] });
    return;
  }
  const indexData = await loadIndex();
  json(res, 200, { sources: getSourceSummaries(indexData) });
}

async function handleSearch({ res, url }: RouteContext) {
  const query = url.searchParams.get("q") || "";
  const repo = url.searchParams.get("repo") || "";
  const source = url.searchParams.get("source") || "";
  const limitRaw = Number.parseInt(url.searchParams.get("limit") || "100", 10);
  const days = Number.parseInt(url.searchParams.get("days") || "0", 10);
  const aiClient = url.searchParams.get("aiClient") || "";
  const model = url.searchParams.get("model") || "";
  // `tag=` mirrors ingest's `?tag=server|frontend|client|__none__`; an
  // absent parameter means "no tag filter" (the team-mode default).
  const tag = url.searchParams.get("tag") || undefined;
  const page = Number.parseInt(url.searchParams.get("page") || "0", 10) || undefined;

  const provider = getActiveProvider();
  const result = await provider.searchSessions({
    q: query,
    repo,
    source,
    aiClient,
    model,
    clientTag: tag,
    pageSize: Number.isNaN(limitRaw) ? 100 : limitRaw,
    days: Number.isNaN(days) ? 0 : days,
    page,
  });

  // Annotations only exist in personal mode; serializeSessionRow merges them
  // when present.
  const annotations = provider.capabilities.annotations
    ? await loadAnnotations()
    : undefined;

  const results = result.results.map((hit) =>
    serializeSessionRow(hit.session, annotations, {
      snippet: hit.snippet,
      match_count: hit.matchCount,
      message_hits: (hit.messageHits || []).map((m) => ({
        segment_index: m.segmentIndex,
        role: m.role,
        ts: m.ts,
        preview: m.preview,
      })),
    })
  );

  json(res, 200, {
    count: results.length,
    results,
    page: result.page,
    page_size: result.pageSize,
    from: result.from,
    to: result.to,
  });
}

async function handleSessionDetail({ res, url }: RouteContext) {
  const sessionKey = decodeURIComponent(url.pathname.replace("/api/session/", ""));
  const provider = getActiveProvider();
  const payload = await provider.getSessionDetail(sessionKey);
  if (!payload) {
    json(res, 404, { error: "session not found" });
    return;
  }

  const annotations = provider.capabilities.annotations
    ? await loadAnnotations()
    : undefined;

  json(res, 200, {
    session_key: payload.session.sessionKey,
    session_id: payload.session.sessionId,
    source: payload.session.source,
    provider: payload.session.provider,
    repo: payload.session.repo,
    repo_path: payload.session.repoPath,
    title: payload.session.title,
    file_path: payload.session.filePath,
    // Mirror serializeSessionRow so the detail view can render the same
    // chip / metadata block as the sidebar without an extra round-trip.
    client_tag: payload.session.clientTag,
    started_at: payload.session.startedAt,
    updated_at: payload.session.updatedAt,
    duration_sec: Math.max(0, payload.session.updatedAt - payload.session.startedAt),
    size_bytes: payload.session.sizeBytes,
    ...(annotations ? projectAnnotation(annotations, payload.session.sessionKey) : {}),
    content: payload.detail.content,
    raw_content: payload.detail.rawContent,
    events: serializeEvents(payload.detail.events),
    clock_alignment: payload.detail.clockAlignment,
    metrics: payload.metrics,
    last_upload_time: payload.lastUploadTime,
    hint: payload.hint,
    subagents: (payload.subagents || []).map((subagent) => ({
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
  if (rejectIfTeamMode(res)) return;
  const indexData = await loadIndex();
  const sessionKey = decodeURIComponent(url.pathname.replace("/api/session/", ""));
  const session = indexData.sessions.find((item) => item.sessionKey === sessionKey);
  if (!session) {
    json(res, 404, { ok: false, error: "session not found" });
    return;
  }
  if (session.provider !== "local" || !session.filePath) {
    json(res, 400, { ok: false, error: "delete only supported for local sessions" });
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
  if (rejectIfTeamMode(res)) return;
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
  if (rejectIfTeamMode(res)) return;
  const annotations = await loadAnnotations();
  json(res, 200, { annotations, tags: buildTagSummary(annotations) });
}

async function handleUpdateAnnotation({ req, res, url }: RouteContext) {
  if (rejectIfTeamMode(res)) return;
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
  // Preserve AI metadata across user-initiated PUTs; intersect aiTagSet
  // with surviving tags so removing an AI tag from the editor also strips
  // it from the AI subset (no orphaned references). aiTaggedAt is kept as
  // long as we have any prior AI run record so the bulk runner remains
  // idempotent for already-processed sessions.
  if (prev?.aiTagSet && prev.aiTagSet.length > 0) {
    const tagSet = new Set(tags);
    const survived = prev.aiTagSet.filter((t) => tagSet.has(t));
    if (survived.length > 0) next.aiTagSet = survived;
  }
  if (typeof prev?.aiTaggedAt === "number") next.aiTaggedAt = prev.aiTaggedAt;

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
  if (rejectIfTeamMode(res)) return;
  const sessionKey = decodeURIComponent(url.pathname.replace("/api/annotations/", ""));
  const annotations = await loadAnnotations();
  if (sessionKey in annotations) {
    delete annotations[sessionKey];
    await saveAnnotations();
  }
  json(res, 200, { ok: true, tags: buildTagSummary(annotations) });
}

async function handleSessionJsonl({ res, url, roots }: RouteContext) {
  if (rejectIfTeamMode(res)) return;
  const match = url.pathname.match(/^\/api\/session\/(.+)\/jsonl$/);
  if (!match) {
    json(res, 404, { ok: false, error: "session not found" });
    return;
  }
  const sessionKey = decodeURIComponent(match[1]);
  const indexData = await loadIndex();
  const session = indexData.sessions.find((item) => item.sessionKey === sessionKey);
  if (!session) {
    json(res, 404, { ok: false, error: "session not found" });
    return;
  }
  if (session.provider !== "local" || !session.filePath) {
    json(res, 400, { ok: false, error: "download only supported for local sessions" });
    return;
  }

  // Defence in depth: only files (a) ending in .jsonl and (b) sitting inside
  // one of the configured source roots are downloadable. Anything else is
  // rejected so this endpoint can't be coerced into reading random local
  // files even if the index ever held a stale entry.
  const filePath = path.resolve(session.filePath);
  if (path.extname(filePath).toLowerCase() !== ".jsonl") {
    json(res, 415, { ok: false, error: "not a jsonl transcript" });
    return;
  }
  const allowedRoots = [roots.cursor, roots.claudeCode, roots.codex]
    .filter(Boolean)
    .map((root) => path.resolve(root));
  const inRoot = allowedRoots.some(
    (root) => filePath === root || filePath.startsWith(root + path.sep)
  );
  if (!inRoot) {
    json(res, 403, { ok: false, error: "path not in allowed roots" });
    return;
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    json(res, code === "ENOENT" ? 404 : 500, { ok: false, error: String(error) });
    return;
  }
  if (!stat.isFile()) {
    json(res, 404, { ok: false, error: "not a file" });
    return;
  }

  // Filename: <source>-<sessionId>.jsonl. Sanitize defensively even though
  // sessionId is normally a UUID/path-safe string.
  const safeId = session.sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const downloadName = `${session.source}-${safeId}.jsonl`;

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
  res.setHeader("Cache-Control", "no-store");

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.once("error", reject);
    res.once("close", () => stream.destroy());
    stream.once("end", () => resolve());
    stream.pipe(res);
  });
}

async function handleOpenFile({ res, url }: RouteContext) {
  if (rejectIfTeamMode(res)) return;
  const indexData = await loadIndex();
  const sessionKey = decodeURIComponent(url.pathname.replace("/api/open-file/", ""));
  const session = indexData.sessions.find((item) => item.sessionKey === sessionKey);
  if (!session) {
    json(res, 404, { ok: false, error: "session not found" });
    return;
  }
  if (session.provider !== "local" || !session.filePath) {
    json(res, 400, { ok: false, error: "open only supported for local sessions" });
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
  // Team mode is allowed here, unlike most other local routes — see
  // `resolveAssetPath`'s `cursorRootOnly` flag for the reasoning. Briefly:
  // remote-aggregated sessions still embed local clipboard-cache paths in
  // `<image_files>` blocks; if the *current* viewer happens to also be the
  // author of that turn, the file is right there on disk and serving it is
  // both safe and useful. Cross-machine paths simply 404 — the same outcome
  // as before, just without blocking everything.
  const rawPath = url.searchParams.get("path") || "";
  const result = resolveAssetPath(rawPath, roots, {
    cursorRootOnly: isTeamMode(),
  });
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

// ---------------------------------------------------------------------------
// /api/mode — read + switch the active data source
// ---------------------------------------------------------------------------

async function handleGetMode({ res }: RouteContext) {
  if (!activeState) {
    json(res, 500, { ok: false, error: "provider not initialised" });
    return;
  }
  // Note: never echo the bearer token. `teamConfigPresent` is enough for the
  // frontend to decide between "first-time setup" and "already configured".
  json(res, 200, {
    ok: true,
    mode: activeState.mode,
    edition: getEdition(),
    capabilities: activeState.provider.capabilities,
    team_config_present: activeState.teamConfigPresent,
    last_error: activeState.lastError,
  });
}

async function handlePostMode({ req, res, roots }: RouteContext) {
  // Body shape: { mode: "team" | "personal" }. team-mode wiring is built in
  // (see src/config.ts TEAM_INGEST_URL / TEAM_INGEST_TOKEN) so we don't
  // accept teamConfig here. Old clients that still send it are tolerated —
  // we just ignore the extra field rather than 400.
  type Body = { mode?: AppMode };
  const body = await readJsonBody<Body>(req, {});
  if (body.mode !== "team" && body.mode !== "personal") {
    json(res, 400, { ok: false, error: "mode must be 'team' or 'personal'" });
    return;
  }

  const result = await applyMode({ mode: body.mode }, roots);
  if (!result.ok) {
    json(res, result.status, { ok: false, error: result.error });
    return;
  }

  // Swap the active provider in-place; the next request will see the new one.
  activeState = {
    mode: result.mode,
    provider: result.provider,
    teamConfigPresent: result.teamConfigPresent,
  };

  // Local mode benefits from a warmup so the index is hot for the next list
  // request; team mode doesn't need it.
  if (activeState.provider.warmup) {
    activeState.provider.warmup().catch((err) => {
      console.error("post-switch warmup failed:", err);
    });
  }

  json(res, 200, {
    ok: true,
    mode: result.mode,
    edition: getEdition(),
    capabilities: result.provider.capabilities,
    team_config_present: result.teamConfigPresent,
  });
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

async function dispatch(ctx: RouteContext): Promise<void> {
  if (await handleStaticAsset(ctx)) return;

  // /api/mode is always available — even before a provider is wired up the
  // GET path can report `provider not initialised` so the renderer doesn't
  // get stuck.
  if (ctx.req.method === "GET" && ctx.url.pathname === "/api/mode") {
    return handleGetMode(ctx);
  }
  if (ctx.req.method === "POST" && ctx.url.pathname === "/api/mode") {
    return handlePostMode(ctx);
  }

  if (ctx.url.pathname.startsWith("/api/ai/")) {
    if (rejectIfTeamMode(ctx.res)) return;
    if (await dispatchAi(ctx.req, ctx.res)) return;
    json(ctx.res, 404, { error: "ai endpoint not found" });
    return;
  }

  const { method } = ctx.req;
  const { pathname } = ctx.url;

  if (method === "GET" && pathname === "/api/repos") return handleListRepos(ctx);
  if (method === "GET" && pathname === "/api/sources") return handleListSources(ctx);
  if (method === "GET" && pathname === "/api/search") return handleSearch(ctx);
  // Match the JSONL download before the generic detail handler — `startsWith`
  // alone would swallow `/api/session/<key>/jsonl` and return JSON instead.
  if (method === "GET" && pathname.match(/^\/api\/session\/.+\/jsonl$/))
    return handleSessionJsonl(ctx);
  if (method === "GET" && pathname.startsWith("/api/session/")) return handleSessionDetail(ctx);
  if (method === "DELETE" && pathname.startsWith("/api/session/")) return handleDeleteSession(ctx);
  if (method === "POST" && pathname === "/api/reindex") return handleReindex(ctx);
  if (method === "GET" && pathname === "/api/annotations") return handleListAnnotations(ctx);
  if (method === "PUT" && pathname.startsWith("/api/annotations/")) return handleUpdateAnnotation(ctx);
  if (method === "DELETE" && pathname.startsWith("/api/annotations/")) return handleDeleteAnnotation(ctx);
  if (method === "POST" && pathname.startsWith("/api/open-file/")) return handleOpenFile(ctx);
  if (method === "POST" && pathname === "/api/open-path") {
    if (rejectIfTeamMode(ctx.res)) return;
    return handleOpenPath(ctx);
  }
  if (method === "GET" && pathname === "/api/asset") return handleAsset(ctx);
  if (method === "GET" && pathname === "/api/fs/list") {
    if (rejectIfTeamMode(ctx.res)) return;
    return handleFsList(ctx);
  }
  // Task center routes (local-only — exports / AI runs)
  if (method === "POST" && pathname === "/api/tasks") {
    if (rejectIfTeamMode(ctx.res)) return;
    return handleCreateTask(ctx);
  }
  if (method === "GET" && pathname === "/api/tasks") {
    if (rejectIfTeamMode(ctx.res)) return;
    return handleListTasks(ctx);
  }
  if (method === "GET" && pathname.match(/^\/api\/tasks\/[^/]+\/stream$/)) {
    if (rejectIfTeamMode(ctx.res)) return;
    return handleTaskStream(ctx);
  }
  if (method === "GET" && pathname.match(/^\/api\/tasks\/[^/]+$/) && !pathname.includes("/stream")) {
    if (rejectIfTeamMode(ctx.res)) return;
    return handleGetTask(ctx);
  }
  // /api/export/target/<key> must be checked before the generic /api/export/<key>
  // download route so the dispatcher doesn't swallow it.
  if (method === "GET" && pathname.startsWith("/api/export/target/")) {
    if (rejectIfTeamMode(ctx.res)) return;
    return handleExportTarget(ctx);
  }
  if (method === "POST" && pathname === "/api/export/write") {
    if (rejectIfTeamMode(ctx.res)) return;
    return handleExportWrite(ctx);
  }
  if (method === "GET" && pathname.startsWith("/api/export/")) {
    if (rejectIfTeamMode(ctx.res)) return;
    return handleExportDownload(ctx);
  }

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

  // Decide which provider to start with. `loadActiveProvider` always returns
  // *something* — even broken team configs fall back to LocalDataProvider so
  // the server boots. The reason is surfaced via `lastError` on `GET /api/mode`.
  activeState = await loadActiveProvider(roots);

  // Personal-mode startup keeps doing the legacy index work so the existing
  // background reindex / annotation migration paths still apply. Team mode
  // doesn't load the local index at all.
  if (activeState.mode === "personal") {
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
  }

  const refreshIndex = async () => {
    if (activeState?.mode !== "personal") return;
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
      console.log(`reunion running: http://${host}:${port}`);
      console.log(`mode:        ${activeState?.mode}`);
      if (activeState?.lastError) {
        console.warn(`mode startup warning: ${activeState.lastError}`);
      }
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

// ---------------------------------------------------------------------------
// Test helpers — the `provider` slot is module-private so tests need a way to
// inject mocks without going through `applyMode`.
// ---------------------------------------------------------------------------

export const __testing__ = {
  setActiveState(state: ActiveProviderState | null) {
    activeState = state;
  },
  getActiveState() {
    return activeState;
  },
};
