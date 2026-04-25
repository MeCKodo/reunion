import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 border transition-colors whitespace-nowrap",
  {
    variants: {
      variant: {
        default:
          "rounded-full border-border bg-background-soft text-muted-foreground",
        accent:
          "rounded-full border-accent/35 bg-accent-soft text-accent",
        outline:
          "rounded-full border-border-strong bg-transparent text-foreground",
        muted:
          "rounded-full border-transparent bg-muted text-muted-foreground",
        primary:
          "rounded-full border-transparent bg-primary text-primary-foreground",
        mono:
          "rounded-sm border-border-strong bg-transparent text-muted-foreground font-mono uppercase tracking-[0.08em] before:content-['['] after:content-[']'] before:mr-0.5 after:ml-0.5 before:opacity-60 after:opacity-60",
      },
      size: {
        default: "text-[11px] px-2.5 py-0.5 font-medium",
        sm: "text-[10px] px-2 py-0 font-medium",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants };
