import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DetailedTranscript,
  HistoryCategory,
  ParsedSegment,
  Role,
  TimelineEvent,
} from "./types";
import { decodeEntities, safeJsonStringify } from "./lib/text";

export function normalizeRole(role: string): Role {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "system";
}

export function categoryFromRole(role: Role): HistoryCategory {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "system";
}

function buildToolEventText(name: string | undefined, input: unknown): string {
  const title = name || "Tool";
  const payload = input === undefined ? "" : safeJsonStringify(input, 2);
  return payload ? `${title}\n${payload}` : title;
}

function buildMetaEventText(item: unknown): string {
  return safeJsonStringify(item, 2);
}

/**
 * Render image / png content items as a short placeholder instead of dumping
 * the raw base64 payload (often hundreds of KB) into the timeline. Both Cursor
 * (`type: "png"`) and Claude Code (`type: "image"` with an Anthropic-style
 * `source` envelope) feed through this branch.
 */
function buildImagePlaceholder(item: unknown): string {
  if (!item || typeof item !== "object") return "[Image attachment]";
  const obj = item as Record<string, unknown>;

  const source = (obj.source && typeof obj.source === "object")
    ? (obj.source as Record<string, unknown>)
    : obj;

  const mediaType = typeof source.media_type === "string"
    ? source.media_type
    : (typeof obj.type === "string" ? `image/${obj.type}` : "image");

  const data = typeof source.data === "string" ? source.data : undefined;
  // base64 → bytes ≈ length × 0.75; round to KB for a stable, readable label.
  const sizeLabel = data
    ? `${Math.max(1, Math.round((data.length * 0.75) / 1024))} KB`
    : "unknown size";

  return `[Image attachment · ${mediaType} · ${sizeLabel}]`;
}

function stringifyJsonlContent(raw: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as {
        role?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      const role = normalizeRole(row.role || "system");
      const text = (row.message?.content || [])
        .filter((item) => item && item.type === "text" && typeof item.text === "string")
        .map((item) => item.text || "")
        .join("\n")
        .trim();
      if (!text) continue;
      out.push(`${role}:`);
      out.push(text);
      out.push("");
    } catch {
      continue;
    }
  }
  return out.join("\n").trim();
}

export function parseTranscript(content: string, startedAt: number, updatedAt: number): ParsedSegment[] {
  const lines = content.split(/\r?\n/);
  const segments: Array<{ role: Role; text: string }> = [];
  let currentRole: Role = "system";
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) {
      segments.push({ role: currentRole, text });
    }
    buffer = [];
  };

  for (const line of lines) {
    const marker = line.trim();
    if (marker === "user:") {
      flush();
      currentRole = "user";
      continue;
    }
    if (marker === "assistant:") {
      flush();
      currentRole = "assistant";
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (segments.length === 0) {
    return [{ index: 0, role: "system", text: content, ts: startedAt }];
  }

  const start = startedAt || updatedAt;
  const end = updatedAt || startedAt;
  const span = Math.max(0, end - start);
  const step = segments.length > 1 ? span / (segments.length - 1) : 0;

  return segments.map((segment, idx) => ({
    index: idx,
    role: segment.role,
    text: segment.text,
    ts: Math.floor(start + idx * step),
  }));
}

export function deriveTitleFromContent(content: string): string {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = decodeEntities(line.trim());
    if (!trimmed) continue;
    if (trimmed === "user:" || trimmed === "assistant:" || trimmed.startsWith("[Tool")) continue;
    if (
      trimmed.startsWith("<manually_attached_skills>") ||
      trimmed.startsWith("<user_query>") ||
      trimmed.startsWith("<environment_context>") ||
      trimmed.startsWith("The user has manually attached")
    ) {
      continue;
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) continue;
    if (trimmed.startsWith("<") && trimmed.endsWith(">")) continue;
    return trimmed.slice(0, 120);
  }
  return "Untitled session";
}

export async function readTranscriptContent(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, "utf-8");
  if (path.extname(filePath).toLowerCase() !== ".jsonl") return raw;
  const parsed = stringifyJsonlContent(raw);
  return parsed || raw;
}

