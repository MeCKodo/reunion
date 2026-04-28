// Route handlers for export-related endpoints:
//   GET  /api/export/target/:sessionKey
//   POST /api/export/write
//   GET  /api/export/:sessionKey  (download)
//   GET  /api/fs/list
//   POST /api/open-path

import path from "node:path";
import { promises as fsp } from "node:fs";
import { json, readJsonBody } from "../lib/http.js";
import { loadIndex } from "../index-store.js";
import { generateExportMarkdown } from "../export.js";
import { resolveRepoTarget, setRepoMapping } from "../repo-target.js";
import { sanitizeFileName, toAsciiFileName } from "../lib/text.js";
import { openFileInSystem } from "../lib/system.js";
import {
  listBookmarks,
  listDirectory,
  resolveBrowsePath,
} from "../lib/fs-browse.js";
import type { ExportKind, ExportMode, Session } from "../types.js";
import type { RouteContext } from "./types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeShortSlug(input: string): string {
  const cleaned = sanitizeFileName(input).toLowerCase();
  if (cleaned.length <= 48) return cleaned;
  return cleaned.slice(0, 48).replace(/-+$/, "");
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

export async function handleExportTarget({ res, url }: RouteContext) {
  const indexData = await loadIndex();
  const sessionKey = decodeURIComponent(url.pathname.replace("/api/export/target/", ""));
  const session = indexData.sessions.find((item: Session) => item.sessionKey === sessionKey);
  if (!session) {
    json(res, 404, { ok: false, error: "session not found" });
    return;
  }
  const kindParam = (url.searchParams.get("kind") || "rules").toLowerCase();
  const kind: ExportKind = kindParam === "skill" ? "skill" : "rules";
  const override = url.searchParams.get("path") || undefined;
  const target = await resolveRepoTarget(session, { override });
  const slug = makeShortSlug(session.title || session.sessionId);
  const relPath =
    kind === "skill"
      ? path.join(".claude", "skills", slug, "SKILL.md")
      : path.join(".cursor", "rules", `${slug}.mdc`);
  let absPath: string | undefined;
  let fileExists = false;
  if (target.path) {
    absPath = path.join(target.path, relPath);
    try {
      await fsp.access(absPath);
      fileExists = true;
    } catch {
      // file doesn't exist yet
    }
  }
  json(res, 200, {
    ok: true,
    repo: {
      path: target.path || null,
      source: target.source,
      exists: target.exists,
      isGitRepo: target.isGitRepo,
    },
    relativePath: relPath,
    absolutePath: absPath || null,
    fileExists,
    slug,
  });
}

interface ExportWriteBody {
  sessionKey: string;
  kind: ExportKind;
  mode: ExportMode;
  targetDir: string;
  relativePath?: string;
  overwrite?: boolean;
  rememberMapping?: boolean;
  provider?: "openai" | "cursor";
  accountId?: string;
}

