import * as React from "react";
import { useTranslation } from "react-i18next";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { assetUrl, basenameOf } from "@/lib/asset";
import { ImageLightbox } from "@/components/shared/ImageLightbox";

/**
 * Source descriptor for a single inline image preview. Two flavours:
 *
 *   - `path`   — absolute local path (e.g. Cursor/Claude attachment, or a
 *                clipboard temp file). Resolved through `/api/asset` so the
 *                backend can enforce the source-roots whitelist.
 *   - `data`   — pre-built URL (data: URI for base64 payloads, https:// for
 *                remote URLs). Rendered directly without going through the
 *                asset endpoint.
 */
export type ImageThumbSource =
  | { kind: "path"; path: string }
  | { kind: "data"; url: string; label?: string };

interface ImageThumbProps {
  source: ImageThumbSource;
  /** Compact 80px square (used inside grids); otherwise renders responsively. */
  variant?: "single" | "grid";
  /** Optional classes appended to the outer button. */
  className?: string;
}

/**
 * Returns the path/URL we hand to ImageLightbox. `assetUrl` is shared
 * between thumbnail and lightbox, and it now passes through `data:` URIs
 * unchanged, so we can use a single value for both.
 */
function resolvePathForLightbox(source: ImageThumbSource): string {
  return source.kind === "path" ? source.path : source.url;
}

function resolveLabel(source: ImageThumbSource, t: (key: string) => string): string {
  if (source.kind === "data") return source.label ?? t("image.image");
  return basenameOf(source.path);
}

/**
 * Heuristic: most "broken image" cases we see in practice are macOS clipboard
 * temp files (under `/var/folders/.../T/clipboard-*.png`) or chat-app temp
 * uploads — these get cleaned up by the OS shortly after the chat happens,
 * so the original byte-for-byte file is genuinely gone by the time someone
 * is browsing the transcript later. Detecting that lets us give a more
 * specific message ("已被系统清理") rather than a generic load-failure.
 */
function looksLikeOsTempPath(p: string): boolean {
  return (
    p.includes("/var/folders/") ||
    p.includes("/T/clipboard-") ||
    /\/temp\/InputTemp\//i.test(p) ||
    /[\\/]Temp[\\/]/i.test(p)
  );
}

type FallbackReason =
  | { kind: "temp-cleared"; path: string }
  | { kind: "path-missing"; path: string }
  | { kind: "data-broken" };

function describeFallback(source: ImageThumbSource): FallbackReason {
  if (source.kind === "data") return { kind: "data-broken" };
  if (looksLikeOsTempPath(source.path)) {
    return { kind: "temp-cleared", path: source.path };
  }
  return { kind: "path-missing", path: source.path };
}

function FallbackTile({
  source,
  large,
}: {
  source: ImageThumbSource;
  large: boolean;
}) {
  const { t } = useTranslation();
  const reason = describeFallback(source);
  const label = resolveLabel(source, t);
  const fullPath = source.kind === "path" ? source.path : undefined;

  const headline =
    reason.kind === "temp-cleared"
      ? t("image.tempCleared")
      : reason.kind === "path-missing"
      ? t("image.unavailable")
      : t("image.loadFailed");
  const detail =
    reason.kind === "temp-cleared"
      ? t("image.tempClearedDetail")
      : reason.kind === "path-missing"
      ? t("image.unavailableDetail")
      : t("image.dataLoadFailed");

  if (!large) {
    return (
      <span
        className="inline-flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-amber-400/40 bg-amber-50/40 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
        title={`${headline}\n${detail}${fullPath ? `\n${fullPath}` : ""}`}
        aria-label={headline}
      >
        <ImageOff className="h-4 w-4" aria-hidden />
      </span>
    );
  }

  return (
    <div
      role="img"
      aria-label={headline}
      title={fullPath ?? undefined}
      className={cn(
        "flex w-full max-w-md items-start gap-3 rounded-md border border-dashed px-3.5 py-3",
        "border-amber-400/40 bg-amber-50/40 text-amber-900",
        "dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
      )}
    >
      <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
        <ImageOff className="h-3.5 w-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-[12.5px] font-medium leading-snug">{headline}</div>
        <div className="text-[11px] leading-snug text-amber-800/80 dark:text-amber-200/70">
          {detail}
        </div>
        <div className="truncate pt-0.5 font-mono text-[10.5px] text-amber-900/55 dark:text-amber-200/50">
          {label}
        </div>
      </div>
    </div>
  );
}

/**
 * Single thumbnail with built-in lightbox. Click opens the existing shared
 * ImageLightbox. When the image fails to load (e.g. clipboard temp file
 * cleaned up by the OS, or a remote URL behind auth), we fall back to a
 * dashed placeholder so the user still sees *something* and can read the
 * raw label.
 */
function ImageThumb({ source, variant = "single", className }: ImageThumbProps) {
  const { t } = useTranslation();
  const [errored, setErrored] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const label = resolveLabel(source, t);
  const lightboxPath = resolvePathForLightbox(source);
  const src = assetUrl(lightboxPath);
  const large = variant === "single";

  if (errored) {
    return <FallbackTile source={source} large={large} />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={label}
        className={cn(
          "group/thumb relative overflow-hidden rounded-md bg-background-soft/50",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          large
            ? "block w-full cursor-zoom-in"
            : "h-20 w-20 cursor-zoom-in border border-border/60 transition-all hover:border-primary/60 hover:shadow-editorial",
          className
        )}
      >
        <img
          src={src}
          alt={label}
          loading="lazy"
          draggable={false}
          onError={() => setErrored(true)}
          className={cn(
            "block",
            large
              ? "max-h-[240px] w-auto max-w-full object-contain"
              : "h-full w-full object-cover transition-transform duration-200 group-hover/thumb:scale-105"
          )}
        />
        {large ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 translate-y-full",
              "bg-gradient-to-t from-black/70 via-black/40 to-transparent px-2.5 py-1.5",
              "font-mono text-[10.5px] text-white",
              "transition-transform duration-150 group-hover/thumb:translate-y-0"
            )}
          >
            <span className="block truncate">{label}</span>
          </div>
        ) : null}
      </button>

      <ImageLightbox
        paths={[lightboxPath]}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export { ImageThumb };
