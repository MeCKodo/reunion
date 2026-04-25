import * as React from "react";
import { cn } from "@/lib/utils";
import { formatClock } from "@/lib/format";
import {
  eventBodyText,
  renderHighlightedBlock,
} from "@/lib/text";
import type { SourceId, TimelineEvent } from "@/lib/types";
import {
  TOOL_ICONS,
  isSubagentToolEvent,
  roleMeta,
  toolCategory,
  type ToolCategory,
} from "@/lib/transcript";
import { StructuredToolInput } from "./StructuredToolInput";
import { Markdown } from "@/components/shared/Markdown";
import { UserMessageBody } from "./UserMessageBody";
import { ToolResultBlock } from "./ToolResultBlock";

interface MessageCardProps {
  event: TimelineEvent;
  queryTokens: string[];
  isMatch: boolean;
  isActiveMatch: boolean;
  pulseKey?: number;
  registerRef?: (node: HTMLDivElement | null) => void;
  source?: SourceId;
  /**
   * tool_result event paired with this tool_use card by `tool_call_id`. When
   * present, the result is rendered inline (collapsed by default) instead of
   * showing the legacy "tool output not captured" footer.
   */
  pairedResult?: TimelineEvent;
}

function MessageCard({
  event,
  queryTokens,
  isMatch,
  isActiveMatch,
  pulseKey = 0,
  registerRef,
  source,
  pairedResult,
}: MessageCardProps) {
  const meta = roleMeta(
    event.category,
    event.tool_name,
    event.content_type,
    event.tool_input,
    source
  );

  const pulseClass = isActiveMatch
    ? pulseKey % 2 === 0
      ? "hit-pulse-a"
      : "hit-pulse-b"
    : null;

  // Structured renderer only kicks in when we have an actual object payload.
  // Array / scalar tool_input falls back to the JSON pre block so nothing is lost.
  const structuredInput =
    event.kind === "tool_use" &&
    event.tool_input &&
    typeof event.tool_input === "object" &&
    !Array.isArray(event.tool_input)
      ? (event.tool_input as Record<string, unknown>)
      : null;

  const isTaskEvent =
    event.kind === "tool_use" && isSubagentToolEvent(event.tool_name);

  return (
    <div
      className="flex gap-3 items-start"
      ref={registerRef}
      data-event-id={event.event_id}
    >
      <div
        className={cn(
          "shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-full text-[12px] font-semibold",
          meta.avatarClass
        )}
        aria-hidden
      >
        {(() => {
          const Icon = meta.avatarIconKey ? TOOL_ICONS[meta.avatarIconKey] : undefined;
          return Icon ? <Icon className="h-4 w-4" strokeWidth={2} /> : meta.avatarLetter;
        })()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span
            className={cn(
              "font-sans text-[13px] font-semibold not-italic tracking-normal normal-case",
              meta.labelClass
            )}
          >
            {meta.label}
          </span>
          <span className="opacity-40">·</span>
          <span>{formatClock(event.ts)}</span>
          {isActiveMatch ? (
            <span className="ml-1 rounded-sm bg-accent/15 px-1.5 py-[1px] text-[9px] text-accent uppercase tracking-overline">
              current match
            </span>
          ) : null}
        </div>
        <div
          className={cn(
            meta.container,
            "transition-[box-shadow,border-color,background-color] duration-200",
            isMatch && "ring-1 ring-accent/40",
            isActiveMatch && "ring-2 ring-accent",
            pulseClass
          )}
        >
          {structuredInput ? (
            <StructuredToolInput
              toolName={event.tool_name ?? "Tool"}
              input={structuredInput}
              category={toolCategory(event.tool_name)}
              queryTokens={queryTokens}
            />
          ) : meta.prose ? (
            event.category === "user" ? (
              <UserMessageBody text={event.text} queryTokens={queryTokens} />
            ) : (
              <Markdown source={event.text} queryTokens={queryTokens} />
            )
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.65] text-foreground/85">
              {renderHighlightedBlock(eventBodyText(event), queryTokens)}
            </pre>
          )}
          {event.kind === "tool_use" ? (
            pairedResult ? (
              <ToolResultBlock result={pairedResult} queryTokens={queryTokens} />
            ) : (
              <div
                className={cn(
                  "mt-3 pt-2 border-t border-dashed font-mono text-[10px] italic",
                  isTaskEvent
                    ? "border-sky-200 text-sky-600/80"
                    : "border-border/70 text-muted-foreground/70"
                )}
              >
                {source === "cursor"
                  ? "Cursor source omits tool output by design"
                  : "tool output missing"}
              </div>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

export { MessageCard };
