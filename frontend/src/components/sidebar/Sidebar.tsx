import * as React from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { SessionListSkeleton } from "@/components/shared/Skeleton";
import { EmptyState } from "@/components/shared/EmptyState";
import { cn } from "@/lib/utils";
import type {
  RepoGroup,
  SourceFilter,
  SourceSummary,
  TagSummary,
} from "@/lib/types";
import { SessionGroup } from "./SessionGroup";
import { SidebarSearch } from "./SidebarSearch";
import { SourceTabs } from "./SourceTabs";

// macOS Electron 下需要给左上角的红/黄/绿交通灯按钮留出 ~70px 安全区，
// 否则它们会盖在 sidebar 顶部的标题上。同时把顶部条标记为窗口拖拽区，
// 让用户可以从这里拖动整个窗口（按钮 / 输入框单独 no-drag 保留交互）。
function useIsMacElectron(): boolean {
  const [isMac, setIsMac] = React.useState(false);
  React.useEffect(() => {
    if (typeof navigator === "undefined") return;
    const ua = navigator.userAgent;
    setIsMac(/Macintosh/i.test(ua) && /Electron/i.test(ua));
  }, []);
  return isMac;
}

const DRAG_STYLE: React.CSSProperties = {
  WebkitAppRegion: "drag",
} as React.CSSProperties;
const NO_DRAG_STYLE: React.CSSProperties = {
  WebkitAppRegion: "no-drag",
} as React.CSSProperties;

interface SidebarProps {
  query: string;
  setQuery: (value: string) => void;
  onSubmit: () => void;
  loading: boolean;
  onReindex: () => void;

  days: string;
  setDays: (value: string) => void;
  selectedRepo: string;
  setSelectedRepo: (value: string) => void;
  repoOptions: string[];

  selectedSource: SourceFilter;
  setSelectedSource: (next: SourceFilter) => void;
  sourceSummaries: SourceSummary[];

  onlyStarred: boolean;
  setOnlyStarred: (value: boolean | ((prev: boolean) => boolean)) => void;
  selectedTags: string[];
  setSelectedTags: (next: string[] | ((prev: string[]) => string[])) => void;
  allTags: TagSummary[];
  tagPickerOpen: boolean;
  setTagPickerOpen: (value: boolean) => void;

  filteredCount: number;
  totalCount: number;
  hasQuery: boolean;
  groupedResults: RepoGroup[];
  collapsedRepos: Record<string, boolean>;
  onToggleRepo: (repo: string) => void;
  activeSessionKey: string;
  onOpenSession: (sessionKey: string) => void;
  onToggleStar: (sessionKey: string) => void;
  onJumpToHit: (sessionKey: string, segmentIndex: number, hitIndex: number) => void;

  firstLoad: boolean;
  className?: string;
}

function Sidebar(props: SidebarProps) {
  const {
    filteredCount,
    totalCount,
    groupedResults,
    collapsedRepos,
    onToggleRepo,
    activeSessionKey,
    hasQuery,
    onOpenSession,
    onToggleStar,
    onJumpToHit,
    firstLoad,
    loading,
    className,
    query,
    onlyStarred,
    selectedTags,
    onReindex,
    selectedSource,
    setSelectedSource,
    sourceSummaries,
    ...searchProps
  } = props;

  const hasFilters = onlyStarred || selectedTags.length > 0;
  const showSkeleton = firstLoad && loading;
  const showEmpty = !showSkeleton && groupedResults.length === 0;

  const isMacElectron = useIsMacElectron();
  const headerDragStyle = isMacElectron ? DRAG_STYLE : undefined;
  const headerNoDragStyle = isMacElectron ? NO_DRAG_STYLE : undefined;

  return (
    <aside
      className={cn(
        "bg-background-soft border-r border-border text-foreground flex flex-col min-h-0",
        className
      )}
    >
      <div
        className="px-4 py-4 border-b border-border"
        style={headerDragStyle}
      >
        <div
          className={cn(
            "flex items-center justify-between",
            isMacElectron && "pl-[70px]"
          )}
        >
          <div className="flex items-center gap-2 font-serif text-[17px] font-semibold tracking-tight">
            <Sparkles className="h-4 w-4 text-primary" />
            Logue
          </div>
          <Tooltip text="Rescan all workspaces for new conversations">
            <button
              type="button"
              onClick={onReindex}
              aria-label="Reindex"
              style={headerNoDragStyle}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
        <div className="mt-3" style={headerNoDragStyle}>
          <SidebarSearch
            query={query}
            onlyStarred={onlyStarred}
            selectedTags={selectedTags}
            loading={loading}
            {...searchProps}
          />
        </div>
      </div>

      <div className="px-4 py-2 border-b border-border space-y-2">
        <SourceTabs
          value={selectedSource}
          onChange={setSelectedSource}
          sources={sourceSummaries}
          totalCount={sourceSummaries.reduce((sum, item) => sum + item.session_count, 0)}
        />
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
          <span>
            Threads ·{" "}
            <span className="text-foreground">{filteredCount}</span>
            {filteredCount !== totalCount ? (
              <span className="opacity-60"> / {totalCount}</span>
            ) : null}
          </span>
          {hasFilters || hasQuery ? (
            <span className="text-accent">filtered</span>
          ) : null}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-thin overscroll-contain">
        {showSkeleton ? (
          <SessionListSkeleton />
        ) : showEmpty ? (
          <EmptyState
            eyebrow="nothing here"
            title={hasQuery || hasFilters ? "No matches" : "No sessions yet"}
            description={
              hasQuery || hasFilters
                ? "Try broadening your query or clearing filters."
                : "Run reindex from the header once your Cursor workspace has conversations."
            }
            className="py-16"
          />
        ) : (
          <div className="px-3 py-3 space-y-2 animate-fade-in">
            {groupedResults.map((group) => {
              const groupKey = `${group.source}:${group.repo}`;
              return (
                <SessionGroup
                  key={groupKey}
                  group={group}
                  collapsed={collapsedRepos[groupKey] ?? false}
                  onToggle={() => onToggleRepo(groupKey)}
                  activeSessionKey={activeSessionKey}
                  hasQuery={hasQuery}
                  onOpenSession={onOpenSession}
                  onToggleStar={onToggleStar}
                  onJumpToHit={onJumpToHit}
                />
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="group/tip relative">
      {children}
      <div
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full mt-1.5 z-50 w-max max-w-[200px] rounded-md bg-foreground px-2.5 py-1.5 text-[11px] leading-snug text-background shadow-lg opacity-0 transition-opacity group-hover/tip:opacity-100"
      >
        {text}
      </div>
    </div>
  );
}

export { Sidebar };
