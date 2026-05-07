export type SessionAnnotation = {
  starred?: boolean;
  tags?: string[];
  notes?: string;
  /** Subset of `tags` that came from the AI auto-tagger. */
  aiTagSet?: string[];
  /** Unix seconds: timestamp of the last successful AI tagging run. */
  aiTaggedAt?: number;
  updatedAt?: number;
};

export type TagSummary = { tag: string; count: number };

export type SourceId = "cursor" | "claude-code" | "codex";
export type SourceFilter = "all" | SourceId;

export type SourceSummary = {
  id: SourceId;
  display_name: string;
  session_count: number;
  last_updated_at: number;
};

export type RepoOption = {
  repo: string;
  source: SourceId;
  repo_path?: string;
  session_count: number;
  last_updated_at: number;
};

export const SOURCE_LABEL: Record<SourceId, string> = {
  cursor: "Cursor",
  "claude-code": "Claude",
  codex: "Codex",
};

export type Role = "user" | "assistant" | "system";
export type HistoryCategory = "user" | "assistant" | "tool" | "system";

export type TimelineEvent = {
  event_id: string;
  category: HistoryCategory;
  role: Role;
  kind: "text" | "tool_use" | "meta";
  content_type: string;
  text: string;
  ts: number;
  legacy_segment_index?: number;
  tool_name?: string;
  tool_input?: unknown;
  // Set on `tool_use` events from Claude/Codex sources, and on the matching
  // `tool_result` / `function_call_output` meta events. Used to fold tool
  // outputs under the originating tool_use card.
  tool_call_id?: string;
  // Only meaningful on tool_result events; surfaces Claude's `is_error` flag
  // so the UI can render error outputs distinctly.
  is_error?: boolean;
};

export type SubagentDetail = {
  session_id: string;
  title: string;
  file_path: string;
  started_at: number;
  updated_at: number;
  duration_sec: number;
  size_bytes: number;
  content: string;
  raw_content: string;
  events: TimelineEvent[];
};

/** Where the row originated. `local` = on-disk transcript; `remote` = team
 * mode aggregate from the ingest backend. The frontend uses this to gate
 * file-system actions (open, delete, download). */
export type SessionProvider = "local" | "remote";

export type SearchResult = {
  session_key: string;
  session_id: string;
  source: SourceId;
  /** Optional in team mode where rows come from the ingest aggregate. */
  provider?: SessionProvider;
  repo: string;
  repo_path?: string;
  title: string;
  /** Empty string for remote sessions — there is no on-disk transcript. */
  file_path: string;
  started_at: number;
  updated_at: number;
  duration_sec: number;
  size_bytes: number;
  snippet: string;
  match_count: number;
  message_hits: Array<{
    segment_index: number;
    role: HistoryCategory;
    ts: number;
    preview: string;
  }>;
  starred?: boolean;
  tags?: string[];
  notes?: string;
  /** Subset of `tags` produced by the AI auto-tagger (snake_case from API). */
  ai_tag_set?: string[];
  /** Unix seconds; null if AI has never tagged this session. */
  ai_tagged_at?: number | null;
  /**
   * Per-machine collector tag — `"server"` / `"frontend"` / `"client"` (or
   * future values). Only ever set in team mode; local-mode rows omit it.
   * Empty / undefined = the upload had no tag (legacy data or
   * `--preset=local` install) and gets bucketed as 未分类 in the UI.
   */
  client_tag?: string;
};

export type ClockAlignment = {
  matched: number;
  total: number;
};

/** Aggregate metrics surfaced by the team-mode backend. Personal mode leaves
 * this undefined; the UI shows them only when present. */
export type SessionMetrics = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  prompt_count: number;
  assistant_turns: number;
  tool_calls_total: number;
  cache_hit_rate?: number;
  version_count?: number;
};

/** Backend-provided rendering hint for the detail view (banner copy etc.).
 * Mainly used in team mode to flag sampled / truncated transcripts. */
export type SessionHint = {
  sampled?: boolean;
  truncated?: boolean;
  missing_tool_results?: boolean;
  message?: string;
};

export type SessionDetail = SearchResult & {
  content: string;
  raw_content: string;
  events: TimelineEvent[];
  subagents: SubagentDetail[];
  clock_alignment?: ClockAlignment;
  metrics?: SessionMetrics;
  /** Unix seconds — only set in team mode (max created_at across versions). */
  last_upload_time?: number;
  hint?: SessionHint;
};

export type Segment = { index: number; role: Role; text: string; ts: number };
export type RepoGroup = {
  repo: string;
  source: SourceId;
  repoPath?: string;
  sessions: SearchResult[];
};
export type ToolBucketFilter =
  | "tool:read"
  | "tool:write"
  | "tool:exec"
  | "tool:agent"
  | "tool:web"
  | "tool:danger";

export type MessageRoleFilter =
  | "all"
  | HistoryCategory
  | "subagent"
  | ToolBucketFilter;
export type PendingJumpTarget = { eventId?: string; legacySegmentIndex?: number } | null;

export type DetailMessageHit = {
  event_id: string;
  category: HistoryCategory;
  ts: number;
  preview: string;
  source_label: string;
};

export type HistoryMode = "push" | "replace" | "skip";

export type OpenSessionOptions = {
  targetSegment?: number;
  historyMode?: HistoryMode;
};

export const SESSION_QUERY_PARAM = "session";

export const DAY_OPTIONS = [
  { value: "0", labelKey: "dayOptions.allTime" },
  { value: "7", labelKey: "dayOptions.last7d" },
  { value: "30", labelKey: "dayOptions.last30d" },
  { value: "60", labelKey: "dayOptions.last60d" },
  { value: "90", labelKey: "dayOptions.last90d" },
  { value: "180", labelKey: "dayOptions.last180d" },
] as const;
