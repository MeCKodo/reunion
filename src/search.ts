import { decodeEntities, escapeHtml, escapeRegex, tokenize } from "./lib/text";
import { parseTranscript } from "./transcript";
import { projectAnnotation } from "./annotations";
import type { IndexData, ParsedSegment, Session, SessionAnnotation } from "./types";

// ---------------------------------------------------------------------------
// Lowercase-haystack caches.
//
// The hot path used to call `decodeEntities(seg.text).toLowerCase()` for every
// segment on every search — for a 35k-segment / ~20MB index that's ~50ms of
// pure string churn per keystroke. We cache the post-decode lowercase form
// keyed by the original Session/segment object so subsequent searches reuse
// the work.
//
// WeakMap means: as soon as buildIndex replaces a Session (changed mtime, etc),
// the old cache entries become eligible for GC automatically — no manual
// invalidation needed.
// ---------------------------------------------------------------------------
const sessionContentLowerCache = new WeakMap<Session, string>();
const segmentTextLowerCache = new WeakMap<ParsedSegment, string>();

function getSessionContentLower(session: Session): string {
  const cached = sessionContentLowerCache.get(session);
  if (cached !== undefined) return cached;
  const lower = decodeEntities(session.content).toLowerCase();
  sessionContentLowerCache.set(session, lower);
  return lower;
}

function getSegmentTextLower(segment: ParsedSegment): string {
  const cached = segmentTextLowerCache.get(segment);
  if (cached !== undefined) return cached;
  const lower = decodeEntities(segment.text).toLowerCase();
  segmentTextLowerCache.set(segment, lower);
  return lower;
}

function highlightWithTokens(text: string, tokens: string[]): string {
  if (!tokens.length) return escapeHtml(text);
  const escapedTokens = Array.from(new Set(tokens.map((token) => token.trim()).filter(Boolean)))
    .sort((a, b) => b.length - a.length)
    .map((token) => escapeRegex(token));
  if (!escapedTokens.length) return escapeHtml(text);
  const regex = new RegExp(`(${escapedTokens.join("|")})`, "gi");
  return escapeHtml(text).replace(regex, '<mark class="hit-mark">$1</mark>');
}

// Cache decoded+collapsed plain text per segment. The output is independent
// of the query (truncation/highlight is layered on top of `plain`), so the
// heavy `decodeEntities + collapse-whitespace` work can be reused across
// keystrokes for any segment that keeps coming back as a top hit. Memory
// is bounded by total segments and entries are freed automatically when a
// Session is replaced (WeakMap key).
const segmentPlainCache = new WeakMap<ParsedSegment, string>();
function getSegmentPlain(segment: ParsedSegment): string {
  const cached = segmentPlainCache.get(segment);
  if (cached !== undefined) return cached;
  const plain = decodeEntities(segment.text).replace(/\s+/g, " ").trim();
  segmentPlainCache.set(segment, plain);
  return plain;
}

function buildSegmentPreviewCached(segment: ParsedSegment, tokens: string[]): string {
  const plain = getSegmentPlain(segment);
  if (!plain) return "";
  const normalized = plain.toLowerCase();
  let hitIndex = -1;
  for (const token of tokens) {
    const idx = normalized.indexOf(token);
    if (idx >= 0 && (hitIndex < 0 || idx < hitIndex)) hitIndex = idx;
  }
  if (hitIndex < 0) return highlightWithTokens(plain.slice(0, 220), tokens);
  const start = Math.max(0, hitIndex - 70);
  const end = Math.min(plain.length, hitIndex + 170);
  return highlightWithTokens(plain.slice(start, end), tokens);
}

function buildSnippet(content: string, query: string): string {
  const normalized = content.toLowerCase();
  const token = tokenize(query)[0] || query.toLowerCase();
  if (!token) return escapeHtml(content.slice(0, 240));

  const index = normalized.indexOf(token);
  if (index < 0) return escapeHtml(content.slice(0, 240));

  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + 180);
  const raw = content.slice(start, end);

  const escaped = escapeHtml(raw);
  const tokenEscaped = escapeHtml(content.slice(index, index + token.length));
  if (!tokenEscaped) return escaped;

  const markRegex = new RegExp(escapeRegex(tokenEscaped), "i");
  return escaped.replace(markRegex, `<mark class="hit-mark">${tokenEscaped}</mark>`);
}

function ensureSegments(
  segments: ParsedSegment[],
  content: string,
  startedAt: number,
  updatedAt: number
): ParsedSegment[] {
  return segments.length > 0 ? segments : parseTranscript(content, startedAt, updatedAt);
}

