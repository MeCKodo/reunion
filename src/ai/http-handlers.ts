// HTTP route handlers for /api/ai/*. Mounted from src/http-server.ts.
//
// Streaming endpoints (login flows + run) speak Server-Sent Events so the
// frontend can use the same fetch-+-ReadableStream loop already used elsewhere
// in the codebase.

import { IncomingMessage, ServerResponse } from "node:http";

import { json, readJsonBody } from "../lib/http.js";
import {
  deleteOpenAiAccount,
  setDefaultOpenAiAccount,
  startOpenAiLogin,
} from "./openai/codex-login.js";
import {
  ensureAiDataDirs,
  getDefaultAccount,
  readStore,
  type Account,
  type AccountStore,
} from "./openai/accounts.js";
import { checkAccount } from "./openai/usage.js";
import {
  getCursorAccountState,
  listCursorModels,
  logoutCursor,
  startCursorLogin,
  type CursorAccountState,
  type CursorModel,
} from "./cursor/status.js";
import { runAi, AiRouterError } from "./router.js";
import {
  readAiSettings,
  updateAiSettings,
  REASONING_EFFORTS,
  SERVICE_TIERS,
  type AiProvider,
  type ReasoningEffort,
  type ServiceTier,
} from "./settings.js";

// Curated OpenAI/codex models. The chatgpt.com codex backend only accepts a
// fixed set of bare names, so we ship them as a static list rather than
// querying the API. Order = recommended top-to-bottom.
//
// `supportsReasoning` mirrors codex-rs `ModelInfo.supports_reasoning_summaries`:
// reasoning is only honored on the gpt-5.5 family (codex backend silently
// drops the field for non-reasoning models, so this is purely a UX hint).
interface OpenAiModelOption extends CursorModel {
  supportsReasoning: boolean;
}
const OPENAI_MODELS: ReadonlyArray<OpenAiModelOption> = [
  { id: "gpt-5.5", label: "GPT-5.5 (default)", isDefault: true, supportsReasoning: true },
  { id: "gpt-5.5-codex", label: "GPT-5.5 Codex", isDefault: false, supportsReasoning: true },
  { id: "gpt-5.4", label: "GPT-5.4", isDefault: false, supportsReasoning: false },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", isDefault: false, supportsReasoning: false },
  { id: "gpt-5.4-codex", label: "GPT-5.4 Codex", isDefault: false, supportsReasoning: true },
];

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function openSse(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

function sendSse(res: ServerResponse, event: string, data: unknown): void {
  if (res.destroyed) return;
  const payload = JSON.stringify(data);
  res.write(`event: ${event}\n`);
  res.write(`data: ${payload}\n\n`);
}

function endSse(res: ServerResponse): void {
  if (res.destroyed) return;
  try {
    res.write("event: end\ndata: {}\n\n");
    res.end();
  } catch {
    // ignore close races
  }
}

function abortSignalFromReq(req: IncomingMessage): AbortSignal {
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  return ac.signal;
}

// ---------------------------------------------------------------------------
// shape -> JSON
// ---------------------------------------------------------------------------

function publicAccount(a: Account) {
  return {
    id: a.id,
    label: a.label,
    email: a.email,
    accountId: a.accountId,
    createdAt: a.createdAt,
    lastUsedAt: a.lastUsedAt,
    lastCheck: a.lastCheck,
  };
}

function publicCursor(state: CursorAccountState) {
  return {
    installed: state.installed,
    loggedIn: state.loggedIn,
    email: state.email,
    plan: state.plan,
    warning: state.warning,
  };
}

interface BuildSnapshotOptions {
  /** Bypass the cursor-state cache; pass `true` after login/logout. */
  refreshCursor?: boolean;
}

async function buildAccountsSnapshot(opts: BuildSnapshotOptions = {}) {
  ensureAiDataDirs();
  const store = readStore();
  const settings = readAiSettings();
  const cursor = await getCursorAccountState({ forceRefresh: opts.refreshCursor });
  const defaultAccount = getDefaultAccount(store);
  return {
    settings: {
      defaultProvider: settings.defaultProvider,
      defaultOpenAiAccountId:
        settings.defaultOpenAiAccountId ?? defaultAccount?.id ?? null,
      defaultModel: settings.defaultModel,
      defaultReasoningEffort: settings.defaultReasoningEffort,
      defaultServiceTier: settings.defaultServiceTier,
    },
    openai: {
      accounts: store.accounts.map(publicAccount),
      defaultAccountId: store.defaultAccountId,
    },
    cursor: publicCursor(cursor),
  };
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------

export async function handleAiAccounts(req: IncomingMessage, res: ServerResponse) {
  // Allow callers to bust the cursor cache when they suspect external state
  // changed (e.g. user ran `cursor-agent logout` from a terminal). Default
  // path stays cached so the SettingsDialog opens instantly.
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const refreshCursor = url.searchParams.get("refresh") === "1";
  const snapshot = await buildAccountsSnapshot({ refreshCursor });
  json(res, 200, snapshot);
}

export async function handleAiSetDefault(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody<{
    provider?: AiProvider;
    openaiAccountId?: string;
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    serviceTier?: ServiceTier | null;
  }>(req, {});
  const patch: Parameters<typeof updateAiSettings>[0] = {};
  if (body.provider === "openai" || body.provider === "cursor") {
    patch.defaultProvider = body.provider;
  }
  if (typeof body.openaiAccountId === "string") {
    patch.defaultOpenAiAccountId = body.openaiAccountId;
    if (!patch.defaultProvider) patch.defaultProvider = "openai";
  }
  if (body.model === null || typeof body.model === "string") {
    patch.defaultModel = body.model;
  }
  if (body.reasoningEffort === null) {
    patch.defaultReasoningEffort = null;
  } else if (
    typeof body.reasoningEffort === "string" &&
    REASONING_EFFORTS.includes(body.reasoningEffort)
  ) {
    patch.defaultReasoningEffort = body.reasoningEffort;
  }
  if (body.serviceTier === null) {
    patch.defaultServiceTier = null;
  } else if (
    typeof body.serviceTier === "string" &&
    SERVICE_TIERS.includes(body.serviceTier)
  ) {
    patch.defaultServiceTier = body.serviceTier;
  }
  updateAiSettings(patch);
  json(res, 200, await buildAccountsSnapshot());
}

export async function handleAiOpenAiLogin(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const accountId = url.searchParams.get("accountId") || undefined;
  const label = url.searchParams.get("label") || undefined;
  const makeDefault = url.searchParams.get("makeDefault") === "1";

  openSse(res);
  const signal = abortSignalFromReq(req);
  try {
    for await (const event of startOpenAiLogin({
      accountId,
      label,
      makeDefault,
      signal,
    })) {
      switch (event.type) {
        case "url":
          sendSse(res, "url", { url: event.url });
          break;
        case "log":
          sendSse(res, "log", { text: event.text });
          break;
        case "success":
          sendSse(res, "success", {
            account: event.account ? publicAccount(event.account) : null,
            snapshot: await buildAccountsSnapshot(),
          });
          break;
        case "error":
          sendSse(res, "error", { error: event.error });
          break;
      }
    }
  } catch (err) {
    sendSse(res, "error", { error: (err as Error).message });
  }
  endSse(res);
}

export async function handleAiOpenAiDelete(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const accountId = decodeURIComponent(
    url.pathname.replace("/api/ai/openai/accounts/", "")
  );
  if (!accountId) {
    json(res, 400, { ok: false, error: "missing accountId" });
    return;
  }
  const r = deleteOpenAiAccount(accountId);
  if (!r.ok) {
    json(res, 400, { ok: false, error: r.error });
    return;
  }
  json(res, 200, { ok: true, snapshot: await buildAccountsSnapshot() });
}

export async function handleAiOpenAiSetDefault(
  req: IncomingMessage,
  res: ServerResponse
) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const accountId = decodeURIComponent(
    url.pathname.replace("/api/ai/openai/accounts/", "").replace("/default", "")
  );
  const r = setDefaultOpenAiAccount(accountId);
  if (!r.ok) {
    json(res, 400, { ok: false, error: r.error });
    return;
  }
  updateAiSettings({ defaultProvider: "openai", defaultOpenAiAccountId: accountId });
  json(res, 200, { ok: true, snapshot: await buildAccountsSnapshot() });
}

export async function handleAiOpenAiRefresh(
  req: IncomingMessage,
  res: ServerResponse
) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const accountId = decodeURIComponent(
    url.pathname.replace("/api/ai/openai/accounts/", "").replace("/refresh", "")
  );
  const store = readStore();
  const account = store.accounts.find((a) => a.id === accountId);
  if (!account) {
    json(res, 404, { ok: false, error: "account not found" });
    return;
  }
  const result = await checkAccount(account);
  // persist refreshed metadata
  const next: AccountStore = {
    ...store,
    accounts: store.accounts.map((a) =>
      a.id === accountId
        ? { ...a, email: result.account.email, accountId: result.account.accountId, lastCheck: result.result }
        : a
    ),
  };
  // write store via accounts module
  const { writeStore } = await import("./openai/accounts.js");
  writeStore(next);
  json(res, 200, { ok: true, snapshot: await buildAccountsSnapshot() });
}

