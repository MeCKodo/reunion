import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { SourceFilter, SourceId, SourceSummary } from "@/lib/types";
import { SOURCE_LABEL } from "@/lib/types";

interface SourceTabsProps {
  value: SourceFilter;
  onChange: (next: SourceFilter) => void;
  sources: SourceSummary[];
  totalCount: number;
  className?: string;
}

const TAB_ORDER: SourceFilter[] = ["all", "cursor", "claude-code", "codex"];

function SourceTabs({ value, onChange, sources, totalCount, className }: SourceTabsProps) {
  const { t } = useTranslation();
  function labelFor(id: SourceFilter): string {
    return id === "all" ? t("sourceTabs.all") : SOURCE_LABEL[id as SourceId];
  }
  const byId = React.useMemo(() => {
    const map = new Map<SourceId, SourceSummary>();
    for (const item of sources) map.set(item.id, item);
    return map;
  }, [sources]);

  const counts = React.useMemo(() => {
    const record: Record<SourceFilter, number> = {
      all: totalCount,
      cursor: byId.get("cursor")?.session_count ?? 0,
      "claude-code": byId.get("claude-code")?.session_count ?? 0,
      codex: byId.get("codex")?.session_count ?? 0,
    };
    return record;
  }, [byId, totalCount]);

  return (
    <div
      role="tablist"
      aria-label={t("sourceTabs.chatHistorySource")}
      className={cn(
        "flex items-center gap-0.5 rounded-md bg-foreground/[0.06] p-0.5",
        className
      )}
    >
      {TAB_ORDER.map((id) => {
        const active = value === id;
        return (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={cn(
              "flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-all",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
              active
                ? "bg-background text-foreground shadow-[0_1px_2px_rgba(22,24,35,0.12),0_0_0_0.5px_rgba(22,24,35,0.08)]"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span className="truncate">{labelFor(id)}</span>
            <span
              className={cn(
                "shrink-0 font-mono text-[10px] tabular-nums",
                active ? "text-foreground/60" : "text-muted-foreground/60"
              )}
            >
              {counts[id]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export { SourceTabs };
