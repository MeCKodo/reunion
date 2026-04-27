import i18n from "@/i18n";
import {
  Bot,
  Globe,
  Pencil,
  Search,
  Terminal,
  Trash2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { Role, Segment, SourceId } from "./types";

export function parseTranscript(
  content: string,
  startedAt: number,
  updatedAt: number
): Segment[] {
  const lines = content.split(/\r?\n/);
  const segments: Segment[] = [];
  let currentRole: Role = "system";
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) {
      segments.push({ index: segments.length, role: currentRole, text, ts: startedAt });
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
    ...segment,
    index: idx,
    ts: Math.floor(start + idx * step),
  }));
}

/**
 * Semantic category of a tool call. Consumers use this key to pick an icon
 * (see TOOL_ICONS in MessageCard) and a palette (TOOL_STYLES below).
 *
 * `subagent` is a synthetic category: it is *not* looked up from TOOL_CATEGORY,
 * it is only produced when roleMeta sees `toolName === "Task"`. We promote it
 * out of the generic `agent` pastel so a Task invocation reads as a distinct
 * "spawning a child agent" moment — purple instead of indigo, with a Bot icon.
 */
export type ToolCategory =
  | "read"
  | "write"
  | "exec"
  | "agent"
  | "subagent"
  | "web"
  | "danger"
  | "default";

export type RoleMeta = {
  label: string;
  container: string;
  prose: boolean;
  avatarLetter: string;
  /** When set, MessageCard renders a lucide icon instead of avatarLetter. */
  avatarIconKey?: ToolCategory;
  avatarClass: string;
  labelClass: string;
};

/**
 * Tool-name → semantic category → Stripe-pastel palette.
 *
 * Tailwind static palette classes must be literal strings so the scanner can
 * emit them at build time. Do NOT compose these class names dynamically.
 * Level 100 bg + 300 border is chosen for visible separation against the
 * white bubble surface and the neutral fallback swatch.
 */
const TOOL_STYLES: Record<ToolCategory, { avatar: string; label: string }> = {
  read: {
    avatar: "bg-sky-100 text-sky-700 border border-sky-300",
    label: "text-sky-700",
  },
  write: {
    avatar: "bg-amber-100 text-amber-800 border border-amber-300",
    label: "text-amber-800",
  },
  exec: {
    avatar: "bg-teal-100 text-teal-700 border border-teal-300",
    label: "text-teal-700",
  },
  agent: {
    avatar: "bg-indigo-100 text-indigo-700 border border-indigo-300",
    label: "text-indigo-700",
  },
  subagent: {
    avatar: "bg-sky-100 text-sky-700 border border-sky-300",
    label: "text-sky-700",
  },
  web: {
    avatar: "bg-emerald-100 text-emerald-700 border border-emerald-300",
    label: "text-emerald-700",
  },
  danger: {
    avatar: "bg-rose-100 text-rose-700 border border-rose-300",
    label: "text-rose-700",
  },
  default: {
    avatar: "bg-background-soft text-muted-foreground border border-border-strong",
    label: "text-foreground",
  },
};

/**
 * Known tool names from all three sources (Cursor / Claude Code / Codex)
 * grouped by semantic intent. Names are case-sensitive — Cursor uses
 * `Shell`, Codex uses `shell`; both are listed where they collide.
 * Unknown tools fall back to neutral gray (see `toolCategory()` for the
 * MCP prefix fallback).
 */
export const TOOL_CATEGORY: Record<string, ToolCategory> = {
  // read / search
  Read: "read",
  Glob: "read",
  Grep: "read",
  SemanticSearch: "read",
  ReadLints: "read",
  FetchMcpResource: "read",
  ListMcpResources: "read",
  codebase_search: "read",
  grep_search: "read",
  file_search: "read",
  list_dir: "read",
  read_file: "read",

  // write / edit
  Write: "write",
  StrReplace: "write",
  EditNotebook: "write",
  Edit: "write",
  edit_file: "write",
  apply_patch: "write", // Codex

  // shell / exec
  Shell: "exec",
  Await: "exec",
  Bash: "exec",
  run_terminal_cmd: "exec",
  shell: "exec", // Codex (legacy name)
  exec_command: "exec", // Codex (current name, ~95% of tool calls)
  write_stdin: "exec", // Codex (feeds stdin into a running exec_command)

  // agent dispatch (actual subagent spawn)
  Task: "agent",
  Agent: "agent", // Claude Code subagent invocation
  spawn_agent: "agent", // Codex subagent spawn
  wait_agent: "agent", // Codex wait for subagent
  close_agent: "agent", // Codex close subagent

  // planning / orchestration (not real subagent spawns)
  TodoWrite: "default",
  AskQuestion: "default",
  SwitchMode: "default",
  CreatePlan: "default", // Cursor plan-mode tool
  TaskCreate: "default", // Claude Code task tracker
  TaskUpdate: "default",
  Skill: "default", // Claude Code skill invocation
  AskUserQuestion: "default", // Claude Code
  update_plan: "default", // Codex

  // web / external
  WebSearch: "web",
  WebFetch: "web",
  CallMcpTool: "web",
  web_search: "web", // Codex web_search_call

  // destructive
  Delete: "danger",
  delete_file: "danger",
};

