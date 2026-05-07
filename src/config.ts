import path from "node:path";

// PROJECT_ROOT defaults to process.cwd() so the CLI workflow keeps working.
// In an Electron build the renderer/main process injects absolute overrides
// before importing this module so we point at userData / resourcesPath instead
// of the read-only app.asar bundle.
export const PROJECT_ROOT = path.resolve(process.cwd());

const DATA_DIR_OVERRIDE = process.env.REUNION_DATA_DIR;
const FRONTEND_DIST_OVERRIDE = process.env.REUNION_FRONTEND_DIST_DIR;
const LEGACY_STATIC_OVERRIDE = process.env.REUNION_LEGACY_STATIC_DIR;

export const DATA_DIR = DATA_DIR_OVERRIDE
  ? path.resolve(DATA_DIR_OVERRIDE)
  : path.join(PROJECT_ROOT, "data");
export const INDEX_FILE = path.join(DATA_DIR, "chat_index.json");
export const ANNOTATIONS_FILE = path.join(DATA_DIR, "annotations.json");

// AI provider state lives under data/ai/. Each ChatGPT account gets its own
// codex-homes/<id> directory so codex's single-use refresh tokens stay isolated.
export const AI_DATA_DIR = path.join(DATA_DIR, "ai");
export const AI_OPENAI_ACCOUNTS_FILE = path.join(AI_DATA_DIR, "openai-accounts.json");
export const AI_CODEX_HOMES_DIR = path.join(AI_DATA_DIR, "codex-homes");
export const AI_SETTINGS_FILE = path.join(AI_DATA_DIR, "settings.json");
// Maps `session.repo` (the per-source bucket label, e.g. "mvp-chat-explorer"
// for codex / "Users-bytedance-workspaces-mvp-chat-explorer" for cursor) to a
// real repository root path the user has confirmed once. Lets Smart Export
// auto-target the right folder on subsequent exports for sibling sessions.
export const AI_REPO_MAPPINGS_FILE = path.join(AI_DATA_DIR, "repo-mappings.json");
export const FRONTEND_DIST_DIR = FRONTEND_DIST_OVERRIDE
  ? path.resolve(FRONTEND_DIST_OVERRIDE)
  : path.join(PROJECT_ROOT, "frontend", "dist");
export const LEGACY_STATIC_DIR = LEGACY_STATIC_OVERRIDE
  ? path.resolve(LEGACY_STATIC_OVERRIDE)
  : path.join(PROJECT_ROOT, "static");
export const LEGACY_STATIC_FILE = path.join(LEGACY_STATIC_DIR, "index.html");

const HOME = process.env.HOME || "";

export const DEFAULT_CURSOR_ROOT = path.join(HOME, ".cursor", "projects");
export const DEFAULT_CLAUDE_ROOT = path.join(HOME, ".claude", "projects");
export const DEFAULT_CODEX_ROOT = path.join(HOME, ".codex", "sessions");
export const DEFAULT_SOURCE_ROOTS = {
  cursor: DEFAULT_CURSOR_ROOT,
  claudeCode: DEFAULT_CLAUDE_ROOT,
  codex: DEFAULT_CODEX_ROOT,
} as const;

// Kept for backward compatibility with callers that only know about Cursor.
export const DEFAULT_SOURCE_ROOT = DEFAULT_CURSOR_ROOT;

export const CURSOR_WORKSPACE_STORAGE = path.join(
  HOME,
  "Library",
  "Application Support",
  "Cursor",
  "User",
  "workspaceStorage"
);

export const DEFAULT_PORT = 9765;
export const DEFAULT_HOST = "127.0.0.1";
export const REINDEX_INTERVAL_MS = 30_000;
export const ANNOTATION_NOTES_MAX = 8192;
export const ANNOTATION_TAG_MAX = 32;

