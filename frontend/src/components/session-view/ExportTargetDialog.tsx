import * as React from "react";
import {
  AlertTriangle,
  Check,
  ChevronUp,
  Folder,
  FolderGit2,
  FolderOpen,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import {
  fetchExportTarget,
  fetchFsList,
  postExportWrite,
  type ExportKind,
  type ExportTarget,
  type FsListResponse,
} from "@/lib/api";

interface ExportTargetDialogProps {
  open: boolean;
  onClose: () => void;
  sessionKey: string;
  kind: ExportKind;
  /** Called once a write succeeds with the absolute path that was written. */
  onWritten: (info: { absolutePath: string; relativePath: string; mode: string }) => void;
  /** Called when the user confirms the dialog but we should fall back to a
   *  download instead (e.g. they explicitly asked to download). */
  onFallbackDownload?: () => void;
}

type WriteState = "idle" | "writing" | "confirm-overwrite";

export function ExportTargetDialog({
  open,
  onClose,
  sessionKey,
  kind,
  onWritten,
}: ExportTargetDialogProps) {
  const [target, setTarget] = React.useState<ExportTarget | null>(null);
  const [loadingTarget, setLoadingTarget] = React.useState(false);
  const [picker, setPicker] = React.useState<{
    open: boolean;
    listing: FsListResponse | null;
    cwd: string;
    loading: boolean;
    error?: string;
  }>({ open: false, listing: null, cwd: "", loading: false });
  const [relPath, setRelPath] = React.useState("");
  const [writeState, setWriteState] = React.useState<WriteState>("idle");
  const [writeError, setWriteError] = React.useState<string | null>(null);

  // Reset and (re)fetch the target preview every time the dialog opens or
  // the kind switches. This keeps the preview accurate for the same session
  // exporting Rules vs Skill in succession.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingTarget(true);
    setWriteError(null);
    setWriteState("idle");
    (async () => {
      try {
        const data = await fetchExportTarget(sessionKey, kind);
        if (cancelled) return;
        setTarget(data);
        setRelPath(data.relativePath);
      } catch (error) {
        if (!cancelled) {
          setWriteError(`Could not preview target: ${String(error)}`);
        }
      } finally {
        if (!cancelled) setLoadingTarget(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionKey, kind]);

  const refreshTarget = React.useCallback(
    async (overridePath?: string) => {
      setLoadingTarget(true);
      try {
        const data = await fetchExportTarget(sessionKey, kind, overridePath);
        setTarget(data);
        // Don't clobber a relPath the user has been editing, but if they
        // haven't changed from the last suggestion, accept the new default.
        setRelPath((current) =>
          current === target?.relativePath || !current ? data.relativePath : current
        );
        setWriteError(null);
      } catch (error) {
        setWriteError(`Could not preview target: ${String(error)}`);
      } finally {
        setLoadingTarget(false);
      }
    },
    [sessionKey, kind, target?.relativePath]
  );

  const openPicker = React.useCallback(
    async (initialPath?: string) => {
      const startingPath = initialPath || target?.repo.path || undefined;
      setPicker((s) => ({ ...s, open: true, loading: true, error: undefined }));
      try {
        const listing = await fetchFsList(startingPath);
        setPicker({
          open: true,
          listing,
          cwd: listing.path,
          loading: false,
        });
      } catch (error) {
        setPicker({
          open: true,
          listing: null,
          cwd: startingPath || "",
          loading: false,
          error: String(error),
        });
      }
    },
    [target?.repo.path]
  );

  const navigatePicker = React.useCallback(async (path: string) => {
    setPicker((s) => ({ ...s, loading: true, error: undefined }));
    try {
      const listing = await fetchFsList(path);
      setPicker({
        open: true,
        listing,
        cwd: listing.path,
        loading: false,
      });
    } catch (error) {
      setPicker((s) => ({ ...s, loading: false, error: String(error) }));
    }
  }, []);

  const choosePickerPath = React.useCallback(
    async (path: string) => {
      setPicker((s) => ({ ...s, open: false }));
      await refreshTarget(path);
    },
    [refreshTarget]
  );

  const performWrite = React.useCallback(
    async (overwrite: boolean) => {
      if (!target?.repo.path) return;
      setWriteState("writing");
      setWriteError(null);
      try {
        const result = await postExportWrite({
          sessionKey,
          kind,
          targetDir: target.repo.path,
          relativePath: relPath,
          overwrite,
          rememberMapping: true,
        });
        onWritten({
          absolutePath: result.absolutePath,
          relativePath: result.relativePath,
          mode: result.mode,
        });
      } catch (error) {
        const err = error as Error & { code?: string };
        if (err.code === "EEXIST") {
          setWriteState("confirm-overwrite");
          setWriteError("A file with this name already exists at the target path.");
          return;
        }
        setWriteState("idle");
        setWriteError(String(error));
      }
    },
    [target?.repo.path, sessionKey, kind, relPath, onWritten]
  );

  const repoPath = target?.repo.path || null;
  const repoSourceLabel = repoSourceText(target?.repo.source);
  const writeBusy = writeState === "writing";

  return (
    <Modal
      open={open}
      onClose={writeBusy ? () => undefined : onClose}
      title={kind === "skill" ? "Write Smart Skill to repo" : "Write Smart Rule to repo"}
      description={
        <>
          We&apos;ll generate the markdown via your default AI provider and drop it
          straight into the project repository. Edit the destination below if our guess
          isn&apos;t quite right.
        </>
      }
      sizeClassName="max-w-2xl"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={writeBusy}>
            Cancel
          </Button>
          {writeState === "confirm-overwrite" ? (
            <Button
              variant="destructive"
              onClick={() => performWrite(true)}
              disabled={writeBusy}
            >
              Overwrite anyway
            </Button>
          ) : (
            <Button
              onClick={() => performWrite(false)}
              disabled={writeBusy || !repoPath || loadingTarget}
            >
              {writeBusy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <FolderOpen className="h-4 w-4" />
                  Generate &amp; write
                </>
              )}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4 text-sm">
        <section>
          <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            Repository
          </h3>
          <div className="mt-2 rounded-md border border-border bg-background-soft px-3 py-2.5">
            {loadingTarget ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Looking up the project repo for this session…
              </div>
            ) : repoPath ? (
              <div className="flex items-start gap-2">
                {target?.repo.isGitRepo ? (
                  <FolderGit2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <Folder className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="break-all font-mono text-[12.5px] text-foreground">
                    {repoPath}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                    {repoSourceLabel}
                    {!target?.repo.isGitRepo
                      ? " · not a git repo (you can still write here)"
                      : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openPicker()}
                  disabled={writeBusy}
                >
                  Change…
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2 text-muted-foreground">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <span>
                    Couldn&apos;t auto-detect this session&apos;s repo. Pick a folder
                    manually.
                  </span>
                </div>
                <Button size="sm" variant="default" onClick={() => openPicker()}>
                  Pick a folder…
                </Button>
              </div>
            )}
          </div>
        </section>

        <section>
          <label className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            File path inside repo
          </label>
          <Input
            value={relPath}
            onChange={(event) => setRelPath(event.target.value)}
            disabled={writeBusy || !repoPath}
            placeholder=".cursor/rules/example.mdc"
            className="mt-2 font-mono text-[12.5px]"
          />
          {repoPath ? (
            <div className="mt-1.5 break-all font-mono text-[11.5px] text-muted-foreground">
              → {joinPath(repoPath, relPath)}
            </div>
          ) : null}
          {target?.fileExists && writeState !== "confirm-overwrite" ? (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              File already exists. We&apos;ll ask before overwriting.
            </div>
          ) : null}
        </section>

        {writeError ? (
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-[12.5px]",
              writeState === "confirm-overwrite"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "border-destructive/40 bg-destructive/10 text-destructive"
            )}
          >
            {writeError}
          </div>
        ) : null}
      </div>

      <FsBrowserOverlay
        state={picker}
        onClose={() => setPicker((s) => ({ ...s, open: false }))}
        onNavigate={navigatePicker}
        onChoose={choosePickerPath}
      />
    </Modal>
  );
}

function repoSourceText(source: ExportTarget["repo"]["source"] | undefined): string {
  switch (source) {
    case "mapping":
      return "Remembered from a previous export";
    case "session":
      return "Inferred from the session's working directory";
    case "decoded":
      return "Decoded from the Cursor project name";
    case "none":
      return "No reliable hint — pick manually";
    default:
      return "";
  }
}

function joinPath(dir: string, rel: string): string {
  if (!rel) return dir;
  const trimmedDir = dir.replace(/[\\/]+$/, "");
  const trimmedRel = rel.replace(/^[\\/]+/, "");
  return `${trimmedDir}/${trimmedRel}`;
}

// ---------------------------------------------------------------------------
// FsBrowserOverlay: an inline overlay rendered above the export dialog so the
// user can navigate the filesystem to confirm or change the destination.
// ---------------------------------------------------------------------------

interface FsBrowserOverlayProps {
  state: {
    open: boolean;
    listing: FsListResponse | null;
    cwd: string;
    loading: boolean;
    error?: string;
  };
  onClose: () => void;
  onNavigate: (path: string) => void;
  onChoose: (path: string) => void;
}

function FsBrowserOverlay({ state, onClose, onNavigate, onChoose }: FsBrowserOverlayProps) {
  if (!state.open) return null;
  const { listing, cwd } = state;
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background/95 backdrop-blur-sm">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          disabled={state.loading}
          aria-label="Close folder picker"
        >
          ← Back
        </Button>
        <div className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
          {cwd || "—"}
        </div>
        {listing?.parent ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onNavigate(listing.parent!)}
            disabled={state.loading}
          >
            <ChevronUp className="h-3.5 w-3.5" />
            Up
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="default"
          onClick={() => onChoose(cwd)}
          disabled={state.loading || !cwd}
        >
          <Check className="h-3.5 w-3.5" />
          Use this folder
        </Button>
      </header>

      {listing && listing.bookmarks?.workspaces?.length ? (
        <div className="flex flex-wrap gap-1.5 border-b border-border bg-background-soft px-4 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            Quick:
          </span>
          <button
            type="button"
            onClick={() => onNavigate(listing.bookmarks.home)}
            className="rounded border border-border-strong px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-background hover:text-foreground"
          >
            ~ home
          </button>
          {listing.bookmarks.workspaces.map((wp) => (
            <button
              key={wp}
              type="button"
              onClick={() => onNavigate(wp)}
              className="rounded border border-border-strong px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-background hover:text-foreground"
            >
              {wp.split("/").pop()}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {state.loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : state.error ? (
          <div className="px-3 py-2 text-[12.5px] text-destructive">{state.error}</div>
        ) : listing && listing.entries.length === 0 ? (
          <div className="px-3 py-3 text-[12.5px] text-muted-foreground">
            No subfolders. Click &quot;Use this folder&quot; to pick {cwd}.
          </div>
        ) : (
          <ul className="flex flex-col">
            {listing?.entries
              .filter((e) => !e.hidden)
              .map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => onNavigate(entry.path)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-background-soft"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {entry.isGitRepo ? (
                        <FolderGit2 className="h-4 w-4 shrink-0 text-primary" />
                      ) : (
                        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{entry.name}</span>
                    </span>
                    {entry.isGitRepo ? (
                      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-primary">
                        git
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border bg-background-soft px-4 py-2 text-[11.5px] text-muted-foreground">
        <span>Hidden folders are filtered out for clarity.</span>
        {listing ? (
          <button
            type="button"
            onClick={() => onNavigate(listing.path)}
            className="inline-flex items-center gap-1 hover:text-foreground"
            aria-label="Refresh"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        ) : null}
      </footer>
    </div>
  );
}