/**
 * MCP-style tool names follow conventions like `chrome-devtools__navigate_page`,
 * `mcp__server__tool`, or `<server>.<tool>`. They are external integrations,
 * so we colour them as `web` by default rather than leaving them grey.
 */
function isMcpStyleToolName(name: string): boolean {
  return (
    name.startsWith("chrome-devtools__") ||
    name.startsWith("mcp__") ||
    name.includes("__mcp_")
  );
}

export function toolCategory(toolName: string | undefined): ToolCategory {
  if (!toolName) return "default";
  const explicit = TOOL_CATEGORY[toolName];
  if (explicit) return explicit;
  if (isMcpStyleToolName(toolName)) return "web";
  return "default";
}

/**
 * Tool buckets surfaced in the toolbar's secondary filter row. `subagent` and
 * `default` are excluded on purpose: `subagent` already has its own first-row
 * tab, and `default` is the catch-all (filtering by it would just be "every
 * tool we don't have a label for", which isn't a useful slice).
 */
export type ToolBucket = "read" | "write" | "exec" | "agent" | "web" | "danger";

export const TOOL_BUCKET_ORDER: ToolBucket[] = [
  "read",
  "write",
  "exec",
  "agent",
  "web",
  "danger",
];

export const TOOL_BUCKET_LABEL: Record<ToolBucket, string> = {
  read: "Read",
  write: "Write",
  exec: "Exec",
  agent: "Agent",
  web: "Web",
  danger: "Danger",
};

export function getToolBucketLabel(bucket: ToolBucket): string {
  return i18n.t(`toolBucket.${bucket}`);
}

/** Lucide icon per tool category — used by both MessageCard avatar and toolbar chips. */
export const TOOL_ICONS: Partial<Record<ToolCategory, LucideIcon>> = {
  read: Search,
  write: Pencil,
  exec: Terminal,
  agent: Workflow,
  subagent: Bot,
  web: Globe,
  danger: Trash2,
};

export function isToolBucket(value: string): value is ToolBucket {
  return (TOOL_BUCKET_ORDER as string[]).includes(value);
}

function toolStyle(toolName: string | undefined): { avatar: string; label: string } {
  return TOOL_STYLES[toolCategory(toolName)];
}

function toolAvatarLetter(toolName: string | undefined): string {
  if (!toolName) return "T";
  const letter = toolName.replace(/[^a-zA-Z]/g, "").charAt(0);
  return letter ? letter.toUpperCase() : "T";
}

/**
 * Subagent invocation tool input shape (best-effort), shared across:
 *   - Cursor `Task`: { subagent_type, description, prompt, ... }
 *   - Claude Code `Agent`: { subagent_type, description, prompt, ... }
 *   - Claude Code `TaskCreate`: { subject, description, status }
 *
 * Returns the best display string to use as the subagent subtitle:
 * `subagent_type` first, then `subject`, then `description` (truncated).
 */
function extractSubagentLabel(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const obj = toolInput as Record<string, unknown>;

  const subagentType = typeof obj.subagent_type === "string" ? obj.subagent_type.trim() : "";
  if (subagentType) return subagentType;

  const subject = typeof obj.subject === "string" ? obj.subject.trim() : "";
  if (subject) return subject.length > 30 ? `${subject.slice(0, 30)}…` : subject;

  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  if (description) return description.length > 30 ? `${description.slice(0, 30)}…` : description;

  return undefined;
}

const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent", "spawn_agent"]);

/**
 * Identify "spawn a child agent" tool calls — promoted to a dedicated
 * Subagent presentation everywhere (avatar, label, footer accent).
 *   - Cursor: `Task`
 *   - Claude Code: `Agent`
 *   - Codex: `spawn_agent`
 */
export function isSubagentToolEvent(toolName: string | undefined): boolean {
  return Boolean(toolName) && SUBAGENT_TOOL_NAMES.has(toolName as string);
}

