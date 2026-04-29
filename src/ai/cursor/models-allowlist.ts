// Curated allow-list for `cursor-agent` models surfaced inside Reunion.
//
// Cursor's CLI exposes ~90 models (composer / codex / sonnet / kimi / gemini /
// grok / nano / mini variants…). For Reunion we want a deliberately small
// menu so users — and the AI tagger — only see the high-quality options the
// team has actually validated. Restricting to the GPT-5.5 family and Anthropic
// Opus 4.6 / 4.7 families keeps the dropdown short and the cost-per-tag
// predictable.
//
// Filtering happens in two places:
//   1. `listCursorModels()` strips disallowed entries before they ever reach
//      the frontend dropdown (or the model-validation guard in run.ts).
//   2. `router.ts` substitutes any out-of-list `model` value at spawn time
//      (covers stale `settings.defaultModel` from before the allow-list
//      shipped, or callers passing a hard-coded id from somewhere else).
//
// Add a new family by appending a prefix here — no need to enumerate every
// (low|medium|high|xhigh|max|thinking|fast) permutation.

export const CURSOR_MODEL_ALLOWLIST_PREFIXES: readonly string[] = [
  "gpt-5.5",
  "claude-4.6-opus",
  "claude-opus-4-7",
];

/**
 * Soft default Reunion picks when the CLI's reported default (e.g.
 * `composer-2-fast`) gets filtered out. Chosen as the most balanced cost /
 * quality entry inside the allow-list.
 */
export const CURSOR_DEFAULT_MODEL_ID = "gpt-5.5-medium";

export function isAllowedCursorModelId(id: string): boolean {
  if (!id) return false;
  return CURSOR_MODEL_ALLOWLIST_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Coerce an arbitrary model id into one that's guaranteed to be allow-listed.
 * Pass `undefined`/`null` to get the soft default; pass an out-of-list id to
 * also get the soft default (callers that want strict validation should use
 * `isAllowedCursorModelId` directly).
 */
export function pickAllowedCursorModelId(model: string | null | undefined): string {
  if (model && isAllowedCursorModelId(model)) return model;
  return CURSOR_DEFAULT_MODEL_ID;
}
