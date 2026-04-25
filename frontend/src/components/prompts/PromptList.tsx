import * as React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/EmptyState";
import { SessionListSkeleton } from "@/components/shared/Skeleton";
import { cn } from "@/lib/utils";
import type {
  PromptEntry,
  RepoOption,
  SourceFilter,
  SourceSummary,
} from "@/lib/types";
import { SOURCE_LABEL } from "@/lib/types";
import { PromptCard } from "./PromptCard";

interface PromptListProps {
  prompts: PromptEntry[];
  total: number;
  loading: boolean;
  selectedHash: string;
  onSelect: (entry: PromptEntry) => void;

  query: string;
  onQueryChange: (next: string) => void;
  selectedSource: SourceFilter;
  onSelectedSourceChange: (next: SourceFilter) => void;
  selectedRepo: string;
  onSelectedRepoChange: (next: string) => void;
  minOccurrences: number;
  onMinOccurrencesChange: (next: number) => void;

  sourceSummaries: SourceSummary[];
  repoCatalog: RepoOption[];

  className?: string;
}

const SOURCE_TABS: SourceFilter[] = ["all", "cursor", "claude-code", "codex"];

const MIN_OCCURRENCES_OPTIONS = [
  { value: 1, label: "All" },
  { value: 2, label: "≥ 2" },
  { value: 3, label: "≥ 3" },
  { value: 5, label: "≥ 5" },
];

function PromptList({
  prompts,
  total,
  loading,
  selectedHash,
  onSelect,
  query,
  onQueryChange,
  selectedSource,
  onSelectedSourceChange,
  selectedRepo,
  onSelectedRepoChange,
  minOccurrences,
  onMinOccurrencesChange,
  sourceSummaries,
  repoCatalog,
  className,
}: PromptListProps) {
  const sourceCounts = React.useMemo(() => {
    const map: Record<SourceFilter, number> = {
      all: sourceSummaries.reduce((sum, item) => sum + item.session_count, 0),
      cursor: 0,
      "claude-code": 0,
      codex: 0,
    };
    for (const summary of sourceSummaries) {
      map[summary.id] = summary.session_count;
    }
    return map;
  }, [sourceSummaries]);

  const repos = React.useMemo(() => {
    const filtered =
      selectedSource === "all"
        ? repoCatalog
        : repoCatalog.filter((option) => option.source === selectedSource);
    const names = new Set<string>();
    for (const option of filtered) names.add(option.repo);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [repoCatalog, selectedSource]);

  return (
    <aside
      className={cn(
        "bg-background-soft border-r border-border text-foreground flex flex-col min-h-0",
        className
      )}
    >
      <div className="px-4 py-3 border-b border-border space-y-3">
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search prompts…"
          leading={<Search className="h-3.5 w-3.5" />}
          className="h-8 text-[13px]"
        />

        <div
          role="tablist"
          aria-label="Prompt source"
          className="flex items-center gap-0.5 rounded-md bg-foreground/[0.06] p-0.5"
        >
          {SOURCE_TABS.map((id) => {
            const active = selectedSource === id;
            const label = id === "all" ? "All" : SOURCE_LABEL[id];
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelectedSourceChange(id)}
                className={cn(
                  "flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-all",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                  active
                    ? "bg-background text-foreground shadow-[0_1px_2px_rgba(22,24,35,0.12),0_0_0_0.5px_rgba(22,24,35,0.08)]"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{label}</span>
                <span
                  className={cn(
                    "shrink-0 font-mono text-[10px] tabular-nums",
                    active ? "text-foreground/60" : "text-muted-foreground/60"
                  )}
                >
                  {sourceCounts[id]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
          <span className="shrink-0">Min</span>
          <div className="flex items-center gap-0.5 rounded-md bg-foreground/[0.06] p-0.5">
            {MIN_OCCURRENCES_OPTIONS.map((option) => {
              const active = minOccurrences === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onMinOccurrencesChange(option.value)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                    active ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <select
            value={selectedRepo}
            onChange={(event) => onSelectedRepoChange(event.target.value)}
            className="ml-auto h-7 max-w-[160px] truncate rounded-md border border-border-strong bg-surface px-2 text-[11px] font-normal normal-case tracking-normal text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            title="Filter by repo"
          >
            <option value="all">All repos</option>
            {repos.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
          <span>
            Prompts ·{" "}
            <span className="text-foreground">{prompts.length}</span>
            {prompts.length !== total ? <span className="opacity-60"> / {total}</span> : null}
          </span>
          {query.trim() ? <span className="text-accent">filtered</span> : null}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-thin overscroll-contain">
        {loading && prompts.length === 0 ? (
          <SessionListSkeleton />
        ) : prompts.length === 0 ? (
          <EmptyState
            eyebrow="nothing here"
            title="No prompts match"
            description="Try clearing the query, lowering the minimum, or switching the source tab."
            className="py-16"
          />
        ) : (
          <div className="px-3 py-3 space-y-1.5 animate-fade-in">
            {prompts.map((entry) => (
              <PromptCard
                key={entry.prompt_hash}
                entry={entry}
                selected={entry.prompt_hash === selectedHash}
                onSelect={() => onSelect(entry)}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

export { PromptList };
