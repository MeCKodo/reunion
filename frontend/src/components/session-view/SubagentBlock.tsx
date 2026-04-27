import * as React from "react";
import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import { formatDuration, formatTs } from "@/lib/format";
import type {
  DetailMessageHit,
  SourceId,
  SubagentDetail,
  TimelineEvent,
} from "@/lib/types";
import { MessageCard } from "./MessageCard";

interface SubagentBlockProps {
  subagent: SubagentDetail & {
    filteredEvents: TimelineEvent[];
    /** Optional: pre-computed display events (with paired results filtered out). */
    displayEvents?: TimelineEvent[];
    /** Optional: tool_call_id -> paired tool_result event. */
    pairedResults?: Map<string, TimelineEvent>;
  };
  queryTokens: string[];
  detailMessageHits: DetailMessageHit[];
  activeMatch: number;
  pulseKey: number;
  registerRef: (eventId: string, node: HTMLDivElement | null) => void;
  source?: SourceId;
}

function SubagentBlock({
  subagent,
  queryTokens,
  detailMessageHits,
  activeMatch,
  pulseKey,
  registerRef,
  source,
}: SubagentBlockProps) {
  const { t } = useTranslation();
  const events = subagent.displayEvents ?? subagent.filteredEvents;
  const pairedResults = subagent.pairedResults;
  const hitEventIds = React.useMemo(
    () => new Set(detailMessageHits.map((hit) => hit.event_id)),
    [detailMessageHits]
  );
  const activeHitEventId =
    detailMessageHits[activeMatch]?.event_id ?? null;
  return (
    <div className="rounded-md border border-sky-200 border-l-[3px] border-l-sky-500 bg-surface overflow-hidden">
      <div className="bg-sky-50/60 border-b border-sky-100 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-sky-100 text-sky-700 border border-sky-200"
            aria-hidden
          >
            <Bot className="h-3.5 w-3.5" />
          </div>
          <span className="rounded-sm bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-sky-700">
            {t("session.subagentLabel")}
          </span>
          <span className="font-sans text-[14px] font-semibold text-foreground">
            {subagent.title || subagent.session_id}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            <span className="opacity-40 mx-1">·</span>
            {formatDuration(subagent.duration_sec)}
            <span className="opacity-40 mx-1">·</span>
            {formatTs(subagent.started_at)}
          </span>
        </div>
        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80">
          {subagent.file_path}
        </div>
      </div>
      <div className="p-4 space-y-4">
        {events.map((event) => {
          const isMatch = hitEventIds.has(event.event_id);
          const isActiveMatch = activeHitEventId === event.event_id;
          const pairedResult =
            event.kind === "tool_use" && event.tool_call_id
              ? pairedResults?.get(event.tool_call_id)
              : undefined;
          return (
            <MessageCard
              key={event.event_id}
              event={event}
              queryTokens={queryTokens}
              isMatch={isMatch}
              isActiveMatch={isActiveMatch}
              pulseKey={pulseKey}
              registerRef={registerRef}
              source={source}
              pairedResult={pairedResult}
            />
          );
        })}
      </div>
    </div>
  );
}

export { SubagentBlock };
