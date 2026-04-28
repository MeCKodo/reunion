import * as React from "react";
import {
  createTask,
  fetchTasks,
  runAiTagging,
  streamTask,
  type AiTaggingPayload,
  type AiTaggingProgress,
  type AiTaggingTaskItem,
  type AiTaggingTaskState,
  type CreateTaskRequest,
  type TaskSnapshot,
} from "./api";

/**
 * Hooks the AI-tagging task plumbing into the rest of the app.
 * `App.tsx` registers the annotation-update bridge so per-session
 * progress can flow into useAnnotations without coupling it to the
 * task center's React tree.
 */
export interface AiTaggingHandlers {
  onSessionTagged: (
    sessionKey: string,
    payload: { allTags: string[]; aiTags: string[]; aiTaggedAt: number }
  ) => void;
  onTagSummary?: (tags: { tag: string; count: number }[]) => void;
  onComplete?: (summary: AiTaggingTaskState) => void;
  onAbort?: (summary: AiTaggingTaskState) => void;
  onError?: (error: string) => void;
}

export interface SubmitAiTaggingArgs {
  payload: AiTaggingPayload;
  label: string;
}

interface TaskCenterContextValue {
  tasks: TaskSnapshot[];
  activeCount: number;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  submitTask: (body: CreateTaskRequest) => Promise<{ taskId: string; label: string }>;
  submitAiTaggingTask: (args: SubmitAiTaggingArgs) => Promise<string>;
  registerAiTaggingHandlers: (handlers: AiTaggingHandlers) => () => void;
  dismissTask: (id: string) => void;
}

const TaskCenterContext = React.createContext<TaskCenterContextValue | null>(null);

