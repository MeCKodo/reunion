// Shared helpers for tests. Import `_env.ts` before this module if you need
// the test-only DATA_DIR overrides applied; this file deliberately does NOT
// import `_env.ts` so that helpers can be reused by isolated unit tests that
// don't touch the filesystem.

import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  IndexData,
  Session,
  SourceId,
  SourceRoots,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// tmp dir helpers
// ---------------------------------------------------------------------------

export function mkTmpDir(prefix = "reunion-tmp"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export async function rmDir(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// mock req/res
// ---------------------------------------------------------------------------

/** Bare-minimum mock that satisfies the surface our handlers actually touch. */
export class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body: Buffer = Buffer.alloc(0);
  ended = false;
  destroyed = false;
  headersSent = false;
  // Capture chunks pushed via `write()` for SSE-style assertions.
  writes: string[] = [];

  setHeader(name: string, value: string | number) {
    this.headers[name.toLowerCase()] = String(value);
  }

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  flushHeaders() {
    this.headersSent = true;
  }

  write(chunk: string | Buffer): boolean {
    if (this.ended || this.destroyed) return false;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.writes.push(buf.toString("utf-8"));
    this.body = Buffer.concat([this.body, buf]);
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.write(chunk);
    if (!this.headersSent) this.headersSent = true;
    this.ended = true;
    this.emit("close");
    return this;
  }

  bodyText(): string {
    return this.body.toString("utf-8");
  }

  bodyJson<T = unknown>(): T {
    return JSON.parse(this.bodyText()) as T;
  }
}

interface MockRequestOptions {
  method?: string;
  url?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
}

export class MockRequest extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  private _body: Buffer;
  private _emitted = false;

  constructor(opts: MockRequestOptions = {}) {
    super();
    this.method = (opts.method || "GET").toUpperCase();
    this.url = opts.url || "/";
    this.headers = opts.headers || {};
    this._body =
      opts.body === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(opts.body)
          ? opts.body
          : Buffer.from(opts.body);
  }

  setEncoding(_enc: string): this {
    // The handler only uses utf-8; we always emit strings below.
    return this;
  }

  /**
   * Trigger the standard data/end emission cycle on the next microtask. Call
   * this AFTER attaching `data` and `end` listeners (i.e. after passing the
   * request into the handler).
   */
  emitBody(): void {
    if (this._emitted) return;
    this._emitted = true;
    setImmediate(() => {
      if (this._body.length > 0) this.emit("data", this._body.toString("utf-8"));
      this.emit("end");
    });
  }
}

export function makeReqRes(opts: MockRequestOptions = {}): {
  req: MockRequest;
  res: MockResponse;
} {
  const req = new MockRequest(opts);
  const res = new MockResponse();
  return { req, res };
}

// ---------------------------------------------------------------------------
// fixture index-data builders
// ---------------------------------------------------------------------------

interface BuildSessionOpts {
  source?: SourceId;
  repo?: string;
  sessionId?: string;
  title?: string;
  filePath?: string;
  provider?: Session["provider"];
  startedAt?: number;
  updatedAt?: number;
  content?: string;
  segments?: Session["segments"];
  sizeBytes?: number;
  mtimeMs?: number;
  repoPath?: string;
}

export function buildSession(opts: BuildSessionOpts = {}): Session {
  const source: SourceId = opts.source || "cursor";
  const repo = opts.repo || "demo-repo";
  const sessionId = opts.sessionId || "sess-1";
  const startedAt = opts.startedAt ?? 1_700_000_000;
  const updatedAt = opts.updatedAt ?? startedAt + 60;
  const sessionKey = `${source}:${repo}:${sessionId}`;
  return {
    source,
    sessionKey,
    sessionId,
    repo,
    repoPath: opts.repoPath,
    title: opts.title || "Test session",
    filePath: opts.filePath || `/tmp/fake/${sessionId}.jsonl`,
    provider: opts.provider || "local",
    startedAt,
    updatedAt,
    sizeBytes: opts.sizeBytes ?? 1234,
    mtimeMs: opts.mtimeMs ?? updatedAt * 1000,
    content: opts.content ?? "user:\nhello\n\nassistant:\nhi there",
    segments:
      opts.segments ??
      [
        { index: 0, role: "user", text: "hello", ts: startedAt },
        { index: 1, role: "assistant", text: "hi there", ts: updatedAt },
      ],
  };
}

export function buildIndexData(
  sessions: Session[],
  rootsOverride?: Partial<SourceRoots>
): IndexData {
  const roots: SourceRoots = {
    cursor: rootsOverride?.cursor ?? "/tmp/fake/cursor",
    claudeCode: rootsOverride?.claudeCode ?? "/tmp/fake/claude",
    codex: rootsOverride?.codex ?? "/tmp/fake/codex",
  };
  return {
    sourceRoots: roots,
    generatedAt: Math.floor(Date.now() / 1000),
    sessions,
  };
}

// ---------------------------------------------------------------------------
// http test helpers (real server)
// ---------------------------------------------------------------------------

interface FetchJsonOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Tiny fetch wrapper for end-to-end tests against runServe(). */
export async function fetchJson<T = unknown>(
  baseUrl: string,
  pathSegment: string,
  opts: FetchJsonOptions = {}
): Promise<{ status: number; body: T; headers: Record<string, string> }> {
  const url = baseUrl.replace(/\/$/, "") + pathSegment;
  const init: Record<string, unknown> = {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(url, init as RequestInit);
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let body: T;
  try {
    body = (text ? JSON.parse(text) : null) as T;
  } catch {
    body = text as unknown as T;
  }
  return { status: res.status, body, headers };
}

export async function fetchRaw(
  baseUrl: string,
  pathSegment: string,
  opts: FetchJsonOptions = {}
): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  const url = baseUrl.replace(/\/$/, "") + pathSegment;
  const init: Record<string, unknown> = {
    method: opts.method || "GET",
    headers: opts.headers || {},
  };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(url, init as RequestInit);
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: res.status, text, headers };
}

// Type aliases re-exported so callers can stay decoupled from our internals.
export type { IncomingMessage, ServerResponse };
