import * as React from "react";
import { Copy, Download, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface MoreActionsMenuProps {
  /** Display title shown in the delete confirmation prompt; helps the user
   *  double-check they're nuking the right conversation when many tabs are
   *  open. */
  sessionTitle: string;
  /** Copy the current session_id to clipboard. Parent surfaces a toast. */
  onCopySessionId: () => void;
  /** Trigger a raw JSONL download for the currently open session. The
   *  promise resolves once the download has been kicked off (or rejected
   *  with a user-facing error). */
  onDownloadJsonl: () => Promise<void>;
  /** Permanently delete the session. Promise stays pending until the
   *  backend round-trip + state cleanup finishes so the spinner stays in
   *  sync. */
  onDeleteSession: () => Promise<void>;
}

type View = "menu" | "confirm-delete";
type BusyKey = "" | "jsonl" | "delete";

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  busy?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}

function MenuItem({ icon, label, hint, busy, disabled, destructive, onClick }: MenuItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
        destructive
          ? "text-destructive hover:bg-destructive/10"
          : "hover:bg-background-soft",
        "disabled:cursor-not-allowed disabled:opacity-60"
      )}
    >
      <span
        className={cn(
          "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center",
          destructive ? "text-destructive/80" : "text-muted-foreground"
        )}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : icon}
      </span>
      <span className="flex flex-col gap-0.5">
        <span
          className={cn(
            "font-medium",
            destructive ? "text-destructive" : "text-foreground"
          )}
        >
          {label}
        </span>
        {hint ? (
          <span
            className={cn(
              "text-[11.5px] leading-snug",
              destructive ? "text-destructive/70" : "text-muted-foreground"
            )}
          >
            {hint}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * Catch-all dropdown for secondary session actions: copy session id,
 * download raw JSONL, and the destructive "permanently delete". Delete uses
 * a two-step confirmation embedded in the same popover so we don't have to
 * juggle nested portals.
 */
function MoreActionsMenu({
  sessionTitle,
  onCopySessionId,
  onDownloadJsonl,
  onDeleteSession,
}: MoreActionsMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<View>("menu");
  const [busyKey, setBusyKey] = React.useState<BusyKey>("");

  // Reset to the top-level menu whenever the popover gets dismissed (any way
  // — outside click, ESC, after a successful action). Avoids the user
  // re-opening straight into a stale "are you sure?" view.
  React.useEffect(() => {
    if (!open) {
      setView("menu");
      setBusyKey("");
    }
  }, [open]);

  const handleCopy = () => {
    if (busyKey) return;
    onCopySessionId();
    setOpen(false);
  };

  const handleDownloadJsonl = async () => {
    if (busyKey) return;
    setBusyKey("jsonl");
    try {
      await onDownloadJsonl();
      setOpen(false);
    } catch {
      // Parent surfaces the error via toast; we just unlock the button so
      // the user can retry without reopening the popover.
    } finally {
      setBusyKey("");
    }
  };

  const handleConfirmDelete = async () => {
    if (busyKey) return;
    setBusyKey("delete");
    try {
      await onDeleteSession();
      setOpen(false);
    } catch {
      // Same as above — keep the confirmation visible so the user can retry
      // or cancel.
    } finally {
      setBusyKey("");
    }
  };

  return (
    <Popover open={open} onOpenChange={(next) => (busyKey ? null : setOpen(next))}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className={cn("shrink-0", open && "bg-background-soft")}
          title={t("more.menuTooltip")}
          aria-label={t("more.menuTooltip")}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
          <span className="hidden md:inline">{t("more.menuLabel")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[280px] p-1.5"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {view === "menu" ? (
          <div className="flex flex-col">
            <MenuItem
              icon={<Copy className="h-3.5 w-3.5" />}
              label={t("more.copySessionId")}
              hint={t("more.copySessionIdHint")}
              onClick={handleCopy}
            />
            <MenuItem
              icon={<Download className="h-3.5 w-3.5" />}
              label={t("more.downloadJsonl")}
              hint={t("more.downloadJsonlHint")}
              busy={busyKey === "jsonl"}
              disabled={busyKey === "jsonl"}
              onClick={handleDownloadJsonl}
            />
            {/* Visual divider separates safe from destructive actions. */}
            <div className="my-1 border-t border-border" />
            <MenuItem
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label={t("more.deleteSession")}
              hint={t("more.deleteSessionHint")}
              destructive
              disabled={Boolean(busyKey)}
              onClick={() => setView("confirm-delete")}
            />
          </div>
        ) : (
          <div className="space-y-3 p-2 text-[13px]">
            <div className="space-y-1">
              <div className="font-semibold text-foreground">{t("delete.confirmTitle")}</div>
              <div className="text-muted-foreground leading-snug">
                {t("delete.confirmBody")}
              </div>
              <div
                className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80"
                title={sessionTitle}
              >
                {sessionTitle}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setView("menu")}
                disabled={busyKey === "delete"}
              >
                {t("delete.confirmCancel")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={handleConfirmDelete}
                disabled={busyKey === "delete"}
              >
                {busyKey === "delete" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                <span>
                  {busyKey === "delete" ? t("delete.deleting") : t("delete.permanentDelete")}
                </span>
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export { MoreActionsMenu };
