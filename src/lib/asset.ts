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

export interface ResolveAssetOptions {
  /**
   * Narrow the allow-list to the Cursor root only. Used in team mode where
   * we still want to surface clipboard screenshots cached by the local
   * Cursor install, but must refuse arbitrary local paths (`~/.claude`,
   * `~/.codex`, etc.) the remote-aggregated session might be carrying from
   * other people's machines.
   */
  cursorRootOnly?: boolean;
}

/**
 * Validate `rawPath` against the source roots we already index. Two layers of
 * defence: (1) extension must be on the image whitelist, (2) the canonicalized
 * absolute path must sit *inside* one of the configured root directories
 * (cursor / claude-code / codex). Anything outside is refused with 403.
 */
export function resolveAssetPath(
  rawPath: string,
  roots: SourceRoots,
  options: ResolveAssetOptions = {}
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

  const candidateRoots = options.cursorRootOnly
    ? [roots.cursor]
    : [roots.cursor, roots.claudeCode, roots.codex];
  const allowedRoots = candidateRoots
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
 * Inspect the first few bytes of a file to determine its real image format.
 * Cursor's clipboard-paste feature names every screenshot `image-<uuid>.png`
 * regardless of the actual encoding — many turn out to be JPEGs. Trusting
 * the file extension makes Chromium silently fail decoding (a JPEG served
 * as `image/png` triggers `<img onError>` instead of rendering), so we
 * prefer magic-byte detection over the extension.
 *
 * Returns `null` when the bytes don't match a recognised image signature,
 * in which case the caller should fall back to the extension-based mime.
 */
async function sniffImageMime(absPath: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(absPath, "r");
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    if (bytesRead < 4) return null;

    if (
      bytesRead >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    ) {
      return "image/png";
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      buf[0] === 0x47 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x38
    ) {
      return "image/gif";
    }
    if (
      bytesRead >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    ) {
      return "image/webp";
    }
    if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
    return null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * Stream the resolved asset to `res` using a long cache header (these files
 * are content-addressed by Cursor, so they're effectively immutable).
 *
 * `mime` is the extension-based mime guessed by `resolveAssetPath`. We
 * sniff the file's magic bytes and prefer that over the extension when they
 * disagree — see `sniffImageMime` above.
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

  const sniffed = await sniffImageMime(absPath);
  const finalMime = sniffed ?? mime;

  res.statusCode = 200;
  res.setHeader("Content-Type", finalMime);
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
