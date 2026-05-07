import * as React from "react";
import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";
import { Markdown } from "@/components/shared/Markdown";
import { InjectionChip } from "./InjectionChip";

/**
 * Cursor occasionally smuggles `<system-reminder>...</system-reminder>` blocks
 * into assistant turns (e.g. to remind the model that an attached skill is in
 * play, or that an `AskQuestion` tool exists). React-Markdown happily renders
 * those tags as raw text, which is ugly and confuses users into thinking the
 * model "leaked" something.
 *
 * This component splits the message text on known reminder wrappers, replaces
 * them with the same collapsible chip we use on the user side, and renders the
 * remainder through normal Markdown.
 *
 * Kept conservative on purpose:
 *   - We do *not* strip `<system-reminder>` produced by the model itself as
 *     part of an explanation (rare, but possible). The chip still shows the
 *     payload on click, so nothing is lost.
 *   - Only outermost `<reminder>` blocks are pulled out; nested wrappers stay
 *     inside their parent's raw payload.
 */

const REMINDER_TAGS = new Set(["system-reminder", "system_reminder"]);

const WRAPPER_RE = /<([\w-]+)>([\s\S]*?)<\/\1>/g;

interface ReminderSegment {
  kind: "reminder";
  raw: string;
}

interface MarkdownSegment {
  kind: "markdown";
  text: string;
}

type Segment = ReminderSegment | MarkdownSegment;

export function parseAssistantMessage(text: string): Segment[] {
  const matches: { start: number; end: number; tag: string; content: string }[] = [];
  WRAPPER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WRAPPER_RE.exec(text)) !== null) {
    if (!REMINDER_TAGS.has(m[1])) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      tag: m[1],
      content: m[2],
    });
  }

  // Drop any match that's nested inside another match — only outer wrappers
  // become chips; inner ones stay inside the raw payload.
  const outer: typeof matches = [];
  for (const x of matches) {
    if (outer.some((o) => o.start < x.start && o.end > x.end)) continue;
    outer.push(x);
  }
  outer.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let pos = 0;
  for (const cut of outer) {
    if (cut.start > pos) {
      segments.push({ kind: "markdown", text: text.slice(pos, cut.start) });
    }
    segments.push({ kind: "reminder", raw: cut.content });
    pos = cut.end;
  }
  if (pos < text.length) {
    segments.push({ kind: "markdown", text: text.slice(pos) });
  }
  return segments;
}

interface AssistantMessageBodyProps {
  text: string;
  queryTokens?: string[];
}

function AssistantMessageBody({ text, queryTokens = [] }: AssistantMessageBodyProps) {
  const { t } = useTranslation();
  const segments = React.useMemo(() => parseAssistantMessage(text), [text]);

  // Common case: no reminder wrappers at all — passthrough so we don't add a
  // wrapping <div> that could mess with margin collapsing in markdown-body.
  if (segments.length === 1 && segments[0].kind === "markdown") {
    return <Markdown source={text} queryTokens={queryTokens} />;
  }

  return (
    <div className="space-y-2">
      {segments.map((seg, i) => {
        if (seg.kind === "markdown") {
          const trimmed = seg.text.trim();
          if (!trimmed) return null;
          return (
            <Markdown
              key={`md-${i}`}
              source={trimmed}
              queryTokens={queryTokens}
            />
          );
        }
        const matchesQuery =
          queryTokens.length > 0 &&
          queryTokens.some((tok) =>
            seg.raw.toLowerCase().includes(tok.toLowerCase())
          );
        return (
          <InjectionChip
            key={`reminder-${i}`}
            icon={Bell}
            label={t("user.systemReminder")}
            raw={seg.raw}
            matchesQuery={matchesQuery}
            compact
          />
        );
      })}
    </div>
  );
}

export { AssistantMessageBody };
