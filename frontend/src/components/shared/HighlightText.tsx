import * as React from "react";
import { cn } from "@/lib/utils";

interface HighlightTextProps {
  text: string;
  query?: string;
  className?: string;
  markClassName?: string;
  caseSensitive?: boolean;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Renders `text` with `query` occurrences wrapped in <mark.hit-mark>.
 * Empty/whitespace-only queries fall back to plain text.
 */
function HighlightText({
  text,
  query,
  className,
  markClassName,
  caseSensitive = false,
}: HighlightTextProps) {
  const trimmed = query?.trim() ?? "";
  if (!trimmed || !text) {
    return <span className={className}>{text}</span>;
  }

  const flags = caseSensitive ? "g" : "gi";
  const parts = text.split(new RegExp(`(${escapeRegExp(trimmed)})`, flags));
  const matcher = caseSensitive
    ? (piece: string) => piece === trimmed
    : (piece: string) => piece.toLowerCase() === trimmed.toLowerCase();

  return (
    <span className={className}>
      {parts.map((piece, idx) =>
        matcher(piece) ? (
          <mark key={idx} className={cn("hit-mark", markClassName)}>
            {piece}
          </mark>
        ) : (
          <React.Fragment key={idx}>{piece}</React.Fragment>
        )
      )}
    </span>
  );
}

export { HighlightText };
