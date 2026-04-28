// Route handlers for task-center endpoints:
//   POST /api/tasks         (create)
//   GET  /api/tasks          (list)
//   GET  /api/tasks/:id      (detail)
//   GET  /api/tasks/:id/stream (SSE)

import { json, readJsonBody } from "../lib/http.js";
import {
  createExportTask,
  getTask,
  listTasks,
  streamTaskToSse,
  type CreateExportTaskBody,
} from "../tasks.js";
import type { RouteContext } from "./types.js";

export async function handleCreateTask({ req, res }: RouteContext) {
  const body = await readJsonBody<Partial<CreateExportTaskBody>>(req, {});
  const { task, error, httpStatus } = await createExportTask(body as CreateExportTaskBody);
  if (error) {
    json(res, httpStatus || 400, { ok: false, error });
    return;
  }
  json(res, 201, { ok: true, taskId: task.id, label: task.label });
}

export function handleListTasks({ res }: RouteContext) {
  json(res, 200, { ok: true, tasks: listTasks() });
}

export function handleTaskStream({ res, url }: RouteContext) {
  const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/stream$/);
  const taskId = match?.[1] || "";
  if (!taskId) {
    json(res, 400, { ok: false, error: "missing taskId" });
    return;
  }
  streamTaskToSse(taskId, res);
}

export function handleGetTask({ res, url }: RouteContext) {
  const taskId = url.pathname.replace("/api/tasks/", "");
  const task = getTask(taskId);
  if (!task) {
    json(res, 404, { ok: false, error: "task not found" });
    return;
  }
  json(res, 200, { ok: true, task });
}
