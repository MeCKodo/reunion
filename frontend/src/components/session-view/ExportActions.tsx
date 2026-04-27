import { Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExportKind } from "@/lib/api";

interface ExportActionsProps {
  onExport: (kind: ExportKind) => void;
  loadingKind: "" | ExportKind;
}

interface ExportButtonProps {
  label: string;
  shortLabel: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}

function ExportButton({ label, shortLabel, loading, disabled, onClick }: ExportButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={`${label} – generated with the default AI provider in Settings`}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2.5 text-[12px] font-medium text-foreground",
        "transition-colors hover:bg-background-soft hover:border-foreground/30",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-60"
      )}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
      <span className="hidden md:inline">{label}</span>
      <span className="md:hidden">{shortLabel}</span>
    </button>
  );
}

function ExportActions({ onExport, loadingKind }: ExportActionsProps) {
  const busy = loadingKind !== "";
  return (
    <>
      <ExportButton
        label="Smart Rules"
        shortLabel="Rules"
        loading={loadingKind === "rules"}
        disabled={busy}
        onClick={() => onExport("rules")}
      />
      <ExportButton
        label="Smart Skill"
        shortLabel="Skill"
        loading={loadingKind === "skill"}
        disabled={busy}
        onClick={() => onExport("skill")}
      />
    </>
  );
}

export { ExportActions };
