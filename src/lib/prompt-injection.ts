import type { SourceId } from "../types";

/**
 * Per-source line prefixes that mark a "user" message as system-injected
 * scaffolding rather than something the human typed. We use them to drop
 * tool-call envelopes, IDE auto-context, scheduled reminders, and the like
 * from the prompt library and similarity index.
 *
 * Keep in sync with `src/sources/claude-code.ts` and `src/sources/codex.ts`,
 * which apply their own subset during transcript parsing — this module
 * unifies them so prompt-extraction logic doesn't have to know about each
 * source's quirks.
 */
const COMMON_PREFIXES = [
  "<system-reminder>",
  "<system_reminder>",
  "<environment_context>",
  "<user_instructions>",
  "<attached_files>",
  "<manually_attached_skills>",
];

const CLAUDE_PREFIXES = [
  ...COMMON_PREFIXES,
  "<local-command-",
  "<command-",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
];

const CODEX_PREFIXES = [
  ...COMMON_PREFIXES,
  "# AGENTS.md",
  "<permissions",
  "<skill>",
  "<automation",
  "OMX native",
];

const CURSOR_PREFIXES = [
  ...COMMON_PREFIXES,
  "<image_files>",
  "<additional_data>",
  "<custom_instructions>",
];

const PREFIXES_BY_SOURCE: Record<SourceId, readonly string[]> = {
  cursor: CURSOR_PREFIXES,
  "claude-code": CLAUDE_PREFIXES,
  codex: CODEX_PREFIXES,
};

/**
 * Returns true when a user-role message body should be treated as injected
 * scaffolding (and therefore excluded from the prompt library / similarity
 * index). Empty / whitespace-only text counts as injected.
 *
 * If `source` is omitted we union all source-specific prefix lists, which is
 * the safe default for code paths that may iterate across sources.
 */
export function isInjectedPrompt(text: string, source?: SourceId): boolean {
  const head = text.trim();
  if (!head) return true;
  const prefixes = source ? PREFIXES_BY_SOURCE[source] : COMMON_PREFIXES;
  for (const prefix of prefixes) {
    if (head.startsWith(prefix)) return true;
  }
  if (!source) {
    for (const list of Object.values(PREFIXES_BY_SOURCE)) {
      for (const prefix of list) {
        if (head.startsWith(prefix)) return true;
      }
    }
  }
  return false;
}

/**
 * Cursor wraps user messages with `<user_query>…</user_query>`. When present
 * we strip the envelope so the inner text is what we extract. Falls back to
 * the original text when no wrapper is found.
 */
export function unwrapUserQuery(text: string): string {
  const match = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  return match ? match[1].trim() : text;
}
