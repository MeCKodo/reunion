import * as React from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ClockAlignment, MessageRoleFilter, SourceId } from "@/lib/types";
import { SOURCE_LABEL } from "@/lib/types";
import {
  TOOL_BUCKET_LABEL,
  TOOL_BUCKET_ORDER,
  TOOL_ICONS,
  type ToolBucket,
} from "@/lib/transcript";

interface ViewToolbarProps {
  messageRoleFilter: MessageRoleFilter;
  setMessageRoleFilter: (filter: MessageRoleFilter) => void;
  toolBucketCounts: Record<ToolBucket, number>;
  queryActive: boolean;
  hitsCount: number;
  activeMatch: number;
  onPrevMatch: () => void;
  onNextMatch: () => void;
  inSessionQuery: string;
  setInSessionQuery: (value: string) => void;
  searchInputRef?: React.Ref<HTMLInputElement>;
  statusText?: string;
  source: SourceId;
  hasSubagents?: boolean;
  clockAlignment?: ClockAlignment;
}

function buildRoleFilters(source: SourceId, hasSubagents: boolean): Array<{ value: MessageRoleFilter; label: string }> {
  const assistantLabel = SOURCE_LABEL[source];
  const filters: Array<{ value: MessageRoleFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "user", label: "You" },
    { value: "assistant", label: assistantLabel },
    { value: "tool", label: "Tool" },
  ];
  if (hasSubagents) filters.push({ value: "subagent", label: "Subagent" });
  return filters;
}

/**
 * Per-bucket palette for the inactive chip (subtle tinted text + border) and
 * the active chip (saturated bg). Tailwind static classes only — composing
 * dynamically would defeat the JIT scanner.
 */
const BUCKET_CHIP_STYLES: Record<
  ToolBucket,
  { idle: string; active: string }
> = {
  read: {
    idle: "border-sky-200 text-sky-700 hover:bg-sky-50",
    active: "border-sky-400 bg-sky-100 text-sky-800",
  },
  write: {
    idle: "border-amber-200 text-amber-800 hover:bg-amber-50",
    active: "border-amber-400 bg-amber-100 text-amber-900",
  },
  exec: {
    idle: "border-teal-200 text-teal-700 hover:bg-teal-50",
    active: "border-teal-400 bg-teal-100 text-teal-800",
  },
  agent: {
    idle: "border-indigo-200 text-indigo-700 hover:bg-indigo-50",
    active: "border-indigo-400 bg-indigo-100 text-indigo-800",
  },
  web: {
    idle: "border-emerald-200 text-emerald-700 hover:bg-emerald-50",
    active: "border-emerald-400 bg-emerald-100 text-emerald-800",
  },
  danger: {
    idle: "border-rose-200 text-rose-700 hover:bg-rose-50",
    active: "border-rose-400 bg-rose-100 text-rose-800",
  },
};

