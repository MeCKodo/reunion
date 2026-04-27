import * as React from "react";
import { useTranslation } from "react-i18next";
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
import { ImageThumb } from "@/components/shared/ImageThumb";
import { isClaudeImagePayload } from "@/lib/asset";

interface MessageCardProps {
  event: TimelineEvent;
  queryTokens: string[];
  isMatch: boolean;
  isActiveMatch: boolean;
  pulseKey?: number;
  /**
   * Stable callback that the parent registers once per session. The card
   * forwards its own event_id so the parent doesn't need an inline closure
   * per event (which would defeat React.memo).
   */
  registerRef?: (eventId: string, node: HTMLDivElement | null) => void;
  source?: SourceId;
  /**
   * tool_result event paired with this tool_use card by `tool_call_id`. When
   * present, the result is rendered inline (collapsed by default) instead of
   * showing the legacy "tool output not captured" footer.
   */
  pairedResult?: TimelineEvent;
}

function MessageCardImpl({
  event,
  queryTokens,
  isMatch,
  isActiveMatch,
  pulseKey = 0,
  registerRef,
  source,
  pairedResult,
}: MessageCardProps) {
  // Bind a stable ref callback that captures the parent's stable registerRef
  // along with our own event_id. Without this, the parent would have to pass
  // an inline closure per event, which would change identity every render
  // and defeat React.memo.
  const handleRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      registerRef?.(event.event_id, node);
    },
    [registerRef, event.event_id]
  );

  const { t } = useTranslation();
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

  // Inline image content from Claude (user-attached or assistant-emitted).
  // The backend serialises base64/url payloads into `tool_input` so the
  // frontend can render an actual <img> instead of the JSON-stringified
  // dump that used to fall through here. Falls back to the default text
  // body when the payload shape is unrecognised.
  const imagePayload =
    event.kind === "meta" && event.content_type === "image"
      ? isClaudeImagePayload(event.tool_input)
        ? event.tool_input
        : null
      : null;

  return (
    <div
      className="flex gap-3 items-start"
      ref={handleRef}
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
              {t("session.currentMatch")}
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
          {imagePayload ? (
            <div className="max-w-md">
              <ImageThumb
                source={{
                  kind: "data",
                  url: imagePayload.data,
                  label:
                    imagePayload.kind === "base64"
                      ? `Inline ${imagePayload.mediaType ?? "image"}`
                      : imagePayload.data,
                }}
              />
            </div>
          ) : structuredInput ? (
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
                  ? t("session.cursorOmitsOutput")
                  : t("session.toolOutputMissing")}
              </div>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

// React.memo with shallow prop comparison. The hot path is keystroke-driven:
// query, activeMatch and pulseKey change on every input, so we re-render only
// the cards whose visible state actually flips. `queryTokens` reference can
// vary even when content is equal, so we compare its tokens explicitly.
function arePropsEqual(prev: MessageCardProps, next: MessageCardProps) {
  if (prev.event !== next.event) return false;
  if (prev.isMatch !== next.isMatch) return false;
  if (prev.isActiveMatch !== next.isActiveMatch) return false;
  // pulseKey only matters for the currently-active card. For inactive cards
  // the value doesn't affect render output, so skip the prop and let them
  // stay mounted across pulse cycles.
  if (next.isActiveMatch && prev.pulseKey !== next.pulseKey) return false;
  if (prev.source !== next.source) return false;
  if (prev.pairedResult !== next.pairedResult) return false;
  if (prev.registerRef !== next.registerRef) return false;
  const a = prev.queryTokens;
  const b = next.queryTokens;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const MessageCard = React.memo(MessageCardImpl, arePropsEqual);

export { MessageCard };
