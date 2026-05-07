import * as React from "react";
import { Clock3 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Cursor injects `<timestamp>Thursday, May 7, 2026, 2:26 PM (UTC+8)</timestamp>`
 * into user messages so the model knows wall-clock time. The full string is too
 * verbose to read inline, but it's also informative — we don't want to discard
 * it. Render a compact, low-emphasis badge in place: short clock face on hover
 * shows the original phrasing as title.
 *
 * Heuristic: try to extract a `H:MM AM/PM` chunk; otherwise fall back to the
 * raw string trimmed.
 */
const TIME_RE = /(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))/;

export function formatTimestampShort(raw: string): string {
  const trimmed = raw.trim();
  const m = TIME_RE.exec(trimmed);
  if (m) return m[1].replace(/\s+/g, " ").toUpperCase();
  // Fall through: keep at most ~24 chars so the badge stays single-line.
  return trimmed.length > 24 ? trimmed.slice(0, 23) + "…" : trimmed;
}

interface TimestampBadgeProps {
  raw: string;
  className?: string;
}

export function TimestampBadge({ raw, className }: TimestampBadgeProps) {
  const short = formatTimestampShort(raw);
  return (
    <span
      title={raw.trim()}
      className={cn(
        "inline-flex items-center gap-1 align-middle",
        "rounded px-1.5 py-[1px]",
        "bg-foreground/[0.04] text-muted-foreground/80",
        "font-mono text-[10.5px] tracking-tight tabular-nums",
        "select-text",
        className
      )}
    >
      <Clock3 className="h-2.5 w-2.5 shrink-0 opacity-70" strokeWidth={2.25} />
      <span>{short}</span>
    </span>
  );
}
