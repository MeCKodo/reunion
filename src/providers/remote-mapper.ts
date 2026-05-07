// Maps the sampled event shape produced by the collector
// (`ai_coding_collector/src/core/conversationSampler.ts` + cursor hookStats)
// to Reunion's frontend-facing `TimelineEvent`. The wire format is documented
// in `ai_coding_collector/docs/payload-schema.md`; this file is the single
// place that bakes those field names into Reunion's vocabulary.

import type { TimelineEvent, HistoryCategory, Role } from "../types.js";

/** Loosely-typed event from `conversations_json.events` (already wrapped/unwrapped on the ingest side). */
export type RemoteEvent = {
  role?: string;
  kind?: string;
  content?: string;
  text?: string;
  timestamp?: string;
  // tool_use
  tool?: string;
  id?: string;
  input?: string | Record<string, unknown>;
  // tool_result
  tool_use_id?: string;
  is_error?: boolean;
  // agent_thought (Cursor)
  duration_ms?: number;
  // any extra fields are preserved into TimelineEvent.text/contentType
};

const ISO_FALLBACK_MS = 1; // ts-skip when previous event has the same string

function parseTs(input: unknown, fallbackMs: number): number {
  if (typeof input === "string" && input.length > 0) {
    const t = Date.parse(input);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  return fallbackMs;
}

function categoryFor(role: string | undefined, kind: string | undefined): HistoryCategory {
  if (kind === "tool_use" || kind === "tool_result") return "tool";
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  return "system";
}

function asRole(role: string | undefined): Role {
  if (role === "assistant" || role === "user" || role === "system") return role;
  return "system";
}

function tryParseJson(input: unknown): unknown {
  if (typeof input === "object" && input !== null) return input;
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (!trimmed) return input;
  // Tool inputs from the sampler are JSON-stringified; parse defensively so
  // the UI can show a structured view, but fall back to the raw string when
  // the value is plain text or has been truncated by `MAX_TOOL_INPUT_JSON`.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }
  return input;
}

/**
 * Convert a list of remote events (already concatenated across slices in
 * jsonl_line_version order by ingest) into TimelineEvent[].
 *
 * `sessionId` is used to mint deterministic event IDs so subsequent calls
 * re-render stably even though ingest doesn't carry an id of its own.
 */
export function mapRemoteEventsToTimeline(
  events: RemoteEvent[],
  sessionId: string
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  let prevTsSec = 0;
  let segIndex = 0;

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i] || {};
    const role = ev.role;
    const kind = ev.kind;
    const ts = parseTs(ev.timestamp, prevTsSec + ISO_FALLBACK_MS / 1000);
    prevTsSec = ts;
    const eventId = `remote:${sessionId}:${i}`;

    if (kind === "text") {
      const text = String(ev.content ?? ev.text ?? "");
      out.push({
        eventId,
        category: categoryFor(role, kind),
        role: asRole(role),
        kind: "text",
        contentType: "text",
        text,
        ts,
        legacySegmentIndex: segIndex,
      });
      segIndex += 1;
      continue;
    }

    if (kind === "tool_use") {
      out.push({
        eventId,
        category: "tool",
        role: "assistant",
        kind: "tool_use",
        contentType: "tool_use",
        text: "",
        ts,
        toolName: ev.tool || "",
        toolCallId: ev.id || "",
        toolInput: tryParseJson(ev.input ?? ""),
      });
      continue;
    }

    if (kind === "tool_result") {
      out.push({
        eventId,
        category: "tool",
        role: "user",
        kind: "meta",
        contentType: "tool_result",
        text: String(ev.content ?? ""),
        ts,
        toolCallId: ev.tool_use_id || "",
        isError: Boolean(ev.is_error),
      });
      continue;
    }

    if (kind === "agent_thought") {
      // Cursor "afterAgentThought" hook events. Fold them into the timeline
      // as assistant-side thinking metadata so the UI can render them in a
      // distinct style without polluting the text stream.
      const text = String(ev.content ?? "");
      const durationMs = typeof ev.duration_ms === "number" ? ev.duration_ms : undefined;
      out.push({
        eventId,
        category: "assistant",
        role: "assistant",
        kind: "meta",
        contentType: "thinking",
        text: durationMs != null ? `${text}\n\n[duration: ${durationMs} ms]` : text,
        ts,
      });
      continue;
    }

    // Unknown kind — preserve it as a system meta event so we don't silently
    // drop new collector versions on Reunion side.
    out.push({
      eventId,
      category: "system",
      role: "system",
      kind: "meta",
      contentType: kind || "unknown",
      text: typeof ev.content === "string" ? ev.content : JSON.stringify(ev),
      ts,
    });
  }

  return out;
}

/** Concatenate `text` events into a coarse content string for legacy fallbacks. */
export function buildContentFromEvents(events: TimelineEvent[]): string {
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.kind !== "text" || !ev.text) continue;
    const role = ev.role === "assistant" ? "assistant" : ev.role === "user" ? "user" : ev.role;
    lines.push(`${role}:`);
    lines.push(ev.text);
    lines.push("");
  }
  return lines.join("\n").trim();
}
