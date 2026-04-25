import path from "node:path";
import { promises as fs, createReadStream } from "node:fs";
import type { ServerResponse } from "node:http";
import type { SourceRoots } from "../types";

// Whitelist of image-ish extensions we are willing to serve. Anything else
// (json, jsonl, pdf, ...) is rejected so this endpoint can only ever leak
// what's already visually rendered in the UI.
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};

export type AssetResolveResult =
  | { ok: true; absPath: string; mime: string }
  | { ok: false; status: number; error: string };

/**
 * Validate `rawPath` against the source roots we already index. Two layers of
 * defence: (1) extension must be on the image whitelist, (2) the canonicalized
 * absolute path must sit *inside* one of the configured root directories
 * (cursor / claude-code / codex). Anything outside is refused with 403.
 */
export function resolveAssetPath(
  rawPath: string,
  roots: SourceRoots
): AssetResolveResult {
  if (!rawPath) return { ok: false, status: 400, error: "missing path" };

  let abs: string;
  try {
    abs = path.resolve(rawPath);
  } catch {
    return { ok: false, status: 400, error: "invalid path" };
  }

  const ext = path.extname(abs).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) return { ok: false, status: 415, error: "unsupported file type" };

  const allowedRoots = [roots.cursor, roots.claudeCode, roots.codex]
    .filter(Boolean)
    .map((root) => path.resolve(root));

  const inRoot = allowedRoots.some((root) => {
    if (abs === root) return true;
    return abs.startsWith(root + path.sep);
  });
  if (!inRoot) return { ok: false, status: 403, error: "path not in allowed roots" };

  return { ok: true, absPath: abs, mime };
}

/**
 * Stream the resolved asset to `res` using a long cache header (these files
 * are content-addressed by Cursor, so they're effectively immutable).
 */
export async function streamAsset(
  res: ServerResponse,
  absPath: string,
  mime: string
): Promise<void> {
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "not a file" }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "private, max-age=86400, immutable");

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath);
    stream.once("error", reject);
    res.once("close", () => stream.destroy());
    stream.once("end", () => resolve());
    stream.pipe(res);
  });
}