function buildDetailedTranscriptFromPlainText(
  content: string,
  startedAt: number,
  updatedAt: number,
  sourcePrefix: string
): DetailedTranscript {
  const segments = parseTranscript(content, startedAt, updatedAt);
  return {
    rawContent: content,
    content,
    events: segments.map((segment) => ({
      eventId: `${sourcePrefix}:${segment.index}`,
      category: categoryFromRole(segment.role),
      role: segment.role,
      kind: "text",
      contentType: "text",
      text: segment.text,
      ts: segment.ts,
      legacySegmentIndex: segment.index,
    })),
  };
}

/**
 * Distribute timestamps across N events. When `userClockHints` provides real
 * timestamps for some user events, they become anchors and the remaining
 * events get linearly interpolated within their enclosing segment. Without
 * hints this degrades to the historical "evenly spread between session
 * start/end" behavior.
 *
 * `userEventIndices` and `userClockHints` are 1-to-1; `userClockHints[k]` is
 * the real timestamp (epoch seconds) for the user event at
 * `userEventIndices[k]`, or `undefined` if no real time is known.
 */
function distributeTimestamps(
  totalEvents: number,
  startSec: number,
  endSec: number,
  userEventIndices: number[],
  userClockHints: Array<number | undefined>
): number[] {
  const out = new Array<number>(totalEvents).fill(0);
  if (totalEvents === 0) return out;

  // Build anchor list: virtual head → confident user hints → virtual tail.
  // Each anchor is [eventIndex, tsSec]. Anchors with index = -1 / totalEvents
  // are virtual endpoints used purely for interpolation.
  const anchors: Array<[number, number]> = [];
  anchors.push([-1, startSec]);
  for (let k = 0; k < userEventIndices.length; k++) {
    const hint = userClockHints[k];
    if (hint === undefined) continue;
    const idx = userEventIndices[k];
    if (idx < 0 || idx >= totalEvents) continue;
    // Clamp into [start, end] so any rogue hint doesn't break monotonicity.
    const clamped = Math.max(startSec, Math.min(endSec, hint));
    // Drop hints that would violate monotonicity vs. the previous anchor.
    const prev = anchors[anchors.length - 1];
    if (clamped < prev[1]) continue;
    if (idx <= prev[0]) continue;
    anchors.push([idx, clamped]);
  }
  anchors.push([totalEvents, endSec]);

  // Walk consecutive anchor pairs and fill the events strictly between them
  // by linear interpolation. Anchor events themselves get their exact ts.
  for (let a = 0; a < anchors.length - 1; a++) {
    const [iL, tL] = anchors[a];
    const [iR, tR] = anchors[a + 1];
    if (iR >= 0 && iR < totalEvents) {
      out[iR] = tR;
    }
    const slots = iR - iL; // number of "gaps" in this segment
    if (slots <= 1) continue;
    for (let k = 1; k < slots; k++) {
      const idx = iL + k;
      if (idx < 0 || idx >= totalEvents) continue;
      out[idx] = Math.floor(tL + ((tR - tL) * k) / slots);
    }
  }

  return out;
}

