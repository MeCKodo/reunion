// Run a one-shot prompt through `cursor-agent --print`. Cursor's CLI itself
// holds the OAuth token in macOS Keychain so we just spawn it; nothing for
// Reunion to refresh or store.

import { spawn } from "node:child_process";

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

export function runCursorAgent(options: CursorRunOptions): Promise<string> {
  const cmd = (process.env.CURSOR_AGENT_CMD || "cursor-agent").trim();
  const args: string[] = ["--print", "--output-format", "text"];
  if (options.model) args.push("--model", options.model);
  args.push(options.prompt);
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
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
