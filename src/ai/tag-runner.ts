// Concurrent batch tag runner extracted from the /api/ai/tag-sessions handler.
// Owns the worker pool, retry/cooldown logic, annotation merging, and progress
// reporting — all behind a callback-based API so the HTTP layer stays thin.

import {
  buildTagSummary,
  loadAnnotations,
  saveAnnotations,
} from "../annotations.js";
import { loadIndex } from "../index-store.js";
import { tagOneSession, EXTRACT_STRATEGIES, type ExtractStrategy } from "./tagger.js";
import { AiRouterError } from "./router.js";
import { getCachedCursorModelId } from "./cursor/status.js";
import type { AiProvider } from "./settings.js";
import type { Session, SessionAnnotation } from "../types.js";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const FLUSH_EVERY = 5;
const FLUSH_INTERVAL_MS = 2_000;
const MAX_CONCURRENCY_HARDCAP = 8;
const DEFAULT_CONCURRENCY = 8;
export const BATCH_LIMIT = 100;
const RETRY_MAX = 1;
const COOLDOWN_THRESHOLD = 5;
const COOLDOWN_MS = 5_000;

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface AiTagBatchOptions {
  sessionKeys: string[];
  includeAlreadyTagged: boolean;
  strategy: ExtractStrategy;
  provider?: AiProvider;
  model?: string;
  maxConcurrency: number;
  signal: AbortSignal;
  onProgress: (event: TagProgressEvent) => void;
}

export type TagProgressEvent =
  | { status: "skip"; index: number; total: number; sessionKey: string; reason: string; strategyUsed?: string }
  | { status: "ok"; index: number; total: number; sessionKey: string; tags: string[]; allTags: string[]; strategyUsed: string; aiTaggedAt: number }
  | { status: "fail"; index: number; total: number; sessionKey: string; error: string; strategyUsed?: string };

export interface TagBatchResult {
  updated: number;
  skipped: number;
  failed: number;
  total: number;
  aborted: boolean;
  tags: Array<{ tag: string; count: number }>;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function looksRateLimited(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("429") ||
    lower.includes("too many requests")
  );
}

function looksTransientCli(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("cli-config.json.tmp") ||
    (lower.includes("enoent") && lower.includes("cli-config.json"))
  );
}

async function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function clampConcurrency(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_CONCURRENCY;
  }
  return Math.min(Math.max(Math.floor(raw), 1), MAX_CONCURRENCY_HARDCAP);
}

function errorMessage(err: unknown): string {
  if (err instanceof AiRouterError) return `${err.code}: ${err.message}`;
  return (err as Error)?.message || String(err);
}

// ---------------------------------------------------------------------------
// batch runner
// ---------------------------------------------------------------------------

