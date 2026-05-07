// Persistence + factory for the active DataSourceProvider.
//
// Team-mode wiring (baseUrl + token) is **compile-time configuration** —
// see `TEAM_INGEST_URL` / `TEAM_INGEST_TOKEN` in `src/config.ts`. The user
// never types it, so we don't persist it either. The only state we keep on
// disk is `data/app-mode.json` recording the current toggle position
// (`personal` / `team`); team-config.json is no longer written, but legacy
// files from older builds are tolerated and ignored.
//
// On startup the http-server calls `loadActiveProvider(roots)` which:
//   1. reads app-mode.json (default `personal`)
//   2. if `team`, constructs RemoteDataProvider against the built-in URL/token
//      WITHOUT performing a health check (we don't want to delay startup)
//   3. returns the provider plus optional `lastError`
//
// `applyMode(...)` is the single entry for `POST /api/mode`. It now only
// validates {mode}, runs a trial `GET /repos` when flipping to team, then
// atomically updates app-mode.json. No teamConfig parameter.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
  getEdition,
  TEAM_INGEST_TOKEN,
  TEAM_INGEST_URL,
} from "../config.js";
import { ensureDataDir } from "../lib/fs.js";
import { LocalDataProvider } from "./local.js";
import {
  RemoteAuthError,
  RemoteDataProvider,
  RemoteUnreachableError,
} from "./remote.js";
import type { AppMode, SourceRoots } from "../types.js";
import type { DataSourceProvider } from "./types.js";

const APP_MODE_FILE = path.join(DATA_DIR, "app-mode.json");
// Kept around purely so we know whether to surface a "stale config detected"
// hint when migrating older installations. We never read its contents.
const LEGACY_TEAM_CONFIG_FILE = path.join(DATA_DIR, "team-config.json");

export type StoredAppMode = {
  mode: AppMode;
  lastError?: string;
};

export type ActiveProviderState = {
  mode: AppMode;
  provider: DataSourceProvider;
  /** True iff the current mode is `team` and the provider was built. */
  teamConfigPresent: boolean;
  lastError?: string;
};

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readAppMode(): Promise<StoredAppMode> {
  const parsed = await readJsonFile<StoredAppMode>(APP_MODE_FILE);
  if (!parsed) return { mode: "personal" };
  if (parsed.mode !== "team" && parsed.mode !== "personal") return { mode: "personal" };
  return { mode: parsed.mode, lastError: parsed.lastError };
}

async function writeJsonAtomic(
  filePath: string,
  payload: unknown,
  mode = 0o600
): Promise<void> {
  await ensureDataDir();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode });
  await fs.rename(tmpPath, filePath);
}

/** Public for tests. */
export async function getStoredMode(): Promise<StoredAppMode> {
  return readAppMode();
}

/**
 * Built-in team-mode wiring resolved at startup. Shared so http-server can
 * surface the URL (not the token) in `GET /api/mode` for diagnostics.
 */
export function teamWiring(): { baseUrl: string; tokenConfigured: boolean } {
  return {
    baseUrl: TEAM_INGEST_URL,
    tokenConfigured: Boolean(TEAM_INGEST_TOKEN && TEAM_INGEST_TOKEN !== "REPLACE_ME_WITH_TEAM_SECRET"),
  };
}

/**
 * Build the right provider for the current persisted mode. Falls back to
 * personal mode if team-mode initialization throws; the failure reason
 * propagates back to `GET /api/mode` via `lastError`.
 */
export async function loadActiveProvider(roots: SourceRoots): Promise<ActiveProviderState> {
  const stored = await readAppMode();

  if (stored.mode === "team") {
    try {
      const provider = new RemoteDataProvider({
        baseUrl: TEAM_INGEST_URL,
        token: TEAM_INGEST_TOKEN,
      });
      return {
        mode: "team",
        provider,
        teamConfigPresent: true,
        lastError: stored.lastError,
      };
    } catch (error) {
      return {
        mode: "personal",
        provider: new LocalDataProvider(roots),
        teamConfigPresent: false,
        lastError: `team provider init failed: ${(error as Error).message}`,
      };
    }
  }

  return {
    mode: "personal",
    provider: new LocalDataProvider(roots),
    teamConfigPresent: false,
  };
}

export type ApplyModeArgs = { mode: AppMode };

export type ApplyModeError =
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 401; error: string }
  | { ok: false; status: 502; error: string }
  | { ok: false; status: 500; error: string };

export type ApplyModeResult =
  | { ok: true; mode: AppMode; provider: DataSourceProvider; teamConfigPresent: boolean }
  | ApplyModeError;

function isHttpsOrLocalUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol === "https:") return true;
    // Allow http only for localhost — bearer tokens should never traverse a
    // shared LAN in plain text. The compile-time PROD_INGEST_URL must be
    // https://; this guard catches an accidentally-shipped http:// build.
    if (url.protocol === "http:") {
      return url.hostname === "localhost" || url.hostname === "127.0.0.1";
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Validate, trial, and persist a mode switch. Returns the freshly built
 * provider on success so the caller can swap it into the running server
 * without restarting.
 */
export async function applyMode(
  args: ApplyModeArgs,
  roots: SourceRoots
): Promise<ApplyModeResult> {
  if (args.mode === "personal") {
    try {
      await writeJsonAtomic(APP_MODE_FILE, { mode: "personal" }, 0o644);
    } catch (error) {
      return {
        ok: false,
        status: 500,
        error: `failed to persist mode: ${(error as Error).message}`,
      };
    }
    return {
      ok: true,
      mode: "personal",
      provider: new LocalDataProvider(roots),
      teamConfigPresent: false,
    };
  }

  // mode === "team": always built from compile-time defaults. The trial call
  // catches "wrong/expired secret in this build" and "network unreachable"
  // before we flip the persisted mode, so the next startup doesn't get stuck
  // in a broken team mode.
  //
  // Edition gate FIRST. Personal-edition bundles must refuse `mode=team`
  // before any network I/O — even if the frontend is bypassed (curl, MITM)
  // we never want a personal build to actually contact a team backend.
  if (getEdition() !== "team") {
    return {
      ok: false,
      status: 403,
      error: "team mode is not available in this edition",
    };
  }
  if (!TEAM_INGEST_URL || !TEAM_INGEST_TOKEN) {
    return {
      ok: false,
      status: 500,
      error: "team mode is not configured in this build",
    };
  }
  if (!isHttpsOrLocalUrl(TEAM_INGEST_URL)) {
    return {
      ok: false,
      status: 500,
      error: `built-in baseUrl is invalid: ${TEAM_INGEST_URL}`,
    };
  }

  const provider = new RemoteDataProvider({
    baseUrl: TEAM_INGEST_URL,
    token: TEAM_INGEST_TOKEN,
  });

  try {
    await provider.listRepos();
  } catch (error) {
    if (error instanceof RemoteAuthError) {
      return { ok: false, status: 401, error: "ingest rejected the bearer token" };
    }
    if (error instanceof RemoteUnreachableError) {
      return { ok: false, status: 502, error: error.message };
    }
    return {
      ok: false,
      status: 502,
      error: `trial request failed: ${(error as Error).message}`,
    };
  }

  try {
    await writeJsonAtomic(APP_MODE_FILE, { mode: "team" }, 0o644);
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: `failed to persist mode: ${(error as Error).message}`,
    };
  }

  return {
    ok: true,
    mode: "team",
    provider,
    teamConfigPresent: true,
  };
}

/** For tests / dev tooling. */
export const __testing__ = {
  APP_MODE_FILE,
  LEGACY_TEAM_CONFIG_FILE,
};