// ---------------------------------------------------------------------------
// Edition + team mode wiring.
//
// "Edition" is a build-time decision: a `personal` edition bundle has team
// mode entirely disabled (no UI, the backend refuses to switch to team
// mode); a `team` edition bundle ships with the shared ingest URL + token
// baked in so users can flip to team mode with a single click.
//
// Why a build-time edition + a runtime mode (not just runtime):
//   * Personal edition can be safely distributed externally — its bundle
//     contains no real secret to scrape.
//   * Team edition is for internal use; the shared token is no worse than a
//     leaked source repo (per-user SSO is on the roadmap).
//
// All three values below are replaced at build time by esbuild `define` in
// `scripts/build-electron.mjs`. Forgetting to set them is a build-time
// failure (esbuild errors on undeclared identifier), not a silent runtime
// fallback.
//
// dev override (still works for `pnpm run serve` outside Electron):
//   REUNION_TEAM_INGEST_URL=http://127.0.0.1:8080 \
//   REUNION_TEAM_INGEST_TOKEN=local-test-token \
//   pnpm run serve
//
// In Electron the bootstrap.cjs auto-injects dev URL/token only when not
// packaged. Packaged builds rely on the bundled __REUNION_PROD_*__ values.

declare const __REUNION_EDITION__: "personal" | "team";
declare const __REUNION_PROD_INGEST_URL__: string;
declare const __REUNION_PROD_INGEST_TOKEN__: string;

// Resolution order (each call):
//   1. esbuild `define` replaces `__REUNION_EDITION__` with a literal — in
//      production builds this short-circuits to a constant and tree-shaking
//      can fold the if-check away.
//   2. `process.env.REUNION_EDITION` — used by `tsx` dev runs and tests so
//      they can flip edition per process without rebuilding.
//   3. `personal` fallback so an unconfigured run is never inadvertently
//      "team".
//
// We export a function instead of a frozen const so per-test edition
// overrides work (Node's `--test` runs all files in the same process and
// `src/config.ts` would otherwise cache the first imported value).
export function getEdition(): "personal" | "team" {
  if (typeof __REUNION_EDITION__ !== "undefined") return __REUNION_EDITION__;
  const fromEnv = process.env.REUNION_EDITION?.trim();
  if (fromEnv === "team" || fromEnv === "personal") return fromEnv;
  return "personal";
}

/** Convenience constant for code paths that only need the value at startup. */
export const REUNION_EDITION: "personal" | "team" = getEdition();

const BUILT_IN_INGEST_URL =
  typeof __REUNION_PROD_INGEST_URL__ !== "undefined" ? __REUNION_PROD_INGEST_URL__ : "";
const BUILT_IN_INGEST_TOKEN =
  typeof __REUNION_PROD_INGEST_TOKEN__ !== "undefined" ? __REUNION_PROD_INGEST_TOKEN__ : "";

export const TEAM_INGEST_URL =
  process.env.REUNION_TEAM_INGEST_URL?.trim() || BUILT_IN_INGEST_URL;
export const TEAM_INGEST_TOKEN =
  process.env.REUNION_TEAM_INGEST_TOKEN?.trim() || BUILT_IN_INGEST_TOKEN;

// Defensive client-side filter: in team mode we only render rows whose
// `gitRepo` host is in this allowlist. The collector is supposed to drop
// non-allowlist projects at the source (see ai_coding_collector
// `repoHostAllowlist`), so this is a belt-and-braces check that protects
// against (a) a freshly upgraded reunion talking to ingest backends still
// holding pre-filter data, and (b) unrelated personal projects accidentally
// reaching the team ingest. Empty array = no filter (legacy behaviour).
//
// Override at runtime with `REUNION_TEAM_REPO_HOST_ALLOWLIST=a.com,b.org`.
// An *explicit empty string* (env var set but empty) disables the filter,
// which the test harness uses to keep its placeholder remotes visible.
const TEAM_HOST_RAW_ENV = process.env.REUNION_TEAM_REPO_HOST_ALLOWLIST;
const RAW_TEAM_HOST_ALLOWLIST =
  TEAM_HOST_RAW_ENV !== undefined ? TEAM_HOST_RAW_ENV.trim() : "code.byted.org";
export const TEAM_REPO_HOST_ALLOWLIST: ReadonlyArray<string> = RAW_TEAM_HOST_ALLOWLIST
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
