import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Users, User, Loader2, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModeState, SwitchModeResult } from "@/lib/mode";

type ModeSwitcherProps = {
  state: ModeState;
  onApply: (payload: { mode: "personal" | "team" }) => Promise<SwitchModeResult>;
  onSuccess?: (mode: "personal" | "team") => void;
  onError?: (message: string) => void;
  className?: string;
};

// Bottom-of-sidebar menu-item style switcher (like Linear / Cursor's account
// area). One click flips personal ↔ team — team-mode wiring (baseUrl + token)
// is built into the bundle, so we never show a configuration dialog. Failures
// from the backend bubble up through `onError` for a toast.
export function ModeSwitcher({
  state,
  onApply,
  onSuccess,
  onError,
  className,
}: ModeSwitcherProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const isTeam = state.mode === "team";

  const handleToggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = isTeam ? "personal" : "team";
      const result = await onApply({ mode: next });
      if (result.ok) {
        onSuccess?.(next);
      } else {
        onError?.(result.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const label = isTeam ? t("mode.teamModeBadge") : t("mode.personalModeBadge");
  const desc = isTeam ? t("mode.teamDesc") : t("mode.personalDesc");

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={busy}
      title={t("mode.switcherTooltip")}
      aria-label={t("mode.switcherTooltip")}
      className={cn(
        "group/mode flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        "hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
        "disabled:cursor-wait disabled:opacity-70",
        className
      )}
    >
      <span
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
          isTeam
            ? "bg-primary-soft text-primary"
            : "bg-background-soft text-muted-foreground ring-1 ring-inset ring-border"
        )}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : isTeam ? (
          <Users className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <User className="h-3.5 w-3.5" aria-hidden />
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[12.5px] font-medium text-foreground">
          {label}
        </span>
        <span className="truncate text-[10.5px] text-muted-foreground">
          {desc}
        </span>
      </span>

      <ChevronsUpDown
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-colors group-hover/mode:text-muted-foreground"
        aria-hidden
      />
    </button>
  );
}