export async function handleExportWrite({ req, res }: RouteContext) {
  const body = await readJsonBody<Partial<ExportWriteBody>>(req, {});
  const sessionKey = String(body.sessionKey || "").trim();
  const targetDir = String(body.targetDir || "").trim();
  if (!sessionKey || !targetDir) {
    json(res, 400, { ok: false, error: "sessionKey and targetDir are required" });
    return;
  }

  const indexData = await loadIndex();
  const session = indexData.sessions.find((item: Session) => item.sessionKey === sessionKey);
  if (!session) {
    json(res, 404, { ok: false, error: "session not found" });
    return;
  }

  const kindRaw = (body.kind || "rules").toLowerCase();
  const kind: ExportKind = kindRaw === "skill" ? "skill" : "rules";
  const modeRaw = (body.mode || "smart").toLowerCase();
  const mode: ExportMode = modeRaw === "smart" ? "smart" : "basic";

  try {
    const stat = await fsp.stat(targetDir);
    if (!stat.isDirectory()) {
      json(res, 400, { ok: false, error: `not a directory: ${targetDir}` });
      return;
    }
  } catch (error) {
    json(res, 400, {
      ok: false,
      error: `target directory missing: ${String((error as Error)?.message || error)}`,
    });
    return;
  }

  const slug = makeShortSlug(session.title || session.sessionId);
  const defaultRel =
    kind === "skill"
      ? path.join(".claude", "skills", slug, "SKILL.md")
      : path.join(".cursor", "rules", `${slug}.mdc`);
  const requestedRel = (body.relativePath || defaultRel).replace(/^[\\/]+/, "");
  const absPath = path.resolve(targetDir, requestedRel);
  const targetDirReal = path.resolve(targetDir);
  if (!absPath.startsWith(targetDirReal + path.sep) && absPath !== targetDirReal) {
    json(res, 400, { ok: false, error: "relativePath must stay inside targetDir" });
    return;
  }

  const overwrite = body.overwrite === true;
  let fileExisted = false;
  try {
    await fsp.access(absPath);
    fileExisted = true;
  } catch {
    // happy path
  }
  if (fileExisted && !overwrite) {
    json(res, 409, {
      ok: false,
      error: "file already exists",
      absolutePath: absPath,
      relativePath: requestedRel,
    });
    return;
  }

  const generated = await generateExportMarkdown(session, kind, mode, {
    provider: body.provider,
    accountId: body.accountId,
  });

  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, generated.markdown, "utf-8");

  if (body.rememberMapping !== false) {
    await setRepoMapping(session.repo, targetDirReal, session.source);
  }

  json(res, 200, {
    ok: true,
    absolutePath: absPath,
    relativePath: requestedRel,
    targetDir: targetDirReal,
    mode: generated.mode,
    warning: generated.warning,
    overwritten: fileExisted,
    bytes: Buffer.byteLength(generated.markdown, "utf-8"),
  });
}

export async function handleExportDownload({ res, url }: RouteContext) {
  const indexData = await loadIndex();
  const sessionKey = decodeURIComponent(url.pathname.replace("/api/export/", ""));
  const session = indexData.sessions.find((item: Session) => item.sessionKey === sessionKey);
  if (!session) {
    json(res, 404, { error: "session not found" });
    return;
  }
  const kind: ExportKind = (url.searchParams.get("type") || "rules").toLowerCase() === "skill" ? "skill" : "rules";
  const mode: ExportMode = (url.searchParams.get("mode") || "basic").toLowerCase() === "smart" ? "smart" : "basic";
  const providerParam = url.searchParams.get("provider");
  const provider =
    providerParam === "openai" || providerParam === "cursor" ? providerParam : undefined;
  const accountId = url.searchParams.get("accountId") || undefined;

  const safeTitle = sanitizeFileName(session.title || session.sessionId);
  const fileName = `${safeTitle}-${kind === "skill" ? "SKILL" : "RULES"}.md`;
  const generated = await generateExportMarkdown(session, kind, mode, { provider, accountId });
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

export async function handleFsList({ res, url }: RouteContext) {
  const requestedPath = url.searchParams.get("path");
  const absPath = resolveBrowsePath(requestedPath);
  try {
    const result = await listDirectory(absPath);
    const bookmarks = await listBookmarks();
    json(res, 200, { ok: true, ...result, bookmarks });
  } catch (error) {
    json(res, 400, {
      ok: false,
      error: String((error as Error)?.message || error),
      path: absPath,
    });
  }
}

interface OpenPathBody {
  path: string;
}

export async function handleOpenPath({ req, res }: RouteContext) {
  const body = await readJsonBody<Partial<OpenPathBody>>(req, {});
  const requested = String(body.path || "").trim();
  if (!requested) {
    json(res, 400, { ok: false, error: "path is required" });
    return;
  }
  try {
    const action = await openFileInSystem(requested);
    json(res, 200, { ok: true, path: requested, action });
  } catch (error) {
    json(res, 500, { ok: false, error: String(error) });
  }
}
