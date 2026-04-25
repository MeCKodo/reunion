export type Role = "user" | "assistant" | "system";
export type HistoryCategory = "user" | "assistant" | "tool" | "system";

export type SourceId = "cursor" | "claude-code" | "codex";

export type ParsedSegment = {
  index: number;
  role: Role;
  text: string;
  ts: number;
};

export type Session = {
  source: SourceId;
  sessionKey: string;
  sessionId: string;
  repo: string;
  repoPath?: string;
  title: string;
  filePath: string;
  startedAt: number;
  updatedAt: number;
  sizeBytes: number;
  mtimeMs: number;
  content: string;
  segments: ParsedSegment[];
};

export type SourceRoots = {
  cursor: string;
  claudeCode: string;
  codex: string;
};

export type IndexData = {
  sourceRoots: SourceRoots;
  generatedAt: number;
  sessions: Session[];
};

export type ReindexStats = {
  source_roots: SourceRoots;
  files_found: number;
  sessions_indexed: number;
  elapsed_ms: number;
  by_source: Array<{
    source: SourceId;
    files_found: number;
    sessions_indexed: number;
    elapsed_ms: number;
  }>;
};

export type SessionAnnotation = {
  starred?: boolean;
  tags?: string[];
  notes?: string;
  updatedAt: number;
};

export type AnnotationsFile = {
  version: number;
  annotations: Record<string, SessionAnnotation>;
};

export type TimelineEvent = {
  eventId: string;
  category: HistoryCategory;
  role: Role;
  kind: "text" | "tool_use" | "meta";
  contentType: string;
  text: string;
  ts: number;
  legacySegmentIndex?: number;
  toolName?: string;
  toolInput?: unknown;
  // Set on `tool_use` events from Claude/Codex sources, and on the matching
  // `tool_result` / `function_call_output` meta events. Used by the frontend
  // to fold a tool's output under the originating tool_use card.
  toolCallId?: string;
  // Only meaningful on tool_result events; surfaces Claude's `is_error` flag
  // so the UI can render error outputs distinctly.
  isError?: boolean;
};

/**
 * Tells the UI whether per-event timestamps are real or estimated. `matched`
 * is how many user messages got real timestamps from `aiService.generations`;
 * `total` is the total user message count. Cursor sessions whose generations
 * have been rotated out of SQLite end up with matched=0/total=N — pure
 * interpolation. Non-Cursor sources omit this and the UI treats them as
 * fully real.
 */
export type ClockAlignment = {
  matched: number;
  total: number;
};

export type DetailedTranscript = {
  rawContent: string;
  content: string;
  events: TimelineEvent[];
  clockAlignment?: ClockAlignment;
};

export type SubagentSessionDetail = {
  sessionId: string;
  title: string;
  filePath: string;
  startedAt: number;
  updatedAt: number;
  sizeBytes: number;
  rawContent: string;
  content: string;
  events: TimelineEvent[];
};

export type ExportKind = "rules" | "skill";
export type ExportMode = "smart" | "basic";
export type OpenFileAction = "opened" | "revealed";

export type ComposerMeta = {
  title: string;
  createdAt?: number;
  lastUpdatedAt?: number;
};

export type TranscriptFileEntry = {
  source: SourceId;
  sessionKey: string;
  sessionId: string;
  repo: string;
  repoPath?: string;
  filePath: string;
  mtimeMs: number;
  birthtimeMs: number;
  size: number;
};
