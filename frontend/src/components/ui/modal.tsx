import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Tailwind size class, e.g. "max-w-2xl" (default). */
  sizeClassName?: string;
}

function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  sizeClassName = "max-w-2xl",
}: ModalProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  React.useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  // Render into document.body so the dialog spans the full viewport instead of
  // being clipped by an ancestor (e.g. the sidebar's bounded width or a parent
  // with `transform`/`filter`/`contain` that would localize `position: fixed`).
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-[3px] animate-fade-in"
      />
      <div
        onClick={(event) => event.stopPropagation()}
        className={cn(
          "relative z-10 w-[min(960px,92vw)] max-h-[88vh] overflow-hidden",
          "rounded-xl border border-border bg-background shadow-editorial-lg",
          "flex flex-col animate-in fade-in-0 zoom-in-95",
          sizeClassName
        )}
      >
        {(title || description) && (
          <header className="flex items-start justify-between gap-4 border-b border-border px-6 pt-5 pb-4">
            <div className="min-w-0 flex-1">
              {title ? (
                <h2 className="font-serif text-lg font-semibold tracking-tight text-foreground">
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background-soft hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </header>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">{children}</div>
        {footer ? (
          <footer className="border-t border-border bg-background-soft px-6 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body
  );
}

export { Modal };
