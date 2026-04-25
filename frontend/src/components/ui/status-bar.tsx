import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Bottom status bar in a quiet terminal/editorial aesthetic:
 *   NORMAL · 7 of 1,284 · indexed 2h ago
 *
 * Composed of <StatusBar> container + <StatusItem> slots. Use the `tone`
 * prop to nudge emphasis without leaving the mono/uppercase rhythm.
 */
const StatusBar = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "flex items-center gap-3 px-4 py-1.5 font-mono text-[10px] uppercase tracking-overline text-muted-foreground border-t border-border bg-background-soft/60",
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);
StatusBar.displayName = "StatusBar";

interface StatusItemProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: "default" | "accent" | "primary" | "muted";
}

const StatusItem = React.forwardRef<HTMLSpanElement, StatusItemProps>(
  ({ className, tone = "default", ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn(
          "inline-flex items-center gap-1.5",
          tone === "default" && "text-muted-foreground",
          tone === "accent" && "text-accent",
          tone === "primary" && "text-primary",
          tone === "muted" && "text-muted-foreground/60",
          className
        )}
        {...props}
      />
    );
  }
);
StatusItem.displayName = "StatusItem";

function StatusDivider({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("text-muted-foreground/40 select-none", className)}>
      ·
    </span>
  );
}

export { StatusBar, StatusItem, StatusDivider };
