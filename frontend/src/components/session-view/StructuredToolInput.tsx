import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  renderHighlightedBlock,
  renderHighlightedText,
  stringifyStructuredValue,
} from "@/lib/text";
import type { ToolCategory } from "@/lib/transcript";

/**
 * Structured renderer for any `tool_use` payload.
 *
 * Problems it solves:
 *   1. Raw `JSON.stringify(toolInput)` is hard to scan — long prompts, file
 *      contents, and diff strings collapse into one giant string with `\n`
 *      escaped, and all tools look visually identical.
 *   2. The previous Subagent-only view made Task calls readable but left Read /
 *      Write / Shell / Grep looking like a wall of text.
 *
 * Strategy:
 *   - Each key is classified (path/code/text/list/inline) by name + value shape.
 *   - Long text/list values get a collapsible code block with a **prominent
 *     full-width Expand button** (not a small link) so the affordance reads as
 *     "click me" at a glance, matching the accent palette of the tool.
 *   - Per-tool `PRIMARY` ordering surfaces the fields the reader actually cares
 *     about (e.g. `command` for Shell, `path`+`pattern` for Grep); everything
 *     else is tucked into a "其他参数" disclosure.
 *   - Tools we have no primary list for (unknown MCP tools, custom agents)
 *     degrade gracefully: every field is shown primary, preserving insertion
 *     order — no content is ever hidden silently.
 */

/* ---------- palette per ToolCategory ---------- */

type AccentStyles = {
  /** Small uppercase tag above each field (the key name). */
  label: string;
  /** Border around code/text value boxes. */
  fieldBorder: string;
  /** Background behind code/text value boxes. */
  fieldBg: string;
  /** Inline chip (path / pattern / subagent_type). */
  chipBg: string;
  chipText: string;
  /** Full-width Expand / "其他参数" button. */
  button: string;
};

// NOTE: every class here MUST be a literal string so the Tailwind scanner can
// emit it at build time. Do not compose these names dynamically.
const ACCENTS: Record<ToolCategory, AccentStyles> = {
  read: {
    label: "text-sky-700/80",
    fieldBorder: "border-sky-200",
    fieldBg: "bg-sky-50/70",
    chipBg: "bg-sky-100",
    chipText: "text-sky-800",
    button:
      "border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100 hover:border-sky-400 hover:text-sky-800",
  },
  write: {
    label: "text-amber-800/80",
    fieldBorder: "border-amber-200",
    fieldBg: "bg-amber-50/70",
    chipBg: "bg-amber-100",
    chipText: "text-amber-900",
    button:
      "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 hover:border-amber-400 hover:text-amber-900",
  },
  exec: {
    label: "text-teal-700/80",
    fieldBorder: "border-teal-200",
    fieldBg: "bg-teal-50/70",
    chipBg: "bg-teal-100",
    chipText: "text-teal-800",
    button:
      "border-teal-300 bg-teal-50 text-teal-700 hover:bg-teal-100 hover:border-teal-400 hover:text-teal-800",
  },
  agent: {
    label: "text-indigo-700/80",
    fieldBorder: "border-indigo-200",
    fieldBg: "bg-indigo-50/70",
    chipBg: "bg-indigo-100",
    chipText: "text-indigo-800",
    button:
      "border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:border-indigo-400 hover:text-indigo-800",
  },
  subagent: {
    label: "text-purple-700/80",
    fieldBorder: "border-purple-200",
    fieldBg: "bg-white/70",
    chipBg: "bg-purple-100",
    chipText: "text-purple-800",
    button:
      "border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-100 hover:border-purple-400 hover:text-purple-800",
  },
  web: {
    label: "text-emerald-700/80",
    fieldBorder: "border-emerald-200",
    fieldBg: "bg-emerald-50/70",
    chipBg: "bg-emerald-100",
    chipText: "text-emerald-800",
    button:
      "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-400 hover:text-emerald-800",
  },
  danger: {
    label: "text-rose-700/80",
    fieldBorder: "border-rose-200",
    fieldBg: "bg-rose-50/70",
    chipBg: "bg-rose-100",
    chipText: "text-rose-800",
    button:
      "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 hover:border-rose-400 hover:text-rose-800",
  },
  default: {
    label: "text-muted-foreground",
    fieldBorder: "border-border",
    fieldBg: "bg-background-soft/50",
    chipBg: "bg-background-soft",
    chipText: "text-foreground",
    button:
      "border-border-strong bg-background-soft text-foreground hover:bg-background hover:border-muted-foreground/60 hover:text-foreground",
  },
};

/* ---------- field key → kind classification ---------- */

type FieldKind = "inline" | "code" | "text" | "list";

/** Files, directories, URLs — render as a monospace chip. */
const PATH_KEYS = new Set([
  "path",
  "target_file",
  "file_path",
  "target_notebook",
  "working_directory",
  "cwd",
  "target_directory",
  "url",
  "relative_workspace_path",
  "uri",
]);

