import * as React from "react";
import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-muted/70",
        "before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer",
        "before:bg-[linear-gradient(90deg,transparent,hsl(var(--surface)/0.8),transparent)]",
        className
      )}
      {...props}
    />
  );
}

function SessionListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-3 px-3 py-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="pl-6 space-y-2">
            <Skeleton className="h-5 w-5/6" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SessionDetailSkeleton() {
  return (
    <div className="max-w-[980px] mx-auto p-6 space-y-5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className={cn("flex", i % 2 === 0 ? "justify-start" : "justify-end")}>
          <div className="max-w-[70%] space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-20 w-96" />
          </div>
        </div>
      ))}
    </div>
  );
}

export { Skeleton, SessionListSkeleton, SessionDetailSkeleton };