export function TaskCenterProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = React.useState<TaskSnapshot[]>([]);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const abortRefs = React.useRef<Map<string, AbortController>>(new Map());
  // Handlers registered by App.tsx so per-session progress can flow into
  // useAnnotations without the task center owning that state directly.
  // We intentionally store a ref so re-registrations don't re-trigger
  // active SSE loops.
  const aiHandlersRef = React.useRef<AiTaggingHandlers | null>(null);

  const activeCount = React.useMemo(
    () => tasks.filter((t) => t.status === "pending" || t.status === "running").length,
    [tasks]
  );

  const toggleSidebar = React.useCallback(() => setSidebarOpen((prev) => !prev), []);

  const upsertTask = React.useCallback((snapshot: TaskSnapshot) => {
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === snapshot.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = snapshot;
        return next;
      }
      return [snapshot, ...prev];
    });
  }, []);

  const watchTask = React.useCallback(
    (taskId: string) => {
      const ac = new AbortController();
      abortRefs.current.set(taskId, ac);

      (async () => {
        try {
          for await (const event of streamTask(taskId, ac.signal)) {
            if (event.type === "snapshot") {
              upsertTask(event.task);
              if (event.task.status === "done" || event.task.status === "failed") {
                break;
              }
            } else if (event.type === "error") {
              break;
            }
          }
        } catch {
          // aborted or network error — ignore
        } finally {
          abortRefs.current.delete(taskId);
        }
      })();
    },
    [upsertTask]
  );

  const submitTask = React.useCallback(
    async (body: CreateTaskRequest) => {
      const { taskId, label } = await createTask(body);
      upsertTask({
        id: taskId,
        type: "export-write",
        status: "pending",
        label,
        createdAt: Date.now(),
      });
      watchTask(taskId);
      setSidebarOpen(true);
      return { taskId, label };
    },
    [upsertTask, watchTask]
  );

  const updateTask = React.useCallback(
    (id: string, updater: (snapshot: TaskSnapshot) => TaskSnapshot) => {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = updater(prev[idx]);
        return next;
      });
    },
    []
  );

  const registerAiTaggingHandlers = React.useCallback(
    (handlers: AiTaggingHandlers) => {
      aiHandlersRef.current = handlers;
      return () => {
        if (aiHandlersRef.current === handlers) aiHandlersRef.current = null;
      };
    },
    []
  );

  /**
   * Run a bulk AI-tagging job. The task is owned entirely client-side
   * (no /api/tasks row): we keep state in the task-center's tasks list
   * so the existing TaskCenter UI can render progress alongside server
   * tasks. Per-session updates flow into the annotation cache through
   * the registered handlers, so the UI scrolls in real-time.
   */
  const submitAiTaggingTask = React.useCallback(
    async ({ payload, label }: SubmitAiTaggingArgs) => {
      const taskId = `ai-tag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ac = new AbortController();
      abortRefs.current.set(taskId, ac);

      const initialState: AiTaggingTaskState = {
        total: payload.sessionKeys.length,
        done: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        items: [],
        strategy: payload.options?.strategy || "auto",
        provider: payload.options?.provider,
        model: payload.options?.model,
      };

      upsertTask({
        id: taskId,
        type: "ai-tagging",
        status: "running",
        label,
        createdAt: Date.now(),
        aiTagging: initialState,
      });
      setSidebarOpen(true);

      const handlers = aiHandlersRef.current;
      let lastState: AiTaggingTaskState = initialState;

      const recordProgress = (event: AiTaggingProgress) => {
        const item: AiTaggingTaskItem = {
          sessionKey: event.sessionKey,
          status: event.status,
          tags: event.allTags,
          reason: event.reason,
          error: event.error,
        };
        updateTask(taskId, (snap) => {
          const prevState = snap.aiTagging || initialState;
          const newState: AiTaggingTaskState = {
            ...prevState,
            done: event.index,
            total: event.total,
            updated: prevState.updated + (event.status === "ok" ? 1 : 0),
            skipped: prevState.skipped + (event.status === "skip" ? 1 : 0),
            failed: prevState.failed + (event.status === "fail" ? 1 : 0),
            currentSessionKey: event.sessionKey,
            // Cap items list to a sane size to keep the UI light;
            // failures are kept in full because they're rarer.
            items: [...prevState.items, item].slice(-200),
          };
          lastState = newState;
          return { ...snap, aiTagging: newState };
        });
        if (
          event.status === "ok" &&
          handlers &&
          event.allTags &&
          event.tags &&
          typeof event.aiTaggedAt === "number"
        ) {
          handlers.onSessionTagged(event.sessionKey, {
            allTags: event.allTags,
            aiTags: event.tags,
            aiTaggedAt: event.aiTaggedAt,
          });
        }
      };

      (async () => {
        try {
          for await (const evt of runAiTagging(payload, { signal: ac.signal })) {
            if (evt.type === "progress") {
              recordProgress(evt.data);
            } else if (evt.type === "done") {
              const finalState: AiTaggingTaskState = {
                ...lastState,
                updated: evt.data.updated,
                skipped: evt.data.skipped,
                failed: evt.data.failed,
                total: evt.data.total,
                aborted: evt.data.aborted,
                currentSessionKey: undefined,
              };
              updateTask(taskId, (snap) => ({
                ...snap,
                status: "done",
                aiTagging: finalState,
              }));
              if (handlers?.onTagSummary && evt.data.tags) {
                handlers.onTagSummary(evt.data.tags);
              }
              if (evt.data.aborted) handlers?.onAbort?.(finalState);
              else handlers?.onComplete?.(finalState);
              break;
            }
          }
        } catch (err) {
          // Two flavours: user-aborted (DOMException name === "AbortError")
          // and network/parse failures. Both end the task, but the former
          // shouldn't surface as a failure toast.
          const isAbort = (err as { name?: string })?.name === "AbortError" || ac.signal.aborted;
          if (isAbort) {
            updateTask(taskId, (snap) => ({
              ...snap,
              status: "done",
              aiTagging: { ...(snap.aiTagging || initialState), aborted: true },
            }));
            handlers?.onAbort?.({ ...lastState, aborted: true });
          } else {
            const message = err instanceof Error ? err.message : String(err);
            updateTask(taskId, (snap) => ({
              ...snap,
              status: "failed",
              error: message,
            }));
            handlers?.onError?.(message);
          }
        } finally {
          abortRefs.current.delete(taskId);
        }
      })();

      return taskId;
    },
    [updateTask, upsertTask]
  );

  const dismissTask = React.useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    const ac = abortRefs.current.get(id);
    if (ac) {
      ac.abort();
      abortRefs.current.delete(id);
    }
  }, []);

  // On mount, recover any in-flight tasks from a page refresh
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const serverTasks = await fetchTasks();
        if (cancelled) return;
        for (const task of serverTasks) {
          upsertTask(task);
          if (task.status === "pending" || task.status === "running") {
            watchTask(task.id);
          }
        }
      } catch {
        // server might not be running yet
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [upsertTask, watchTask]);

  // Cleanup all SSE connections on unmount
  React.useEffect(() => {
    return () => {
      for (const ac of abortRefs.current.values()) ac.abort();
      abortRefs.current.clear();
    };
  }, []);

  const value = React.useMemo<TaskCenterContextValue>(
    () => ({
      tasks,
      activeCount,
      sidebarOpen,
      setSidebarOpen,
      toggleSidebar,
      submitTask,
      submitAiTaggingTask,
      registerAiTaggingHandlers,
      dismissTask,
    }),
    [
      tasks,
      activeCount,
      sidebarOpen,
      submitTask,
      submitAiTaggingTask,
      registerAiTaggingHandlers,
      dismissTask,
      toggleSidebar,
    ]
  );

  return (
    <TaskCenterContext.Provider value={value}>
      {children}
    </TaskCenterContext.Provider>
  );
}

export function useTaskCenter(): TaskCenterContextValue {
  const ctx = React.useContext(TaskCenterContext);
  if (!ctx) {
    throw new Error("useTaskCenter must be used within <TaskCenterProvider>");
  }
  return ctx;
}
