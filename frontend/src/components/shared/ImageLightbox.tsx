import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Copy, Download, X } from "lucide-react";
import { assetUrl, basenameOf } from "@/lib/asset";
import { cn } from "@/lib/utils";

interface ImageLightboxProps {
  paths: string[];
  initialIndex?: number;
  open: boolean;
  onClose: () => void;
}

function ImageLightbox({ paths, initialIndex = 0, open, onClose }: ImageLightboxProps) {
  const [index, setIndex] = React.useState(initialIndex);

  React.useEffect(() => {
    if (open) setIndex(Math.min(Math.max(0, initialIndex), Math.max(0, paths.length - 1)));
  }, [open, initialIndex, paths.length]);

  const total = paths.length;
  const current = paths[index];

  const go = React.useCallback(
    (delta: number) => {
      if (total <= 1) return;
      setIndex((i) => (i + delta + total) % total);
    },
    [total]
  );

  React.useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, go]);

  // Lock body scroll while the overlay is open so wheel events don't bleed
  // through to the chat list underneath.
  React.useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open || !current) return null;

  const onCopyPath = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(current);
      }
    } catch {
      // copy failure is non-fatal — user can still drag the URL bar
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/85 backdrop-blur-sm animate-in fade-in-0"
      onClick={onClose}
      role="dialog"
      aria-modal
    >
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 text-[12px] text-white/80"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono">{basenameOf(current)}</span>
          {total > 1 ? (
            <span className="font-mono tabular-nums text-white/45">
              {index + 1}/{total}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCopyPath}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] text-white/80 transition-colors hover:bg-white/10"
            title="Copy path"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy path
          </button>
          <a
            href={assetUrl(current)}
            download={basenameOf(current)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] text-white/80 transition-colors hover:bg-white/10"
            title="Download"
            onClick={(event) => event.stopPropagation()}
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </a>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/10"
            title="Close (Esc)"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        className="relative flex flex-1 items-center justify-center px-12 pb-6"
        onClick={(event) => event.stopPropagation()}
      >
        {total > 1 ? (
          <button
            type="button"
            onClick={() => go(-1)}
            className={cn(
              "absolute left-2 top-1/2 -translate-y-1/2 inline-flex h-10 w-10 items-center justify-center rounded-full",
              "bg-white/10 text-white/90 transition-colors hover:bg-white/20"
            )}
            aria-label="Previous"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        ) : null}

        <img
          key={current}
          src={assetUrl(current)}
          alt={basenameOf(current)}
          className="max-h-full max-w-full select-none rounded-md object-contain shadow-2xl"
          draggable={false}
        />

        {total > 1 ? (
          <button
            type="button"
            onClick={() => go(1)}
            className={cn(
              "absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-10 w-10 items-center justify-center rounded-full",
              "bg-white/10 text-white/90 transition-colors hover:bg-white/20"
            )}
            aria-label="Next"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        ) : null}
      </div>

      <div
        className="truncate px-4 pb-3 text-center font-mono text-[10px] text-white/40"
        onClick={(event) => event.stopPropagation()}
      >
        {current}
      </div>
    </div>,
    document.body
  );
}

export { ImageLightbox };
