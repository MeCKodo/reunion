import * as React from "react";
import { Download } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExportKind } from "@/lib/api";

interface ExportActionsProps {
  // Kept for API compatibility while the actions are stubbed out.
  // We intentionally don't invoke this — the buttons are visual-only
  // until the backend export feature lands.
  onExport: (kind: ExportKind) => void;
  loadingKind: "" | ExportKind;
}

// Smart Rules / Smart Skill are not wired up yet. We render the slots
// as visually-disabled buttons (so users can see what's coming) and
// surface the status with a custom hover tooltip. We avoid the native
// `disabled` attribute because Chromium swallows pointer events on
// disabled buttons, which would also kill the tooltip's hover trigger.
function ComingSoonAction({ label, shortLabel }: { label: string; shortLabel: string }) {
  return (
    <div className="group/coming relative shrink-0">
      <button
        type="button"
        aria-disabled="true"
        tabIndex={-1}
        onClick={(event) => event.preventDefault()}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2.5 text-[12px] font-medium text-muted-foreground/70",
          "cursor-not-allowed select-none",
          "transition-colors hover:bg-secondary/60 hover:text-muted-foreground"
        )}
      >
        <Download className="h-3.5 w-3.5" />
        <span className="hidden md:inline">{label}</span>
        <span className="md:hidden">{shortLabel}</span>
      </button>
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute right-0 top-full z-50 mt-1.5 hidden whitespace-nowrap",
          "rounded-md bg-foreground px-2 py-1 text-[11px] font-medium leading-snug text-background shadow-lg",
          "group-hover/coming:block"
        )}
      >
        Coming soon
      </span>
    </div>
  );
}

function ExportActions(_props: ExportActionsProps) {
  return (
    <>
      <ComingSoonAction label="Smart Rules" shortLabel="Rules" />
      <ComingSoonAction label="Smart Skill" shortLabel="Skill" />
    </>
  );
}

export { ExportActions };
