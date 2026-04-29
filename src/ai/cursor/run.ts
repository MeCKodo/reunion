// Run a one-shot prompt through `cursor-agent --print`. Cursor's CLI itself
// holds the OAuth token in macOS Keychain so we just spawn it; nothing for
// Reunion to refresh or store.

import { spawn } from "node:child_process";

import { getCursorSpawnCwd } from "./spawn-env.js";

export interface CursorRunOptions {
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Override the model for this run (e.g. "gpt-5.5-medium"). */
  model?: string;
}

// Smart Export prompts can be ~5k tokens of context plus model thinking time;
// 90s often clipped legitimate runs. Allow up to 3 minutes by default while
// still guarding against truly stuck CLIs.
const DEFAULT_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Spawn stagger lock
// ---------------------------------------------------------------------------
//
// cursor-agent atomically rewrites `~/.cursor/cli-config.json` on every
// launch (write `.tmp`, then rename). When Reunion fires N agents in
// parallel for batch tagging they race on the same `.tmp` filename and
// produce two flavours of failure:
//
//   - ENOENT: rename '.../cli-config.json.tmp' → '.../cli-config.json'
//     (process A renamed first, process B's rename now misses the file)
//   - Unexpected end of JSON input
//     (a reader saw the file mid-write before the rename)
//
// Both are inherent to cursor-agent's startup sequence; we cannot fix them
// inside the CLI. Instead we serialise just the spawn moment with a short
// stagger: each acquirer waits for the previous spawn to be ~150ms old
// before it spawns its own child. After the stagger window the lock
// auto-releases, so the children themselves run fully in parallel — only
// their initial file-touch is serialised. With 8 workers the total stagger
// budget is ~1s up front, negligible against per-call LLM latency.
//
// Override via CURSOR_SPAWN_STAGGER_MS for stress tests / disabled tests.

const SPAWN_STAGGER_MS = (() => {
  const raw = process.env.CURSOR_SPAWN_STAGGER_MS;
  if (!raw) return 150;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 150;
})();

let cursorSpawnGate: Promise<void> = Promise.resolve();

function acquireCursorSpawnSlot(): Promise<void> {
  const previous = cursorSpawnGate;
  let release!: () => void;
  cursorSpawnGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous.then(() => {
    if (SPAWN_STAGGER_MS <= 0) {
      release();
      return;
    }
    setTimeout(release, SPAWN_STAGGER_MS);
  });
}

export async function runCursorAgent(options: CursorRunOptions): Promise<string> {
  await acquireCursorSpawnSlot();
  if (options.signal?.aborted) {
    throw new Error("cursor-agent aborted");
  }
  const cmd = (process.env.CURSOR_AGENT_CMD || "cursor-agent").trim();
  // `--trust` skips the workspace-trust prompt that cursor-agent now requires
  // in `--print` mode; without it the CLI exits non-zero with a "Workspace
  // Trust Required" message whenever Reunion is launched from a directory the
  // user hasn't explicitly trusted (e.g. `/` when the packaged app starts from
  // Finder/Dock). Reunion only needs text generation — no file edits or shell
  // — so `--trust` is the minimum viable bypass; we deliberately avoid the
  // broader `-f`/`--yolo` which would also auto-approve write/exec tools.
  const args: string[] = ["--print", "--trust", "--output-format", "text"];
  if (options.model) args.push("--model", options.model);
  args.push(options.prompt);
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: getCursorSpawnCwd(),
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`cursor-agent timeout after ${Math.round(timeout / 1000)}s`));
    }, timeout);

    let stdout = "";
    let stderr = "";

    const onAbort = () => {
      child.kill("SIGTERM");
      clearTimeout(timer);
      reject(new Error("cursor-agent aborted"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `cursor-agent exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Stream-like wrapper. Cursor's `--print --output-format text` is not actually
 * SSE; the CLI buffers and dumps the full response on close. We surface the
 * full string as a single chunk so the router has a uniform AsyncIterable
 * contract regardless of provider.
 */
export async function* streamCursorAgent(
  options: CursorRunOptions
): AsyncIterable<string> {
  const text = await runCursorAgent(options);
  if (text) yield text;
}

/**
 * Best-effort check that the chosen model is allowed under the active account.
 * Returns null when the CLI is unreachable so the router can soft-fail and
 * just hand the model through.
 */
export async function ensureCursorModelAvailable(
  model: string | null | undefined
): Promise<string | null> {
  if (!model) return null;
  try {
    const { listCursorModels } = await import("./status.js");
    const models = await listCursorModels();
    if (!models.length) return null;
    const found = models.find((m) => m.id === model);
    if (!found) {
      const known = models.slice(0, 5).map((m) => m.id).join(", ");
      return `Cursor model "${model}" is not in your available list (e.g. ${known}…)`;
    }
    return null;
  } catch {
    return null;
  }
}
