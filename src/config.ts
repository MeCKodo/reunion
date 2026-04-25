import path from "node:path";

// PROJECT_ROOT defaults to process.cwd() so the CLI workflow keeps working.
// In an Electron build the renderer/main process injects absolute overrides
// before importing this module so we point at userData / resourcesPath instead
// of the read-only app.asar bundle.
export const PROJECT_ROOT = path.resolve(process.cwd());

const DATA_DIR_OVERRIDE = process.env.LOGUE_DATA_DIR;
const FRONTEND_DIST_OVERRIDE = process.env.LOGUE_FRONTEND_DIST_DIR;
const LEGACY_STATIC_OVERRIDE = process.env.LOGUE_LEGACY_STATIC_DIR;

export const DATA_DIR = DATA_DIR_OVERRIDE
  ? path.resolve(DATA_DIR_OVERRIDE)
  : path.join(PROJECT_ROOT, "data");
export const INDEX_FILE = path.join(DATA_DIR, "chat_index.json");
export const ANNOTATIONS_FILE = path.join(DATA_DIR, "annotations.json");
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

// User-data-scoped paths for the embedding pipeline. We deliberately put the
// 100MB+ ONNX model under "Application Support" rather than DATA_DIR so it
// survives app uninstall/reinstall and doesn't bloat the dev workspace
// `data/` folder. Tests/CI can point everything inside DATA_DIR by setting
// LOGUE_USER_DATA_DIR=$LOGUE_DATA_DIR.
const USER_DATA_OVERRIDE = process.env.LOGUE_USER_DATA_DIR;
export const USER_DATA_DIR = USER_DATA_OVERRIDE
  ? path.resolve(USER_DATA_OVERRIDE)
  : HOME
    ? path.join(HOME, "Library", "Application Support", "Logue")
    : DATA_DIR;
export const MODELS_DIR = path.join(USER_DATA_DIR, "models");
export const EMBEDDINGS_DB = path.join(DATA_DIR, "embeddings.sqlite");
export const EMBEDDING_MODEL_ID = "Xenova/multilingual-e5-small";
// Output dimensionality of the model above. Hard-coded so the SQLite schema
// can validate stored vectors at insert time without booting the model.
export const EMBEDDING_DIMS = 384;
