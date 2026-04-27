import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  FileText,
  FolderOpen,
  Loader2,
  ListTodo,
  X,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTaskCenter } from "@/lib/task-center";
import { postOpenPath, type TaskSnapshot } from "@/lib/api";
import { useToast } from "@/components/ui/toast";

export function TaskCenter() {
  const { tasks, activeCount, sidebarOpen, setSidebarOpen } = useTaskCenter();
  const { push: pushToast } = useToast();

  const notifiedRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    for (const task of tasks) {
      if (task.status === "done" && !notifiedRef.current.has(task.id)) {
        notifiedRef.current.add(task.id);
        pushToast(
          <span className="flex flex-col gap-1">
            <span className="font-semibold">{task.label}</span>
            <span className="text-muted-foreground">生成完成</span>
            {task.result?.absolutePath ? (
              <code className="break-all rounded bg-background-soft px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {task.result.absolutePath}
              </code>
            ) : null}
          </span>,
          "success",
          8000
        );
      }
      if (task.status === "failed" && !notifiedRef.current.has(task.id)) {
        notifiedRef.current.add(task.id);
        pushToast(
          <span className="flex flex-col gap-1">
            <span className="font-semibold">{task.label}</span>
            <span>{task.error || "任务失败"}</span>
          </span>,
          "error",
          8000
        );
      }
    }
  }, [tasks, pushToast]);

  return (
    <>
      {/* Backdrop for mobile */}
      {sidebarOpen ? (
        <div
          onClick={() => setSidebarOpen(false)}
          aria-hidden
          className="fixed inset-0 z-[100] bg-foreground/30 backdrop-blur-[2px] animate-fade-in lg:hidden"
        />
      ) : null}

      {/* Sidebar panel */}
      <div
        className={cn(
          "fixed inset-y-0 right-0 z-[110] flex w-[min(380px,90vw)] flex-col border-l border-border bg-surface shadow-editorial-lg",
          "transition-transform duration-200 ease-out",
          sidebarOpen ? "translate-x-0" : "translate-x-full"
        )}
      >
        {/* Header */}
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 shrink-0">
          <div className="flex items-center gap-2.5 text-sm font-semibold text-foreground">
            <ListTodo className="h-4.5 w-4.5 text-muted-foreground" />
            <span>任务中心</span>
            {activeCount > 0 ? (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">
                {activeCount}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="rounded-md p-1 text-muted-foreground hover:bg-background-soft hover:text-foreground transition-colors"
            aria-label="关闭任务面板"
          >
            <ChevronRight className="h-4.5 w-4.5" />
          </button>
        </header>

        {/* Task list */}
        <div className="flex-1 overflow-y-auto">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
              <ListTodo className="h-10 w-10 opacity-30" />
              <p className="text-sm">暂无进行中的任务</p>
              <p className="text-xs opacity-60 text-center leading-relaxed px-6">AI 生成、导出等耗时操作会在这里<br/>显示进度和结果</p>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {tasks.map((task) => (
                <TaskItem key={task.id} task={task} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Floating toggle button — always visible when sidebar is closed */
export function TaskCenterToggle() {
  const { tasks, activeCount, sidebarOpen, toggleSidebar } = useTaskCenter();

  if (tasks.length === 0 && !sidebarOpen) return null;

  return (
    <button
      type="button"
      onClick={toggleSidebar}
      className={cn(
        "fixed bottom-4 right-4 z-[90] inline-flex h-10 items-center gap-2 rounded-full border border-border bg-surface pl-3 pr-3.5 shadow-editorial-lg",
        "transition-all hover:bg-background-soft",
        activeCount > 0 && "border-primary/50",
        sidebarOpen && "opacity-0 pointer-events-none"
      )}
      aria-label={sidebarOpen ? "关闭任务面板" : "打开任务面板"}
    >
      <ListTodo className={cn("h-4.5 w-4.5", activeCount > 0 ? "text-primary" : "text-muted-foreground")} />
      {activeCount > 0 ? (
        <span className="text-[12px] font-semibold text-primary">{activeCount} 进行中</span>
      ) : (
        <span className="text-[12px] text-muted-foreground">{tasks.length} 任务</span>
      )}
    </button>
  );
}

function TaskItem({ task }: { task: TaskSnapshot }) {
  const { dismissTask } = useTaskCenter();
  const { push: pushToast } = useToast();
  const isActive = task.status === "pending" || task.status === "running";

  const handleOpen = async (absPath: string) => {
    try {
      await postOpenPath(absPath);
    } catch (err) {
      pushToast(`打开失败: ${String(err)}`, "error");
    }
  };

  const handleReveal = async (absPath: string) => {
    try {
      const parent = absPath.replace(/\/[^/]+$/, "");
      await postOpenPath(parent);
    } catch (err) {
      pushToast(`打开失败: ${String(err)}`, "error");
    }
  };

  return (
    <div className="group px-4 py-3">
      {/* Header row */}
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0">
          <TaskStatusIcon status={task.status} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-1.5">
            <div className="text-[13px] font-medium text-foreground leading-snug break-all">
              {task.label}
            </div>
            {!isActive ? (
              <button
                type="button"
                onClick={() => dismissTask(task.id)}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
                aria-label="移除"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>

          {/* Status text */}
          <div className="mt-1 flex items-center gap-2 text-[11.5px] text-muted-foreground">
            <span>{task.progress?.detail || phaseLabel(task)}</span>
            {task.progress?.elapsedSec != null && task.progress.elapsedSec > 0 ? (
              <span className="inline-flex items-center gap-0.5">
                <Clock className="h-3 w-3" />
                {formatElapsed(task.progress.elapsedSec)}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Progress bar for active tasks */}
      {isActive ? (
        <div className="mt-2.5 ml-6.5">
          <TaskProgressBar task={task} />
        </div>
      ) : null}

      {/* Action buttons for completed tasks */}
      {task.status === "done" && task.result ? (
        <div className="mt-2.5 ml-6.5 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => handleOpen(task.result!.absolutePath)}
            className="inline-flex items-center gap-1 rounded border border-border-strong bg-background px-2 py-1 text-[11px] text-foreground hover:bg-background-soft transition-colors"
          >
            <FileText className="h-3 w-3" />
            打开文件
          </button>
          <button
            type="button"
            onClick={() => handleReveal(task.result!.absolutePath)}
            className="inline-flex items-center gap-1 rounded border border-border-strong bg-background px-2 py-1 text-[11px] text-foreground hover:bg-background-soft transition-colors"
          >
            <FolderOpen className="h-3 w-3" />
            在 Finder 中显示
          </button>
        </div>
      ) : null}

      {/* Error display */}
      {task.status === "failed" && task.error ? (
        <div className="mt-2 ml-6.5 rounded bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive leading-relaxed">
          {task.error}
        </div>
      ) : null}
    </div>
  );
}

function TaskProgressBar({ task }: { task: TaskSnapshot }) {
  const chars = task.progress?.generatedChars ?? 0;
  const isGenerating = task.progress?.phase === "generating";
  const isWriting = task.progress?.phase === "writing";

  const estimatedTotal = 2000;
  const progressPct = isWriting
    ? 95
    : Math.min(90, Math.round((chars / estimatedTotal) * 90));

  return (
    <div className="space-y-1.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/60">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500 ease-out",
            isGenerating && "bg-primary",
            isWriting && "bg-primary",
            task.status === "pending" && "bg-muted-foreground/40"
          )}
          style={{ width: `${progressPct}%` }}
        />
      </div>
      {isGenerating && chars > 0 ? (
        <div className="text-[10.5px] text-muted-foreground/70 tabular-nums">
          已生成 {chars.toLocaleString()} 字符
        </div>
      ) : null}
    </div>
  );
}

function TaskStatusIcon({ status }: { status: TaskSnapshot["status"] }) {
  if (status === "running" || status === "pending") {
    return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  }
  if (status === "done") {
    return <CheckCircle2 className="h-4 w-4 text-primary" />;
  }
  if (status === "failed") {
    return <AlertCircle className="h-4 w-4 text-destructive" />;
  }
  return <Loader2 className="h-4 w-4 text-muted-foreground" />;
}

function phaseLabel(task: TaskSnapshot): string {
  switch (task.status) {
    case "pending": return "排队中…";
    case "running": return task.progress?.phase === "writing" ? "写入文件…" : "AI 生成中…";
    case "done": return "完成";
    case "failed": return "失败";
    default: return "";
  }
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s > 0 ? `${s}s` : ""}`;
}
