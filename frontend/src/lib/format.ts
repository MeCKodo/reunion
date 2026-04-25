import type { HistoryCategory } from "./types";

export function prettifyRepoName(repo: string): string {
  return repo.replace(/^Users-bytedance-/, "").replace(/^workspaces-/, "").replaceAll("-", " ");
}

export function decodeEntities(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

export function stripHtml(text: string): string {
  return decodeEntities(text).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

export function formatTsCompact(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDuration(durationSec: number): string {
  const t = Math.max(0, durationSec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function relativeTime(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - ts);
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d`;
  return `${Math.floor(delta / (86400 * 30))}mo`;
}

export function historyCategoryLabel(category: HistoryCategory): string {
  if (category === "assistant") return "Cursor";
  if (category === "tool") return "Tool";
  if (category === "system") return "System";
  return "User";
}

export function buildHistoryPreview(text: string): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim().slice(0, 220);
}

export function normalizeTagInput(input: string): string | null {
  const cleaned = input.toLowerCase().trim().replace(/[^\w\u4e00-\u9fff_-]+/g, "");
  if (!cleaned) return null;
  return cleaned.slice(0, 32);
}
