// Single dispatcher used by Smart Export, Ask AI, and any future caller.
// Translates a high-level RunRequest into the appropriate provider-specific
// stream. Routes errors back as plain Error instances with sufficient context
// for the UI to suggest "re-login" / "switch provider" / etc.

import {
  getDefaultAccount,
  readStore,
  type Account,
} from "./openai/accounts.js";
import { streamOpenAi } from "./openai/bearer-client.js";
import { streamCursorAgent } from "./cursor/run.js";
import {
  getCursorAccountState,
  type CursorAccountState,
} from "./cursor/status.js";
import {
  readAiSettings,
  type AiProvider,
  type ReasoningEffort,
  type ServiceTier,
} from "./settings.js";

export interface RunRequest {
  /** Forced provider; falls back to `settings.defaultProvider`. */
  provider?: AiProvider;
  /** Forced OpenAI account id; falls back to settings then store default. */
  accountId?: string;
  prompt: string;
  /** Custom model name (overrides default). */
  model?: string;
  /** System / instruction prelude (OpenAI only). */
  instructions?: string;
  /** OpenAI reasoning effort override; null = explicitly omit reasoning. */
  reasoningEffort?: ReasoningEffort | null;
  /** OpenAI service tier override (sent on the wire as "priority"/"flex"). */
  serviceTier?: ServiceTier | null;
  /** AbortSignal piped through to the underlying fetch / spawn. */
  signal?: AbortSignal;
}

export interface ResolvedRunPlan {
  provider: AiProvider;
  openaiAccount?: Account;
  cursor?: CursorAccountState;
}

export class AiRouterError extends Error {
  readonly code:
    | "no_default_provider"
    | "openai_no_account"
    | "openai_account_missing"
    | "cursor_not_logged_in"
    | "cursor_not_installed"
    | "provider_unknown";
  constructor(
    code: AiRouterError["code"],
    message: string
  ) {
    super(message);
    this.code = code;
  }
}

export async function resolveRunPlan(req: RunRequest): Promise<ResolvedRunPlan> {
  const settings = readAiSettings();
  const provider: AiProvider = req.provider ?? settings.defaultProvider;

  if (provider === "openai") {
    const store = readStore();
    if (store.accounts.length === 0) {
      throw new AiRouterError(
        "openai_no_account",
        "No ChatGPT account configured. Open Settings to log in."
      );
    }
    const accountId =
      req.accountId ?? settings.defaultOpenAiAccountId ?? null;
    let account: Account | null = accountId
      ? store.accounts.find((a) => a.id === accountId) ?? null
      : null;
    if (!account) account = getDefaultAccount(store);
    if (!account) {
      throw new AiRouterError(
        "openai_account_missing",
        `Requested ChatGPT account ${accountId ?? "(default)"} not found`
      );
    }
    return { provider, openaiAccount: account };
  }

  if (provider === "cursor") {
    const cursor = await getCursorAccountState();
    if (!cursor.installed) {
      throw new AiRouterError(
        "cursor_not_installed",
        cursor.warning ||
          "cursor-agent CLI not found. Install Cursor desktop app first."
      );
    }
    if (!cursor.loggedIn) {
      throw new AiRouterError(
        "cursor_not_logged_in",
        "Cursor is not logged in. Open Settings to authenticate."
      );
    }
    return { provider, cursor };
  }

  throw new AiRouterError("provider_unknown", `Unknown provider: ${provider}`);
}

/**
 * Stream text deltas from the resolved provider. Always async-iterable so
 * callers can `for await (const piece of runAi(...))` regardless of provider.
 *
 * Model resolution order: explicit `req.model` > settings.defaultModel >
 * provider-specific built-in default. Settings are loaded once per invocation
 * so the same value is used for both account routing and model selection.
 */
export async function* runAi(req: RunRequest): AsyncIterable<string> {
  const settings = readAiSettings();
  const plan = await resolveRunPlan(req);
  const model = req.model || settings.defaultModel || undefined;

  if (plan.provider === "openai") {
    const account = plan.openaiAccount!;
    // Reasoning/tier overrides treat `undefined` as "fall back to settings"
    // and `null` as "explicitly omit". This keeps callers expressive without
    // forcing them to read settings themselves.
    const reasoningEffort =
      req.reasoningEffort === undefined ? settings.defaultReasoningEffort : req.reasoningEffort;
    const serviceTier =
      req.serviceTier === undefined ? settings.defaultServiceTier : req.serviceTier;
    yield* streamOpenAi({
      codexHome: account.codexHome,
      prompt: req.prompt,
      model,
      instructions: req.instructions,
      reasoningEffort,
      serviceTier,
      signal: req.signal,
    });
    return;
  }

  if (plan.provider === "cursor") {
    yield* streamCursorAgent({
      prompt: req.prompt,
      model,
      signal: req.signal,
    });
    return;
  }
}

/** Convenience: collect the full streamed text into a single string. */
export async function runAiToString(req: RunRequest): Promise<string> {
  let out = "";
  for await (const piece of runAi(req)) out += piece;
  return out;
}
