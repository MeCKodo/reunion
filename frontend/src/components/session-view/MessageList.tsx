import * as React from "react";
import type {
  DetailMessageHit,
  SourceId,
  SubagentDetail,
  TimelineEvent,
} from "@/lib/types";
import { MessageCard } from "./MessageCard";
import { SubagentBlock } from "./SubagentBlock";

interface MessageListProps {
  visibleEvents: TimelineEvent[];
  visibleSubagents: Array<SubagentDetail & { filteredEvents: TimelineEvent[] }>;
  queryTokens: string[];
  detailMessageHits: DetailMessageHit[];
  activeMatch: number;
  pulseKey: number;
  registerRef: (eventId: string, node: HTMLDivElement | null) => void;
  source?: SourceId;
}

/**
 * Index `tool_result` (kind === "meta", content_type === "tool_result") events
 * by `tool_call_id` so each `tool_use` card can render its paired result
 * inline. Standalone results (no matching tool_use in the visible set) are
 * preserved so we never silently drop output.
 */
function pairToolResults(events: TimelineEvent[]): {
  pairedResults: Map<string, TimelineEvent>;
  displayEvents: TimelineEvent[];
} {
  const pairedResults = new Map<string, TimelineEvent>();
  const toolUseIds = new Set<string>();

  for (const event of events) {
    if (event.kind === "tool_use" && event.tool_call_id) {
      toolUseIds.add(event.tool_call_id);
    }
  }

  for (const event of events) {
    if (
      event.kind === "meta" &&
      event.content_type === "tool_result" &&
      event.tool_call_id &&
      toolUseIds.has(event.tool_call_id) &&
      !pairedResults.has(event.tool_call_id)
    ) {
      pairedResults.set(event.tool_call_id, event);
    }
  }

  const displayEvents = events.filter((event) => {
    if (
      event.kind === "meta" &&
      event.content_type === "tool_result" &&
      event.tool_call_id &&
      pairedResults.get(event.tool_call_id) === event
    ) {
      return false;
    }
    return true;
  });

  return { pairedResults, displayEvents };
}

function MessageList({
  visibleEvents,
  visibleSubagents,
  queryTokens,
  detailMessageHits,
  activeMatch,
  pulseKey,
  registerRef,
  source,
}: MessageListProps) {
  const { pairedResults, displayEvents } = React.useMemo(
    () => pairToolResults(visibleEvents),
    [visibleEvents]
  );

  const subagentsWithPairing = React.useMemo(
    () =>
      visibleSubagents.map((subagent) => {
        const { pairedResults: subPairs, displayEvents: subDisplay } = pairToolResults(
          subagent.filteredEvents
        );
        return { ...subagent, displayEvents: subDisplay, pairedResults: subPairs };
      }),
    [visibleSubagents]
  );

  return (
    <div className="max-w-[920px] mx-auto p-6 space-y-6">
      <div className="space-y-5">
        {displayEvents.map((event) => {
          const isMatch = detailMessageHits.some((hit) => hit.event_id === event.event_id);
          const isActiveMatch =
            detailMessageHits[activeMatch] &&
            detailMessageHits[activeMatch].event_id === event.event_id;
          const pairedResult =
            event.kind === "tool_use" && event.tool_call_id
              ? pairedResults.get(event.tool_call_id)
              : undefined;
          return (
            <MessageCard
              key={event.event_id}
              event={event}
              queryTokens={queryTokens}
              isMatch={isMatch}
              isActiveMatch={Boolean(isActiveMatch)}
              pulseKey={pulseKey}
              registerRef={(node) => registerRef(event.event_id, node)}
              source={source}
              pairedResult={pairedResult}
            />
          );
        })}
      </div>

      {subagentsWithPairing.length > 0 ? (
        <div className="space-y-4 border-t border-border pt-6">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] font-semibold text-sky-700">
            <span className="h-px flex-1 bg-sky-200" aria-hidden />
            <span>Subagents · {subagentsWithPairing.length}</span>
            <span className="h-px flex-1 bg-sky-200" aria-hidden />
          </div>
          {subagentsWithPairing.map((subagent) => (
            <SubagentBlock
              key={subagent.session_id}
              subagent={subagent}
              queryTokens={queryTokens}
              detailMessageHits={detailMessageHits}
              activeMatch={activeMatch}
              pulseKey={pulseKey}
              registerRef={registerRef}
              source={source}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export { MessageList };
