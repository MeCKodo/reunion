import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { decodeEntities } from "@/lib/format";
import type { PromptEntry, PromptSimilarMatch } from "@/lib/types";

interface SimilarPromptListProps {
  loading: boolean;
  matches: PromptSimilarMatch[];
  method: "jaccard" | "embedding" | null;
  onSelect: (entry: PromptEntry) => void;
}

const PREVIEW_CHARS = 140;

function preview(text: string): string {
  const decoded = decodeEntities(text).replace(/\s+/g, " ").trim();
  if (decoded.length <= PREVIEW_CHARS) return decoded;
  return decoded.slice(0, PREVIEW_CHARS).trimEnd() + "…";
}

function SimilarPromptList({ loading, matches, method, onSelect }: SimilarPromptListProps) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Searching similar prompts…</span>
      </div>
    );
  }

  if (matches.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background-soft px-3 py-3 text-[12px] text-muted-foreground">
        No prompts cleared the similarity threshold. This one is unique in the
        index — try lowering the threshold once embeddings ship.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
        <span>
          Similar · <span className="text-foreground">{matches.length}</span>
        </span>
        {method ? <span className="text-muted-foreground/80">{method}</span> : null}
      </div>
      <div className="space-y-1.5">
        {matches.map((match) => {
          const entry = match.prompt;
          if (!entry) return null;
          return (
            <button
              key={entry.prompt_hash}
              type="button"
              onClick={() => onSelect(entry)}
              className={cn(
                "block w-full rounded-md border border-border bg-surface px-3 py-2 text-left transition-colors",
                "hover:border-border-strong hover:bg-background-soft"
              )}
            >
              <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
                <span className="rounded-sm bg-foreground/[0.07] px-1 py-px text-[9.5px] tabular-nums text-foreground">
                  {(match.score * 100).toFixed(0)}%
                </span>
                <span>×{entry.occurrence_count ?? entry.occurrences.length}</span>
                {entry.sources.length > 0 ? (
                  <>
                    <span className="opacity-40">·</span>
                    <span className="truncate normal-case tracking-normal">
                      {entry.sources.join(" / ")}
                    </span>
                  </>
                ) : null}
              </div>
              <p className="text-[12.5px] leading-snug text-foreground/90 line-clamp-3">
                {preview(entry.text)}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { SimilarPromptList };