function buildDetailedTranscriptFromJsonl(
  raw: string,
  startedAt: number,
  updatedAt: number,
  sourcePrefix: string,
  userClockHints?: Array<number | undefined>
): DetailedTranscript {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const flatContent: string[] = [];
  const draftEvents: Array<Omit<TimelineEvent, "eventId" | "ts">> = [];
  // Track which event indices correspond to user-role text events, in the
  // order they appear. Aligns 1-to-1 with the userClockHints input.
  const userEventIndices: number[] = [];
  let legacySegmentIndex = 0;

  for (const line of lines) {
    try {
      const row = JSON.parse(line) as {
        role?: string;
        message?: {
          content?: Array<{
            type?: string;
            text?: string;
            name?: string;
            input?: unknown;
            [key: string]: unknown;
          }>;
        };
      };
      const role = normalizeRole(row.role || "system");
      const contentItems = Array.isArray(row.message?.content) ? row.message?.content : [];
      const rowTextItems: string[] = [];

      for (const item of contentItems) {
        if (!item || typeof item !== "object") continue;
        const itemType = typeof item.type === "string" ? item.type : "unknown";

        if (itemType === "text" && typeof item.text === "string") {
          const text = item.text.trim();
          if (!text) continue;
          rowTextItems.push(text);
          if (role === "user") {
            userEventIndices.push(draftEvents.length);
          }
          draftEvents.push({
            category: categoryFromRole(role),
            role,
            kind: "text",
            contentType: "text",
            text,
            legacySegmentIndex,
          });
          continue;
        }

        if (itemType === "tool_use") {
          draftEvents.push({
            category: "tool",
            role,
            kind: "tool_use",
            contentType: "tool_use",
            text: buildToolEventText(typeof item.name === "string" ? item.name : undefined, item.input),
            toolName: typeof item.name === "string" ? item.name : undefined,
            toolInput: item.input,
          });
          continue;
        }

        if (itemType === "png" || itemType === "image") {
          draftEvents.push({
            category: "system",
            role,
            kind: "meta",
            contentType: itemType,
            text: buildImagePlaceholder(item),
          });
          continue;
        }

        const metaText = buildMetaEventText(item);
        if (!metaText) continue;
        draftEvents.push({
          category: "system",
          role,
          kind: "meta",
          contentType: itemType,
          text: metaText,
        });
      }

      if (rowTextItems.length > 0) {
        flatContent.push(`${role}:`);
        flatContent.push(rowTextItems.join("\n"));
        flatContent.push("");
        legacySegmentIndex += 1;
      }
    } catch {
      continue;
    }
  }

  const start = startedAt || updatedAt;
  const end = updatedAt || startedAt;
  const safeEnd = Math.max(end, start);

  // Truncate hints if the caller passed more than we found user events for
  // (defensive — should not normally happen).
  const hints = userClockHints && userClockHints.length >= userEventIndices.length
    ? userClockHints.slice(0, userEventIndices.length)
    : new Array<number | undefined>(userEventIndices.length).fill(undefined);

  const tsByIndex = distributeTimestamps(
    draftEvents.length,
    start,
    safeEnd,
    userEventIndices,
    hints
  );

  const events = draftEvents.map((event, index) => ({
    ...event,
    eventId: `${sourcePrefix}:${index}`,
    ts: tsByIndex[index] ?? start,
  }));

  const clockAlignment =
    userClockHints !== undefined && userEventIndices.length > 0
      ? {
          matched: hints.filter((h) => h !== undefined).length,
          total: userEventIndices.length,
        }
      : undefined;

  return {
    rawContent: raw,
    content: flatContent.join("\n").trim() || stringifyJsonlContent(raw),
    events,
    clockAlignment,
  };
}

export async function loadDetailedTranscript(
  filePath: string,
  startedAt: number,
  updatedAt: number,
  sourcePrefix: string,
  userClockHints?: Array<number | undefined>
): Promise<DetailedTranscript> {
  const raw = await fs.readFile(filePath, "utf-8");
  if (path.extname(filePath).toLowerCase() !== ".jsonl") {
    return buildDetailedTranscriptFromPlainText(raw, startedAt, updatedAt, sourcePrefix);
  }
  return buildDetailedTranscriptFromJsonl(raw, startedAt, updatedAt, sourcePrefix, userClockHints);
}

/**
 * Extract user-role text messages from a Cursor jsonl in their original
 * order. Used to build the input array for `alignUserTimestamps()`.
 */
export function extractUserMessagesFromJsonl(raw: string): string[] {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    let row: { role?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (normalizeRole(row.role || "system") !== "user") continue;
    const items = Array.isArray(row.message?.content) ? row.message?.content : [];
    for (const item of items) {
      if (!item || item.type !== "text" || typeof item.text !== "string") continue;
      const text = item.text.trim();
      if (text) out.push(text);
    }
  }
  return out;
}