export async function handleAiCursorLogin(req: IncomingMessage, res: ServerResponse) {
  openSse(res);
  try {
    for await (const event of startCursorLogin()) {
      switch (event.type) {
        case "url":
          sendSse(res, "url", { url: event.url });
          break;
        case "log":
          sendSse(res, "log", { text: event.text });
          break;
        case "success":
          sendSse(res, "success", {
            cursor: event.account ? publicCursor(event.account) : null,
            snapshot: await buildAccountsSnapshot({ refreshCursor: true }),
          });
          break;
        case "error":
          sendSse(res, "error", { error: event.error });
          break;
      }
    }
  } catch (err) {
    sendSse(res, "error", { error: (err as Error).message });
  }
  endSse(res);
}

export async function handleAiCursorLogout(_req: IncomingMessage, res: ServerResponse) {
  const r = await logoutCursor();
  if (!r.ok) {
    json(res, 500, { ok: false, error: r.error });
    return;
  }
  json(res, 200, {
    ok: true,
    snapshot: await buildAccountsSnapshot({ refreshCursor: true }),
  });
}

export async function handleAiModels(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const providerParam = url.searchParams.get("provider");
  const provider: AiProvider =
    providerParam === "openai" || providerParam === "cursor"
      ? providerParam
      : readAiSettings().defaultProvider;

  if (provider === "openai") {
    // Capabilities live alongside the model list so the frontend can render
    // a single fetch's worth of UI (model dropdown + reasoning radio + tier
    // radio) without any extra round-trips.
    json(res, 200, {
      provider,
      models: OPENAI_MODELS,
      capabilities: {
        reasoningEfforts: REASONING_EFFORTS,
        serviceTiers: SERVICE_TIERS,
      },
    });
    return;
  }

  // cursor — query the CLI live so we surface exactly the models the user has
  // access to under their plan.
  try {
    const models = await listCursorModels();
    json(res, 200, { provider, models, capabilities: null });
  } catch (err) {
    json(res, 200, {
      provider,
      models: [] as CursorModel[],
      capabilities: null,
      warning: (err as Error).message,
    });
  }
}

