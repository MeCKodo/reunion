// Generic CLI spawn helpers used to drive `codex login`, `cursor-agent login`,
// `cursor-agent --print`, etc. Two flavours:
//
// 1. runAndCapture(): blocks until exit, returns full stdout/stderr. Use for
//    short status commands like `cursor-agent status` or `codex login status`.
//
// 2. runWithUrlExtraction(): streams stdout, fires the first matched OAuth URL
//    immediately so the frontend can open it in the system browser, then keeps
//    the child running until the CLI completes the auth handshake.
//
// We deliberately avoid stdio: 'inherit' because Electron's main process has
// no controlling TTY and the login CLIs would otherwise fail / hang.

import { spawn, type ChildProcess } from "node:child_process";

export interface CaptureResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface SpawnOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Forward to child stdin (e.g. API key for `codex login --with-api-key`). */
  stdin?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function normalizeEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...(env ?? {}) };
}

function attachAbort(child: ChildProcess, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    child.kill("SIGTERM");
    return () => {};
  }
  const onAbort = () => child.kill("SIGTERM");
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Spawn a CLI, capture full stdout/stderr, return when it exits or on timeout.
 * Never throws; failures land in the result struct.
 */
export async function runAndCapture(
  cmd: string,
  args: string[],
  options: SpawnOptions = {}
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let resolved = false;
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        env: normalizeEnv(options.env),
        cwd: options.cwd,
        stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        error: (err as Error).message,
      });
      return;
    }

    const timer = setTimeout(() => {
      if (resolved) return;
      child.kill("SIGTERM");
      finish(false, null, `${cmd} timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const detachAbort = attachAbort(child, options.signal);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    if (options.stdin && child.stdin) {
      child.stdin.end(options.stdin);
    }

    function finish(ok: boolean, code: number | null, error: string | null) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      detachAbort();
      resolve({ ok, exitCode: code, stdout, stderr, error });
    }

    child.on("error", (err) => finish(false, null, err.message));
    child.on("close", (code) => {
      finish(code === 0, code, code === 0 ? null : stderr.trim() || `exit ${code}`);
    });
  });
}

export interface UrlStreamEvent {
  type: "url" | "stdout" | "stderr" | "done" | "error";
  /** Present on `url` events. */
  url?: string;
  /** Present on `stdout`/`stderr` events. */
  text?: string;
  /** Present on `done` events. */
  exitCode?: number | null;
  /** Present on `error` events. */
  error?: string;
}

export interface UrlExtractionOptions extends SpawnOptions {
  /** Pattern that picks the OAuth URL from stdout/stderr. */
  urlPattern?: RegExp;
  /** Only first match is reported. Set to true to report every match. */
  reportEveryMatch?: boolean;
}

const DEFAULT_URL_PATTERN =
  /(https:\/\/(?:auth\.openai\.com|cursor\.com|chatgpt\.com)\/[^\s'"<>]+)/g;

/**
 * Spawn a CLI and stream events back as the process produces output. The first
 * regex match in stdout/stderr is emitted as `{type:'url', url}` so callers can
 * pop the system browser. The child keeps running and we forward subsequent
 * stdout/stderr lines, finally emitting `{type:'done', exitCode}`.
 */
export async function* runWithUrlExtraction(
  cmd: string,
  args: string[],
  options: UrlExtractionOptions = {}
): AsyncIterable<UrlStreamEvent> {
  const pattern = new RegExp(
    options.urlPattern?.source ?? DEFAULT_URL_PATTERN.source,
    options.urlPattern?.flags ?? "g"
  );

  let child: ChildProcess;
  try {
    child = spawn(cmd, args, {
      env: normalizeEnv(options.env),
      cwd: options.cwd,
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
  } catch (err) {
    yield { type: "error", error: (err as Error).message };
    return;
  }

  if (options.stdin && child.stdin) {
    child.stdin.end(options.stdin);
  }

  type QueueItem = UrlStreamEvent | { type: "__end__" };
  const queue: QueueItem[] = [];
  let resolveWaiter: ((item: QueueItem) => void) | null = null;
  let urlSeen = !options.reportEveryMatch ? false : true;

  function push(item: QueueItem) {
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r(item);
    } else {
      queue.push(item);
    }
  }

  const emitOutput = (text: string, kind: "stdout" | "stderr") => {
    push({ type: kind, text });
    let m: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(text)) !== null) {
      if (urlSeen && !options.reportEveryMatch) break;
      urlSeen = true;
      push({ type: "url", url: m[1] });
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => emitOutput(String(chunk), "stdout"));
  child.stderr?.on("data", (chunk) => emitOutput(String(chunk), "stderr"));

  const detachAbort = attachAbort(child, options.signal);
  const timer = options.timeoutMs
    ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
    : null;

  child.on("error", (err) => {
    push({ type: "error", error: err.message });
    push({ type: "__end__" });
  });
  child.on("close", (code) => {
    if (timer) clearTimeout(timer);
    detachAbort();
    push({ type: "done", exitCode: code });
    push({ type: "__end__" });
  });

  while (true) {
    const item: QueueItem =
      queue.shift() ??
      (await new Promise<QueueItem>((resolve) => {
        resolveWaiter = resolve;
      }));
    if (item.type === "__end__") return;
    yield item;
  }
}
