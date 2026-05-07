export type Role = "user" | "assistant" | "system";
export type HistoryCategory = "user" | "assistant" | "tool" | "system";

export type SourceId = "cursor" | "claude-code" | "codex";

export type ParsedSegment = {
  index: number;
  role: Role;
  text: string;
  ts: number;
};

/**
 * Provenance of the session record. `local` sessions come from the on-disk
 * adapters (Cursor / Claude Code / Codex JSONL) and have a real `filePath`
 * pointing at the transcript inside one of `SourceRoots`. `remote` sessions
 * come from the team-mode `ingest` HTTP API and intentionally have NO local
 * file (`filePath` is `undefined`); any code path that wants to read the
 * underlying transcript on disk must check `provider === "local"` first.
 */
export type SessionProvider = "local" | "remote";

export type Session = {
  source: SourceId;
  sessionKey: string;
  sessionId: string;
  repo: string;
  repoPath?: string;
  title: string;
  /**
   * Absolute path of the underlying transcript on local disk. `undefined`
   * when `provider === "remote"` — the session lives in the ingest DB and
   * has no per-machine file. Callers that need to delete / download / open
   * the file must guard on `provider` first.
   */
  filePath?: string;
  /**
   * Defaults to `"local"` for legacy callers/tests that don't set it. Set to
   * `"remote"` when a session is materialised from the ingest API.
   */
  provider: SessionProvider;
  /**
   * Per-machine identity tag the collector was installed with — `"server"`
   * / `"frontend"` / `"client"` (extensible). Drives the team-mode sidebar
   * tag filter and the chip rendered next to a session row. `undefined` /
   * `""` for un-tagged data (legacy uploads, `--preset=local` installs);
   * the UI surfaces those in a "未分类" bucket. Always undefined for local
   * provider sessions.
   */
  clientTag?: string;
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
  /**
   * Subset of `tags` that came from the AI auto-tagger. Lets the UI render
   * AI-suggested tags with a different visual treatment without changing
   * any of the existing tag-search/filter pipelines (which still operate
   * on the merged `tags` array).
   */
  aiTagSet?: string[];
  /**
   * Unix seconds timestamp of the last successful AI tagging run for this
   * session. `undefined` means "never tagged by AI", which the bulk runner
   * uses to skip already-processed sessions by default.
   */
  aiTaggedAt?: number;
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

/**
 * Top-level data-source mode. `personal` reads from the on-machine adapters,
 * `team` proxies an `ingest` HTTP API. The two modes are mutually exclusive
 * — switching wipes the in-memory provider and rebuilds from configuration.
 */
export type AppMode = "personal" | "team";

/**
 * Capability bits surfaced to the frontend so destructive / file-system
 * actions can hide themselves when they would not work on the current data
 * source. These mirror the boolean methods the active provider implements.
 */
export type ProviderCapabilities = {
  /** star / tags / notes editing on session metadata */
  annotations: boolean;
  /** AI auto-tagging (LLM call out) */
  aiTagging: boolean;
  /** Smart Export (rules / skill markdown generation) */
  smartExport: boolean;
  /** delete a session's underlying transcript files */
  deleteSession: boolean;
  /** download the raw JSONL file */
  downloadJsonl: boolean;
  /** "Reveal in Finder" / open in default app */
  openLocalFile: boolean;
  /** show subagent timeline (Cursor / Claude sidechain) */
  subagents: boolean;
  /** detail page returns the full original transcript text */
  fullTranscript: boolean;
  /** search has full-text content matching (vs project/repo LIKE only) */
  fullTextSearch: boolean;
};

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
