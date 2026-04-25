import crypto from "node:crypto";
import { isInjectedPrompt, unwrapUserQuery } from "./lib/prompt-injection";
import type { IndexData, Session, SourceId } from "./types";

export type PromptOccurrence = {
  sessionKey: string;
  sessionId: string;
  source: SourceId;
  repo: string;
  repoPath?: string;
  ts: number;
  segmentIndex: number;
};

export type PromptEntry = {
  promptHash: string;
  text: string;
  normalizedText: string;
  occurrences: PromptOccurrence[];
  sources: SourceId[];
  repos: string[];
  firstSeen: number;
  lastSeen: number;
};

/**
 * Lower + trim + collapse whitespace. Used to deduplicate user prompts that
 * are textually identical except for trailing newlines, casing, or
 * indentation. The original text is preserved separately so the UI can show
 * exactly what the user typed.
 */
export function normalizePrompt(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function hashPrompt(normalized: string): string {
  return crypto.createHash("sha1").update(normalized).digest("hex");
}

/**
 * Walk every session segment, peel off Cursor's `<user_query>` envelope when
 * present, drop injected scaffolding, and return one occurrence per surviving
 * user message. Order matches index iteration order.
 */
function* iterateUserSegments(
  indexData: IndexData
): Generator<{ session: Session; segmentIndex: number; text: string; ts: number }> {
  for (const session of indexData.sessions) {
    if (!Array.isArray(session.segments)) continue;
    for (const segment of session.segments) {
      if (segment.role !== "user") continue;
      const unwrapped = unwrapUserQuery(segment.text).trim();
      if (!unwrapped) continue;
      if (isInjectedPrompt(unwrapped, session.source)) continue;
      yield {
        session,
        segmentIndex: segment.index,
        text: unwrapped,
        ts: segment.ts,
      };
    }
  }
}

export type ExtractPromptsOptions = {
  /** Drop messages whose normalized form is shorter than this. */
  minLength?: number;
  /** Drop messages whose normalized form is longer than this (defensive). */
  maxLength?: number;
};

/**
 * One PromptEntry per unique (normalized) user prompt found across the index.
 * Occurrences inside an entry are sorted ascending by timestamp so the UI can
 * show "first seen → last seen" without resorting.
 */
export function extractPrompts(
  indexData: IndexData,
  options: ExtractPromptsOptions = {}
): PromptEntry[] {
  const minLength = options.minLength ?? 4;
  const maxLength = options.maxLength ?? 50_000;

  const byHash = new Map<string, PromptEntry>();

  for (const item of iterateUserSegments(indexData)) {
    const normalized = normalizePrompt(item.text);
    if (normalized.length < minLength || normalized.length > maxLength) continue;
    const promptHash = hashPrompt(normalized);

    let entry = byHash.get(promptHash);
    if (!entry) {
      entry = {
        promptHash,
        text: item.text,
        normalizedText: normalized,
        occurrences: [],
        sources: [],
        repos: [],
        firstSeen: item.ts,
        lastSeen: item.ts,
      };
      byHash.set(promptHash, entry);
    }

    entry.occurrences.push({
      sessionKey: item.session.sessionKey,
      sessionId: item.session.sessionId,
      source: item.session.source,
      repo: item.session.repo,
      repoPath: item.session.repoPath,
      ts: item.ts,
      segmentIndex: item.segmentIndex,
    });
    if (!entry.sources.includes(item.session.source)) entry.sources.push(item.session.source);
    if (!entry.repos.includes(item.session.repo)) entry.repos.push(item.session.repo);
    if (item.ts && (entry.firstSeen === 0 || item.ts < entry.firstSeen)) entry.firstSeen = item.ts;
    if (item.ts > entry.lastSeen) entry.lastSeen = item.ts;
  }

  for (const entry of byHash.values()) {
    entry.occurrences.sort((a, b) => a.ts - b.ts);
  }

  return Array.from(byHash.values());
}

export type PromptFilter = {
  source?: SourceId | "all";
  repo?: string;
  minOccurrences?: number;
  /**
   * Free-text substring filter applied to the normalized prompt body. Case
   * insensitive. Empty string disables the filter.
   */
  query?: string;
  /** Drop entries first seen before this epoch second; 0 disables. */
  sinceTs?: number;
};

export function filterPrompts(
  entries: PromptEntry[],
  filter: PromptFilter
): PromptEntry[] {
  const minOccurrences = filter.minOccurrences ?? 1;
  const query = (filter.query ?? "").trim().toLowerCase();
  const sinceTs = filter.sinceTs ?? 0;

  return entries.filter((entry) => {
    if (entry.occurrences.length < minOccurrences) return false;
    if (filter.source && filter.source !== "all" && !entry.sources.includes(filter.source)) {
      return false;
    }
    if (filter.repo && !entry.repos.includes(filter.repo)) return false;
    if (sinceTs > 0 && entry.lastSeen < sinceTs) return false;
    if (query && !entry.normalizedText.includes(query)) return false;
    return true;
  });
}

/**
 * Default sort: most-recent-first ties broken by occurrence count then
 * normalized text (alphabetical) so output is stable across calls.
 */
export function sortPrompts(entries: PromptEntry[]): PromptEntry[] {
  return [...entries].sort((a, b) => {
    if (b.lastSeen !== a.lastSeen) return b.lastSeen - a.lastSeen;
    if (b.occurrences.length !== a.occurrences.length) {
      return b.occurrences.length - a.occurrences.length;
    }
    return a.normalizedText.localeCompare(b.normalizedText);
  });
}

/**
 * Compact JSON form matching the frontend's `PromptEntry` type. Trims
 * `text` to a hard ceiling so the wire payload stays predictable when a user
 * pasted a multi-megabyte transcript.
 */
export function serializePromptEntry(entry: PromptEntry, textLimit = 8000) {
  return {
    prompt_hash: entry.promptHash,
    text: entry.text.length > textLimit ? entry.text.slice(0, textLimit) : entry.text,
    normalized_text: entry.normalizedText,
    occurrences: entry.occurrences.map((occurrence) => ({
      session_key: occurrence.sessionKey,
      session_id: occurrence.sessionId,
      source: occurrence.source,
      repo: occurrence.repo,
      repo_path: occurrence.repoPath,
      ts: occurrence.ts,
      segment_index: occurrence.segmentIndex,
    })),
    sources: entry.sources,
    repos: entry.repos,
    first_seen: entry.firstSeen,
    last_seen: entry.lastSeen,
    occurrence_count: entry.occurrences.length,
    text_truncated: entry.text.length > textLimit,
  };
}
