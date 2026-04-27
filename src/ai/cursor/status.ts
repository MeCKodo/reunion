// Wraps `cursor-agent` login state queries. The CLI stores OAuth tokens in
// macOS Keychain so we never read them directly; we only ask the CLI to tell us
// whether the user is logged in and (when possible) which email + plan.
//
// Observed CLI output (cursor-agent 2026.04.17-787b533):
//   $ cursor-agent status
//   ✓ Logged in as huangzheyu@bytedance.com
//
//   $ cursor-agent about
//   About Cursor CLI
//   CLI Version       ...
//   Model             ...
//   Subscription Tier Enterprise
//   User Email        huangzheyu@bytedance.com
//
// `cursor-agent login` opens a browser by default but supports NO_OPEN_BROWSER=1
// which makes it print the OAuth URL on stdout so we can route it through
// shell.openExternal in the renderer.

import { runAndCapture, runWithUrlExtraction, type UrlStreamEvent } from "../cli-spawn.js";

const CURSOR_CMD = (process.env.CURSOR_AGENT_CMD || "cursor-agent").trim();
const STATUS_TIMEOUT_MS = 10_000;
const ABOUT_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGOUT_TIMEOUT_MS = 15_000;

export interface CursorAccountState {
  installed: boolean;
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
  /** Human-readable warning when the CLI is in a half-broken state. */
  warning: string | null;
  /** Raw `cursor-agent status` stdout for debugging in the UI. */
  rawStatus: string | null;
  /** Raw `cursor-agent about` stdout for debugging in the UI. */
  rawAbout: string | null;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function parseAbout(text: string): { email: string | null; plan: string | null } {
  const cleaned = stripAnsi(text);
  const emailMatch = cleaned.match(/^User Email\s+(.+)$/m);
  const planMatch = cleaned.match(/^Subscription Tier\s+(.+)$/m);
  const email = emailMatch ? emailMatch[1].trim() : null;
  const plan = planMatch ? planMatch[1].trim() : null;
  if (email && /not logged in/i.test(email)) return { email: null, plan };
  return { email, plan };
}

function parseStatus(text: string): { loggedIn: boolean; email: string | null } {
  const cleaned = stripAnsi(text);
  if (/logged in as\s+(.+)/i.test(cleaned)) {
    const match = cleaned.match(/logged in as\s+(\S+)/i);
    return { loggedIn: true, email: match ? match[1].trim() : null };
  }
  if (/not logged in|please login|run login/i.test(cleaned)) {
    return { loggedIn: false, email: null };
  }
  return { loggedIn: false, email: null };
}

// Cursor state querying spawns 1-2 cursor-agent subprocesses (~3.9s on a warm
// machine). The state itself only changes on login/logout, but we re-read the
// snapshot after every settings mutation. Cache for ~60s and require explicit
// invalidation on login/logout to keep PUT /api/ai/settings fast.
const CURSOR_STATE_TTL_MS = 60_000;

interface CursorCacheEntry {
  state: CursorAccountState;
  fetchedAt: number;
}

let cursorCache: CursorCacheEntry | null = null;
let inflightCursorQuery: Promise<CursorAccountState> | null = null;

/** Mark the cached cursor state as stale (call after login/logout). */
export function invalidateCursorCache(): void {
  cursorCache = null;
  inflightCursorQuery = null;
}

async function fetchCursorAccountState(): Promise<CursorAccountState> {
  const status = await runAndCapture(CURSOR_CMD, ["status"], {
    timeoutMs: STATUS_TIMEOUT_MS,
  });

  if (status.error && (status.error.includes("ENOENT") || status.error.includes("not found"))) {
    return {
      installed: false,
      loggedIn: false,
      email: null,
      plan: null,
      warning: "cursor-agent CLI not found. Install Cursor desktop app first.",
      rawStatus: null,
      rawAbout: null,
    };
  }

  const statusText = `${status.stdout}\n${status.stderr}`;
  const { loggedIn, email: statusEmail } = parseStatus(statusText);

  if (!loggedIn) {
    return {
      installed: true,
      loggedIn: false,
      email: null,
      plan: null,
      warning: null,
      rawStatus: status.stdout || null,
      rawAbout: null,
    };
  }

  const about = await runAndCapture(CURSOR_CMD, ["about"], {
    timeoutMs: ABOUT_TIMEOUT_MS,
  });
  const aboutText = `${about.stdout}\n${about.stderr}`;
  const { email: aboutEmail, plan } = parseAbout(aboutText);
  const email = aboutEmail || statusEmail;

  let warning: string | null = null;
  if (!email) {
    warning =
      "Cursor reports a login session but cannot fetch account details. The OAuth token may be expired — try logging out and back in.";
  }

  return {
    installed: true,
    loggedIn: true,
    email,
    plan,
    warning,
    rawStatus: status.stdout || null,
    rawAbout: about.stdout || null,
  };
}

export interface CursorStateOptions {
  /** Bypass the cache and always re-spawn cursor-agent. */
  forceRefresh?: boolean;
}

export async function getCursorAccountState(
  opts: CursorStateOptions = {}
): Promise<CursorAccountState> {
  // Cache hit: return the already-known state in <1ms.
  if (!opts.forceRefresh && cursorCache) {
    const ageMs = Date.now() - cursorCache.fetchedAt;
    if (ageMs < CURSOR_STATE_TTL_MS) {
      return cursorCache.state;
    }
  }

  // Coalesce concurrent callers (e.g. SettingsDialog opens and the user
  // immediately clicks "Set provider") onto one in-flight CLI invocation
  // instead of spawning the same query twice.
  if (!opts.forceRefresh && inflightCursorQuery) {
    return inflightCursorQuery;
  }

  inflightCursorQuery = fetchCursorAccountState()
    .then((state) => {
      cursorCache = { state, fetchedAt: Date.now() };
      return state;
    })
    .finally(() => {
      inflightCursorQuery = null;
    });
  return inflightCursorQuery;
}

export interface CursorLoginEvent {
  type: "url" | "log" | "success" | "error";
  url?: string;
  text?: string;
  error?: string;
  account?: CursorAccountState;
}

/**
 * Trigger `cursor-agent login` with NO_OPEN_BROWSER=1 so we can intercept the
 * OAuth URL. The CLI keeps running until the user finishes auth in the
 * browser; once it exits cleanly we re-query account state and emit success.
 */
export async function* startCursorLogin(): AsyncIterable<CursorLoginEvent> {
  const env = { ...process.env, NO_OPEN_BROWSER: "1" };

  let urlEmitted = false;
  let exitCode: number | null = null;

  for await (const event of runWithUrlExtraction(CURSOR_CMD, ["login"], {
    env,
    timeoutMs: LOGIN_TIMEOUT_MS,
    urlPattern: /(https:\/\/(?:cursor\.com|api2\.cursor\.sh)\/[^\s'"<>]+)/g,
  })) {
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
        yield { type: "error", error: event.error || "cursor-agent login failed" };
        return;
    }
  }

  if (exitCode !== 0) {
    yield {
      type: "error",
      error: `cursor-agent login exited with code ${exitCode ?? "?"}`,
    };
    return;
  }

  invalidateCursorCache();
  const account = await getCursorAccountState({ forceRefresh: true });
  yield { type: "success", account };
}

export async function logoutCursor(): Promise<{ ok: boolean; error?: string }> {
  const r = await runAndCapture(CURSOR_CMD, ["logout"], {
    timeoutMs: LOGOUT_TIMEOUT_MS,
  });
  if (!r.ok) {
    return { ok: false, error: r.error || "logout failed" };
  }
  invalidateCursorCache();
  return { ok: true };
}

export interface CursorModel {
  id: string;
  label: string;
  /** True when the CLI itself marked this model as the account default. */
  isDefault: boolean;
}

const MODELS_TIMEOUT_MS = 15_000;

/**
 * Parse `cursor-agent --list-models` output into a flat list of options. The
 * CLI prints one entry per line in the form `id - Pretty label`; the default
 * row is suffixed with `(default)`.
 */
export function parseCursorModels(text: string): CursorModel[] {
  const cleaned = stripAnsi(text);
  const out: CursorModel[] = [];
  for (const raw of cleaned.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^available models$/i.test(line)) continue;
    const match = line.match(/^([a-zA-Z0-9_.\-]+)\s+-\s+(.+?)$/);
    if (!match) continue;
    const id = match[1];
    let label = match[2].trim();
    let isDefault = false;
    const defaultMatch = label.match(/^(.*)\s*\(default\)\s*$/i);
    if (defaultMatch) {
      label = defaultMatch[1].trim();
      isDefault = true;
    }
    out.push({ id, label, isDefault });
  }
  return out;
}

export async function listCursorModels(): Promise<CursorModel[]> {
  const r = await runAndCapture(CURSOR_CMD, ["--list-models"], {
    timeoutMs: MODELS_TIMEOUT_MS,
  });
  if (!r.ok) return [];
  return parseCursorModels(`${r.stdout}\n${r.stderr}`);
}
