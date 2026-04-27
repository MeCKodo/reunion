import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { ServerResponse } from "node:http";

import {
  generateExportMarkdown,
  buildSmartPrompt,
  buildSkillMarkdown,
  buildRulesMarkdown,
  stripCodeFence,
  isValidSmartMarkdown,
} from "./export.js";
import { loadIndex } from "./index-store.js";
import { setRepoMapping } from "./repo-target.js";
import { runAi, AiRouterError } from "./ai/router.js";
import type { ExportKind, ExportMode, Session } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface TaskProgress {
  phase: string;
  detail?: string;
  /** Number of characters generated so far (streaming AI). */
  generatedChars?: number;
  /** Elapsed seconds since task started running. */
  elapsedSec?: number;
}

export interface TaskResult {
  absolutePath: string;
  relativePath: string;
  targetDir: string;
  mode: string;
  warning?: string;
  overwritten: boolean;
  bytes: number;
}

export interface Task {
  id: string;
  type: string;
  status: TaskStatus;
  label: string;
  createdAt: number;
  progress?: TaskProgress;
  result?: TaskResult;
  error?: string;
}

export interface CreateExportTaskBody {
  sessionKey: string;
  kind: ExportKind;
  mode?: ExportMode;
  targetDir: string;
  relativePath?: string;
  overwrite?: boolean;
  rememberMapping?: boolean;
  provider?: "openai" | "cursor";
  accountId?: string;
}

type TaskListener = (task: Task) => void;

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const tasks = new Map<string, Task>();
const listeners = new Map<string, Set<TaskListener>>();

const CLEANUP_AFTER_MS = 30 * 60 * 1000;

function notifyListeners(task: Task): void {
  const set = listeners.get(task.id);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(task);
    } catch {
      // listener errors must not crash the task
    }
  }
}

function updateTask(id: string, patch: Partial<Task>): Task | null {
  const task = tasks.get(id);
  if (!task) return null;
  Object.assign(task, patch);
  notifyListeners(task);
  return task;
}

