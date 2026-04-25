import * as React from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ScrollToTopProps {
  onClick: () => void;
  className?: string;
  label?: string;
}

function ScrollToTop({ onClick, className, label = "Back to top" }: ScrollToTopProps) {
  return (
    <Button
      onClick={onClick}
      size="sm"
      variant="secondary"
      className={cn(
        "fixed bottom-6 right-6 z-[80] h-10 px-3.5 rounded-full gap-1.5 shadow-editorial-lg",
        className
      )}
    >
      <ArrowUp className="h-4 w-4" />
      {label}
    </Button>
  );
}

export { ScrollToTop };
