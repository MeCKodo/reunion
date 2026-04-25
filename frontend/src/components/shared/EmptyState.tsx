import * as React from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: React.ReactNode;
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

/**
 * Editorial empty state. Uses serif headline + quiet mono eyebrow.
 */
function EmptyState({ icon, eyebrow, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col items-center justify-center px-8 py-12 text-center",
        className
      )}
    >
      {icon ? (
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground">
          {icon}
        </div>
      ) : null}
      {eyebrow ? (
        <p className="mb-3 font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
          {eyebrow}
        </p>
      ) : null}
      <h3 className="font-serif text-2xl font-medium leading-tight text-foreground">
        {title}
      </h3>
      {description ? (
        <p className="mt-3 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-6 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

export { EmptyState };
