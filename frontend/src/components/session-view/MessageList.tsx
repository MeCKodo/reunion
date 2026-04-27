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

// Progressive render budget. The first paint renders this many cards
// synchronously so users see something immediately; the remainder is
// streamed in chunks during idle time so the main thread stays responsive
// during the heavy ReactMarkdown + rehype-highlight pass.
//
// Numbers tuned against transcripts with 200-800 events. INITIAL_RENDER_LIMIT
// has to clear "above-the-fold" content so the user can read while the rest
// streams in; RENDER_CHUNK has to be big enough that the streaming finishes
// in finite time on huge sessions but small enough to stay <16ms/frame on
// average hardware.
const INITIAL_RENDER_LIMIT = 30;
const RENDER_CHUNK = 20;
// Window length used by the "match-aware" fast path. When a match index is
// active outside the currently rendered window, we expand around it instead
// of waiting for the streaming fill — keeps Cmd-F navigation feeling snappy
// even on 800-event transcripts.
const MATCH_WINDOW = 20;

/**
 * Streams `displayEvents` in chunks via requestAnimationFrame so the first
 * paint stays cheap on long sessions. When a search match (or jump target)
 * lands beyond the current limit we widen the window immediately so the
 * referenced card is mountable on the next render.
 */
function useProgressiveLimit(
  total: number,
  resetKey: string,
  forcedMin: number
): number {
  const [limit, setLimit] = React.useState(() =>
    Math.min(total, INITIAL_RENDER_LIMIT)
  );

  // Reset back to the initial budget whenever the underlying list changes
  // (typically: switching sessions or filter mode).
  React.useEffect(() => {
    setLimit(Math.min(total, INITIAL_RENDER_LIMIT));
  }, [resetKey, total]);

  // Drive incremental growth on idle frames until we've materialized
  // everything. Prefer requestIdleCallback so streaming yields to user input
  // (typing, scrolling) before adding more expensive markdown nodes; fall
  // back to a cascading rAF + macrotask schedule when the browser doesn't
  // expose rIC (Safari).
  React.useEffect(() => {
    if (limit >= total) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      setLimit((prev) => {
        if (prev >= total) return prev;
        return Math.min(total, prev + RENDER_CHUNK);
      });
    };
    const ric = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        cancelIdleCallback?: (id: number) => void;
      }
    ).requestIdleCallback;
    if (typeof ric === "function") {
      const id = ric(tick, { timeout: 250 });
      return () => {
        cancelled = true;
        const cancel = (
          window as unknown as { cancelIdleCallback?: (id: number) => void }
        ).cancelIdleCallback;
        if (typeof cancel === "function") cancel(id);
      };
    }
    // Fallback: queue a macrotask after the next paint so we still yield
    // to layout/scroll handlers between batches.
    const rafId = window.requestAnimationFrame(() => {
      const tid = window.setTimeout(tick, 0);
      // No clean way to cancel both here; relying on `cancelled` flag suffices.
      void tid;
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [limit, total]);

  // External jumps (search-hit / pulse navigation) may need a card that's
  // beyond the current limit. Bump the limit so the targeted index is
  // always rendered.
  React.useEffect(() => {
    if (forcedMin > 0 && forcedMin > limit) {
      setLimit(Math.min(total, forcedMin));
    }
  }, [forcedMin, limit, total]);

  return Math.min(limit, total);
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

  // Build a Set of hit event_ids so per-card lookup is O(1) instead of
  // detailMessageHits.some(...) per row (O(N×M)).
  const hitEventIds = React.useMemo(
    () => new Set(detailMessageHits.map((hit) => hit.event_id)),
    [detailMessageHits]
  );
  const activeHitEventId =
    detailMessageHits[activeMatch]?.event_id ?? null;

  // If the active match is past our streamed-in tail, force the limit to at
  // least cover that index. Resolving the index linearly is fine — N is at
  // most a few thousand and we only run it when navigation actually moves.
  const forcedMin = React.useMemo(() => {
    if (!activeHitEventId) return 0;
    const idx = displayEvents.findIndex((e) => e.event_id === activeHitEventId);
    if (idx < 0) return 0;
    return Math.min(displayEvents.length, idx + MATCH_WINDOW);
  }, [activeHitEventId, displayEvents]);

  // Reset key: switching sessions / filter changes triggers a fresh budget.
  const resetKey = React.useMemo(
    () => `${displayEvents[0]?.event_id ?? ""}|${displayEvents.length}`,
    [displayEvents]
  );

  const limit = useProgressiveLimit(displayEvents.length, resetKey, forcedMin);
  const visible = limit < displayEvents.length ? displayEvents.slice(0, limit) : displayEvents;

  return (
    <div className="max-w-[920px] mx-auto p-6 space-y-6">
      <div className="space-y-5">
        {visible.map((event) => {
          const isMatch = hitEventIds.has(event.event_id);
          const isActiveMatch = activeHitEventId === event.event_id;
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
              isActiveMatch={isActiveMatch}
              pulseKey={pulseKey}
              registerRef={registerRef}
              source={source}
              pairedResult={pairedResult}
            />
          );
        })}
        {limit < displayEvents.length ? (
          <div
            className="flex items-center justify-center py-4 font-mono text-[11px] text-muted-foreground/70"
            aria-live="polite"
          >
            <span className="inline-flex items-center gap-2">
              <span
                className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-pulse"
                aria-hidden
              />
              Loading {displayEvents.length - limit} more events…
            </span>
          </div>
        ) : null}
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