function scheduleCleanup(id: string): void {
  setTimeout(() => {
    tasks.delete(id);
    listeners.delete(id);
  }, CLEANUP_AFTER_MS).unref();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

export function listTasks(): Task[] {
  return Array.from(tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function subscribe(id: string, fn: TaskListener): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(id);
  };
}

// ---------------------------------------------------------------------------
// Export-write task execution
// ---------------------------------------------------------------------------

export async function createExportTask(
  body: CreateExportTaskBody
): Promise<{ task: Task; error?: string; httpStatus?: number }> {
  const sessionKey = String(body.sessionKey || "").trim();
  const targetDir = String(body.targetDir || "").trim();
  if (!sessionKey || !targetDir) {
    return {
      task: null as unknown as Task,
      error: "sessionKey and targetDir are required",
      httpStatus: 400,
    };
  }

  const indexData = await loadIndex();
  const session = indexData.sessions.find((s: Session) => s.sessionKey === sessionKey);
  if (!session) {
    return {
      task: null as unknown as Task,
      error: "session not found",
      httpStatus: 404,
    };
  }

  try {
    const stat = await fsp.stat(targetDir);
    if (!stat.isDirectory()) {
      return {
        task: null as unknown as Task,
        error: `not a directory: ${targetDir}`,
        httpStatus: 400,
      };
    }
  } catch (err) {
    return {
      task: null as unknown as Task,
      error: `target directory missing: ${(err as Error).message}`,
      httpStatus: 400,
    };
  }

  const kindRaw = (body.kind || "rules").toLowerCase();
  const kind: ExportKind = kindRaw === "skill" ? "skill" : "rules";
  const modeRaw = (body.mode || "smart").toLowerCase();
  const mode: ExportMode = modeRaw === "smart" ? "smart" : "basic";

  const { sanitizeFileName } = await import("./lib/text.js");
  const slug = sanitizeFileName(session.title || session.sessionId)
    .toLowerCase()
    .slice(0, 48)
    .replace(/-+$/, "");
  const defaultRel =
    kind === "skill"
      ? path.join(".claude", "skills", slug, "SKILL.md")
      : path.join(".cursor", "rules", `${slug}.mdc`);
  const requestedRel = (body.relativePath || defaultRel).replace(/^[\\/]+/, "");

  const absPath = path.resolve(targetDir, requestedRel);
  const targetDirReal = path.resolve(targetDir);
  if (!absPath.startsWith(targetDirReal + path.sep) && absPath !== targetDirReal) {
    return {
      task: null as unknown as Task,
      error: "relativePath must stay inside targetDir",
      httpStatus: 400,
    };
  }

  const overwrite = body.overwrite === true;
  let fileExisted = false;
  try {
    await fsp.access(absPath);
    fileExisted = true;
  } catch {
    // doesn't exist — happy path
  }
  if (fileExisted && !overwrite) {
    return {
      task: null as unknown as Task,
      error: "file already exists",
      httpStatus: 409,
    };
  }

  const kindLabel = kind === "skill" ? "Smart Skill" : "Smart Rules";
  const shortRel = requestedRel.length > 50 ? `…${requestedRel.slice(-45)}` : requestedRel;
  const task: Task = {
    id: randomUUID(),
    type: "export-write",
    status: "pending",
    label: `${kindLabel} → ${shortRel}`,
    createdAt: Date.now(),
  };
  tasks.set(task.id, task);

  setImmediate(() => {
    void runExportTask(task.id, session, kind, mode, {
      absPath,
      requestedRel,
      targetDirReal,
      fileExisted,
      rememberMapping: body.rememberMapping,
      provider: body.provider,
      accountId: body.accountId,
    });
  });

  return { task };
}

async function runExportTask(
  taskId: string,
  session: Session,
  kind: ExportKind,
  mode: ExportMode,
  opts: {
    absPath: string;
    requestedRel: string;
    targetDirReal: string;
    fileExisted: boolean;
    rememberMapping?: boolean;
    provider?: "openai" | "cursor";
    accountId?: string;
  }
): Promise<void> {
  const startedAt = Date.now();

  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);

  updateTask(taskId, {
    status: "running",
    progress: { phase: "generating", detail: "AI 生成中…", generatedChars: 0, elapsedSec: 0 },
  });

  try {
    let markdown: string;
    let resultMode: ExportMode;
    let warning: string | undefined;

    const fallback = kind === "skill" ? buildSkillMarkdown(session) : buildRulesMarkdown(session);

    if (mode !== "smart") {
      markdown = fallback;
      resultMode = "basic";
    } else {
      const prompt = buildSmartPrompt(session, kind, fallback);
      const chunks: string[] = [];
      let charCount = 0;
      let lastPushAt = 0;

      try {
        for await (const chunk of runAi({
          prompt,
          provider: opts.provider,
          accountId: opts.accountId,
        })) {
          chunks.push(chunk);
          charCount += chunk.length;

          const now = Date.now();
          if (now - lastPushAt > 500) {
            lastPushAt = now;
            updateTask(taskId, {
              progress: {
                phase: "generating",
                detail: `AI 生成中… ${charCount} 字`,
                generatedChars: charCount,
                elapsedSec: elapsed(),
              },
            });
          }
        }

        const rawOutput = chunks.join("");
        const generated = stripCodeFence(rawOutput);

        if (!generated || generated.length < 120 || !isValidSmartMarkdown(kind, generated)) {
          markdown = fallback;
          resultMode = "basic";
          warning = "smart generation returned low-confidence content, fallback applied";
        } else {
          markdown = generated;
          resultMode = "smart";
        }
      } catch (error) {
        if (error instanceof AiRouterError) {
          markdown = fallback;
          resultMode = "basic";
          warning = `${error.code}: ${error.message}`;
        } else {
          markdown = fallback;
          resultMode = "basic";
          warning = String(error);
        }
      }
    }

    updateTask(taskId, {
      progress: { phase: "writing", detail: "写入文件…", elapsedSec: elapsed() },
    });

    await fsp.mkdir(path.dirname(opts.absPath), { recursive: true });
    await fsp.writeFile(opts.absPath, markdown, "utf-8");

    if (opts.rememberMapping !== false) {
      await setRepoMapping(session.repo, opts.targetDirReal, session.source);
    }

    updateTask(taskId, {
      status: "done",
      progress: {
        phase: "done",
        detail: "完成",
        generatedChars: Buffer.byteLength(markdown, "utf-8"),
        elapsedSec: elapsed(),
      },
      result: {
        absolutePath: opts.absPath,
        relativePath: opts.requestedRel,
        targetDir: opts.targetDirReal,
        mode: resultMode,
        warning,
        overwritten: opts.fileExisted,
        bytes: Buffer.byteLength(markdown, "utf-8"),
      },
    });
  } catch (err) {
    updateTask(taskId, {
      status: "failed",
      progress: { phase: "failed", detail: "失败", elapsedSec: elapsed() },
      error: (err as Error).message || String(err),
    });
  } finally {
    scheduleCleanup(taskId);
  }
}

// ---------------------------------------------------------------------------
// SSE streaming for a single task
// ---------------------------------------------------------------------------

export function streamTaskToSse(
  taskId: string,
  res: ServerResponse
): void {
  const task = tasks.get(taskId);

  // SSE headers
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    if (res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const end = () => {
    if (res.destroyed) return;
    try {
      res.write("event: end\ndata: {}\n\n");
      res.end();
    } catch {
      // ignore
    }
  };

  if (!task) {
    send("error", { error: "task not found" });
    end();
    return;
  }

  const sendSnapshot = (t: Task) => {
    send("snapshot", {
      id: t.id,
      type: t.type,
      status: t.status,
      label: t.label,
      createdAt: t.createdAt,
      progress: t.progress,
      result: t.result,
      error: t.error,
    });
  };

  // Send current state immediately
  sendSnapshot(task);

  if (task.status === "done" || task.status === "failed") {
    end();
    return;
  }

  // Subscribe for updates
  const unsub = subscribe(taskId, (updated) => {
    sendSnapshot(updated);
    if (updated.status === "done" || updated.status === "failed") {
      unsub();
      end();
    }
  });

  // Client disconnect
  res.on("close", () => {
    unsub();
  });
}