function serializeSession(
  session: Session,
  snippet: string,
  matchCount: number,
  messageHits: Array<{ segment_index: number; role: string; ts: number; preview: string }>,
  annotations: Record<string, SessionAnnotation>
) {
  return {
    session_key: session.sessionKey,
    session_id: session.sessionId,
    source: session.source,
    repo: session.repo,
    repo_path: session.repoPath,
    title: session.title,
    file_path: session.filePath,
    started_at: session.startedAt,
    updated_at: session.updatedAt,
    duration_sec: Math.max(0, session.updatedAt - session.startedAt),
    size_bytes: session.sizeBytes,
    snippet,
    match_count: matchCount,
    message_hits: messageHits,
    ...projectAnnotation(annotations, session.sessionKey),
  };
}

export function searchSessions(
  indexData: IndexData,
  query: string,
  repo: string,
  limit: number,
  days: number,
  annotations: Record<string, SessionAnnotation>,
  source: string = ""
) {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const normalizedRepo = repo.trim();
  const normalizedSource = source.trim();
  const normalizedQuery = query.trim();
  const tokens = tokenize(normalizedQuery);
  const safeDays = Math.max(0, days);
  const minUpdatedAt = safeDays > 0 ? Math.floor(Date.now() / 1000) - safeDays * 24 * 60 * 60 : 0;

  let candidates = indexData.sessions;
  if (normalizedSource && normalizedSource !== "all") {
    candidates = candidates.filter((session) => session.source === normalizedSource);
  }
  if (normalizedRepo) {
    candidates = candidates.filter((session) => session.repo === normalizedRepo);
  }
  if (minUpdatedAt > 0) {
    candidates = candidates.filter((session) => session.updatedAt >= minUpdatedAt);
  }

  if (!normalizedQuery) {
    return candidates
      .slice(0, safeLimit)
      .map((session) =>
        serializeSession(session, escapeHtml(session.content.slice(0, 240)), 0, [], annotations)
      );
  }

  // ---------------------------------------------------------------------
  // Two-phase matching:
  //   Phase 1 — coarse session-level filter on cached lowercase `content`.
  //             Cheap `String.includes` knocks out the long tail (typically
  //             >90% of sessions for a focused query) without touching any
  //             segments. The longest token is checked first so we bail
  //             early on the most selective term.
  //   Phase 2 — precise per-segment scan for survivors. Segment lowercase
  //             forms are also cached, so re-typing a longer query reuses
  //             everything from the previous search.
  //
  // Sort + slice happen before we build any HTML preview, so high-frequency
  // queries like "a" don't pay 25k preview escapes only to throw 24700 away.
  // ---------------------------------------------------------------------
  const tokensByLength = [...tokens].sort((a, b) => b.length - a.length);

  type Hit = {
    segment: ParsedSegment;
  };

  type Ranked = {
    session: Session;
    matchCount: number;
    topHits: Hit[];
  };

  const ranked: Ranked[] = [];

  for (const session of candidates) {
    const sessionLower = getSessionContentLower(session);
    let sessionMatches = true;
    for (const token of tokensByLength) {
      if (!sessionLower.includes(token)) {
        sessionMatches = false;
        break;
      }
    }
    if (!sessionMatches) continue;

    const segments = ensureSegments(
      session.segments,
      session.content,
      session.startedAt,
      session.updatedAt
    );

    let matchCount = 0;
    const topHits: Hit[] = [];
    for (const segment of segments) {
      const haystack = getSegmentTextLower(segment);
      let allMatch = true;
      for (const token of tokensByLength) {
        if (!haystack.includes(token)) {
          allMatch = false;
          break;
        }
      }
      if (!allMatch) continue;
      matchCount += 1;
      if (topHits.length < 5) {
        topHits.push({ segment });
      }
    }

    if (matchCount === 0) continue;
    ranked.push({ session, matchCount, topHits });
  }

  ranked.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
    return b.session.updatedAt - a.session.updatedAt;
  });

  const top = ranked.slice(0, safeLimit);

  return top.map(({ session, matchCount, topHits }) => {
    const messageHits = topHits.map(({ segment }) => ({
      segment_index: segment.index,
      role: segment.role,
      ts: segment.ts,
      preview: buildSegmentPreviewCached(segment, tokens),
    }));
    const snippet = messageHits[0]?.preview || buildSnippet(session.content, normalizedQuery);
    return serializeSession(session, snippet, matchCount, messageHits, annotations);
  });
}
