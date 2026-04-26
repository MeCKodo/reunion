// Frontend mirror of `src/lib/asset.ts` policy. The actual security check
// lives on the backend; this module's job is only to (a) recognize image-ish
// paths in raw text and (b) build the URL the frontend should hit.

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)(?:[?#].*)?$/i;

export function isImagePath(value: string): boolean {
  return IMG_EXT_RE.test(value.trim());
}

export function isAbsoluteLocalPath(value: string): boolean {
  if (!value) return false;
  // Unix absolute path (starts with `/` and is not a URL scheme).
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  // Windows drive path: C:\..., D:/...
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  // file:// URL — the backend will normalize but we still want to detect it.
  if (value.toLowerCase().startsWith("file://")) return true;
  return false;
}

export function assetUrl(absPath: string): string {
  const normalized = absPath.trim();
  // Already a renderable URL — leave it alone. This covers inline base64
  // payloads (`data:image/png;base64,...`) returned by Claude's image
  // content items, plus any remote http(s) URL we might surface in future.
  const lower = normalized.toLowerCase();
  if (
    lower.startsWith("data:") ||
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("blob:")
  ) {
    return normalized;
  }
  let resolved = normalized;
  if (lower.startsWith("file://")) {
    try {
      resolved = decodeURIComponent(new URL(normalized).pathname);
    } catch {
      resolved = normalized.slice("file://".length);
    }
  }
  return `/api/asset?path=${encodeURIComponent(resolved)}`;
}

// Pull every absolute path that *looks like an image* out of a free-form
// block of text. Tolerates the `1. /path/to/file.png` numbered-list shape
// that Cursor uses inside `<image_files>` blocks, as well as bare paths.
export function extractImagePaths(content: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const lineRe = /(?:^|\s)((?:\/|[A-Za-z]:[\\/])[^\s'"<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(content)) !== null) {
    const candidate = match[1].replace(/[),.;]+$/, "");
    if (!isImagePath(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    paths.push(candidate);
  }
  return paths;
}

export function basenameOf(p: string): string {
  const trimmed = p.trim();
  // data: URIs have no real basename; render a stable "image.<ext>" label
  // derived from the media type so the lightbox header doesn't show the
  // raw base64 payload.
  if (trimmed.toLowerCase().startsWith("data:")) {
    const match = /^data:([^;,]+)/i.exec(trimmed);
    const mime = match?.[1] ?? "";
    const ext = mime.split("/")[1] || "img";
    return `image.${ext}`;
  }
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Frontend mirror of the backend `ClaudeImagePayload`. Carried on a Claude
 * timeline event's `tool_input` field whenever a content item of type
 * `image` is parsed — the frontend uses the `data` URI / URL as `<img src>`
 * directly, so we don't re-fetch through `/api/asset`.
 */
export type ClaudeImagePayload = {
  kind: "base64" | "url";
  mediaType?: string;
  data: string;
};

export function isClaudeImagePayload(value: unknown): value is ClaudeImagePayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "base64" && candidate.kind !== "url") return false;
  return typeof candidate.data === "string" && candidate.data.length > 0;
}

const TEXT_IMAGE_RE =
  /\[Image:\s*source:\s*((?:\/|[A-Za-z]:[\\/])[^\]]+?)\s*\]/g;

export type InlineImageMatch = {
  start: number;
  end: number;
  path: string;
};

/**
 * Find every `[Image: source: /abs/path.png]` reference in a text blob.
 * Claude CLI uses this textual form to record clipboard pastes whose
 * underlying file lives in `/var/folders/...`. We surface it as an inline
 * image preview, with a graceful fallback when the temp file is gone.
 */
export function extractInlineImageRefs(text: string): InlineImageMatch[] {
  const out: InlineImageMatch[] = [];
  TEXT_IMAGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEXT_IMAGE_RE.exec(text)) !== null) {
    const candidate = match[1].trim();
    if (!candidate || !isImagePath(candidate)) continue;
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      path: candidate,
    });
  }
  return out;
}
