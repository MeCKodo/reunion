import * as React from "react";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { renderHighlightedBlock } from "@/lib/text";
import { Markdown } from "@/components/shared/Markdown";
import type { TimelineEvent } from "@/lib/types";

const PREVIEW_LINE_LIMIT = 30;
const PREVIEW_BYTE_LIMIT = 2048;

/**
 * Heuristic: only treat the result as Markdown if it contains structural
 * markdown markers AND at least one fenced code block / heading / list. Plain
 * shell output / JSON should stay in <pre> so whitespace is preserved.
 */
function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  const sample = text.slice(0, 4000);
  const hasFence = sample.includes("```");
  const hasHeading = /^\s{0,3}#{1,6}\s/m.test(sample);
  const hasBulletList = /^\s{0,3}[-*]\s/m.test(sample);
  const hasNumberedList = /^\s{0,3}\d+\.\s/m.test(sample);
  return hasFence || (hasHeading && (hasBulletList || hasNumberedList));
}

function truncateForPreview(text: string): { preview: string; truncated: boolean } {
  const lines = text.split("\n");
  let truncated = false;
  let preview = text;

  if (lines.length > PREVIEW_LINE_LIMIT) {
    preview = lines.slice(0, PREVIEW_LINE_LIMIT).join("\n");
    truncated = true;
  }

  if (preview.length > PREVIEW_BYTE_LIMIT) {
    preview = preview.slice(0, PREVIEW_BYTE_LIMIT);
    truncated = true;
  }

  return { preview, truncated };
}

interface ToolResultBlockProps {
  result: TimelineEvent;
  /** Visible inside the structured markdown renderer when expanded. */
  queryTokens?: string[];
}

function ToolResultBlock({ result, queryTokens = [] }: ToolResultBlockProps) {
  const [expanded, setExpanded] = React.useState(false);
  const [showFull, setShowFull] = React.useState(false);

  const text = result.text ?? "";
  const isError = result.is_error === true;
  const lineCount = text === "" ? 0 : text.split("\n").length;
  const byteCount = text.length;

  const { preview, truncated } = React.useMemo(
    () => truncateForPreview(text),
    [text]
  );

  const visibleText = showFull ? text : preview;
  const useMarkdown = expanded && looksLikeMarkdown(visibleText);

  const summary = isError
    ? "tool_result · error"
    : "tool_result";

  const sizeLabel = lineCount
    ? `${lineCount} line${lineCount === 1 ? "" : "s"} · ${byteCount} chars`
    : `${byteCount} chars`;

  return (
    <div
      className={cn(
        "mt-3 rounded-md border text-[12px]",
        isError
          ? "border-rose-300 bg-rose-50/60"
          : "border-border/70 bg-background-soft/60"
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[11px] uppercase tracking-[0.08em] transition-colors",
          isError
            ? "text-rose-700 hover:bg-rose-100/70"
            : "text-muted-foreground hover:bg-background-soft"
        )}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        {isError ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-600" />
        ) : null}
        <span className="font-semibold normal-case tracking-normal">{summary}</span>
        <span className="opacity-40">·</span>
        <span className="normal-case tracking-normal">{sizeLabel}</span>
      </button>

      {expanded ? (
        <div
          className={cn(
            "border-t px-3 py-2",
            isError ? "border-rose-200" : "border-border/60"
          )}
        >
          {useMarkdown ? (
            <Markdown source={visibleText} queryTokens={queryTokens} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6] text-foreground/85">
              {renderHighlightedBlock(visibleText, queryTokens)}
            </pre>
          )}

          {truncated ? (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowFull((value) => !value)}
                className={cn(
                  "rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors",
                  isError
                    ? "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
                    : "border-border/70 bg-background-soft text-muted-foreground hover:text-foreground"
                )}
              >
                {showFull ? "Show preview" : `Show full (${lineCount} lines)`}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { ToolResultBlock };
