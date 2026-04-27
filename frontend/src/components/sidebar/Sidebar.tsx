import * as React from "react";
import { useTranslation } from "react-i18next";
import { ListTodo, RefreshCw, Settings as SettingsIcon } from "lucide-react";
import i18n from "@/i18n";
import { SessionListSkeleton } from "@/components/shared/Skeleton";
import { EmptyState } from "@/components/shared/EmptyState";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useElectronDrag } from "@/hooks/useElectronDrag";
import { useTaskCenter } from "@/lib/task-center";
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

  const { t } = useTranslation();
  const hasFilters = onlyStarred || selectedTags.length > 0;
  const showSkeleton = firstLoad && loading;
  const showEmpty = !showSkeleton && groupedResults.length === 0;

  // macOS Electron 下需要给左上角的红/黄/绿交通灯按钮留出 ~70px 安全区，
  // 否则它们会盖在 sidebar 顶部的标题上。同时把顶部条标记为窗口拖拽区，
  // 让用户可以从这里拖动整个窗口（按钮 / 输入框单独 no-drag 保留交互）。
  const { enabled: isMacElectron, dragStyle: headerDragStyle, noDragStyle: headerNoDragStyle } =
    useElectronDrag();
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const { activeCount, toggleSidebar } = useTaskCenter();

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
            <ReunionMark className="h-[18px] w-[18px]" />
            Reunion
          </div>
          <div className="flex items-center gap-0.5" style={headerNoDragStyle}>
            <Tooltip text={t("language.label")}>
              <button
                type="button"
                onClick={() => {
                  const next = i18n.language === "zh" ? "en" : "zh";
                  i18n.changeLanguage(next);
                }}
                className="inline-flex h-7 items-center justify-center rounded-md px-1.5 font-mono text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
              >
                {i18n.language === "zh" ? "EN" : "中文"}
              </button>
            </Tooltip>
            <Tooltip text={t("sidebar.settingsTooltip")}>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                aria-label={t("sidebar.openSettings")}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
              >
                <SettingsIcon className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <Tooltip text="任务中心">
              <button
                type="button"
                onClick={toggleSidebar}
                aria-label="任务中心"
                className={cn(
                  "relative inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface hover:text-foreground",
                  activeCount > 0 && "text-primary"
                )}
              >
                <ListTodo className="h-3.5 w-3.5" />
                {activeCount > 0 ? (
                  <span className="absolute -top-0.5 -right-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-bold text-primary-foreground">
                    {activeCount}
                  </span>
                ) : null}
              </button>
            </Tooltip>
            <Tooltip text={t("sidebar.reindexTooltip")}>
              <button
                type="button"
                onClick={onReindex}
                aria-label={t("sidebar.reindex")}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>
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
            {t("sidebar.threads")} ·{" "}
            <span className="text-foreground">{filteredCount}</span>
            {filteredCount !== totalCount ? (
              <span className="opacity-60"> / {totalCount}</span>
            ) : null}
          </span>
          {hasFilters || hasQuery ? (
            <span className="text-accent">{t("sidebar.filtered")}</span>
          ) : null}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-thin overscroll-contain">
        {showSkeleton ? (
          <SessionListSkeleton />
        ) : showEmpty ? (
          <EmptyState
            eyebrow={t("sidebar.nothingHere")}
            title={hasQuery || hasFilters ? t("sidebar.noMatches") : t("sidebar.noSessionsYet")}
            description={
              hasQuery || hasFilters
                ? t("sidebar.noMatchesDesc")
                : t("sidebar.noSessionsDesc")
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
                  onToggle={onToggleRepo}
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
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </aside>
  );
}

function ReunionMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 74 74"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Reunion"
      className={className}
    >
      <rect x="0" y="0" width="66" height="66" rx="16" fill="#fbfaf7" />
      <path d="M18 15h24c7 0 12 5 12 12v23H30c-7 0-12-5-12-12V15Z" fill="#5a4f7b" />
      <path d="M10 24h24c7 0 12 5 12 12v14H22c-7 0-12-5-12-12V24Z" fill="#e08454" />
      <path d="M23 19h17c6 0 10 4 10 10v17H33c-6 0-10-4-10-10V19Z" fill="#23202d" />
      <circle cx="37" cy="33" r="5" fill="#fbfaf7" />
    </svg>
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
