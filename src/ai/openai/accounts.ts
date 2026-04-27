// Adapted from gpt-usage-checker (@kodo/agent-meter) src/core/accounts.ts.
// Manages multiple ChatGPT accounts by giving each one a private CODEX_HOME
// under <DATA_DIR>/ai/codex-homes/<accountId>/. The store metadata lives in
// <DATA_DIR>/ai/openai-accounts.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AI_CODEX_HOMES_DIR,
  AI_DATA_DIR,
  AI_OPENAI_ACCOUNTS_FILE,
} from "../../config.js";

export type SourceUsed = "oauth";

export interface LastCheck {
  ok: boolean;
  planType: string | null;
  primaryUsedPercent: number | null;
  primaryRemainingPercent: number | null;
  primaryResetAt: string | null;
  secondaryUsedPercent: number | null;
  secondaryRemainingPercent: number | null;
  secondaryResetAt: string | null;
  creditsBalance: number | null;
  creditsUnlimited: boolean | null;
  sourceUsed: SourceUsed;
  checkedAt: string;
  elapsedMs: number;
  error: string | null;
}

export interface Account {
  id: string;
  label: string;
  email: string | null;
  accountId: string | null;
  codexHome: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastCheck: LastCheck | null;
}

export interface AccountStore {
  version: number;
  defaultAccountId: string | null;
  accounts: Account[];
}

const STORE_VERSION = 1;
const PRIMARY_CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");

function hasConfigContent(value: string | null): boolean {
  return Boolean(value && value.trim().length > 0);
}

export function ensureAiDataDirs(): void {
  fs.mkdirSync(AI_DATA_DIR, { recursive: true });
  fs.mkdirSync(AI_CODEX_HOMES_DIR, { recursive: true });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeLastCheck(lastCheck: unknown): LastCheck | null {
  if (!lastCheck || typeof lastCheck !== "object") return null;
  const input = lastCheck as Record<string, unknown>;
  return {
    ok: Boolean(input.ok),
    planType: typeof input.planType === "string" ? input.planType : null,
    primaryUsedPercent: numberOrNull(input.primaryUsedPercent),
    primaryRemainingPercent: numberOrNull(input.primaryRemainingPercent),
    primaryResetAt: typeof input.primaryResetAt === "string" ? input.primaryResetAt : null,
    secondaryUsedPercent: numberOrNull(input.secondaryUsedPercent),
    secondaryRemainingPercent: numberOrNull(input.secondaryRemainingPercent),
    secondaryResetAt:
      typeof input.secondaryResetAt === "string" ? input.secondaryResetAt : null,
    creditsBalance: numberOrNull(input.creditsBalance),
    creditsUnlimited: input.creditsUnlimited == null ? null : Boolean(input.creditsUnlimited),
    sourceUsed: "oauth",
    checkedAt: typeof input.checkedAt === "string" ? input.checkedAt : nowIso(),
    elapsedMs: numberOrNull(input.elapsedMs) ?? 0,
    error: typeof input.error === "string" ? input.error : null,
  };
}

export function normalizeAccount(
  account: Partial<Account> & { id: string; codexHome: string }
): Account {
  return {
    id: String(account.id),
    label: account.label?.trim() || "ChatGPT Account",
    email: account.email ?? null,
    accountId: account.accountId ?? null,
    codexHome: account.codexHome,
    createdAt: account.createdAt || nowIso(),
    lastUsedAt: account.lastUsedAt ?? null,
    lastCheck: normalizeLastCheck(account.lastCheck),
  };
}

function migrateStore(raw: unknown): AccountStore {
  if (Array.isArray(raw)) {
    const accounts = raw
      .filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object"
      )
      .filter(
        (item) => typeof item.id === "string" && typeof item.codexHome === "string"
      )
      .map((item) =>
        normalizeAccount({
          id: item.id as string,
          label: typeof item.label === "string" ? item.label : "ChatGPT Account",
          email: typeof item.email === "string" ? item.email : null,
          accountId: typeof item.accountId === "string" ? item.accountId : null,
          codexHome: item.codexHome as string,
          createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso(),
          lastUsedAt: typeof item.lastUsedAt === "string" ? item.lastUsedAt : null,
          lastCheck: item.lastCheck as LastCheck | null | undefined,
        })
      );
    return {
      version: STORE_VERSION,
      defaultAccountId: accounts[0]?.id ?? null,
      accounts,
    };
  }

  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const accounts = Array.isArray(input.accounts)
    ? input.accounts
        .filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object"
        )
        .filter(
          (item) => typeof item.id === "string" && typeof item.codexHome === "string"
        )
        .map((item) =>
          normalizeAccount({
            id: item.id as string,
            label: typeof item.label === "string" ? item.label : "ChatGPT Account",
            email: typeof item.email === "string" ? item.email : null,
            accountId: typeof item.accountId === "string" ? item.accountId : null,
            codexHome: item.codexHome as string,
            createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso(),
            lastUsedAt: typeof item.lastUsedAt === "string" ? item.lastUsedAt : null,
            lastCheck: item.lastCheck as LastCheck | null | undefined,
          })
        )
    : [];

  const defaultAccountId =
    typeof input.defaultAccountId === "string" ? input.defaultAccountId : null;
  return {
    version: STORE_VERSION,
    defaultAccountId: accounts.some((account) => account.id === defaultAccountId)
      ? defaultAccountId
      : accounts[0]?.id ?? null,
    accounts,
  };
}

