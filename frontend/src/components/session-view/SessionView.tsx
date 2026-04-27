import * as React from "react";
import { Menu, NotebookPen } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StatusBar, StatusItem, StatusDivider } from "@/components/ui/status-bar";
import { EmptyState } from "@/components/shared/EmptyState";
import { SessionDetailSkeleton } from "@/components/shared/Skeleton";
import { useElectronDrag } from "@/hooks/useElectronDrag";
import { cn } from "@/lib/utils";
import type { ExportKind } from "@/lib/api";
import type {
  DetailMessageHit,
  MessageRoleFilter,
  SessionDetail,
  SubagentDetail,
  TimelineEvent,
} from "@/lib/types";
import type { ToolBucket } from "@/lib/transcript";
import { MessageList } from "./MessageList";
import { SessionHeader } from "./SessionHeader";
import { ViewToolbar } from "./ViewToolbar";

interface SessionViewProps {
  detail: SessionDetail | null;
  detailLoading: boolean;

  messageRoleFilter: MessageRoleFilter;
  setMessageRoleFilter: (filter: MessageRoleFilter) => void;
  toolBucketCounts: Record<ToolBucket, number>;

  queryTokens: string[];
  detailMessageHits: DetailMessageHit[];
  activeMatch: number;
  pulseKey: number;
  onPrevMatch: () => void;
  onNextMatch: () => void;

  inSessionQuery: string;
  setInSessionQuery: (value: string) => void;

  visibleEvents: TimelineEvent[];
  visibleSubagents: Array<SubagentDetail & { filteredEvents: TimelineEvent[] }>;
  conversationViewportRef: React.Ref<HTMLDivElement>;
  registerEventRef: (eventId: string, node: HTMLDivElement | null) => void;

  onToggleStar: () => void;
  onCopySessionId: () => void;
  onExport: (kind: ExportKind) => void;
  exportLoading: "" | ExportKind;
  onDeleteSession: () => Promise<void>;

  tagInput: string;
  setTagInput: (value: string) => void;
  onAddTag: (value: string) => boolean;
  onRemoveTag: (tag: string) => void;

  statusText?: string;
  className?: string;

  onOpenSidebar?: () => void;
}

function SessionView(props: SessionViewProps) {
  const {
    detail,
    detailLoading,
    messageRoleFilter,
    setMessageRoleFilter,
    toolBucketCounts,
    queryTokens,
    detailMessageHits,
    activeMatch,
    pulseKey,
    onPrevMatch,
    onNextMatch,
    inSessionQuery,
    setInSessionQuery,
    visibleEvents,
    visibleSubagents,
    conversationViewportRef,
    registerEventRef,
    onToggleStar,
    onCopySessionId,
    onExport,
    exportLoading,
    onDeleteSession,
    tagInput,
    setTagInput,
    onAddTag,
    onRemoveTag,
    statusText,
    className,
    onOpenSidebar,
  } = props;

  // Wire ⌘F / Ctrl-F to the in-session search box. We mount the listener on
  // window so it works regardless of where focus currently is inside the
  // detail pane — but only when a conversation is open, so we don't fight
  // the browser's native find on the empty state.
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!detail) return;
    const handler = (event: KeyboardEvent) => {
      const isFind = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";
      if (!isFind) return;
      event.preventDefault();
      const input = searchInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [detail]);

  const { enabled: isMacElectron, dragStyle, noDragStyle } = useElectronDrag();

  const mobileTopBar = onOpenSidebar ? (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-2 lg:hidden"
      style={dragStyle}
    >
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label="Open sidebar"
        style={noDragStyle}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border-strong bg-surface text-muted-foreground transition-colors hover:bg-background-soft hover:text-foreground"
      >
        <Menu className="h-4 w-4" />
      </button>
      <span
        style={noDragStyle}
        className="font-mono text-[10px] uppercase tracking-overline text-muted-foreground"
      >
        Sessions
      </span>
    </div>
  ) : null;

  // 没有打开任何 session 时，右侧没有 SessionHeader 提供拖拽区域；为了让 macOS
  // Electron 用户依旧能从顶部拖动窗口，在大屏下补一条隐形拖拽条（mobile 已经
  // 通过 mobileTopBar 处理）。高度刚好覆盖红绿灯区域。
  const electronEmptyTopDragBar = isMacElectron ? (
    <div
      className="hidden lg:block shrink-0 h-10"
      style={dragStyle}
      aria-hidden
    />
  ) : null;

  if (!detail) {
    return (
      <section
        className={cn(
          "bg-background text-foreground h-full flex flex-col overflow-hidden min-w-0",
          className
        )}
      >
        {mobileTopBar}
        {electronEmptyTopDragBar}
        <EmptyState
          eyebrow="ready"
          title="Select a conversation"
          description="Pick any thread from the panel on the left, or search across every repository to begin."
          icon={<NotebookPen className="h-5 w-5" />}
        />
      </section>
    );
  }

  return (
    <section
      className={cn(
        "bg-background text-foreground h-full flex flex-col overflow-hidden min-w-0",
        className
      )}
    >
      {mobileTopBar}

      <SessionHeader
        detail={detail}
        onToggleStar={onToggleStar}
        onCopySessionId={onCopySessionId}
        onExport={onExport}
        exportLoading={exportLoading}
        onDeleteSession={onDeleteSession}
        tagInput={tagInput}
        setTagInput={setTagInput}
        onAddTag={onAddTag}
        onRemoveTag={onRemoveTag}
      />

      <ViewToolbar
        messageRoleFilter={messageRoleFilter}
        setMessageRoleFilter={setMessageRoleFilter}
        toolBucketCounts={toolBucketCounts}
        queryActive={queryTokens.length > 0}
        hitsCount={detailMessageHits.length}
        activeMatch={activeMatch}
        onPrevMatch={onPrevMatch}
        onNextMatch={onNextMatch}
        inSessionQuery={inSessionQuery}
        setInSessionQuery={setInSessionQuery}
        searchInputRef={searchInputRef}
        statusText={statusText}
        source={detail.source}
        hasSubagents={detail.subagents.length > 0}
        clockAlignment={detail.clock_alignment}
      />

      <div className="relative flex-1 min-h-0">
        <ScrollArea
          className="h-full"
          viewportRef={conversationViewportRef}
          viewportClassName="scrollbar-thin"
        >
          {detailLoading ? (
            <SessionDetailSkeleton />
          ) : (
            <MessageList
              visibleEvents={visibleEvents}
              visibleSubagents={visibleSubagents}
              queryTokens={queryTokens}
              detailMessageHits={detailMessageHits}
              activeMatch={activeMatch}
              pulseKey={pulseKey}
              registerRef={registerEventRef}
              source={detail.source}
            />
          )}
        </ScrollArea>
      </div>

      <StatusBar>
        <StatusItem>CONVERSATION</StatusItem>
        <StatusDivider />
        <StatusItem>
          {visibleEvents.length} events
          {visibleSubagents.length > 0
            ? ` · ${visibleSubagents.length} subagents`
            : ""}
        </StatusItem>
        {queryTokens.length > 0 ? (
          <>
            <StatusDivider />
            <StatusItem tone="accent">
              {detailMessageHits.length ? `${activeMatch + 1}/${detailMessageHits.length}` : "0"} hits
            </StatusItem>
          </>
        ) : null}
        <StatusDivider />
        <StatusItem tone="muted" className="ml-auto truncate">
          {detail.session_id}
        </StatusItem>
      </StatusBar>
    </section>
  );
}

export { SessionView };
