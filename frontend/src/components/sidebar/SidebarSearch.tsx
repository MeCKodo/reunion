import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Filter, Loader2, Search, Star } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { prettifyRepoName } from "@/lib/format";
import { DAY_OPTIONS, type TagSummary } from "@/lib/types";
import { ChipButton } from "./ChipButton";
import { TagFilterPopover } from "./TagFilterPopover";
import { AiTaggerButton } from "./AiTaggerButton";
import type { SearchResult } from "@/lib/types";

interface SidebarSearchProps {
  query: string;
  setQuery: (value: string) => void;
  onSubmit: () => void;
  loading: boolean;
  days: string;
  setDays: (value: string) => void;
  selectedRepo: string;
  setSelectedRepo: (value: string) => void;
  repoOptions: string[];
  onlyStarred: boolean;
  setOnlyStarred: (value: boolean | ((prev: boolean) => boolean)) => void;
  selectedTags: string[];
  setSelectedTags: (next: string[] | ((prev: string[]) => string[])) => void;
  allTags: TagSummary[];
  tagPickerOpen: boolean;
  setTagPickerOpen: (value: boolean) => void;
  /**
   * Flat list of currently filtered sessions, fed straight to the AI
   * tagger button so it can target the same set the user sees in the
   * sidebar (no extra "select all" step).
   */
  filteredResults: SearchResult[];
  onAiTaggerError?: (message: string) => void;
}

function SidebarSearch({
  query,
  setQuery,
  onSubmit,
  loading,
  days,
  setDays,
  selectedRepo,
  setSelectedRepo,
  repoOptions,
  onlyStarred,
  setOnlyStarred,
  selectedTags,
  setSelectedTags,
  allTags,
  tagPickerOpen,
  setTagPickerOpen,
  filteredResults,
  onAiTaggerError,
}: SidebarSearchProps) {
  const { t } = useTranslation();
  const hasAdvancedFilter = selectedRepo !== "all" || days !== "30";
  const daysLabel = (() => {
    const opt = DAY_OPTIONS.find((d) => d.value === days);
    return opt ? t(opt.labelKey) : days;
  })();

  return (
    <div className="space-y-2.5">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit();
        }}
        leading={<Search className="h-3.5 w-3.5" />}
        trailing={
          loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <kbd className="pointer-events-none font-mono text-[10px] text-muted-foreground/60">⌘K</kbd>
          )
        }
        placeholder={t("sidebar.searchPlaceholder")}
        className="h-9"
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <ChipButton
          active={!onlyStarred && selectedTags.length === 0 && !hasAdvancedFilter}
          onClick={() => {
            setOnlyStarred(false);
            setSelectedTags([]);
            setSelectedRepo("all");
            setDays("30");
          }}
        >
          {t("sidebar.all")}
        </ChipButton>

        <ChipButton
          active={onlyStarred}
          onClick={() => setOnlyStarred((v) => !v)}
          icon={<Star className={cn("h-3 w-3", onlyStarred && "fill-current")} />}
        >
          {t("sidebar.starred")}
        </ChipButton>

        <TagFilterPopover
          allTags={allTags}
          selectedTags={selectedTags}
          setSelectedTags={setSelectedTags}
          open={tagPickerOpen}
          setOpen={setTagPickerOpen}
        />

        <AiTaggerButton
          filteredResults={filteredResults}
          allTags={allTags}
          onError={onAiTaggerError}
        />

        <Popover>
          <PopoverTrigger asChild>
            <ChipButton
              active={hasAdvancedFilter}
              icon={<Filter className="h-3 w-3" />}
              trailing={<ChevronDown className="h-3 w-3 opacity-60" />}
            >
              {hasAdvancedFilter
                ? [
                    selectedRepo !== "all" && prettifyRepoName(selectedRepo),
                    days !== "30" && daysLabel,
                  ].filter(Boolean).join(" · ")
                : t("sidebar.filter")}
            </ChipButton>
          </PopoverTrigger>

          <PopoverContent align="start" sideOffset={8} className="w-72 p-0">
            <div className="px-2.5 pt-2.5 pb-1.5">
              <div className="flex items-center justify-between mb-1">
                <span className="inline-flex items-baseline gap-1.5 font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
                  {t("sidebar.project")}
                  <span className="font-mono text-[10px] tabular-nums normal-case tracking-normal text-muted-foreground/60">
                    {repoOptions.length}
                  </span>
                </span>
                {selectedRepo !== "all" && (
                  <button
                    className="text-[10px] text-accent hover:underline"
                    onClick={() => setSelectedRepo("all")}
                  >
                    {t("common.reset")}
                  </button>
                )}
              </div>
              {/* max-h is intentionally tuned to clip the last visible row in
                  half (≈6.3 rows at ~28px each). The half-row hint signals
                  "more below" without needing an explicit scrollbar arrow,
                  while the actual scrollbar still works on hover. */}
              <div className="max-h-[176px] overflow-y-auto scrollbar-thin space-y-0.5">
                <FilterOption
                  active={selectedRepo === "all"}
                  onClick={() => setSelectedRepo("all")}
                >
                  {t("sidebar.allProjects")}
                </FilterOption>
                {repoOptions.map((repo) => (
                  <FilterOption
                    key={repo}
                    active={selectedRepo === repo}
                    onClick={() => setSelectedRepo(repo)}
                  >
                    {prettifyRepoName(repo)}
                  </FilterOption>
                ))}
              </div>
            </div>

            <div className="border-t border-border px-2.5 pt-1.5 pb-2.5">
              <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
                {t("sidebar.timeRange")}
              </span>
              {/* Segmented control: equal-width 3×2 grid. Each option is a
                  real chip with its own visible background so users can see
                  every hit target before they hover. Hover state goes
                  high-contrast (foreground tint + dark text + subtle ring)
                  so it's unambiguous when the cursor has landed inside the
                  button — the previous "translucent white on light grey"
                  transition was almost invisible. */}
              <div className="grid grid-cols-3 gap-1">
                {DAY_OPTIONS.map((item) => {
                  const active = days === item.value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setDays(item.value)}
                      className={cn(
                        "inline-flex h-7 items-center justify-center rounded-md px-2 text-[11.5px] tabular-nums transition-colors",
                        "border focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                        active
                          ? "border-foreground bg-foreground text-background font-medium"
                          : "border-border bg-surface text-muted-foreground hover:border-border-strong hover:bg-background-soft hover:text-foreground"
                      )}
                    >
                      {t(item.labelKey)}
                    </button>
                  );
                })}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

function FilterOption({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center rounded-md px-2 py-1 text-left text-[12px] transition-colors",
        active
          ? "bg-foreground text-background font-medium"
          : "text-foreground hover:bg-background-soft"
      )}
    >
      <span className="truncate">{children}</span>
    </button>
  );
}

export { SidebarSearch };