export async function runTagBatch(opts: AiTagBatchOptions): Promise<TagBatchResult> {
  const {
    sessionKeys,
    includeAlreadyTagged,
    strategy,
    provider,
    model,
    maxConcurrency,
    signal,
    onProgress,
  } = opts;

  const indexData = await loadIndex();
  const annotations = await loadAnnotations();
  const sessionMap = new Map<string, Session>(
    indexData.sessions.map((s: Session) => [s.sessionKey, s] as const)
  );
  const existingTagsList = buildTagSummary(annotations).map((s) => s.tag);

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let pendingSinceFlush = 0;
  let lastFlush = Date.now();
  let consecutiveFailures = 0;
  let cooldownUntil = 0;

  const total = sessionKeys.length;
  let cursor = 0;

  const flushIfNeeded = async () => {
    if (
      pendingSinceFlush >= FLUSH_EVERY ||
      Date.now() - lastFlush >= FLUSH_INTERVAL_MS
    ) {
      await saveAnnotations();
      pendingSinceFlush = 0;
      lastFlush = Date.now();
    }
  };

  // Cursor CLI warm-up gate: serialise the first task when the requested
  // model differs from the cached one to avoid cli-config.json races.
  let firstTaskGate: Promise<void> | null = null;
  let releaseFirstTaskGate: () => void = () => {};
  if (provider === "cursor" && maxConcurrency > 1 && total > 1 && model) {
    const cached = await getCachedCursorModelId();
    if (cached !== model) {
      firstTaskGate = new Promise<void>((resolve) => {
        releaseFirstTaskGate = resolve;
      });
    }
  }

  const runWorker = async (workerId: number) => {
    if (workerId > 0 && firstTaskGate) {
      await firstTaskGate;
      if (signal.aborted) return;
    }
    let isWorkerZeroFirstCall = workerId === 0 && firstTaskGate !== null;

    try {
      while (!signal.aborted) {
        const idx = cursor;
        cursor += 1;
        if (idx >= total) return;
        const sessionKey = sessionKeys[idx];
        const session = sessionMap.get(sessionKey);
        const prev = annotations[sessionKey];

        if (!includeAlreadyTagged && typeof prev?.aiTaggedAt === "number") {
          skipped += 1;
          onProgress({ status: "skip", index: idx + 1, total, sessionKey, reason: "already_tagged" });
          continue;
        }
        if (!session) {
          skipped += 1;
          onProgress({ status: "skip", index: idx + 1, total, sessionKey, reason: "not_found" });
          continue;
        }

        if (cooldownUntil > Date.now()) {
          await sleepUnlessAborted(cooldownUntil - Date.now(), signal);
          if (signal.aborted) return;
        }

        let result: Awaited<ReturnType<typeof tagOneSession>> | null = null;
        let lastError: unknown = null;
        for (let attempt = 0; attempt <= RETRY_MAX; attempt += 1) {
          try {
            result = await tagOneSession({
              session,
              existingTags: existingTagsList,
              strategy,
              provider,
              model,
              signal,
            });
            lastError = null;
            break;
          } catch (err) {
            if (signal.aborted) return;
            lastError = err;
            const msg = errorMessage(err);
            const transient =
              looksRateLimited(msg) ||
              looksTransientCli(msg) ||
              /\b5\d\d\b/.test(msg);
            if (attempt < RETRY_MAX && transient) {
              const base = 750 * (attempt + 1);
              const jitter = Math.floor(Math.random() * 500);
              await sleepUnlessAborted(base + jitter, signal);
              if (signal.aborted) return;
              continue;
            }
            break;
          }
        }

        if (isWorkerZeroFirstCall) {
          releaseFirstTaskGate();
          isWorkerZeroFirstCall = false;
        }

        if (!result) {
          if (signal.aborted) return;
          failed += 1;
          consecutiveFailures += 1;
          if (consecutiveFailures >= COOLDOWN_THRESHOLD) {
            consecutiveFailures = 0;
            cooldownUntil = Date.now() + COOLDOWN_MS;
          }
          onProgress({ status: "fail", index: idx + 1, total, sessionKey, error: errorMessage(lastError) });
          continue;
        }

        try {
          if (result.userMsgCount === 0) {
            skipped += 1;
            consecutiveFailures = 0;
            onProgress({ status: "skip", index: idx + 1, total, sessionKey, reason: "no_user_messages", strategyUsed: result.strategyUsed });
            continue;
          }

          if (result.tags.length === 0) {
            failed += 1;
            consecutiveFailures += 1;
            onProgress({ status: "fail", index: idx + 1, total, sessionKey, strategyUsed: result.strategyUsed, error: "Could not parse tags from model response" });
            continue;
          }

          const prevTags = (prev?.tags || []).slice();
          const seen = new Set(prevTags);
          const mergedTags = prevTags.slice();
          for (const t of result.tags) {
            if (!seen.has(t)) {
              seen.add(t);
              mergedTags.push(t);
            }
          }

          const nowSec = Math.floor(Date.now() / 1000);
          const next: SessionAnnotation = {
            ...(prev || {}),
            tags: mergedTags,
            aiTagSet: result.tags,
            aiTaggedAt: nowSec,
            updatedAt: nowSec,
          };
          annotations[sessionKey] = next;
          updated += 1;
          pendingSinceFlush += 1;
          consecutiveFailures = 0;

          onProgress({
            status: "ok",
            index: idx + 1,
            total,
            sessionKey,
            tags: result.tags,
            allTags: mergedTags,
            strategyUsed: result.strategyUsed,
            aiTaggedAt: nowSec,
          });

          await flushIfNeeded();
        } catch (err) {
          if (signal.aborted) return;
          failed += 1;
          onProgress({ status: "fail", index: idx + 1, total, sessionKey, error: errorMessage(err) });
        }
      }
    } finally {
      if (isWorkerZeroFirstCall) releaseFirstTaskGate();
    }
  };

  const workers = Array.from({ length: maxConcurrency }, (_, i) => runWorker(i));
  try {
    await Promise.all(workers);
  } catch {
    // worker errors already surfaced via onProgress
  }

  try {
    if (pendingSinceFlush > 0) await saveAnnotations();
  } catch {
    // save races resolve on retry
  }

  return {
    updated,
    skipped,
    failed,
    total,
    aborted: signal.aborted,
    tags: buildTagSummary(annotations),
  };
}
