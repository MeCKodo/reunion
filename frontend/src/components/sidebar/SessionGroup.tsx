import * as React from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { prettifyRepoName } from "@/lib/format";
import type { RepoGroup } from "@/lib/types";
import { SessionListItem } from "./SessionListItem";

interface SessionGroupProps {
  group: RepoGroup;
  collapsed: boolean;
  onToggle: () => void;
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
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
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
              onOpen={() => onOpenSession(item.session_key)}
              onToggleStar={() => onToggleStar(item.session_key)}
              onJumpToHit={(segmentIndex, hitIndex) =>
                onJumpToHit(item.session_key, segmentIndex, hitIndex)
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export { SessionGroup };
