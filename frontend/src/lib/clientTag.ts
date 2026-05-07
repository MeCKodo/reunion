// Per-machine collector tag — chosen at install time via `--tag=` (see
// ai_coding_collector/install.sh) and propagated through the upload payload
// → ingest `client_tag` column → reunion remote provider → here.
//
// Kept as a tiny standalone module rather than dropped into types.ts so the
// sidebar filter, the row chip, and the URL-param normaliser all share one
// source of truth and the test suite has a single place to assert the value
// list against ingest's enum.

import type { TFunction } from "i18next";

/**
 * Canonical, ordered list of "real" tag values. Order is what the sidebar
 * renders and matches the priority we'd use for sorting if we ever colour
 * legends consistently across charts.
 *
 * NOTE: keep in sync with `ALLOWED_CLIENT_TAGS` in ai_coding_collector
 * `install.sh` and the validation logic in `readClientTag`. Adding a new
 * tag here without also adding it to install.sh would let the UI offer a
 * filter no collector can write.
 */
export const CLIENT_TAG_VALUES = ["server", "frontend", "client"] as const;
export type ClientTagValue = (typeof CLIENT_TAG_VALUES)[number];

/**
 * Sentinel value the ingest API uses to explicitly request rows whose
 * `client_tag` column is empty (legacy data + `--preset=local` installs).
 * Mirrors `store.FilterUntaggedSentinel` in the Go backend exactly — the
 * literal `__none__` is part of the wire contract, not a UI concern.
 */
export const CLIENT_TAG_UNTAGGED = "__none__" as const;

/**
 * Filter selection used by the sidebar. `undefined` means "all tags",
 * a known value narrows to that role, and `__none__` asks for legacy /
 * untagged rows only. We model this as a string union (rather than three
 * booleans) so URL state, the sidebar component, and the API call all
 * share one shape.
 */
export type ClientTagFilter = ClientTagValue | typeof CLIENT_TAG_UNTAGGED | undefined;

export function isClientTagValue(value: unknown): value is ClientTagValue {
  return (
    typeof value === "string" &&
    (CLIENT_TAG_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Normalise a free-form string (URL param, stored prefs, payload field)
 * into the typed filter union. Anything we don't recognise collapses to
 * `undefined` rather than throwing — the wire format may evolve faster
 * than the UI, and "show everything" is the safe degraded behaviour.
 */
export function normalizeClientTagFilter(value: unknown): ClientTagFilter {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed === CLIENT_TAG_UNTAGGED) return CLIENT_TAG_UNTAGGED;
  return isClientTagValue(trimmed) ? trimmed : undefined;
}

/**
 * Resolve the display label for a tag value. Untagged rows get a dedicated
 * "未分类 / Untagged" label so the chip is meaningful instead of blank;
 * other unrecognised strings (forward-compat with a future `mobile` etc.)
 * fall through verbatim so adding a new collector value doesn't require a
 * synchronous frontend release.
 */
export function clientTagLabel(value: string | undefined | null, t: TFunction): string {
  if (!value) return t("clientTag.untagged");
  if (value === CLIENT_TAG_UNTAGGED) return t("clientTag.untagged");
  if (isClientTagValue(value)) return t(`clientTag.values.${value}`);
  return value;
}

/**
 * Tailwind classes for the chip rendered next to a session row. Each role
 * gets a distinct hue so the sidebar reads at a glance without colliding
 * with the existing `cursor` / `claude-code` / `codex` source badge palette.
 *
 * `untagged` deliberately reuses the muted swatch — it's an absence of
 * signal, not a category, and styling it loud would draw the eye to legacy
 * data that the team typically wants to *de-prioritise*.
 */
export function clientTagBadgeClass(value: string | undefined | null): string {
  switch (value) {
    case "server":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "frontend":
      return "bg-sky-500/15 text-sky-700 dark:text-sky-300";
    case "client":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}
