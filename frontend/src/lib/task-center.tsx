import * as React from "react";
import {
  createTask,
  fetchTasks,
  streamTask,
  type CreateTaskRequest,
  type TaskSnapshot,
} from "./api";

interface TaskCenterContextValue {
  tasks: TaskSnapshot[];
  activeCount: number;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  submitTask: (body: CreateTaskRequest) => Promise<{ taskId: string; label: string }>;
  dismissTask: (id: string) => void;
}

const TaskCenterContext = React.createContext<TaskCenterContextValue | null>(null);

export function TaskCenterProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = React.useState<TaskSnapshot[]>([]);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const abortRefs = React.useRef<Map<string, AbortController>>(new Map());

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
    () => ({ tasks, activeCount, sidebarOpen, setSidebarOpen, toggleSidebar, submitTask, dismissTask }),
    [tasks, activeCount, sidebarOpen, submitTask, dismissTask, toggleSidebar]
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
