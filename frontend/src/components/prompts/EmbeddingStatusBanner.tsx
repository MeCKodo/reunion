import * as React from "react";
import { AlertCircle, CheckCircle2, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fetchEmbeddingsStatus,
  postEmbeddingsInit,
  postEmbeddingsRebuild,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import type { EmbeddingsState } from "@/lib/types";

interface EmbeddingStatusBannerProps {
  /** When non-zero, the banner can offer "Encode N prompts" once the model is ready. */
  totalPrompts: number;
  /** Notifies the parent when smart clustering becomes available — used so it
   * can refresh related UI (e.g. retry the similar list with embeddings). */
  onReady?: (state: EmbeddingsState) => void;
  className?: string;
}

const POLL_IDLE_MS = 4000;
const POLL_ACTIVE_MS = 1000;

/**
 * Small chrome above the prompt list that tells the user where smart
 * clustering currently stands. Hidden when ready and embeddings cover
 * everything; otherwise renders one of: enable CTA, download progress, encode
 * progress, or error retry.
 */
function EmbeddingStatusBanner({
  totalPrompts,
  onReady,
  className,
}: EmbeddingStatusBannerProps) {
  const [state, setState] = React.useState<EmbeddingsState | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const [requestError, setRequestError] = React.useState<string>("");
  const lastReadySignaledRef = React.useRef(false);

  const refresh = React.useCallback(async () => {
    try {
      const next = await fetchEmbeddingsStatus();
      setState(next);
      return next;
    } catch (error) {
      setRequestError(String(error));
      return null;
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void refresh();
    const tick = async () => {
      if (cancelled) return;
      const next = await refresh();
      const isActive =
        !!next &&
        (next.embedder.status === "downloading" ||
          next.embedder.status === "loading" ||
          next.rebuild.status === "running");
      window.setTimeout(tick, isActive ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    const handle = window.setTimeout(tick, POLL_IDLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [refresh]);

  React.useEffect(() => {
    if (!state) return;
    const ready =
      state.embedder.status === "ready" &&
      state.stored_count > 0 &&
      state.rebuild.status !== "running";
    if (ready && !lastReadySignaledRef.current) {
      lastReadySignaledRef.current = true;
      onReady?.(state);
    }
    if (!ready) lastReadySignaledRef.current = false;
  }, [state, onReady]);

  const handleEnable = React.useCallback(async () => {
    setBusy(true);
    setRequestError("");
    try {
      await postEmbeddingsInit();
      await refresh();
    } catch (error) {
      setRequestError(String(error));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleRebuild = React.useCallback(async () => {
    setBusy(true);
    setRequestError("");
    try {
      await postEmbeddingsRebuild();
      await refresh();
    } catch (error) {
      setRequestError(String(error));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (!state) return null;

  const { embedder, rebuild, stored_count: storedCount } = state;
  const fullyCovered =
    embedder.status === "ready" &&
    rebuild.status !== "running" &&
    storedCount >= totalPrompts &&
    totalPrompts > 0;

  // Once the model is ready and every prompt is embedded the banner is just
  // noise — collapse it. The user can still see status implicitly through
  // similarity results changing method.
  if (fullyCovered && dismissed) return null;
  if (fullyCovered) {
    return (
      <BannerShell tone="ready" className={className}>
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="font-mono text-[10.5px] uppercase tracking-overline text-muted-foreground">
          Smart clustering ready
        </span>
        <span className="text-[12px] text-foreground/80 truncate">
          {storedCount.toLocaleString()} prompt{storedCount === 1 ? "" : "s"} encoded
        </span>
        <button
          type="button"
          aria-label="dismiss"
          onClick={() => setDismissed(true)}
          className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-background-soft"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </BannerShell>
    );
  }

  if (embedder.status === "unsupported") {
    if (dismissed) return null;
    return (
      <BannerShell tone="info" className={className}>
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="font-mono text-[10.5px] uppercase tracking-overline text-muted-foreground">
          Lite mode
        </span>
        <span className="truncate text-[12px] text-foreground/80">
          {embedder.unsupported_reason ||
            "Smart clustering not supported on this platform — using lite mode."}
        </span>
        <button
          type="button"
          aria-label="dismiss"
          onClick={() => setDismissed(true)}
          className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-background-soft"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </BannerShell>
    );
  }

  if (embedder.status === "error") {
    return (
      <BannerShell tone="error" className={className}>
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span className="font-mono text-[10.5px] uppercase tracking-overline text-destructive">
          Smart clustering unavailable
        </span>
        <span className="truncate text-[12px] text-foreground/80">
          {embedder.error || "model load failed — falling back to lite mode"}
        </span>
        <Button variant="secondary" size="sm" onClick={() => void handleEnable()} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Retry
        </Button>
      </BannerShell>
    );
  }

  if (embedder.status === "downloading" || embedder.status === "loading") {
    const pct = Math.round(embedder.progress * 100);
    return (
      <BannerShell tone="info" className={className}>
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        <span className="font-mono text-[10.5px] uppercase tracking-overline text-muted-foreground">
          {embedder.status === "loading" ? "Loading model" : "Downloading model"}
        </span>
        <ProgressBar value={pct} />
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {pct}%
          {embedder.current_file ? ` · ${embedder.current_file.split("/").pop()}` : ""}
        </span>
      </BannerShell>
    );
  }

  if (rebuild.status === "running") {
    const pct = rebuild.total > 0 ? Math.round((rebuild.processed / rebuild.total) * 100) : 0;
    return (
      <BannerShell tone="info" className={className}>
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        <span className="font-mono text-[10.5px] uppercase tracking-overline text-muted-foreground">
          Encoding prompts
        </span>
        <ProgressBar value={pct} />
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {rebuild.processed.toLocaleString()}/{rebuild.total.toLocaleString()} · {pct}%
        </span>
      </BannerShell>
    );
  }

  if (rebuild.status === "error") {
    return (
      <BannerShell tone="error" className={className}>
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span className="font-mono text-[10.5px] uppercase tracking-overline text-destructive">
          Encoding failed
        </span>
        <span className="truncate text-[12px] text-foreground/80">{rebuild.error || "unknown error"}</span>
        <Button variant="secondary" size="sm" onClick={() => void handleRebuild()} disabled={busy}>
          Retry
        </Button>
      </BannerShell>
    );
  }

  // embedder.status === "ready" but no embeddings yet → prompt user to encode
  if (embedder.status === "ready") {
    const remaining = Math.max(0, totalPrompts - storedCount);
    return (
      <BannerShell tone="info" className={className}>
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="font-mono text-[10.5px] uppercase tracking-overline text-muted-foreground">
          Smart clustering
        </span>
        <span className="truncate text-[12px] text-foreground/80">
          Encode {remaining.toLocaleString()} prompt{remaining === 1 ? "" : "s"} to enable similarity search
        </span>
        <Button variant="accent" size="sm" onClick={() => void handleRebuild()} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          Encode now
        </Button>
      </BannerShell>
    );
  }

  // embedder.status === "idle"
  return (
    <BannerShell tone="info" className={className}>
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span className="font-mono text-[10.5px] uppercase tracking-overline text-muted-foreground">
        Smart clustering
      </span>
      <span className="truncate text-[12px] text-foreground/80">
        Download a small local model (~120MB) to enable semantic similarity. Falls back to lite mode otherwise.
      </span>
      <Button variant="accent" size="sm" onClick={() => void handleEnable()} disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        Enable
      </Button>
      {requestError ? (
        <span className="ml-2 truncate text-[11px] text-destructive">{requestError}</span>
      ) : null}
    </BannerShell>
  );
}

function BannerShell({
  tone,
  children,
  className,
}: {
  tone: "info" | "ready" | "error";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-4 py-2",
        tone === "info" && "border-border bg-background-soft",
        tone === "ready" && "border-border bg-background",
        tone === "error" && "border-destructive/30 bg-destructive/5",
        className
      )}
    >
      {children}
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-32 overflow-hidden rounded-full bg-border">
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-300"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export { EmbeddingStatusBanner };
