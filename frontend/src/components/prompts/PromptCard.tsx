import * as React from "react";
import { cn } from "@/lib/utils";
import { decodeEntities, formatTsCompact, relativeTime } from "@/lib/format";
import type { PromptEntry, SourceId } from "@/lib/types";
import { SOURCE_LABEL } from "@/lib/types";

const SOURCE_BADGE_CLASS: Record<SourceId, string> = {
  cursor: "bg-muted text-muted-foreground",
  "claude-code": "bg-accent/15 text-accent",
  codex: "bg-muted text-muted-foreground",
};

interface PromptCardProps {
  entry: PromptEntry;
  selected: boolean;
  onSelect: () => void;
}

const PREVIEW_CHARS = 160;

function buildPreview(text: string): string {
  const decoded = decodeEntities(text).replace(/\s+/g, " ").trim();
  if (decoded.length <= PREVIEW_CHARS) return decoded;
  return decoded.slice(0, PREVIEW_CHARS).trimEnd() + "…";
}

function PromptCard({ entry, selected, onSelect }: PromptCardProps) {
  const preview = buildPreview(entry.text);
  const occurrences = entry.occurrence_count ?? entry.occurrences.length;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group relative cursor-pointer rounded-md px-3 py-2.5 transition-colors",
        "hover:bg-surface focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
        selected && "bg-primary-soft hover:bg-primary-soft"
      )}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 font-serif text-[13.5px] leading-[1.4] line-clamp-3",
              selected ? "text-foreground" : "text-foreground/90"
            )}
          >
            {preview || "(empty prompt)"}
          </span>
          <span className="mt-[2px] shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {relativeTime(entry.last_seen)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground/80">
          <span
            className={cn(
              "inline-flex h-[16px] items-center rounded-sm px-1 text-[9.5px] font-semibold uppercase tracking-[0.06em]",
              "bg-foreground/[0.07] text-foreground"
            )}
            title={`${occurrences} occurrence${occurrences === 1 ? "" : "s"}`}
          >
            ×{occurrences}
          </span>
          {entry.sources.map((source) => (
            <span
              key={source}
              className={cn(
                "inline-flex h-[15px] items-center rounded-sm px-1 text-[9.5px] font-semibold uppercase tracking-[0.06em]",
                SOURCE_BADGE_CLASS[source]
              )}
            >
              {SOURCE_LABEL[source]}
            </span>
          ))}
          <span className="opacity-40">·</span>
          <span className="truncate tabular-nums">{formatTsCompact(entry.last_seen)}</span>
          {entry.repos.length > 0 ? (
            <>
              <span className="opacity-40">·</span>
              <span className="truncate text-muted-foreground/80">
                {entry.repos.length === 1
                  ? entry.repos[0]
                  : `${entry.repos[0]} +${entry.repos.length - 1}`}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export { PromptCard };
