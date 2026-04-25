import * as React from "react";
import { Clock3, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  decodeEntities,
  formatClock,
  formatDuration,
  formatTsCompact,
  historyCategoryLabel,
  relativeTime,
  stripHtml,
} from "@/lib/format";
import type { SearchResult, SourceId } from "@/lib/types";
import { SOURCE_LABEL } from "@/lib/types";

const SOURCE_BADGE_CLASS: Record<SourceId, string> = {
  cursor: "bg-muted text-muted-foreground",
  "claude-code": "bg-accent/15 text-accent",
  codex: "bg-muted text-muted-foreground",
};

interface SessionListItemProps {
  item: SearchResult;
  selected: boolean;
  hasQuery: boolean;
  onOpen: () => void;
  onToggleStar: () => void;
  onJumpToHit: (segmentIndex: number, hitIndex: number) => void;
}

const MAX_VISIBLE_TAGS = 2;

function SessionListItem({
  item,
  selected,
  hasQuery,
  onOpen,
  onToggleStar,
  onJumpToHit,
}: SessionListItemProps) {
  const title = decodeEntities(item.title || stripHtml(item.snippet) || item.session_id);
  const tags = item.tags ?? [];
  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);
  const overflowTagCount = Math.max(0, tags.length - visibleTags.length);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group relative cursor-pointer rounded-md px-3 py-2 transition-colors",
        "hover:bg-surface",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
        selected && "bg-primary-soft hover:bg-primary-soft"
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleStar();
          }}
          title={item.starred ? "Unstar" : "Star"}
          className={cn(
            "mt-[2px] inline-flex h-4 w-4 shrink-0 items-center justify-center transition-colors",
            item.starred
              ? "text-primary hover:text-primary/80"
              : "text-muted-foreground/50 hover:text-foreground"
          )}
        >
          <Star className={cn("h-3.5 w-3.5", item.starred && "fill-primary")} />
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start justify-between gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 font-serif text-[13.5px] leading-[1.35] line-clamp-2",
                selected ? "text-foreground" : "text-foreground/90"
              )}
            >
              {title}
            </span>
            <span className="mt-[2px] shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
              {relativeTime(item.updated_at)}
            </span>
          </div>

          <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground/80">
            <span
              className={cn(
                "inline-flex h-[15px] items-center rounded-sm px-1 text-[9.5px] font-semibold uppercase tracking-[0.06em]",
                SOURCE_BADGE_CLASS[item.source]
              )}
              title={item.repo_path || item.repo}
            >
              {SOURCE_LABEL[item.source]}
            </span>
            <Clock3 className="h-3 w-3 shrink-0 opacity-70" />
            <span className="tabular-nums">{formatDuration(item.duration_sec)}</span>
            <span className="opacity-40">·</span>
            <span className="truncate tabular-nums">{formatTsCompact(item.started_at)}</span>
            {visibleTags.length > 0 ? (
              <>
                <span className="opacity-40">·</span>
                <span className="flex min-w-0 items-center gap-1 truncate">
                  {visibleTags.map((tag) => (
                    <span key={tag} className="text-muted-foreground/90">
                      #{tag}
                    </span>
                  ))}
                  {overflowTagCount > 0 ? (
                    <span className="text-muted-foreground/60">+{overflowTagCount}</span>
                  ) : null}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {hasQuery ? (
        <div className="mt-2 space-y-1.5 pl-6">
          <div className="font-mono text-[10px] uppercase tracking-overline text-accent">
            {item.match_count || 0} {(item.match_count || 0) === 1 ? "hit" : "hits"}
          </div>
          {item.message_hits.slice(0, 2).map((hit, hitIndex) => (
            <button
              key={`${item.session_key}-${hit.segment_index}-${hitIndex}`}
              onClick={(event) => {
                event.stopPropagation();
                onJumpToHit(hit.segment_index, hitIndex);
              }}
              className="block w-full border-l border-border bg-surface/70 px-2 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-surface"
            >
              <div className="mb-0.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
                <span>{historyCategoryLabel(hit.role)}</span>
                <span className="opacity-40">·</span>
                <span>{formatClock(hit.ts)}</span>
              </div>
              <div
                className="line-clamp-2 text-[12px] leading-snug text-foreground/80"
                dangerouslySetInnerHTML={{ __html: hit.preview }}
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export { SessionListItem };
