import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Tags } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TagSummary } from "@/lib/types";
import { ChipButton } from "./ChipButton";

interface TagFilterPopoverProps {
  allTags: TagSummary[];
  selectedTags: string[];
  setSelectedTags: (next: string[] | ((prev: string[]) => string[])) => void;
  open: boolean;
  setOpen: (next: boolean) => void;
}

function TagFilterPopover({
  allTags,
  selectedTags,
  setSelectedTags,
  open,
  setOpen,
}: TagFilterPopoverProps) {
  const { t } = useTranslation();
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (event.target instanceof Node && wrapperRef.current.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [open, setOpen]);

  const activeCount = selectedTags.length;

  return (
    <div className="relative" ref={wrapperRef}>
      <ChipButton
        active={activeCount > 0}
        onClick={() => setOpen(!open)}
        title={t("tags.filterByTags")}
        icon={<Tags className="h-3 w-3" />}
        trailing={<ChevronDown className="h-3 w-3 opacity-60" />}
      >
        {activeCount > 0 ? t("tags.tagsCount", { count: activeCount }) : t("tags.tags")}
      </ChipButton>

      {open ? (
        <div className="absolute left-0 top-9 z-30 w-60 rounded-md border border-border bg-popover p-2 shadow-editorial-lg animate-slide-down">
          <div className="mb-1 flex items-center justify-between px-1 font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
            <span>{t("tags.orMatchToggle")}</span>
            {selectedTags.length > 0 ? (
              <button
                className="text-accent hover:underline"
                onClick={() => setSelectedTags([])}
              >
                {t("tags.clear")}
              </button>
            ) : null}
          </div>
          <div className="max-h-56 space-y-0.5 overflow-y-auto scrollbar-thin">
            {allTags.length === 0 ? (
              <div className="px-2 py-6 text-center text-[12px] text-muted-foreground">
                {t("tags.noTagsYet")}
              </div>
            ) : (
              allTags.map((item) => {
                const active = selectedTags.includes(item.tag);
                return (
                  <button
                    key={item.tag}
                    onClick={() =>
                      setSelectedTags((prev) =>
                        prev.includes(item.tag)
                          ? prev.filter((t) => t !== item.tag)
                          : [...prev, item.tag]
                      )
                    }
                    className={cn(
                      "flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-[12px] transition-colors",
                      active
                        ? "bg-foreground text-background"
                        : "text-foreground hover:bg-background-soft"
                    )}
                  >
                    <span className="truncate">#{item.tag}</span>
                    <span
                      className={cn(
                        "ml-2 shrink-0 font-mono text-[10px]",
                        active ? "text-background/70" : "text-muted-foreground"
                      )}
                    >
                      {item.count}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export { TagFilterPopover };
