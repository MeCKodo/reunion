import * as React from "react";
import { cn } from "@/lib/utils";

interface ChipButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
}

const ChipButton = React.forwardRef<HTMLButtonElement, ChipButtonProps>(
  ({ active, icon, trailing, className, children, type, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
          active
            ? "border-foreground bg-foreground text-background"
            : "border-border-strong bg-surface text-muted-foreground hover:text-foreground hover:bg-background-soft",
          className
        )}
        {...rest}
      >
        {icon}
        <span className="truncate max-w-[100px]">{children}</span>
        {trailing}
      </button>
    );
  }
);
ChipButton.displayName = "ChipButton";

export { ChipButton };
export type { ChipButtonProps };