/** Short opaque identifiers — render as a monospace chip. */
const CODE_KEYS = new Set([
  "pattern",
  "glob_pattern",
  "glob",
  "search_term",
  "query",
  "task_id",
  "server",
  "toolName",
  "target_mode_id",
  "subagent_type",
  "output_mode",
  "include_pattern",
  "exclude_pattern",
]);

/** Multi-line payloads — render as a collapsible pre. */
const TEXT_KEYS = new Set([
  "command",
  "old_string",
  "new_string",
  "old_str",
  "new_str",
  "contents",
  "content",
  "prompt",
  "plan",
  "overview",
  "body",
  "code",
]);

/** Arrays/objects — always collapsible JSON. */
const LIST_KEYS = new Set([
  "todos",
  "questions",
  "paths",
  "arguments",
  "required_permissions",
  "target_directories",
]);

/**
 * Keys that read as "short caption" — always get a full-width line so the
 * reader can parse them as prose, not as a code chip.
 */
const CAPTION_KEYS = new Set([
  "description",
  "title",
  "name",
  "explanation",
]);

/** Per-tool primary ordering. Anything not listed is collapsed under "其他参数". */
const PRIMARY: Record<string, string[]> = {
  Shell: ["description", "command", "working_directory"],
  Bash: ["description", "command"],
  run_terminal_cmd: ["explanation", "command", "is_background"],
  Read: ["path", "offset", "limit"],
  read_file: ["target_file", "offset", "limit"],
  Write: ["path", "contents"],
  StrReplace: ["path", "old_string", "new_string"],
  Edit: ["path", "old_string", "new_string"],
  edit_file: ["target_file", "old_string", "new_string"],
  search_replace: ["file_path", "old_string", "new_string"],
  Grep: [
    "pattern",
    "path",
    "output_mode",
    "-n",
    "-i",
    "head_limit",
    "-A",
    "-B",
    "-C",
  ],
  grep: ["pattern", "path", "-i", "-A", "-B"],
  Glob: ["glob_pattern", "target_directory"],
  SemanticSearch: ["query", "target_directories", "num_results"],
  codebase_search: ["query", "target_directories"],
  file_search: ["query"],
  grep_search: ["query", "include_pattern"],
  list_dir: ["relative_workspace_path"],
  WebSearch: ["search_term", "explanation"],
  WebFetch: ["url"],
  Task: ["description", "subagent_type", "prompt"],
  TodoWrite: ["todos", "merge"],
  AskQuestion: ["title", "questions"],
  CreatePlan: ["name", "overview", "plan", "todos"],
  CallMcpTool: ["server", "toolName", "arguments"],
  Await: ["task_id", "block_until_ms", "pattern"],
  ReadLints: ["paths"],
  Delete: ["path"],
  delete_file: ["path"],
  SwitchMode: ["target_mode_id", "explanation"],
  EditNotebook: ["target_notebook", "cell_idx", "old_string", "new_string"],
  FetchMcpResource: ["server", "uri"],

  // Codex-native tools
  shell: ["command", "workdir", "timeout_ms"], // legacy
  exec_command: ["cmd", "workdir", "yield_time_ms", "max_output_tokens"],
  write_stdin: ["session_id", "chars", "yield_time_ms"],
  apply_patch: ["input"],
  update_plan: ["explanation", "plan"],
  web_search: ["query"],

  // Claude Code tools
  Agent: ["description", "subagent_type", "prompt"],
  Skill: ["skill", "args"],
  TaskCreate: ["subject", "description", "status"],
  TaskUpdate: ["taskId", "status"],
  AskUserQuestion: ["questions"],
};

function classifyField(key: string, value: unknown): FieldKind {
  if (CAPTION_KEYS.has(key)) {
    if (typeof value === "string" && value.includes("\n")) return "text";
    return "inline";
  }
  if (PATH_KEYS.has(key)) return "code";
  if (CODE_KEYS.has(key)) return "code";
  if (TEXT_KEYS.has(key)) return "text";
  if (LIST_KEYS.has(key)) return "list";
  if (Array.isArray(value)) return "list";
  if (value && typeof value === "object") return "list";
  if (typeof value === "string") {
    if (value.includes("\n") || value.length > 120) return "text";
    return "inline";
  }
  return "inline";
}

/* ---------- collapsible code block with prominent Expand button ---------- */

const DEFAULT_PREVIEW_LINES = 6;

