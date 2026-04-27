export type SessionAnnotation = {
  starred?: boolean;
  tags?: string[];
  notes?: string;
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

export type SearchResult = {
  session_key: string;
  session_id: string;
  source: SourceId;
  repo: string;
  repo_path?: string;
  title: string;
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
};

export type ClockAlignment = {
  matched: number;
  total: number;
};

export type SessionDetail = SearchResult & {
  content: string;
  raw_content: string;
  events: TimelineEvent[];
  subagents: SubagentDetail[];
  clock_alignment?: ClockAlignment;
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
