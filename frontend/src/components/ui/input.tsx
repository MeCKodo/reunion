import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.ComponentProps<"input"> {
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  wrapperClassName?: string;
}

const baseInputClass =
  "flex h-9 w-full rounded-md border border-border-strong bg-surface text-sm text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50";

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, leading, trailing, wrapperClassName, ...props }, ref) => {
    const hasAdornment = Boolean(leading || trailing);
    const input = (
      <input
        ref={ref}
        className={cn(
          baseInputClass,
          !hasAdornment && "px-3 py-1",
          hasAdornment && (leading ? "pl-9" : "pl-3"),
          hasAdornment && (trailing ? "pr-9" : "pr-3"),
          hasAdornment && "py-1",
          className
        )}
        {...props}
      />
    );

    if (!hasAdornment) return input;

    return (
      <div className={cn("relative flex items-center", wrapperClassName)}>
        {leading && (
          <span className="pointer-events-none absolute left-3 flex items-center text-muted-foreground">
            {leading}
          </span>
        )}
        {input}
        {trailing && (
          <span className="absolute right-3 flex items-center text-muted-foreground">
            {trailing}
          </span>
        )}
      </div>
    );
  }
);
Input.displayName = "Input";

export { Input };
