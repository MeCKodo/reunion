// data/ai/settings.json: which provider Smart Export / Ask AI default to.
// Stored separately from the per-provider account stores so the user can swap
// the default without touching the multi-account list.

import fs from "node:fs";

import { AI_DATA_DIR, AI_SETTINGS_FILE } from "../config.js";
import { ensureAiDataDirs } from "./openai/accounts.js";

export type AiProvider = "openai" | "cursor";

// Mirrors codex-rs `ReasoningEffort` enum (lowercase serde rename).
// `none` = explicitly disable reasoning, distinct from "unset"/null which
// means "let the model decide based on its own default".
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

// Mirrors codex-rs `ServiceTier`. `fast` is sent as `"priority"` on the wire,
// `flex` as `"flex"`. Null means "do not include service_tier in payload".
export type ServiceTier = "fast" | "flex";
export const SERVICE_TIERS: readonly ServiceTier[] = ["fast", "flex"];

export interface AiSettings {
  defaultProvider: AiProvider;
  defaultOpenAiAccountId: string | null;
  defaultModel: string | null;
  /** OpenAI-only: reasoning effort sent in /responses payload. */
  defaultReasoningEffort: ReasoningEffort | null;
  /** OpenAI-only: service tier (Fast => "priority", Flex => "flex"). */
  defaultServiceTier: ServiceTier | null;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  // Cursor wins by default because it is the existing zero-config path: any
  // user who already logged into Cursor desktop can run Smart Export with no
  // setup. OpenAI requires installing the `codex` CLI first.
  defaultProvider: "cursor",
  defaultOpenAiAccountId: null,
  defaultModel: null,
  defaultReasoningEffort: null,
  defaultServiceTier: null,
};

function normalizeEffort(raw: unknown): ReasoningEffort | null {
  if (typeof raw !== "string") return null;
  const lower = raw.toLowerCase() as ReasoningEffort;
  return REASONING_EFFORTS.includes(lower) ? lower : null;
}

function normalizeTier(raw: unknown): ServiceTier | null {
  if (typeof raw !== "string") return null;
  const lower = raw.toLowerCase() as ServiceTier;
  return SERVICE_TIERS.includes(lower) ? lower : null;
}

function normalize(raw: unknown): AiSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_AI_SETTINGS };
  const r = raw as Record<string, unknown>;
  const provider =
    r.defaultProvider === "openai" || r.defaultProvider === "cursor"
      ? r.defaultProvider
      : DEFAULT_AI_SETTINGS.defaultProvider;
  return {
    defaultProvider: provider,
    defaultOpenAiAccountId:
      typeof r.defaultOpenAiAccountId === "string" ? r.defaultOpenAiAccountId : null,
    defaultModel: typeof r.defaultModel === "string" ? r.defaultModel : null,
    defaultReasoningEffort: normalizeEffort(r.defaultReasoningEffort),
    defaultServiceTier: normalizeTier(r.defaultServiceTier),
  };
}

export function readAiSettings(): AiSettings {
  ensureAiDataDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(AI_SETTINGS_FILE, "utf8"));
    return normalize(raw);
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export function writeAiSettings(next: AiSettings): AiSettings {
  fs.mkdirSync(AI_DATA_DIR, { recursive: true });
  const tmp = `${AI_SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, AI_SETTINGS_FILE);
  return next;
}

export function updateAiSettings(patch: Partial<AiSettings>): AiSettings {
  const current = readAiSettings();
  const merged: AiSettings = { ...current, ...patch };
  return writeAiSettings(merged);
}
