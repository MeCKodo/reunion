import * as React from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Generic collapsible "noise" chip used for XML-shaped wrappers that the
 * agent CLI injects into messages (`<system-reminder>`, `<attached_files>`,
 * `<manually_attached_skills>`, etc.). The chip itself is low-emphasis — it
 * only exists to acknowledge that *something* was injected — and expands on
 * click to reveal the raw payload.
 *
 * Both `UserMessageBody` and `AssistantMessageBody` render through this so
 * the visual treatment of injection wrappers stays consistent across roles.
 */
export interface InjectionChipProps {
  icon: LucideIcon;
  label: string;
  summary?: string;
  raw: string;
  /**
   * Highlights the chip border with the accent ring color. We surface this
   * for chips whose collapsed payload contains a search match — without it
   * the search result count would drift higher than what's visible on screen.
   */
  matchesQuery?: boolean;
  /**
   * Slightly tighter density. Used by the assistant variant where chips
   * appear inside flowing prose instead of standing alone above a message.
   */
  compact?: boolean;
}

export function InjectionChip({
  icon: Icon,
  label,
  summary,
  raw,
  matchesQuery = false,
  compact = false,
}: InjectionChipProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <span
      className={cn(
        "inline-flex max-w-full flex-col items-stretch gap-1.5 align-top",
        compact ? "my-1" : "my-1.5"
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 self-start rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
          "border-border bg-background-soft text-muted-foreground",
          "hover:border-primary/50 hover:bg-primary-soft/40 hover:text-foreground",
          open && "border-primary/40 bg-primary-soft/30 text-foreground",
          matchesQuery && !open && "border-accent/60 ring-1 ring-accent/30"
        )}
        aria-expanded={open}
      >
        <Icon className="h-3 w-3 shrink-0" strokeWidth={2} />
        <span className="font-sans font-medium tracking-tight whitespace-nowrap">
          {label}
        </span>
        {summary ? (
          <>
            <span className="opacity-40">·</span>
            <span className="truncate">{summary}</span>
          </>
        ) : null}
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150",
            open && "rotate-90"
          )}
          strokeWidth={2}
        />
      </button>

      {open ? (
        <pre className="max-h-[400px] overflow-auto rounded-md border border-border bg-background-soft px-3 py-2.5 font-mono text-[11px] leading-[1.6] text-foreground/80 whitespace-pre-wrap break-words">
          {raw.trim()}
        </pre>
      ) : null}
    </span>
  );
}