function CollapsibleText({
  text,
  previewLines = DEFAULT_PREVIEW_LINES,
  accent,
  queryTokens,
}: {
  text: string;
  previewLines?: number;
  accent: AccentStyles;
  queryTokens: string[];
}) {
  const { t } = useTranslation();
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;
  // "Long" if either line count or char count exceeds the preview budget.
  // The char threshold catches 1-line-but-very-wide payloads.
  const isLong =
    totalLines > previewLines ||
    text.length > Math.max(400, previewLines * 80);

  const [expanded, setExpanded] = React.useState(false);
  const visible =
    expanded || !isLong ? text : lines.slice(0, previewLines).join("\n");
  const hiddenLines = totalLines - previewLines;

  return (
    <div>
      <div
        className={cn(
          "rounded border px-3 py-2",
          accent.fieldBorder,
          accent.fieldBg
        )}
      >
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.65] text-foreground/85">
          {renderHighlightedBlock(visible, queryTokens)}
          {isLong && !expanded ? (
            <span className={cn("select-none", accent.label)}>{"\n…"}</span>
          ) : null}
        </pre>
      </div>
      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className={cn(
            "mt-1.5 flex w-full items-center justify-center gap-1.5",
            "rounded border border-dashed px-3 py-1.5",
            "font-sans text-[11px] font-semibold tracking-[0.02em]",
            "transition-colors",
            accent.button
          )}
        >
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5" strokeWidth={2.25} />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.25} />
          )}
          <span>
            {expanded
              ? t("tool.collapse")
              : hiddenLines > 0
                ? t("tool.expandRemaining", { hidden: hiddenLines, total: totalLines })
                : t("tool.expandAll")}
          </span>
        </button>
      ) : null}
    </div>
  );
}

/* ---------- single field renderer ---------- */

function FieldBlock({
  keyName,
  kind,
  value,
  accent,
  queryTokens,
}: {
  keyName: string;
  kind: FieldKind;
  value: unknown;
  accent: AccentStyles;
  queryTokens: string[];
}) {
  return (
    <div>
      <div
        className={cn(
          "mb-1 font-mono text-[10px] uppercase tracking-[0.08em]",
          accent.label
        )}
      >
        {keyName}
      </div>
      {kind === "inline" ? (
        <div className="text-[13px] leading-relaxed text-foreground/90">
          {renderHighlightedText(
            typeof value === "string" ? value : String(value),
            queryTokens
          )}
        </div>
      ) : null}
      {kind === "code" ? (
        <div
          className={cn(
            "inline-block max-w-full break-all rounded px-2 py-1",
            "font-mono text-[12px] leading-[1.55]",
            accent.chipBg,
            accent.chipText
          )}
        >
          {renderHighlightedText(
            typeof value === "string" ? value : stringifyStructuredValue(value),
            queryTokens
          )}
        </div>
      ) : null}
      {kind === "text" ? (
        <CollapsibleText
          text={
            typeof value === "string" ? value : stringifyStructuredValue(value)
          }
          accent={accent}
          queryTokens={queryTokens}
        />
      ) : null}
      {kind === "list" ? (
        <CollapsibleText
          text={stringifyStructuredValue(value)}
          accent={accent}
          queryTokens={queryTokens}
        />
      ) : null}
    </div>
  );
}

/* ---------- public component ---------- */

export function StructuredToolInput({
  toolName,
  input,
  category,
  queryTokens,
}: {
  toolName: string;
  input: Record<string, unknown>;
  category: ToolCategory;
  queryTokens: string[];
}) {
  const { t } = useTranslation();
  const accent = ACCENTS[category] ?? ACCENTS.default;

  // Drop nil / empty-string values; they add noise without information.
  const entries = Object.entries(input).filter(([, v]) => {
    if (v === undefined || v === null) return false;
    if (typeof v === "string" && v === "") return false;
    return true;
  });

  const primaryKeys = PRIMARY[toolName] ?? [];
  let primary: [string, unknown][];
  let rest: [string, unknown][];

  if (primaryKeys.length > 0) {
    const pickedKeys = new Set<string>();
    primary = [];
    for (const k of primaryKeys) {
      const hit = entries.find(([name]) => name === k);
      if (hit) {
        primary.push(hit);
        pickedKeys.add(k);
      }
    }
    rest = entries.filter(([k]) => !pickedKeys.has(k));
  } else {
    // Unknown tool: show everything inline, don't silently hide anything.
    primary = entries;
    rest = [];
  }

  return (
    <div className="space-y-3">
      {primary.map(([k, v]) => (
        <FieldBlock
          key={k}
          keyName={k}
          kind={classifyField(k, v)}
          value={v}
          accent={accent}
          queryTokens={queryTokens}
        />
      ))}
      {rest.length > 0 ? (
        <details className="group">
          <summary
            className={cn(
              "flex cursor-pointer list-none items-center gap-1.5",
              "w-fit rounded border border-dashed px-2.5 py-1",
              "font-mono text-[10px] uppercase tracking-[0.08em]",
              "transition-colors",
              accent.button
            )}
          >
            <ChevronRight
              className="h-3 w-3 transition-transform group-open:rotate-90"
              strokeWidth={2.25}
            />
            <span>{t("tool.otherParams", { count: rest.length })}</span>
          </summary>
          <div className="mt-2 space-y-3">
            {rest.map(([k, v]) => (
              <FieldBlock
                key={k}
                keyName={k}
                kind={classifyField(k, v)}
                value={v}
                accent={accent}
                queryTokens={queryTokens}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
