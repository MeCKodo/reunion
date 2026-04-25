import * as React from "react";
import { fetchPromptDetail, fetchPrompts } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  PromptEntry,
  PromptOccurrence,
  RepoOption,
  SourceFilter,
  SourceSummary,
} from "@/lib/types";
import { EmbeddingStatusBanner } from "./EmbeddingStatusBanner";
import { PromptDetail } from "./PromptDetail";
import { PromptList } from "./PromptList";

interface PromptsViewProps {
  sourceSummaries: SourceSummary[];
  repoCatalog: RepoOption[];
  onJumpToOccurrence: (occurrence: PromptOccurrence) => void;
  onNotify: (message: string, tone?: "default" | "success" | "error") => void;
  className?: string;
}

const LIST_DEBOUNCE_MS = 200;
const LIST_LIMIT = 500;

function PromptsView({
  sourceSummaries,
  repoCatalog,
  onJumpToOccurrence,
  onNotify,
  className,
}: PromptsViewProps) {
  const [prompts, setPrompts] = React.useState<PromptEntry[]>([]);
  const [total, setTotal] = React.useState(0);
  const [listLoading, setListLoading] = React.useState(false);

  const [selectedHash, setSelectedHash] = React.useState<string>("");
  const [selectedEntry, setSelectedEntry] = React.useState<PromptEntry | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);

  const [query, setQuery] = React.useState("");
  const [selectedSource, setSelectedSource] = React.useState<SourceFilter>("all");
  const [selectedRepo, setSelectedRepo] = React.useState("all");
  const [minOccurrences, setMinOccurrences] = React.useState(2);

  // Debounce filter changes so typing in the search box doesn't fire one
  // request per keystroke against the in-memory pipeline.
  React.useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setListLoading(true);
      fetchPrompts({
        source: selectedSource,
        repo: selectedRepo,
        query,
        minOccurrences,
        limit: LIST_LIMIT,
      })
        .then((response) => {
          if (cancelled) return;
          setPrompts(response.prompts);
          setTotal(response.total);
          // Auto-select the first entry if nothing is selected yet, or if the
          // current selection got filtered out.
          setSelectedHash((prev) => {
            if (response.prompts.length === 0) return "";
            if (prev && response.prompts.some((entry) => entry.prompt_hash === prev)) return prev;
            return response.prompts[0].prompt_hash;
          });
        })
        .catch((error) => {
          if (cancelled) return;
          onNotify(`Prompts load failed: ${String(error)}`, "error");
          setPrompts([]);
          setTotal(0);
        })
        .finally(() => {
          if (cancelled) return;
          setListLoading(false);
        });
    }, LIST_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedSource, selectedRepo, query, minOccurrences, onNotify]);

  // Pull the full prompt body whenever the selection changes — list responses
  // truncate `text` to 8KB by default, while detail returns up to ~200KB.
  React.useEffect(() => {
    if (!selectedHash) {
      setSelectedEntry(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    fetchPromptDetail(selectedHash)
      .then((entry) => {
        if (cancelled) return;
        setSelectedEntry(entry);
      })
      .catch((error) => {
        if (cancelled) return;
        onNotify(`Prompt detail failed: ${String(error)}`, "error");
        setSelectedEntry(null);
      })
      .finally(() => {
        if (cancelled) return;
        setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedHash, onNotify]);

  const handleSelect = React.useCallback((entry: PromptEntry) => {
    setSelectedHash(entry.prompt_hash);
  }, []);

  // Bumped whenever the embeddings pipeline becomes ready, so children that
  // render similarity results can re-fetch with the upgraded backend.
  const [embeddingsReadyToken, setEmbeddingsReadyToken] = React.useState(0);
  const handleEmbeddingsReady = React.useCallback(() => {
    setEmbeddingsReadyToken((prev) => prev + 1);
  }, []);

  // Reset repo filter when switching source if the current repo no longer
  // belongs to the new source.
  React.useEffect(() => {
    if (selectedRepo === "all") return;
    const stillAvailable = repoCatalog.some(
      (option) =>
        option.repo === selectedRepo &&
        (selectedSource === "all" || option.source === selectedSource)
    );
    if (!stillAvailable) setSelectedRepo("all");
  }, [repoCatalog, selectedRepo, selectedSource]);

  return (
    <div className={cn("flex flex-col flex-1 min-w-0 min-h-0", className)}>
      <EmbeddingStatusBanner totalPrompts={total} onReady={handleEmbeddingsReady} />
      <div className="flex flex-1 min-w-0 min-h-0">
        <PromptList
          className="w-[380px] shrink-0"
          prompts={prompts}
          total={total}
          loading={listLoading}
          selectedHash={selectedHash}
          onSelect={handleSelect}
          query={query}
          onQueryChange={setQuery}
          selectedSource={selectedSource}
          onSelectedSourceChange={setSelectedSource}
          selectedRepo={selectedRepo}
          onSelectedRepoChange={setSelectedRepo}
          minOccurrences={minOccurrences}
          onMinOccurrencesChange={setMinOccurrences}
          sourceSummaries={sourceSummaries}
          repoCatalog={repoCatalog}
        />
        <PromptDetail
          entry={selectedEntry}
          loading={detailLoading}
          onJumpToOccurrence={onJumpToOccurrence}
          onSelectPrompt={handleSelect}
          onCopy={onNotify}
          embeddingsReadyToken={embeddingsReadyToken}
        />
      </div>
    </div>
  );
}

export { PromptsView };
