// AI auto-tagger: extracts user messages from a session, asks the configured
// AI provider for 1-3 short tags, and returns them after JSON / shape recovery.
// Designed to be called from a bulk runner (concurrency-pooled via the SSE
// route in http-server) but small enough that callers could invoke it
// per-session from a future "tag this one session" action too.

import { parseTranscript } from "../transcript.js";
import { normalizeTag } from "../annotations.js";
import type { ParsedSegment, Session } from "../types.js";
import { runAiToString } from "./router.js";
import type { AiProvider } from "./settings.js";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Hard cap per single user message. Long pasted code/logs get truncated. */
const MAX_PER_MESSAGE_CHARS = 2000;
/** Hard cap on the full extracted blob fed into the prompt. ~3000 tokens. */
const MAX_TOTAL_CHARS = 12_000;
/** The product spec promises 1-3 tags; we enforce the upper bound here too. */
const MAX_TAGS = 3;
/** How many existing tags we surface to the model as the seed vocabulary. */
const MAX_EXISTING_TAGS_HINT = 60;

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type ExtractStrategy = "auto" | "first" | "first_last" | "sample" | "all";

export const EXTRACT_STRATEGIES: readonly ExtractStrategy[] = [
  "auto",
  "first",
  "first_last",
  "sample",
  "all",
];

export interface ExtractedMessages {
  text: string;
  strategyUsed: Exclude<ExtractStrategy, "auto">;
  userMsgCount: number;
}

export interface TagOneSessionInput {
  session: Session;
  existingTags: string[];
  strategy?: ExtractStrategy;
  provider?: AiProvider;
  model?: string;
  signal?: AbortSignal;
}

export interface TagOneSessionResult {
  tags: string[];
  raw: string;
  strategyUsed: Exclude<ExtractStrategy, "auto">;
  userMsgCount: number;
}

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

/**
 * Pull every user-role segment from the session, falling back to a fresh
 * `parseTranscript` when the index didn't pre-populate `segments` (some
 * adapters lazy-parse). System / assistant / tool messages are never
 * surfaced — the whole point of this tagger is "user intent only".
 */
function getUserSegments(session: Session): ParsedSegment[] {
  const segs =
    session.segments && session.segments.length > 0
      ? session.segments
      : parseTranscript(session.content, session.startedAt, session.updatedAt);
  return segs.filter((s) => s.role === "user");
}

/**
 * Truncate a single user message that's longer than the per-message cap.
 * Keep both head and tail so framing context (initial intent) and signal
 * (final clarifications) survive when the user pasted a giant blob.
 */
function clipMessage(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_PER_MESSAGE_CHARS) return trimmed;
  const headLen = Math.floor(MAX_PER_MESSAGE_CHARS * 0.7);
  const tailLen = Math.floor(MAX_PER_MESSAGE_CHARS * 0.25);
  const head = trimmed.slice(0, headLen);
  const tail = trimmed.slice(-tailLen);
  return `${head}\n... [truncated ${trimmed.length - headLen - tailLen} chars] ...\n${tail}`;
}

/**
 * Concatenate the picked user messages with positional headers and a
 * total-size guard. We stop appending once we'd exceed MAX_TOTAL_CHARS so
 * the prompt stays cheap regardless of how many messages got picked.
 */
function joinMessages(msgs: ParsedSegment[]): string {
  if (msgs.length === 0) return "";
  const blocks: string[] = [];
  let total = 0;
  for (let i = 0; i < msgs.length; i += 1) {
    const text = clipMessage(msgs[i].text);
    if (!text) continue;
    const block = `[user msg ${i + 1}]\n${text}`;
    if (total + block.length > MAX_TOTAL_CHARS) {
      blocks.push(`[truncated ${msgs.length - i} more message(s) for length]`);
      break;
    }
    blocks.push(block);
    total += block.length + 2;
  }
  return blocks.join("\n\n");
}

/**
 * The auto strategy picker. Tied to user-message count rather than byte
 * length so 1 long pasted message is still treated as a "short" session.
 *
 *   ≤ 5 messages → all  (cheap, full context)
 *   ≤ 20 messages → first_last (intent typically established by the bookends)
 *   > 20 messages → sample (head + spread + tail to avoid mid-conversation rot)
 */
export function pickAuto(userMsgCount: number): Exclude<ExtractStrategy, "auto"> {
  if (userMsgCount <= 5) return "all";
  if (userMsgCount <= 20) return "first_last";
  return "sample";
}