function ViewToolbar({
  messageRoleFilter,
  setMessageRoleFilter,
  toolBucketCounts,
  queryActive,
  hitsCount,
  activeMatch,
  onPrevMatch,
  onNextMatch,
  inSessionQuery,
  setInSessionQuery,
  searchInputRef,
  statusText,
  source,
  hasSubagents = false,
  clockAlignment,
}: ViewToolbarProps) {
  const roleFilters = buildRoleFilters(source, hasSubagents);

  // Only call out a fidelity warning when *all* timestamps are estimates
  // (Cursor session whose generations have rotated out of SQLite). When at
  // least one user prompt aligned to a real timestamp, the displayed times
  // are already trustworthy enough that a badge would just be noise.
  const clockBadge = React.useMemo<{ text: string; tip: string } | null>(() => {
    if (source !== "cursor") return null;
    const matched = clockAlignment?.matched ?? 0;
    const total = clockAlignment?.total ?? 0;
    if (matched > 0 || total === 0) return null;
    return {
      text: "all timestamps estimated",
      tip: "Cursor's chat log has no per-event timestamps. The session's start/end are real, but every message time you see is estimated by spreading messages evenly across the session window.",
    };
  }, [source, clockAlignment]);

  // Surface only the buckets that actually appear in this session, sorted by
  // the canonical semantic order so the layout stays predictable across
  // sessions.
  const activeBuckets = TOOL_BUCKET_ORDER.filter(
    (bucket) => toolBucketCounts[bucket] > 0
  );

  const activeBucketKey: ToolBucket | null =
    typeof messageRoleFilter === "string" && messageRoleFilter.startsWith("tool:")
      ? (messageRoleFilter.slice("tool:".length) as ToolBucket)
      : null;

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border bg-background px-5 py-2">
      <SegmentedTabs
        compact
        options={roleFilters}
        value={
          // When a tool-bucket chip is active, fold the primary tabs to "Tool"
          // so the user can still see which top-level family they're inside.
          activeBucketKey ? "tool" : messageRoleFilter
        }
        onChange={(value) => setMessageRoleFilter(value as MessageRoleFilter)}
      />

      {activeBuckets.length > 0 ? (
        <>
          <span
            aria-hidden
            className="hidden md:inline-block h-4 w-px bg-border"
          />
          <div className="flex flex-wrap items-center gap-1">
            {activeBuckets.map((bucket) => {
              const Icon = TOOL_ICONS[bucket];
              const isActive = activeBucketKey === bucket;
              const palette = BUCKET_CHIP_STYLES[bucket];
              return (
                <button
                  key={bucket}
                  type="button"
                  onClick={() =>
                    setMessageRoleFilter(
                      isActive ? "all" : (`tool:${bucket}` as MessageRoleFilter)
                    )
                  }
                  title={`${TOOL_BUCKET_LABEL[bucket]} tools · ${toolBucketCounts[bucket]}`}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors",
                    isActive ? palette.active : cn("bg-background", palette.idle)
                  )}
                >
                  {Icon ? <Icon className="h-3 w-3" strokeWidth={2.25} /> : null}
                  <span className="font-medium">{TOOL_BUCKET_LABEL[bucket]}</span>
                  <span
                    className={cn(
                      "tabular-nums",
                      isActive ? "" : "text-muted-foreground"
                    )}
                  >
                    {toolBucketCounts[bucket]}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      {clockBadge ? (
        <span
          title={clockBadge.tip}
          className="hidden md:inline-flex items-center rounded-sm bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-overline text-amber-700 ring-1 ring-amber-200"
        >
          {clockBadge.text}
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        <SessionSearchBox
          value={inSessionQuery}
          onChange={setInSessionQuery}
          inputRef={searchInputRef}
          hitsCount={hitsCount}
          activeMatch={activeMatch}
          onPrevMatch={onPrevMatch}
          onNextMatch={onNextMatch}
        />

        {/* Global-search hit counter still shows up when no local query is
            active so sidebar-driven searches remain navigable. When a local
            query is set, the search box itself surfaces the count. */}
        {queryActive && !inSessionQuery ? (
          <div className="flex items-center gap-1 rounded-md border border-border-strong bg-surface px-2 py-1 font-mono text-[11px] text-foreground">
            <span className="text-muted-foreground">
              {hitsCount ? `${activeMatch + 1}/${hitsCount}` : "0 hits"}
            </span>
            {hitsCount > 0 ? (
              <>
                <button
                  className="rounded-sm p-0.5 text-muted-foreground hover:bg-background-soft hover:text-foreground"
                  onClick={onPrevMatch}
                  title="Previous match"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  className="rounded-sm p-0.5 text-muted-foreground hover:bg-background-soft hover:text-foreground"
                  onClick={onNextMatch}
                  title="Next match"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        {statusText ? (
          <div className="hidden lg:block truncate font-mono text-[11px] text-muted-foreground max-w-[14rem]">
            {statusText}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface SessionSearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  hitsCount: number;
  activeMatch: number;
  onPrevMatch: () => void;
  onNextMatch: () => void;
}

// Detected once at module init. Vite-only (no SSR), so `navigator` is always
// available. Pure desktop heuristic — "meta" key is named Cmd on Apple and
// Ctrl on everything else users are likely to run this on.
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
const FIND_SHORTCUT_LABEL = IS_MAC ? "⌘F" : "Ctrl+F";

/**
 * Compact search affordance that lives in the session toolbar. It serves
 * two roles: collect a query that scopes hit highlighting + navigation to
 * the open conversation, and expose the current match position when a
 * query is active. ESC clears the box; Enter / Shift+Enter cycle hits;
 * ⌘F focuses it from anywhere via SessionView's global key handler.
 */
function SessionSearchBox({
  value,
  onChange,
  inputRef,
  hitsCount,
  activeMatch,
  onPrevMatch,
  onNextMatch,
}: SessionSearchBoxProps) {
  const trimmed = value.trim();
  const handleKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (value) onChange("");
      else (event.currentTarget as HTMLInputElement).blur();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!hitsCount) return;
      if (event.shiftKey) onPrevMatch();
      else onNextMatch();
    }
  };
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md border bg-surface pl-2 pr-1 h-7 transition-colors",
        trimmed
          ? "border-accent/40 ring-1 ring-accent/20"
          : "border-border-strong focus-within:border-accent/40 focus-within:ring-1 focus-within:ring-accent/20"
      )}
    >
      <Search
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          trimmed ? "text-accent" : "text-muted-foreground"
        )}
      />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKey}
        placeholder="Find in session"
        aria-label="Find in session"
        className="h-6 w-32 bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none sm:w-44"
      />
      {/* Keyboard-hint key-cap. Only surfaces in the resting state (no query
          and no focus) so it teaches the shortcut without fighting the
          match counter / clear button once the user has engaged. */}
      {!trimmed ? (
        <kbd
          aria-hidden
          className="hidden sm:inline-flex items-center rounded border border-border-strong bg-background-soft px-1 py-[1px] font-mono text-[10px] leading-none text-muted-foreground transition-opacity group-focus-within:opacity-0"
        >
          {FIND_SHORTCUT_LABEL}
        </kbd>
      ) : null}
      {trimmed ? (
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground whitespace-nowrap">
          {hitsCount ? `${activeMatch + 1}/${hitsCount}` : "0/0"}
        </span>
      ) : null}
      {trimmed && hitsCount > 0 ? (
        <>
          <button
            type="button"
            className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-background-soft hover:text-foreground"
            onClick={onPrevMatch}
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-background-soft hover:text-foreground"
            onClick={onNextMatch}
            title="Next match (Enter)"
            aria-label="Next match"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </>
      ) : null}
      {trimmed ? (
        <button
          type="button"
          className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-background-soft hover:text-foreground"
          onClick={() => onChange("")}
          title="Clear (Esc)"
          aria-label="Clear search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

interface SegmentedTabsProps<T extends string> {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  compact?: boolean;
}

function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
  compact,
}: SegmentedTabsProps<T>) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md border border-border bg-background-soft p-0.5",
        compact && "p-[2px]"
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center rounded-sm transition-[background-color,color,box-shadow] duration-150",
              compact ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-[12px]",
              active
                ? "bg-surface text-foreground font-medium shadow-[0_1px_2px_hsl(var(--foreground)/0.08),0_0_0_1px_hsl(var(--border))]"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export { ViewToolbar };