/**
 * Per-source assistant identity. Each chat backend has its own brand voice;
 * the message bubble keeps the same neutral surface but the avatar chip
 * carries a brand-tinted swatch so a glance tells you which agent spoke.
 *   - cursor:      Twilight Ember (project primary)
 *   - claude-code: Anthropic warm orange
 *   - codex:       OpenAI charcoal
 */
const ASSISTANT_META: Record<
  SourceId,
  { label: string; avatarLetter: string; avatarClass: string }
> = {
  cursor: {
    label: "Cursor",
    avatarLetter: "C",
    avatarClass: "bg-primary text-primary-foreground",
  },
  "claude-code": {
    label: "Claude",
    avatarLetter: "C",
    avatarClass: "bg-[#D97757] text-white",
  },
  codex: {
    label: "Codex",
    avatarLetter: "C",
    avatarClass: "bg-neutral-900 text-white",
  },
};

/**
 * Chat-thread role metadata (Stripe / ChatGPT style):
 * - All roles left-align, with an avatar chip on the left and bubble on the right.
 * - User / Assistant share the purple avatar; bubble bg differentiates them.
 * - Assistant label + avatar swatch are sourced from ASSISTANT_META so that
 *   a Claude transcript reads as "Claude", a Codex transcript reads as "Codex",
 *   etc. — no more "Cursor" mislabel for non-Cursor backends.
 * - Tool avatars & labels are colored per semantic category (read/write/exec/...).
 * - Task tool gets promoted to a dedicated "Subagent · {type}" presentation.
 * - System uses neutral gray.
 */
export function roleMeta(
  category: "user" | "assistant" | "tool" | "system",
  toolName?: string,
  contentType?: string,
  toolInput?: unknown,
  source?: SourceId
): RoleMeta {
  if (category === "user") {
    return {
      label: i18n.t("format.you"),
      container:
        "bg-primary-soft/70 text-foreground rounded-md px-4 py-3",
      prose: true,
      avatarLetter: "Y",
      avatarClass: "bg-primary text-primary-foreground",
      labelClass: "text-foreground",
    };
  }
  if (category === "assistant") {
    const meta = ASSISTANT_META[source ?? "cursor"];
    return {
      label: meta.label,
      container:
        "bg-surface border border-border text-surface-foreground rounded-md px-4 py-3",
      prose: true,
      avatarLetter: meta.avatarLetter,
      avatarClass: meta.avatarClass,
      labelClass: "text-foreground",
    };
  }
  if (category === "tool") {
    // Task / Agent = subagent spawn. Render it as its own first-class role so
    // the reader can distinguish "main agent used a tool" from "main agent
    // dispatched a child agent" at a glance — the latter is usually followed
    // by a SubagentBlock rendering the child's transcript.
    //   - Cursor uses `Task` with input.subagent_type
    //   - Claude Code uses `Agent` with input.subagent_type (or falls back to
    //     description)
    if (isSubagentToolEvent(toolName)) {
      const subagentLabel = extractSubagentLabel(toolInput);
      const style = TOOL_STYLES.subagent;
      return {
        label: subagentLabel
          ? i18n.t("format.subagentLabel", { label: subagentLabel })
          : i18n.t("format.subagent"),
        container:
          "bg-sky-50/50 border border-sky-200 border-l-[3px] border-l-sky-500 text-foreground rounded-md px-4 py-3",
        prose: false,
        avatarLetter: "S",
        avatarIconKey: "subagent",
        avatarClass: style.avatar,
        labelClass: style.label,
      };
    }
    const style = toolStyle(toolName);
    const cat = toolCategory(toolName);
    return {
      label: toolName ? i18n.t("format.toolLabel", { name: toolName }) : i18n.t("format.tool"),
      container:
        "bg-background-soft border border-border-strong text-foreground rounded-md px-4 py-3",
      prose: false,
      avatarLetter: toolAvatarLetter(toolName),
      avatarIconKey: cat === "default" ? undefined : cat,
      avatarClass: style.avatar,
      labelClass: style.label,
    };
  }
  // Defensive fallback. Empirically Cursor transcript JSONL only emits
  // user:text / assistant:text / assistant:tool_use, so this branch never
  // runs today — kept in case the transcript format adds thinking /
  // tool_result / image / etc. item types in the future.
  return {
    label:
      contentType && contentType !== "text"
        ? i18n.t("format.systemLabel", { type: contentType })
        : i18n.t("format.system"),
    container:
      "bg-muted border border-border text-muted-foreground rounded-md px-4 py-3",
    prose: false,
    avatarLetter: "S",
    avatarClass:
      "bg-background-soft text-muted-foreground border border-border-strong",
    labelClass: "text-muted-foreground",
  };
}