export function extractUserMessages(
  session: Session,
  strategy: ExtractStrategy = "auto"
): ExtractedMessages {
  const all = getUserSegments(session);
  const userMsgCount = all.length;
  if (userMsgCount === 0) {
    return {
      text: "",
      strategyUsed: strategy === "auto" ? "all" : strategy,
      userMsgCount: 0,
    };
  }

  const resolved: Exclude<ExtractStrategy, "auto"> =
    strategy === "auto" ? pickAuto(userMsgCount) : strategy;

  let picked: ParsedSegment[];
  switch (resolved) {
    case "first":
      picked = [all[0]];
      break;
    case "first_last":
      picked = userMsgCount === 1 ? [all[0]] : [all[0], all[userMsgCount - 1]];
      break;
    case "sample": {
      if (userMsgCount <= 7) {
        picked = all;
      } else {
        // Five evenly-spaced indices in the open interval (0, last) plus the
        // bookends. We round so adjacent samples never collapse onto the
        // same segment for moderate-length sessions.
        const middleCount = 5;
        const middle: ParsedSegment[] = [];
        const seen = new Set<number>([0, userMsgCount - 1]);
        for (let i = 1; i <= middleCount; i += 1) {
          const idx = Math.round((i * (userMsgCount - 1)) / (middleCount + 1));
          if (idx > 0 && idx < userMsgCount - 1 && !seen.has(idx)) {
            seen.add(idx);
            middle.push(all[idx]);
          }
        }
        picked = [all[0], ...middle, all[userMsgCount - 1]];
      }
      break;
    }
    case "all":
    default:
      picked = all;
      break;
  }

  return {
    text: joinMessages(picked),
    strategyUsed: resolved,
    userMsgCount,
  };
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

export function buildTaggingPrompt(
  extracted: string,
  strategyUsed: Exclude<ExtractStrategy, "auto">,
  existingTags: string[]
): string {
  const seed = existingTags.slice(0, MAX_EXISTING_TAGS_HINT);
  const seedLine =
    seed.length > 0
      ? seed.join(", ")
      : "(no existing tags yet — pick the most natural lowercase identifiers)";
  return [
    "You are categorizing AI coding-assistant conversations based on the USER's intent.",
    "",
    "The text below shows ONLY the user's messages from a conversation",
    "(the assistant's responses have been omitted; user messages express intent",
    "which is what matters for tagging).",
    "",
    "Output 1 to 3 short tags capturing the main topic/intent.",
    "",
    "Rules:",
    "- You MUST output between 1 and 3 tags. Never more, never zero.",
    `- Strongly prefer reusing tags from this existing set: ${seedLine}`,
    "- Only invent a new tag if nothing in the set reasonably fits",
    "- Tags should be lowercase, ≤32 chars; ASCII letters/digits/_/- (CJK characters are also allowed)",
    "- Avoid generic catch-alls like 'general', 'misc', 'help'",
    '- Output ONLY JSON, no markdown, no commentary: {"tags": ["..."]}',
    "",
    `User messages (extracted via "${strategyUsed}" strategy):`,
    extracted,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// response parsing
// ---------------------------------------------------------------------------

/**
 * Parse the model's reply into at most {@link MAX_TAGS} normalized tags.
 *
 * Tries three increasingly tolerant paths:
 *   1. Treat the entire response as JSON.
 *   2. Strip ```json fences and retry.
 *   3. Find the largest `{...}` substring and parse that.
 *
 * Bare arrays are accepted too because some models forget the wrapper.
 */
export function parseTagsResponse(raw: string): string[] {
  if (!raw || typeof raw !== "string") return [];

  let payload: unknown = null;
  const trimmed = raw.trim();
  try {
    payload = JSON.parse(trimmed);
  } catch {
    const fenceCleaned = trimmed
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```/g, "")
      .trim();
    try {
      payload = JSON.parse(fenceCleaned);
    } catch {
      const objMatch = fenceCleaned.match(/\{[\s\S]*\}/);
      const arrMatch = fenceCleaned.match(/\[[\s\S]*\]/);
      const candidate = objMatch?.[0] || arrMatch?.[0];
      if (candidate) {
        try {
          payload = JSON.parse(candidate);
        } catch {
          payload = null;
        }
      }
    }
  }

  let candidate: unknown[] = [];
  if (Array.isArray(payload)) {
    candidate = payload;
  } else if (payload && typeof payload === "object") {
    const obj = payload as { tags?: unknown };
    if (Array.isArray(obj.tags)) candidate = obj.tags;
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of candidate) {
    const norm = normalizeTag(item);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------

/**
 * Drive a single session through the tagger end-to-end. Returns an empty
 * `tags` array (with `userMsgCount: 0`) when the session has no user
 * messages — the bulk runner uses that as a "skip" signal so it can
 * report back distinct progress states.
 *
 * Errors from the underlying provider (network, auth, rate limit) bubble
 * up as plain `Error`s so the caller can decide whether to retry or
 * record the session as failed.
 */
export async function tagOneSession(opts: TagOneSessionInput): Promise<TagOneSessionResult> {
  const { text, strategyUsed, userMsgCount } = extractUserMessages(
    opts.session,
    opts.strategy ?? "auto"
  );
  if (!text || userMsgCount === 0) {
    return { tags: [], raw: "", strategyUsed, userMsgCount };
  }
  const prompt = buildTaggingPrompt(text, strategyUsed, opts.existingTags);
  const raw = await runAiToString({
    prompt,
    provider: opts.provider,
    model: opts.model,
    signal: opts.signal,
    instructions:
      "Reply with ONLY the JSON object specified in the user prompt. No prose, no code fences.",
    // Deliberately omit reasoningEffort/serviceTier — tagging is a quick
    // classification that doesn't need o-class reasoning, and falling back
    // to provider defaults keeps cost predictable.
  });
  const tags = parseTagsResponse(raw);
  return { tags, raw, strategyUsed, userMsgCount };
}
