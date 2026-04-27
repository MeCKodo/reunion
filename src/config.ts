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
