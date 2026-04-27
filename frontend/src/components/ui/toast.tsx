import * as React from "react";
import { AlertCircle, CheckCircle2, Info, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastTone = "default" | "success" | "error" | "info" | "loading";

export interface ToastRecord {
  id: string;
  message: React.ReactNode;
  tone: ToastTone;
  createdAt: number;
  timeoutMs?: number;
}

interface ToastContextValue {
  toasts: ToastRecord[];
  push: (message: React.ReactNode, tone?: ToastTone, timeoutMs?: number) => string;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([]);
  const timersRef = React.useRef<Record<string, number>>({});

  const dismiss = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current[id];
    if (timer) {
      window.clearTimeout(timer);
      delete timersRef.current[id];
    }
  }, []);

  const push = React.useCallback(
    (message: React.ReactNode, tone: ToastTone = "default", timeoutMs?: number) => {
      const id = Math.random().toString(36).slice(2, 10);
      const duration = timeoutMs ?? (tone === "error" ? 6000 : tone === "loading" ? 0 : 3200);
      setToasts((prev) => [...prev, { id, message, tone, createdAt: Date.now(), timeoutMs: duration }]);
      if (duration > 0) {
        timersRef.current[id] = window.setTimeout(() => dismiss(id), duration);
      }
      return id;
    },
    [dismiss]
  );

  React.useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach((timer) => window.clearTimeout(timer));
      timersRef.current = {};
    };
  }, []);

  const value = React.useMemo<ToastContextValue>(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within <ToastProvider>");
  }
  return ctx;
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastRecord[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[120] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </div>
  );
}

function toneStyles(tone: ToastTone) {
  switch (tone) {
    case "success":
      return "border-primary/40 bg-surface text-foreground";
    case "error":
      return "border-destructive/50 bg-surface text-foreground";
    case "info":
      return "border-accent/40 bg-surface text-foreground";
    case "loading":
      return "border-border bg-surface text-foreground";
    default:
      return "border-border bg-surface text-foreground";
  }
}

function ToastIcon({ tone }: { tone: ToastTone }) {
  const className = "h-4 w-4 shrink-0 mt-0.5";
  if (tone === "success") return <CheckCircle2 className={cn(className, "text-primary")} />;
  if (tone === "error") return <AlertCircle className={cn(className, "text-destructive")} />;
  if (tone === "loading") return <Loader2 className={cn(className, "animate-spin text-muted-foreground")} />;
  return <Info className={cn(className, "text-accent")} />;
}

function ToastItem({ toast, onDismiss }: { toast: ToastRecord; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 shadow-editorial-lg animate-slide-up",
        toneStyles(toast.tone)
      )}
    >
      <ToastIcon tone={toast.tone} />
      <div className="flex-1 text-[13px] leading-snug">{toast.message}</div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="mt-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-background-soft hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
