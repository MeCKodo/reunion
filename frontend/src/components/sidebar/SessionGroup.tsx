import * as React from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { prettifyRepoName } from "@/lib/format";
import type { RepoGroup } from "@/lib/types";
import { SessionListItem } from "./SessionListItem";

interface SessionGroupProps {
  group: RepoGroup;
  collapsed: boolean;
  /**
   * Stable callback shared across all groups. The group derives its own key
   * (`source:repo`) so we don't need an inline closure per row.
   */
  onToggle: (groupKey: string) => void;
  activeSessionKey: string;
  hasQuery: boolean;
  onOpenSession: (sessionKey: string) => void;
  onToggleStar: (sessionKey: string) => void;
  onJumpToHit: (sessionKey: string, segmentIndex: number, hitIndex: number) => void;
}

function SessionGroup({
  group,
  collapsed,
  onToggle,
  activeSessionKey,
  hasQuery,
  onOpenSession,
  onToggleStar,
  onJumpToHit,
}: SessionGroupProps) {
  const repoLabel = prettifyRepoName(group.repo);
  const groupKey = `${group.source}:${group.repo}`;
  const handleToggle = React.useCallback(() => {
    onToggle(groupKey);
  }, [onToggle, groupKey]);
  return (
    <div>
      <button
        type="button"
        onClick={handleToggle}
        className={cn(
          "w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md transition-colors",
          "hover:bg-surface focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        )}
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3 text-muted-foreground/70" />
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground/70" />
        )}
        <Folder className="h-3.5 w-3.5 text-muted-foreground/70" />
        <span className="flex-1 truncate text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/65">
          {repoLabel}
        </span>
        <span className="font-mono text-[10px] tracking-overline text-muted-foreground/70">
          {group.sessions.length}
        </span>
      </button>

      {!collapsed ? (
        <div className="mt-1 space-y-0.5">
          {group.sessions.map((item) => (
            <SessionListItem
              key={item.session_key}
              item={item}
              selected={item.session_key === activeSessionKey}
              hasQuery={hasQuery}
              onOpen={onOpenSession}
              onToggleStar={onToggleStar}
              onJumpToHit={onJumpToHit}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Memoized so the sidebar's keystroke-driven re-renders stop cascading into
// every group header. The groupedResults array is rebuilt on every keystroke
// (new RepoGroup objects), so when the same query is in flight the list
// stays referentially equal anyway. We compare by reference plus the few
// scalar props to keep this tight.
const SessionGroupMemo = React.memo(SessionGroup, (prev, next) => {
  if (prev.group !== next.group) return false;
  if (prev.collapsed !== next.collapsed) return false;
  if (prev.activeSessionKey !== next.activeSessionKey) return false;
  if (prev.hasQuery !== next.hasQuery) return false;
  if (prev.onToggle !== next.onToggle) return false;
  if (prev.onOpenSession !== next.onOpenSession) return false;
  if (prev.onToggleStar !== next.onToggleStar) return false;
  if (prev.onJumpToHit !== next.onJumpToHit) return false;
  return true;
});

export { SessionGroupMemo as SessionGroup };
