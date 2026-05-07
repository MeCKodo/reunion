import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  CLIENT_TAG_UNTAGGED,
  CLIENT_TAG_VALUES,
  clientTagBadgeClass,
  clientTagLabel,
  type ClientTagFilter,
} from "@/lib/clientTag";

interface ClientTagTabsProps {
  /** `undefined` = "all roles". A canonical role value (`server` /
   *  `frontend` / `client`) narrows to that role. The `__none__` sentinel
   *  selects rows with an empty `client_tag` (legacy + `--preset=local`). */
  value: ClientTagFilter;
  onChange: (next: ClientTagFilter) => void;
}

/**
 * Single-select role filter shown at the top of the sidebar in team mode.
 *
 * We deliberately keep this single-select (rather than a multi-select
 * popover) because each row carries exactly one tag — letting the user
 * union-pick `server`+`frontend` would just translate to two consecutive
 * `?tag=` requests merged on the client, which adds wire complexity for
 * a flow that "All roles" already covers cheaply. If product feedback
 * later asks for multi-select we can swap this control out without
 * touching the API surface.
 */
function ClientTagTabs({ value, onChange }: ClientTagTabsProps) {
  const { t } = useTranslation();
  // Order: All → canonical roles (in the order ingest emits them) → Untagged
  // bucket pinned last because it's the lowest-signal slice.
  const items: Array<{ key: string; filter: ClientTagFilter; label: string }> = [
    { key: "all", filter: undefined, label: t("clientTag.all") },
    ...CLIENT_TAG_VALUES.map((tag) => ({
      key: tag,
      filter: tag as ClientTagFilter,
      label: clientTagLabel(tag, t),
    })),
    {
      key: CLIENT_TAG_UNTAGGED,
      filter: CLIENT_TAG_UNTAGGED,
      label: t("clientTag.untagged"),
    },
  ];

  return (
    <div
      role="tablist"
      aria-label={t("clientTag.label")}
      title={t("clientTag.filterTooltip")}
      className="flex flex-wrap items-center gap-1"
    >
      {items.map((item) => {
        const active = item.filter === value;
        const tagSwatch = item.filter && item.filter !== CLIENT_TAG_UNTAGGED
          ? clientTagBadgeClass(item.filter)
          : null;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.filter)}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-full px-2 font-mono text-[10.5px] uppercase tracking-overline transition-colors",
              "border focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
              active
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-background-soft text-muted-foreground hover:border-border-strong hover:text-foreground"
            )}
          >
            {tagSwatch ? (
              <span
                aria-hidden
                className={cn("inline-block h-2 w-2 rounded-full", tagSwatch)}
              />
            ) : null}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export { ClientTagTabs };
