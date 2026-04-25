import * as React from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DeleteSessionButtonProps {
  /** Display title shown in the confirmation prompt; helps the user double-check
   *  they're nuking the right conversation when many tabs are open. */
  title: string;
  /** Returns a promise that resolves once the deletion succeeds. The button
   *  stays in its busy state until the promise settles, so the parent can
   *  trigger network calls + state cleanup before the popover closes. */
  onConfirm: () => Promise<void>;
  disabled?: boolean;
}

function DeleteSessionButton({ title, onConfirm, disabled }: DeleteSessionButtonProps) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Reset busy state if the popover gets dismissed externally (e.g. clicking
  // outside) so a stale spinner never sticks around.
  React.useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } catch {
      // Parent surfaces the error via toast; we just unlock the buttons so
      // the user can retry or cancel.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(next) => (busy ? null : setOpen(next))}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          title="Delete this session (and its transcript file)"
          className={cn(
            "shrink-0 text-muted-foreground",
            "hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive",
            open && "border-destructive/50 bg-destructive/10 text-destructive"
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="hidden md:inline">Delete</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[300px] p-3 text-[13px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="font-semibold text-foreground">删除此会话？</div>
            <div className="text-muted-foreground leading-snug">
              将永久删除磁盘上的 transcript 文件（含关联子代理与本地标注），此操作不可撤销。
            </div>
            <div
              className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80"
              title={title}
            >
              {title}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleConfirm}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              <span>{busy ? "删除中…" : "永久删除"}</span>
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export { DeleteSessionButton };