export function readStore(): AccountStore {
  ensureAiDataDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(AI_OPENAI_ACCOUNTS_FILE, "utf8")) as unknown;
    return migrateStore(raw);
  } catch {
    return {
      version: STORE_VERSION,
      defaultAccountId: null,
      accounts: [],
    };
  }
}

export function writeStore(store: AccountStore): void {
  ensureAiDataDirs();
  const normalized: AccountStore = {
    version: STORE_VERSION,
    defaultAccountId: store.defaultAccountId,
    accounts: store.accounts.map((account) => normalizeAccount(account)),
  };
  const tmp = `${AI_OPENAI_ACCOUNTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2));
  fs.renameSync(tmp, AI_OPENAI_ACCOUNTS_FILE);
}

export function createCodexHome(accountId: string): string {
  ensureAiDataDirs();
  const codexHome = path.join(AI_CODEX_HOMES_DIR, accountId);
  fs.mkdirSync(codexHome, { recursive: true });
  ensureCodexConfigInitialized(codexHome);
  return codexHome;
}

export function ensureCodexConfigInitialized(codexHome: string): void {
  fs.mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;

  if (hasConfigContent(current)) {
    return;
  }

  if (!fs.existsSync(PRIMARY_CODEX_CONFIG)) {
    if (current == null) {
      fs.writeFileSync(configPath, "");
    }
    return;
  }

  const source = fs.readFileSync(PRIMARY_CODEX_CONFIG, "utf8");
  if (current == null || !hasConfigContent(current)) {
    fs.writeFileSync(configPath, source);
  }
}

export function updateAccount(
  store: AccountStore,
  nextAccount: Account,
  options: { makeDefault?: boolean } = {}
): AccountStore {
  const existingIndex = store.accounts.findIndex(
    (account) => account.id === nextAccount.id
  );
  const accounts = [...store.accounts];
  if (existingIndex >= 0) {
    accounts[existingIndex] = normalizeAccount(nextAccount);
  } else {
    accounts.push(normalizeAccount(nextAccount));
  }

  const defaultAccountId = options.makeDefault
    ? nextAccount.id
    : store.defaultAccountId ?? accounts[0]?.id ?? null;

  return {
    version: STORE_VERSION,
    defaultAccountId,
    accounts,
  };
}

export function markLastUsed(account: Account, at = nowIso()): Account {
  return {
    ...account,
    lastUsedAt: at,
  };
}

export function getDefaultAccount(store: AccountStore): Account | null {
  if (store.accounts.length === 0) return null;
  return (
    store.accounts.find((account) => account.id === store.defaultAccountId) ??
    store.accounts[0] ??
    null
  );
}

export function setDefaultAccount(
  store: AccountStore,
  accountId: string
): AccountStore {
  if (!store.accounts.some((account) => account.id === accountId)) {
    throw new Error("Account not found");
  }
  return {
    ...store,
    defaultAccountId: accountId,
  };
}

export function removeAccountFromStore(
  store: AccountStore,
  accountId: string
): AccountStore {
  const accountExists = store.accounts.some((account) => account.id === accountId);
  if (!accountExists) {
    throw new Error("Account not found");
  }

  const accounts = store.accounts.filter((account) => account.id !== accountId);
  let defaultAccountId = store.defaultAccountId;
  if (defaultAccountId === accountId) {
    const nextDefault = [...accounts].sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })[0];
    defaultAccountId = nextDefault?.id ?? null;
  }

  return {
    version: STORE_VERSION,
    defaultAccountId,
    accounts,
  };
}

export function removeCodexHome(accountId: string): void {
  const codexHome = path.join(AI_CODEX_HOMES_DIR, accountId);
  fs.rmSync(codexHome, { recursive: true, force: true });
}