export async function handleAiRun(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody<{
    prompt?: string;
    provider?: AiProvider;
    accountId?: string;
    model?: string;
    instructions?: string;
    reasoningEffort?: ReasoningEffort | null;
    serviceTier?: ServiceTier | null;
  }>(req, {});

  const prompt = body.prompt?.trim();
  if (!prompt) {
    json(res, 400, { error: "prompt is required" });
    return;
  }

  openSse(res);
  const signal = abortSignalFromReq(req);

  // Validate enum values; an unknown string should fall back to settings
  // rather than be silently sent to the wire (which could trigger 400 from
  // the upstream API and a confusing error toast for the user).
  const reasoningEffort =
    body.reasoningEffort === null
      ? null
      : typeof body.reasoningEffort === "string" &&
          REASONING_EFFORTS.includes(body.reasoningEffort)
        ? body.reasoningEffort
        : undefined;
  const serviceTier =
    body.serviceTier === null
      ? null
      : typeof body.serviceTier === "string" && SERVICE_TIERS.includes(body.serviceTier)
        ? body.serviceTier
        : undefined;

  try {
    for await (const piece of runAi({
      prompt,
      provider: body.provider,
      accountId: body.accountId,
      model: body.model,
      instructions: body.instructions,
      reasoningEffort,
      serviceTier,
      signal,
    })) {
      sendSse(res, "delta", { text: piece });
    }
    sendSse(res, "done", {});
  } catch (err) {
    if (err instanceof AiRouterError) {
      sendSse(res, "error", { code: err.code, error: err.message });
    } else {
      sendSse(res, "error", { error: (err as Error).message });
    }
  }
  endSse(res);
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export async function dispatchAi(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const { pathname } = url;
  const method = req.method || "GET";

  if (!pathname.startsWith("/api/ai/")) return false;

  if (method === "GET" && pathname === "/api/ai/accounts") {
    await handleAiAccounts(req, res);
    return true;
  }
  if (method === "GET" && pathname === "/api/ai/models") {
    await handleAiModels(req, res);
    return true;
  }
  if (method === "PUT" && pathname === "/api/ai/settings") {
    await handleAiSetDefault(req, res);
    return true;
  }
  if (method === "POST" && pathname === "/api/ai/openai/login") {
    await handleAiOpenAiLogin(req, res);
    return true;
  }
  if (
    method === "POST" &&
    /^\/api\/ai\/openai\/accounts\/[^/]+\/default$/.test(pathname)
  ) {
    await handleAiOpenAiSetDefault(req, res);
    return true;
  }
  if (
    method === "POST" &&
    /^\/api\/ai\/openai\/accounts\/[^/]+\/refresh$/.test(pathname)
  ) {
    await handleAiOpenAiRefresh(req, res);
    return true;
  }
  if (
    method === "DELETE" &&
    /^\/api\/ai\/openai\/accounts\/[^/]+$/.test(pathname)
  ) {
    await handleAiOpenAiDelete(req, res);
    return true;
  }
  if (method === "POST" && pathname === "/api/ai/cursor/login") {
    await handleAiCursorLogin(req, res);
    return true;
  }
  if (method === "POST" && pathname === "/api/ai/cursor/logout") {
    await handleAiCursorLogout(req, res);
    return true;
  }
  if (method === "POST" && pathname === "/api/ai/run") {
    await handleAiRun(req, res);
    return true;
  }
  return false;
}
