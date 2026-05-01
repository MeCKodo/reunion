import "../_env.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { buildIndex } from "../../src/index-store.js";
import {
  createExportTask,
  getTask,
  listTasks,
  subscribe,
  type Task,
} from "../../src/tasks.js";
import type { SourceRoots } from "../../src/types.js";
import { mkTmpDir, rmDir } from "../_helpers.js";

const scratch = mkTmpDir("reunion-tasks");
let roots: SourceRoots;
let writeRoot: string;
let knownSessionKey = "";

before(async () => {
  // Build a tiny fixture index that contains exactly one cursor session.
  // We only need to test request-level validation + the basic-mode happy
  // path of createExportTask, so a single session is enough.
  const cursorRoot = path.join(scratch, "cursor");
  const projectDir = path.join(cursorRoot, "tasks-proj", "agent-transcripts");
  await fsp.mkdir(projectDir, { recursive: true });
  await fsp.writeFile(
    path.join(projectDir, "sess-tasks.txt"),
    "user:\nbuild a thing\n\nassistant:\nstep one"
  );
  roots = {
    cursor: cursorRoot,
    claudeCode: path.join(scratch, "claude"),
    codex: path.join(scratch, "codex"),
  };
  await buildIndex(roots, null);
  knownSessionKey = "cursor:tasks-proj:sess-tasks";

  writeRoot = path.join(scratch, "writeable");
  await fsp.mkdir(writeRoot, { recursive: true });
});

after(async () => rmDir(scratch));

/**
 * Block until a task reaches `status==='done' | 'failed'`. Resolves with the
 * final task snapshot. Times out after 5s so a regression in the runner
 * doesn't hang the suite.
 */
function waitForFinish(taskId: string, timeoutMs = 5000): Promise<Task> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`task ${taskId} did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    const unsub = subscribe(taskId, (task) => {
      if (task.status === "done" || task.status === "failed") {
        clearTimeout(timer);
        unsub();
        resolve(task);
      }
    });
    // Also handle the case where the task already completed before we got
    // here (subscribe() does not replay).
    const current = getTask(taskId);
    if (current && (current.status === "done" || current.status === "failed")) {
      clearTimeout(timer);
      unsub();
      resolve(current);
    }
  });
}

describe("tasks/createExportTask — validation", () => {
  it("returns 400 when sessionKey is missing", async () => {
    const out = await createExportTask({ sessionKey: "", targetDir: writeRoot } as never);
    assert.equal(out.httpStatus, 400);
    assert.match(out.error || "", /sessionKey/);
  });

  it("returns 400 when targetDir is missing", async () => {
    const out = await createExportTask({
      sessionKey: knownSessionKey,
      targetDir: "",
    } as never);
    assert.equal(out.httpStatus, 400);
  });

  it("returns 404 when the sessionKey does not exist in the index", async () => {
    const out = await createExportTask({
      sessionKey: "cursor:nope:nope",
      targetDir: writeRoot,
    } as never);
    assert.equal(out.httpStatus, 404);
  });

  it("returns 400 when targetDir does not exist on disk", async () => {
    const missing = path.join(scratch, "nope-not-here");
    const out = await createExportTask({
      sessionKey: knownSessionKey,
      targetDir: missing,
    } as never);
    assert.equal(out.httpStatus, 400);
    assert.match(out.error || "", /missing/i);
  });

  it("returns 400 when targetDir is a file, not a directory", async () => {
    const file = path.join(scratch, "not-a-dir");
    await fsp.writeFile(file, "x");
    const out = await createExportTask({
      sessionKey: knownSessionKey,
      targetDir: file,
    } as never);
    assert.equal(out.httpStatus, 400);
    assert.match(out.error || "", /not a directory/i);
  });

  it("returns 400 when relativePath escapes targetDir", async () => {
    const out = await createExportTask({
      sessionKey: knownSessionKey,
      targetDir: writeRoot,
      relativePath: "../escape.md",
      kind: "rules",
      mode: "basic",
    } as never);
    assert.equal(out.httpStatus, 400);
    assert.match(out.error || "", /must stay inside/);
  });
});

describe("tasks/createExportTask — basic happy path", () => {
  it("queues a task that writes a basic RULES.md to disk", async () => {
    const out = await createExportTask({
      sessionKey: knownSessionKey,
      targetDir: writeRoot,
      kind: "rules",
      mode: "basic",
      rememberMapping: false,
    } as never);
    assert.ok(out.task, "expected task to be returned");
    assert.equal(out.task.status, "pending");
    assert.equal(out.task.type, "export-write");

    const finished = await waitForFinish(out.task.id);
    assert.equal(finished.status, "done", `expected done, got ${finished.status} (error=${finished.error})`);
    assert.ok(finished.result);
    const text = await fsp.readFile(finished.result!.absolutePath, "utf-8");
    assert.match(text, /^# .* Rules/);
    assert.match(text, /## Rules/);
    assert.equal(finished.result!.mode, "basic");
  });

  it("returns 409 when the destination file already exists and overwrite=false", async () => {
    // The previous test wrote a file; calling again with overwrite=false
    // should be rejected at validation time.
    const out = await createExportTask({
      sessionKey: knownSessionKey,
      targetDir: writeRoot,
      kind: "rules",
      mode: "basic",
      rememberMapping: false,
    } as never);
    assert.equal(out.httpStatus, 409);
  });

  it("overwrite=true lets the same file be regenerated", async () => {
    const out = await createExportTask({
      sessionKey: knownSessionKey,
      targetDir: writeRoot,
      kind: "rules",
      mode: "basic",
      overwrite: true,
      rememberMapping: false,
    } as never);
    assert.ok(out.task);
    const finished = await waitForFinish(out.task.id);
    assert.equal(finished.status, "done");
    assert.equal(finished.result!.overwritten, true);
  });
});

describe("tasks/listTasks + getTask", () => {
  it("listTasks returns all tasks created so far, newest first", () => {
    const all = listTasks();
    assert.ok(all.length >= 2);
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i - 1].createdAt >= all[i].createdAt, "tasks must be sorted by createdAt desc");
    }
  });

  it("getTask returns undefined for unknown id", () => {
    assert.equal(getTask("does-not-exist"), undefined);
  });
});
