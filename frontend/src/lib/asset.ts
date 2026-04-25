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
  let normalized = absPath.trim();
  if (normalized.toLowerCase().startsWith("file://")) {
    try {
      normalized = decodeURIComponent(new URL(normalized).pathname);
    } catch {
      normalized = normalized.slice("file://".length);
    }
  }
  return `/api/asset?path=${encodeURIComponent(normalized)}`;
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
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
