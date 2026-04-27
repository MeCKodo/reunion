// Drives `codex login` against an isolated CODEX_HOME so the OAuth handshake
// writes auth.json into Reunion's per-account directory. We rely on the URL
// extraction streamer to surface the browser link to the renderer; the codex
// CLI keeps running until the user finishes auth in the browser.
//
// codex 0.124+ also has a `--device-auth` flow, but spawning device-auth
// produces a code-pair UI rather than an OAuth URL; we stay with the default
// browser flow because the renderer can pop a system browser easily via
// shell.openExternal.

import path from "node:path";

import {
  runAndCapture,
  runWithUrlExtraction,
  type SpawnOptions,
} from "../cli-spawn.js";
import {
  createCodexHome,
  ensureAiDataDirs,
  makeId,
  markLastUsed,
  normalizeAccount,
  readStore,
  removeAccountFromStore,
  removeCodexHome,
  setDefaultAccount,
  updateAccount,
  writeStore,
  type Account,
  type AccountStore,
} from "./accounts.js";
import { loadCredentials, type Credentials } from "./auth.js";
import { checkAccount } from "./usage.js";
import { AI_CODEX_HOMES_DIR } from "../../config.js";

const CODEX_CMD = (process.env.CODEX_CMD || "codex").trim();
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 10_000;

function codexEnv(codexHome: string): NodeJS.ProcessEnv {
  // Strip any user-level OPENAI_API_KEY because it would short-circuit the
  // OAuth flow and leave us with `auth_mode: api_key` instead of `chatgpt`.
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  return env;
}

export async function ensureCodexInstalled(): Promise<{ ok: boolean; error?: string }> {
  const r = await runAndCapture(CODEX_CMD, ["--version"], {
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  if (!r.ok) {
    return {
      ok: false,
      error:
        r.error?.includes("ENOENT") || r.error?.includes("not found")
          ? "codex CLI not found. Install with `brew install codex` or see https://developers.openai.com/codex/"
          : r.error || "codex --version failed",
    };
  }
  return { ok: true };
}

export interface OpenAiLoginEvent {
  type: "url" | "log" | "success" | "error";
  url?: string;
  text?: string;
  error?: string;
  account?: Account;
}

export interface StartOpenAiLoginOptions {
  /**
   * If set, re-uses an existing account directory (relogin scenario). If not
   * set, a fresh account id + codex-home is created.
   */
  accountId?: string;
  label?: string;
  makeDefault?: boolean;
  signal?: AbortSignal;
}

/**
 * Pops `codex login` for the given (or new) account, streams the OAuth URL,
 * waits for the CLI to exit, then refreshes account metadata from the new
 * auth.json (email, plan, accountId, last check).
 */
export async function* startOpenAiLogin(
  options: StartOpenAiLoginOptions = {}
): AsyncIterable<OpenAiLoginEvent> {
  const installed = await ensureCodexInstalled();
  if (!installed.ok) {
    yield { type: "error", error: installed.error };
    return;
  }

  ensureAiDataDirs();
  let store = readStore();
  let accountId = options.accountId;
  let codexHome: string;
  let isNew = false;

  if (accountId) {
    const existing = store.accounts.find((a) => a.id === accountId);
    if (!existing) {
      yield { type: "error", error: `Account ${accountId} not found` };
      return;
    }
    codexHome = existing.codexHome;
  } else {
    accountId = makeId();
    codexHome = createCodexHome(accountId);
    isNew = true;
  }

  const env = codexEnv(codexHome);
  const spawnOptions: SpawnOptions = {
    env,
    timeoutMs: LOGIN_TIMEOUT_MS,
    signal: options.signal,
  };

  let urlEmitted = false;
  let exitCode: number | null = null;
  let firstError: string | null = null;

  try {
    for await (const event of runWithUrlExtraction(
      CODEX_CMD,
      ["login"],
      {
        ...spawnOptions,
        urlPattern:
          /(https:\/\/(?:auth\.openai\.com|chatgpt\.com|platform\.openai\.com)\/[^\s'"<>]+)/g,
      }
    )) {
      switch (event.type) {
        case "url":
          if (!urlEmitted && event.url) {
            urlEmitted = true;
            yield { type: "url", url: event.url };
          }
          break;
        case "stdout":
        case "stderr":
          if (event.text?.trim()) yield { type: "log", text: event.text };
          break;
        case "done":
          exitCode = event.exitCode ?? null;
          break;
        case "error":
          firstError = event.error || "codex login failed";
          break;
      }
    }
  } catch (err) {
    firstError = (err as Error).message;
  }

  if (firstError) {
    if (isNew) cleanupNewAccount(accountId);
    yield { type: "error", error: firstError };
    return;
  }

  if (exitCode !== 0) {
    if (isNew) cleanupNewAccount(accountId);
    yield {
      type: "error",
      error: `codex login exited with code ${exitCode ?? "?"}`,
    };
    return;
  }

  // Login succeeded; harvest metadata from auth.json.
  let credentials: Credentials;
  try {
    credentials = loadCredentials(codexHome);
  } catch (err) {
    if (isNew) cleanupNewAccount(accountId);
    yield {
      type: "error",
      error: `auth.json missing after login: ${(err as Error).message}`,
    };
    return;
  }

  const account: Account = normalizeAccount({
    id: accountId,
    label: options.label || credentials.email || "ChatGPT Account",
    email: credentials.email,
    accountId: credentials.accountId,
    codexHome,
  });

  store = updateAccount(store, account, { makeDefault: options.makeDefault ?? isNew });
  writeStore(store);

  // Best-effort usage check so the UI gets an immediate plan / quota readout.
  try {
    const check = await checkAccount(account);
    const enriched: Account = markLastUsed({
      ...account,
      email: check.account.email,
      accountId: check.account.accountId,
      lastCheck: check.result,
    });
    store = updateAccount(readStore(), enriched);
    writeStore(store);
    yield { type: "success", account: enriched };
  } catch {
    yield { type: "success", account };
  }
}

function cleanupNewAccount(accountId: string): void {
  try {
    const store = readStore();
    if (store.accounts.some((a) => a.id === accountId)) {
      writeStore(removeAccountFromStore(store, accountId));
    }
    removeCodexHome(accountId);
  } catch {
    // best-effort cleanup
  }
}

export function deleteOpenAiAccount(accountId: string): {
  ok: boolean;
  store?: AccountStore;
  error?: string;
} {
  try {
    const store = readStore();
    if (!store.accounts.some((a) => a.id === accountId)) {
      return { ok: false, error: "Account not found" };
    }
    const next = removeAccountFromStore(store, accountId);
    writeStore(next);
    removeCodexHome(accountId);
    return { ok: true, store: next };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function setDefaultOpenAiAccount(accountId: string): {
  ok: boolean;
  store?: AccountStore;
  error?: string;
} {
  try {
    const next = setDefaultAccount(readStore(), accountId);
    writeStore(next);
    return { ok: true, store: next };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function codexHomeFor(accountId: string): string {
  return path.join(AI_CODEX_HOMES_DIR, accountId);
}
