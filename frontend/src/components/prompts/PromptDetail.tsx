import * as React from "react";
import { ArrowUpRight, Copy, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/shared/EmptyState";
import { cn } from "@/lib/utils";
import {
  decodeEntities,
  formatTs,
  formatTsCompact,
  relativeTime,
} from "@/lib/format";
import { fetchSimilarPrompts } from "@/lib/api";
import type {
  PromptEntry,
  PromptOccurrence,
  PromptSimilarMatch,
  SourceId,
} from "@/lib/types";
import { SOURCE_LABEL } from "@/lib/types";
import { SimilarPromptList } from "./SimilarPromptList";

const SOURCE_BADGE_CLASS: Record<SourceId, string> = {
  cursor: "bg-muted text-muted-foreground",
  "claude-code": "bg-accent/15 text-accent",
  codex: "bg-muted text-muted-foreground",
};

interface PromptDetailProps {
  entry: PromptEntry | null;
  loading: boolean;
  onJumpToOccurrence: (occurrence: PromptOccurrence) => void;
  onSelectPrompt: (entry: PromptEntry) => void;
  onCopy: (message: string, tone?: "default" | "success" | "error") => void;
  /** Increments when the embeddings pipeline becomes ready, so we can re-fetch
   * an existing similar list with the upgraded backend. */
  embeddingsReadyToken?: number;
  className?: string;
}

function PromptDetail({
  entry,
  loading,
  onJumpToOccurrence,
  onSelectPrompt,
  onCopy,
  embeddingsReadyToken,
  className,
}: PromptDetailProps) {
  const [similarLoading, setSimilarLoading] = React.useState(false);
  const [similarMatches, setSimilarMatches] = React.useState<PromptSimilarMatch[]>([]);
  const [similarMethod, setSimilarMethod] = React.useState<"jaccard" | "embedding" | null>(null);
  const [similarFallback, setSimilarFallback] = React.useState<string | undefined>(undefined);
  const [similarRequested, setSimilarRequested] = React.useState(false);
  const [similarError, setSimilarError] = React.useState<string>("");

  // Switching to a different prompt resets the similar-prompt panel so we don't
  // briefly show the previous prompt's matches against the new header.
  React.useEffect(() => {
    setSimilarRequested(false);
    setSimilarMatches([]);
    setSimilarMethod(null);
    setSimilarFallback(undefined);
    setSimilarError("");
  }, [entry?.prompt_hash]);

  const handleShowSimilar = React.useCallback(async () => {
    if (!entry) return;
    setSimilarRequested(true);
    setSimilarLoading(true);
    setSimilarError("");
    try {
      // method=auto lets the backend prefer embeddings, falling back to
      // Jaccard whenever the model isn't ready. The threshold here matches
      // the Jaccard branch on the backend; embedding branch uses its own
      // higher default of 0.6.
      const response = await fetchSimilarPrompts(entry.prompt_hash, {
        k: 10,
        threshold: 0.4,
        method: "auto",
      });
      setSimilarMatches(response.matches);
      setSimilarMethod(response.method);
      setSimilarFallback(response.fallback);
    } catch (error) {
      setSimilarError(String(error));
    } finally {
      setSimilarLoading(false);
    }
  }, [entry]);

  // When embeddings transition to ready and the user already opened the
  // similar list with Jaccard, transparently re-fetch to upgrade the result.
  React.useEffect(() => {
    if (!embeddingsReadyToken) return;
    if (!similarRequested) return;
    if (similarMethod !== "jaccard") return;
    void handleShowSimilar();
    // intentionally narrow deps — we want to retry exactly once per ready event
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embeddingsReadyToken]);

  const handleCopy = React.useCallback(async () => {
    if (!entry) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(entry.text);
      } else {
        const input = document.createElement("textarea");
        input.value = entry.text;
        input.setAttribute("readonly", "true");
        input.style.position = "absolute";
        input.style.left = "-9999px";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      onCopy("Prompt copied", "success");
    } catch (error) {
      onCopy(`Copy failed: ${String(error)}`, "error");
    }
  }, [entry, onCopy]);

  if (!entry && !loading) {
    return (
      <div className={cn("flex-1 min-w-0 flex items-center justify-center", className)}>
        <EmptyState
          eyebrow="prompt library"
          title="Pick a prompt from the list"
          description="Each prompt aggregates every time you (or a teammate using your machine) sent the same instruction across Cursor, Claude Code, and Codex."
        />
      </div>
    );
  }

  if (!entry) {
    return (
      <div className={cn("flex-1 min-w-0 flex items-center justify-center", className)}>
        <div className="text-[12px] text-muted-foreground">Loading prompt…</div>
      </div>
    );
  }

  const occurrences = [...entry.occurrences].sort((a, b) => b.ts - a.ts);
  const occurrenceCount = entry.occurrence_count ?? entry.occurrences.length;

  return (
    <div className={cn("flex-1 min-w-0 flex flex-col bg-background min-h-0", className)}>
      <header className="border-b border-border px-6 py-4">
        <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
          <span>Prompt</span>
          <span className="opacity-40">·</span>
          <span>×{occurrenceCount}</span>
          <span className="opacity-40">·</span>
          <span>last seen {relativeTime(entry.last_seen)}</span>
          {entry.text_truncated ? (
            <>
              <span className="opacity-40">·</span>
              <span className="text-amber-600 dark:text-amber-400">truncated</span>
            </>
          ) : null}
        </div>
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 flex-1 font-serif text-[18px] font-medium leading-snug text-foreground line-clamp-3">
            {decodeEntities(entry.text).replace(/\s+/g, " ").trim().slice(0, 240)}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" size="sm" onClick={handleCopy}>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={() => void handleShowSimilar()}
              disabled={similarLoading}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Show similar
            </Button>
          </div>
        </div>
      </header>

      <ScrollArea className="flex-1 min-h-0">
        <div className="mx-auto max-w-[900px] space-y-6 px-6 py-6">
          <section>
            <h3 className="mb-2 font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
              Full text
            </h3>
            <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-background-soft px-4 py-3 text-[13px] leading-relaxed text-foreground">
              {entry.text}
            </pre>
          </section>

          <section>
            <h3 className="mb-2 font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
              Metadata
            </h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
              <dt className="text-muted-foreground">First seen</dt>
              <dd className="text-foreground tabular-nums">{formatTs(entry.first_seen)}</dd>
              <dt className="text-muted-foreground">Last seen</dt>
              <dd className="text-foreground tabular-nums">{formatTs(entry.last_seen)}</dd>
              <dt className="text-muted-foreground">Sources</dt>
              <dd className="flex flex-wrap items-center gap-1.5">
                {entry.sources.map((source) => (
                  <span
                    key={source}
                    className={cn(
                      "inline-flex h-[16px] items-center rounded-sm px-1 text-[9.5px] font-semibold uppercase tracking-[0.06em]",
                      SOURCE_BADGE_CLASS[source]
                    )}
                  >
                    {SOURCE_LABEL[source]}
                  </span>
                ))}
              </dd>
              <dt className="text-muted-foreground">Repos</dt>
              <dd className="text-foreground">
                {entry.repos.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  entry.repos.join(", ")
                )}
              </dd>
              <dt className="text-muted-foreground">Hash</dt>
              <dd className="font-mono text-[11px] text-muted-foreground/80 truncate">
                {entry.prompt_hash}
              </dd>
            </dl>
          </section>

          <section>
            <h3 className="mb-2 font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
              Occurrences
            </h3>
            <ul className="space-y-1.5">
              {occurrences.map((occurrence, idx) => (
                <li key={`${occurrence.session_key}-${occurrence.segment_index}-${idx}`}>
                  <button
                    type="button"
                    onClick={() => onJumpToOccurrence(occurrence)}
                    className={cn(
                      "group flex w-full items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-left text-[12px] transition-colors",
                      "hover:border-border-strong hover:bg-background-soft"
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex h-[16px] items-center rounded-sm px-1 text-[9.5px] font-semibold uppercase tracking-[0.06em]",
                        SOURCE_BADGE_CLASS[occurrence.source]
                      )}
                    >
                      {SOURCE_LABEL[occurrence.source]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground/90">
                      {occurrence.repo || "(unknown repo)"}
                    </span>
                    <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                      {formatTsCompact(occurrence.ts)}
                    </span>
                    <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {similarRequested ? (
            <section>
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
                Similar prompts
              </h3>
              {similarError ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                  {similarError}
                </div>
              ) : (
                <>
                  {similarFallback === "embedding-unavailable" ? (
                    <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                      Smart clustering not ready yet — showing token-overlap matches. Enable it via the banner above for semantic results.
                    </div>
                  ) : null}
                  <SimilarPromptList
                    loading={similarLoading}
                    matches={similarMatches}
                    method={similarMethod}
                    onSelect={onSelectPrompt}
                  />
                </>
              )}
            </section>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

export { PromptDetail };
