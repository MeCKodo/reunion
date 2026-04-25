import { decodeEntities, escapeHtml, escapeRegex, tokenize } from "./lib/text";
import { parseTranscript } from "./transcript";
import { projectAnnotation } from "./annotations";
import type { IndexData, ParsedSegment, Session, SessionAnnotation } from "./types";

function highlightWithTokens(text: string, tokens: string[]): string {
  if (!tokens.length) return escapeHtml(text);
  const escapedTokens = Array.from(new Set(tokens.map((token) => token.trim()).filter(Boolean)))
    .sort((a, b) => b.length - a.length)
    .map((token) => escapeRegex(token));
  if (!escapedTokens.length) return escapeHtml(text);
  const regex = new RegExp(`(${escapedTokens.join("|")})`, "gi");
  return escapeHtml(text).replace(regex, '<mark class="hit-mark">$1</mark>');
}

function buildSegmentPreview(text: string, tokens: string[]): string {
  const plain = decodeEntities(text).replace(/\s+/g, " ").trim();
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

  const ranked = candidates
    .map((session) => {
      const segments = ensureSegments(session.segments, session.content, session.startedAt, session.updatedAt);
      const hits = segments
        .filter((segment) => {
          const haystack = decodeEntities(segment.text).toLowerCase();
          return tokens.every((token) => haystack.includes(token));
        })
        .map((segment) => ({
          segment_index: segment.index,
          role: segment.role,
          ts: segment.ts,
          preview: buildSegmentPreview(segment.text, tokens),
        }));
      return { session, hits };
    })
    .filter((item) => item.hits.length > 0)
    .sort((a, b) => {
      if (b.hits.length !== a.hits.length) return b.hits.length - a.hits.length;
      return b.session.updatedAt - a.session.updatedAt;
    });

  return ranked
    .slice(0, safeLimit)
    .map(({ session, hits }) =>
      serializeSession(
        session,
        hits[0]?.preview || buildSnippet(session.content, normalizedQuery),
        hits.length,
        hits.slice(0, 5),
        annotations
      )
    );
}
