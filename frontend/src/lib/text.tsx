import { Fragment, type ReactNode } from "react";
import type { TimelineEvent } from "./types";
import { decodeEntities } from "./format";

export function tokenizeQuery(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_\-\u4e00-\u9fff]+/g);
  return Array.from(new Set((matches || []).map((item) => item.toLowerCase())));
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stringifyStructuredValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) || "";
  } catch {
    return String(value);
  }
}

export function eventSearchText(event: TimelineEvent): string {
  if (event.kind === "tool_use" && typeof event.tool_input !== "undefined") {
    const payload = stringifyStructuredValue(event.tool_input);
    return [event.tool_name || "Tool", payload].filter(Boolean).join("\n");
  }
  return event.text;
}

export function eventBodyText(event: TimelineEvent): string {
  if (event.kind === "tool_use" && typeof event.tool_input !== "undefined") {
    return stringifyStructuredValue(event.tool_input);
  }
  return event.text;
}

/**
 * Splits `text` into React fragments with search tokens wrapped in <mark.hit-mark>.
 * Returns plain text if no tokens provided.
 */
export function renderHighlightedText(text: string, tokens: string[]): ReactNode {
  if (!tokens.length) return text;
  const regex = new RegExp(`(${tokens.map((token) => escapeRegex(token)).join("|")})`, "gi");
  const parts = text.split(regex);
  return parts.map((part, index) => {
    const matched = tokens.some((token) => part.toLowerCase() === token.toLowerCase());
    if (!matched) return <Fragment key={`${part}-${index}`}>{part}</Fragment>;
    return (
      <mark key={`${part}-${index}`} className="hit-mark">
        {part}
      </mark>
    );
  });
}

export function renderHighlightedBlock(text: string, tokens: string[]): ReactNode {
  return text.split("\n").map((line, index, array) => (
    <Fragment key={`${line}-${index}`}>
      {renderHighlightedText(line, tokens)}
      {index < array.length - 1 ? <br /> : null}
    </Fragment>
  ));
}

export { decodeEntities };
