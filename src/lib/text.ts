export function normalizeTs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return fallback;
  if (value > 1_000_000_000_000) return Math.floor(value / 1000);
  return Math.floor(value);
}

export function decodeEntities(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function toPlainText(text: string): string {
  return decodeEntities(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function escapeRegex(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tokenize(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_\-\u4e00-\u9fff]+/g);
  return (matches || []).map((item) => item.toLowerCase());
}

export function sanitizeFileName(input: string): string {
  const base = input
    .normalize("NFKD")
    .replace(/[^\w\u4e00-\u9fff-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "conversation";
}

export function toAsciiFileName(input: string): string {
  const ascii = input
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii || "conversation";
}

export function safeJsonStringify(value: unknown, space = 2): string {
  try {
    return JSON.stringify(value, null, space) || "";
  } catch {
    return String(value);
  }
}
