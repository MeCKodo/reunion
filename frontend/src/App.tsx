import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ScrollToTop } from "@/components/shared/ScrollToTop";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { SessionView } from "@/components/session-view/SessionView";
import { useToast } from "@/components/ui/toast";
import { ExportTargetDialog } from "@/components/session-view/ExportTargetDialog";
import { useAnnotations } from "@/hooks/useAnnotations";
import { usePersistentState } from "@/hooks/usePersistentState";
import {
  deleteSession,
  downloadBlob,
  fetchExport,
  fetchRepos,
  fetchSearch,
  fetchSession,
  fetchSources,
  postOpenPath,
  postReindex,
  type ExportKind,
} from "@/lib/api";
import { decodeEntities } from "@/lib/format";
import { eventSearchText, tokenizeQuery } from "@/lib/text";
import {
  isSubagentToolEvent,
  toolCategory,
  type ToolBucket,
} from "@/lib/transcript";
import type {
  DetailMessageHit,
  HistoryMode,
  MessageRoleFilter,
  OpenSessionOptions,
  RepoGroup,
  RepoOption,
  SearchResult,
  SessionDetail,
  SourceFilter,
  SourceSummary,
  TimelineEvent,
} from "@/lib/types";
import { buildHistoryPreview } from "@/lib/format";
import { getSessionKeyFromUrl, syncSessionKeyToUrl } from "@/lib/url";

export default function App() {
  // ── Core data state ────────────────────────────────────────────────
  const [results, setResults] = useState<SearchResult[]>([]);
  const [repoCatalog, setRepoCatalog] = useState<RepoOption[]>([]);
  const [sourceSummaries, setSourceSummaries] = useState<SourceSummary[]>([]);
  // Sidebar filter state is mirrored to localStorage so the user's choice
  // (source tab, repo, time window, starred-only, tag filter) survives a
  // reload. Stale values that no longer exist (e.g. a repo that's been
  // removed) are reset by the existing reconciliation effects below.
  const [selectedSource, setSelectedSource] = usePersistentState<SourceFilter>(
    "filter:source",
    "all"
  );
  const [query, setQuery] = useState("");
  const [days, setDays] = usePersistentState<string>("filter:days", "30");
  const [selectedRepo, setSelectedRepo] = usePersistentState<string>(
    "filter:repo",
    "all"
  );
  const [activeSessionKey, setActiveSessionKey] = useState("");
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [status, setStatus] = useState("Ready");
  const [loading, setLoading] = useState(false);
  const [firstLoad, setFirstLoad] = useState(true);
  const [messageRoleFilter, setMessageRoleFilter] = useState<MessageRoleFilter>("all");
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});
  const [activeMatch, setActiveMatch] = useState(0);
  const [pulseKey, setPulseKey] = useState(0);
  const [pendingJumpTarget, setPendingJumpTarget] = useState<{
    eventId?: string;
    legacySegmentIndex?: number;
  } | null>(null);
  const [exportLoading, setExportLoading] = useState<"" | ExportKind>("");
  // Export-to-repo dialog state. Only one kind is open at a time so a single
  // discriminator on `kind` is enough (null means closed).
  const [exportDialogKind, setExportDialogKind] = useState<ExportKind | null>(null);
  const [onlyStarred, setOnlyStarred] = usePersistentState<boolean>(
    "filter:starred",
    false
  );
  const [selectedTags, setSelectedTags] = usePersistentState<string[]>(
    "filter:tags",
    []
  );
  const [tagInput, setTagInput] = useState("");
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Query that was actually submitted to the backend. Drives the sidebar
  // "hits" badge, so we never show stale "0 hits" for an un-searched term.
  const [submittedQuery, setSubmittedQuery] = useState("");

  // Per-session search box, independent of the sidebar query. When non-empty
  // it takes precedence over the global query for hit calculation and
  // highlighting inside the open conversation, so users can pivot from
  // "find this session" to "find inside this session" without losing their
  // global search context.
  const [inSessionQuery, setInSessionQuery] = useState("");

  // ── Refs ───────────────────────────────────────────────────────────
  const eventRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const conversationViewportRef = useRef<HTMLDivElement | null>(null);
  const initialUrlSessionKeyRef = useRef(getSessionKeyFromUrl());
  const didInitRef = useRef(false);

  // ── Toast helpers ──────────────────────────────────────────────────
  const { push: pushToast, dismiss: dismissToast } = useToast();
  const notify = useCallback(
    (
      message: Parameters<typeof pushToast>[0],
      tone: Parameters<typeof pushToast>[1] = "default",
      timeoutMs?: number
    ) => pushToast(message, tone, timeoutMs),
    [pushToast]
  );

  // ── Extracted business logic (annotations) ─────────────────────────
  const {
    allTags,
    loaded: annotationsLoaded,
    toggleStar,
    addTag,
    removeTag,
    loadOnce: loadAnnotationsOnce,
  } = useAnnotations({
    setResults,
    setDetail,
    onError: (message) => notify(message, "error"),
  });

  // ── Derived / memoized data ────────────────────────────────────────
  // Deferred query keeps the input itself snappy while expensive derivations
  // (message hit matching, highlight rendering) can be interrupted by React.
  const deferredQuery = useDeferredValue(query);
  const queryTokens = useMemo(() => tokenizeQuery(deferredQuery), [deferredQuery]);
  const submittedTokens = useMemo(() => tokenizeQuery(submittedQuery), [submittedQuery]);

  // Tokens used to drive in-session highlighting + hit navigation. Falls back
  // to the global query so existing "click sidebar hit → highlights persist"
  // behavior is unchanged when the user hasn't started a local search.
  const deferredInSessionQuery = useDeferredValue(inSessionQuery);
  const inSessionTokens = useMemo(
    () => tokenizeQuery(deferredInSessionQuery),
    [deferredInSessionQuery]
  );
  const detailQueryTokens = inSessionTokens.length > 0 ? inSessionTokens : queryTokens;

  const toolBucketFilter = useMemo<ToolBucket | null>(() => {
    if (typeof messageRoleFilter !== "string") return null;
    if (!messageRoleFilter.startsWith("tool:")) return null;
    return messageRoleFilter.slice("tool:".length) as ToolBucket;
  }, [messageRoleFilter]);

  const visibleEvents = useMemo<TimelineEvent[]>(() => {
    if (!detail) return [];
    if (messageRoleFilter === "all") return detail.events;
    if (messageRoleFilter === "subagent") {
      // Keep only subagent-spawn tool calls (Cursor `Task` / Claude `Agent`)
      // from the main session as contextual anchors; full subagent content is
      // rendered via `visibleSubagents`.
      return detail.events.filter(
        (event) => event.kind === "tool_use" && isSubagentToolEvent(event.tool_name)
      );
    }
    if (toolBucketFilter) {
      return detail.events.filter(
        (event) =>
          event.kind === "tool_use" && toolCategory(event.tool_name) === toolBucketFilter
      );
    }
    return detail.events.filter((event) => event.category === messageRoleFilter);
  }, [detail, messageRoleFilter, toolBucketFilter]);

  const visibleSubagents = useMemo(() => {
    if (!detail) return [];
    return detail.subagents
      .map((subagent) => ({
        ...subagent,
        filteredEvents:
          messageRoleFilter === "all" || messageRoleFilter === "subagent"
            ? subagent.events
            : toolBucketFilter
              ? subagent.events.filter(
                  (event) =>
                    event.kind === "tool_use" &&
                    toolCategory(event.tool_name) === toolBucketFilter
                )
              : subagent.events.filter((event) => event.category === messageRoleFilter),
      }))
      .filter((subagent) => subagent.filteredEvents.length > 0);
  }, [detail, messageRoleFilter, toolBucketFilter]);

  // Frequency of every (real) tool bucket across the main timeline + every
  // subagent transcript. Drives the toolbar's secondary filter row, which only
  // surfaces buckets that actually appear in this session — keeps the chip set
  // small and contextually relevant.
  const toolBucketCounts = useMemo<Record<ToolBucket, number>>(() => {
    const counts: Record<ToolBucket, number> = {
      read: 0, write: 0, exec: 0, agent: 0, web: 0, danger: 0,
    };
    if (!detail) return counts;
    const tally = (events: TimelineEvent[]) => {
      for (const event of events) {
        if (event.kind !== "tool_use") continue;
        const cat = toolCategory(event.tool_name);
        if (cat === "default" || cat === "subagent") continue;
        counts[cat as ToolBucket] += 1;
      }
    };
    tally(detail.events);
    for (const subagent of detail.subagents) tally(subagent.events);
    return counts;
  }, [detail]);

  const visibleHistoryEntries = useMemo(
    () => [
      ...visibleEvents.map((event) => ({ event, sourceLabel: "Main session" })),
      ...visibleSubagents.flatMap((subagent) =>
        subagent.filteredEvents.map((event) => ({
          event,
          sourceLabel: `Subagent · ${subagent.title || subagent.session_id}`,
        }))
      ),
    ],
    [visibleEvents, visibleSubagents]
  );

  const detailMessageHits = useMemo<DetailMessageHit[]>(() => {
    if (!detail) return [];
    if (!detailQueryTokens.length) return [];
    return visibleHistoryEntries
      .filter(({ event }) => {
        const haystack = decodeEntities(eventSearchText(event)).toLowerCase();
        return detailQueryTokens.every((token) => haystack.includes(token));
      })
      .map(({ event, sourceLabel }) => ({
        event_id: event.event_id,
        category: event.category,
        ts: event.ts,
        preview: buildHistoryPreview(eventSearchText(event)),
        source_label: sourceLabel,
      }));
  }, [detail, visibleHistoryEntries, detailQueryTokens]);

  const filteredResults = useMemo(() => {
    return results.filter((item) => {
      if (selectedSource !== "all" && item.source !== selectedSource) return false;
      if (onlyStarred && !item.starred) return false;
      if (selectedTags.length > 0) {
        const tags = item.tags || [];
        if (!selectedTags.some((tag) => tags.includes(tag))) return false;
      }
      return true;
    });
  }, [results, selectedSource, onlyStarred, selectedTags]);

  const repoOptions = useMemo(() => {
    const filtered =
      selectedSource === "all"
        ? repoCatalog
        : repoCatalog.filter((option) => option.source === selectedSource);
    const names = new Set<string>();
    for (const option of filtered) names.add(option.repo);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [repoCatalog, selectedSource]);

  const groupedResults = useMemo<RepoGroup[]>(() => {
    const map = new Map<string, { source: SearchResult["source"]; repoPath?: string; sessions: SearchResult[] }>();
    for (const item of filteredResults) {
      const key = `${item.source}:${item.repo}`;
      const curr = map.get(key);
      if (curr) {
        curr.sessions.push(item);
        if (!curr.repoPath && item.repo_path) curr.repoPath = item.repo_path;
      } else {
        map.set(key, {
          source: item.source,
          repoPath: item.repo_path,
          sessions: [item],
        });
      }
    }
    return Array.from(map.entries())
      .map(([key, value]) => {
        const idx = key.indexOf(":");
        const repo = idx >= 0 ? key.slice(idx + 1) : key;
        return {
          repo,
          source: value.source,
          repoPath: value.repoPath,
          sessions: value.sessions.sort((a, b) => b.updated_at - a.updated_at),
        };
      })
      .sort((a, b) => b.sessions.length - a.sessions.length);
  }, [filteredResults]);

  useEffect(() => {
    setCollapsedRepos((prev) => {
      const next = { ...prev };
      for (const group of groupedResults) {
        const key = `${group.source}:${group.repo}`;
        if (next[key] === undefined) next[key] = false;
      }
      return next;
    });
  }, [groupedResults]);

  // ── Session open + search ──────────────────────────────────────────
  const openSession = useCallback(
    async (sessionKey: string, options: OpenSessionOptions = {}) => {
      const { targetSegment, historyMode = "push" } = options;
      setActiveSessionKey(sessionKey);
      if (historyMode !== "skip" && getSessionKeyFromUrl() !== sessionKey) {
        syncSessionKeyToUrl(sessionKey, historyMode as Exclude<HistoryMode, "skip">);
      }
      if (typeof targetSegment === "number") {
        setMessageRoleFilter("all");
        setPendingJumpTarget({ legacySegmentIndex: targetSegment });
      }
      setDetailLoading(true);
      try {
        const data = await fetchSession(sessionKey);
        setDetail(data);
      } catch (error) {
        notify(`Failed to load session: ${String(error)}`, "error");
      } finally {
        setDetailLoading(false);
      }
    },
    [notify]
  );

  const runSearch = useCallback(
    async (options: { preferredSessionKey?: string; overrideQuery?: string } = {}) => {
      const effectiveQuery = options.overrideQuery ?? query;
      setLoading(true);
      setStatus("Searching…");
      try {
        const { results: items, count } = await fetchSearch({
          query: effectiveQuery,
          days,
          repo: selectedRepo,
          source: selectedSource,
          limit: 300,
        });
        setResults(items);
        setSubmittedQuery(effectiveQuery);
        setStatus(`${count} ${count === 1 ? "result" : "results"}`);

        const preferred = options.preferredSessionKey || "";
        if (preferred) {
          if (activeSessionKey !== preferred || !detail) {
            await openSession(preferred, { historyMode: "skip" });
            setActiveMatch(0);
          }
          return;
        }

        const hasActive = items.some((item) => item.session_key === activeSessionKey);
        if (items.length > 0 && (!activeSessionKey || !hasActive)) {
          await openSession(items[0].session_key, { historyMode: "replace" });
          setActiveMatch(0);
        }
      } catch (error) {
        setStatus("Search failed");
        notify(`Search failed: ${String(error)}`, "error");
      } finally {
        setLoading(false);
        setFirstLoad(false);
      }
    },
    [activeSessionKey, days, detail, notify, openSession, query, selectedRepo, selectedSource]
  );

  const reindex = useCallback(async () => {
    const toastId = pushToast("Reindexing sessions…", "loading");
    setStatus("Indexing…");
    try {
      const data = await postReindex();
      dismissToast(toastId);
      notify(`Indexed ${data.stats.sessions_indexed} sessions`, "success");
      setStatus("Ready");
      await loadRepoOptions();
      await loadSourceSummaries();
      await runSearch();
    } catch (error) {
      dismissToast(toastId);
      setStatus("Reindex failed");
      notify(`Reindex failed: ${String(error)}`, "error");
    }
  }, [dismissToast, notify, pushToast, runSearch]);

  const loadRepoOptions = useCallback(async () => {
    try {
      setRepoCatalog(await fetchRepos());
    } catch {
      // non-fatal
    }
  }, []);

  const loadSourceSummaries = useCallback(async () => {
    try {
      setSourceSummaries(await fetchSources());
    } catch {
      // non-fatal
    }
  }, []);

  // Switching source triggers a fresh backend search, but we also narrow the
  // currently rendered results synchronously so the sidebar's "Threads · X / Y"
  // hint doesn't briefly show a stale total before the request resolves.
  const handleSelectSource = useCallback((next: SourceFilter) => {
    setSelectedSource((prev) => {
      if (prev === next) return prev;
      setResults((items) =>
        next === "all" ? items : items.filter((item) => item.source === next)
      );
      return next;
    });
  }, []);

  // ── Utilities bound to current detail ──────────────────────────────
  const onCopySessionId = useCallback(async () => {
    if (!detail) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(detail.session_id);
      } else {
        const input = document.createElement("textarea");
        input.value = detail.session_id;
        input.setAttribute("readonly", "true");
        input.style.position = "absolute";
        input.style.left = "-9999px";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      notify("Session ID copied", "success");
    } catch (error) {
      notify(`Copy failed: ${String(error)}`, "error");
    }
  }, [detail, notify]);

  // Triggered by the Smart Rules / Smart Skill buttons in the session
  // header. Instead of going straight to a download we now open a dialog
  // so the user can confirm the destination repo + path. The legacy
  // download path is reachable via the dialog's "Download instead" affordance
  // (and is also used as a fallback when no repo can be detected).
  const onExport = useCallback(
    (kind: ExportKind) => {
      if (!detail) return;
      setExportDialogKind(kind);
    },
    [detail]
  );

  // Used by the dialog when it succeeds. We surface a richer toast with
  // "Open file" / "Reveal in Finder" actions because that's the second piece
  // of feedback the user explicitly asked for.
  const handleExportWritten = useCallback(
    async (
      kind: ExportKind,
      info: { absolutePath: string; relativePath: string; mode: string }
    ) => {
      setExportDialogKind(null);
      const action = (target: "open" | "reveal", id: string) => async () => {
        try {
          await postOpenPath(target === "open" ? info.absolutePath : info.absolutePath);
          if (target === "reveal") {
            // postOpenPath resolves to "opened" for files; macOS reveals the
            // parent dir when called with a directory path, so we explicitly
            // pass the parent for "reveal in finder" semantics.
            const parent = info.absolutePath.replace(/\/[^/]+$/, "");
            await postOpenPath(parent);
          }
          dismissToast(id);
        } catch (error) {
          notify(`Open failed: ${String(error)}`, "error");
        }
      };
      const toastId = `export-${Date.now()}`;
      pushToast(
        <span className="flex flex-col gap-1.5">
          <span>
            <strong className="font-semibold">
              Smart {kind === "skill" ? "Skill" : "Rules"} written
            </strong>{" "}
            <span className="text-muted-foreground">({info.mode})</span>
          </span>
          <code className="break-all rounded bg-background-soft px-1.5 py-0.5 font-mono text-[11.5px] text-muted-foreground">
            {info.absolutePath}
          </code>
          <span className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={action("open", toastId)}
              className="rounded border border-border-strong bg-surface px-2 py-0.5 text-[11.5px] text-foreground hover:bg-background-soft"
            >
              Open file
            </button>
            <button
              type="button"
              onClick={action("reveal", toastId)}
              className="rounded border border-border-strong bg-surface px-2 py-0.5 text-[11.5px] text-foreground hover:bg-background-soft"
            >
              Reveal in Finder
            </button>
          </span>
        </span>,
        "success",
        12000
      );
    },
    [dismissToast, notify, pushToast]
  );

  // Reachable by the dialog when the user explicitly opts to download rather
  // than write to repo (e.g. they want to send it to someone else).
  // Currently kept private because the dialog doesn't surface the
  // "Download instead" button yet — but the implementation lives here so we
  // can hook it up without touching App.tsx again.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleExportDownload = useCallback(
    async (kind: ExportKind) => {
      if (!detail) return;
      setExportLoading(kind);
      const toastId = pushToast(
        `Generating Smart ${kind === "skill" ? "Skill" : "Rules"} via AI… this can take ~30s`,
        "loading"
      );
      try {
        const fallback = `${decodeEntities(detail.title || detail.session_id)}-${kind.toUpperCase()}.md`;
        const { blob, mode, warning, filename } = await fetchExport(
          detail.session_key,
          kind,
          fallback
        );
        downloadBlob(blob, filename);
        dismissToast(toastId);
        const fileLine = `Saved to your Downloads folder · ${filename}`;
        if (mode === "smart") {
          notify(`Smart ${kind.toUpperCase()} ready · ${fileLine}`, "success", 6000);
        } else {
          const reason = warning ? ` (${warning})` : "";
          notify(
            `Smart ${kind.toUpperCase()} fell back to basic template${reason} · ${fileLine}`,
            "info",
            8000
          );
        }
      } catch (error) {
        dismissToast(toastId);
        notify(
          `Export failed: ${String(error)} — check Settings if your CLI is signed in.`,
          "error",
          8000
        );
      } finally {
        setExportLoading("");
      }
    },
    [detail, dismissToast, notify, pushToast]
  );

  // Permanently remove the currently open session: nukes the transcript file
  // (and any sidechain agents) on disk via the backend, prunes the session
  // from results, clears the open detail pane + URL state, and surfaces a
  // toast for both success and failure. The DeleteSessionButton awaits this
  // promise to keep its busy state in sync.
  const onDeleteSession = useCallback(async () => {
    if (!detail) return;
    const sessionKey = detail.session_key;
    const friendlyTitle = decodeEntities(detail.title || detail.session_id);
    const toastId = pushToast(`Deleting "${friendlyTitle}"…`, "loading");
    try {
      await deleteSession(sessionKey);
      setResults((prev) => prev.filter((item) => item.session_key !== sessionKey));
      setDetail(null);
      setActiveSessionKey("");
      if (getSessionKeyFromUrl() === sessionKey) {
        syncSessionKeyToUrl("", "replace");
      }
      dismissToast(toastId);
      notify(`Deleted "${friendlyTitle}"`, "success");
      loadRepoOptions().catch(() => undefined);
      loadSourceSummaries().catch(() => undefined);
    } catch (error) {
      dismissToast(toastId);
      notify(`Delete failed: ${String(error)}`, "error");
      throw error;
    }
  }, [detail, dismissToast, loadRepoOptions, loadSourceSummaries, notify, pushToast]);

  const jumpToMatch = useCallback(
    (nextIndex: number) => {
      if (!detailMessageHits.length) return;
      const normalized =
        ((nextIndex % detailMessageHits.length) + detailMessageHits.length) %
        detailMessageHits.length;
      setActiveMatch(normalized);
      setPulseKey((prev) => prev + 1);
      setPendingJumpTarget({ eventId: detailMessageHits[normalized].event_id });
    },
    [detailMessageHits]
  );

  const scrollToEventInViewport = useCallback((eventId: string) => {
    const viewport = conversationViewportRef.current;
    const target = eventRefs.current[eventId];
    if (!viewport || !target) return;
    const viewportRect = viewport.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const nextTop = viewport.scrollTop + (targetRect.top - viewportRect.top) - 96;
    viewport.scrollTo({ top: Math.max(0, nextTop), behavior: "smooth" });
  }, []);

  const scrollToTop = useCallback(() => {
    conversationViewportRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const registerEventRef = useCallback((eventId: string, node: HTMLDivElement | null) => {
    eventRefs.current[eventId] = node;
  }, []);

  const handleJumpFromSidebar = useCallback(
    (sessionKey: string, segmentIndex: number, hitIndex: number) => {
      setActiveMatch(hitIndex);
      setPulseKey((prev) => prev + 1);
      void openSession(sessionKey, { targetSegment: segmentIndex, historyMode: "push" });
    },
    [openSession]
  );

  const handleToggleRepo = useCallback((groupKey: string) => {
    setCollapsedRepos((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
  }, []);

  // ── Effects ────────────────────────────────────────────────────────
  useEffect(() => {
    if (detailMessageHits.length > 0) {
      setActiveMatch((prev) => Math.min(prev, detailMessageHits.length - 1));
    } else {
      setActiveMatch(0);
    }
  }, [detailMessageHits.length]);

  useEffect(() => {
    if (!pendingJumpTarget) return;
    let eventId = pendingJumpTarget.eventId;
    if (!eventId && typeof pendingJumpTarget.legacySegmentIndex === "number" && detail) {
      eventId = detail.events.find(
        (event) => event.legacy_segment_index === pendingJumpTarget.legacySegmentIndex
      )?.event_id;
    }
    if (!eventId) return;
    // Tool results are folded under the originating tool_use card and have no
    // standalone DOM node. If the target event_id has no registered ref and it
    // belongs to a folded tool_result, scroll to the matching tool_use instead.
    if (!eventRefs.current[eventId] && detail) {
      const target = detail.events.find((event) => event.event_id === eventId);
      if (
        target &&
        target.kind === "meta" &&
        target.content_type === "tool_result" &&
        target.tool_call_id
      ) {
        const parent = detail.events.find(
          (event) => event.kind === "tool_use" && event.tool_call_id === target.tool_call_id
        );
        if (parent) eventId = parent.event_id;
      }
    }
    scrollToEventInViewport(eventId);
    setPendingJumpTarget(null);
  }, [pendingJumpTarget, detail, messageRoleFilter, visibleSubagents.length, scrollToEventInViewport]);

  // Auto-search as the user types (debounced). Uses the deferred query so
  // React can batch updates during fast typing.
  useEffect(() => {
    if (!didInitRef.current) return;
    const id = window.setTimeout(() => {
      runSearch({ overrideQuery: deferredQuery }).catch((error) =>
        notify(String(error), "error")
      );
    }, 250);
    return () => window.clearTimeout(id);
  }, [deferredQuery]);

  // Filters change immediately re-run the search with the current query.
  useEffect(() => {
    if (!didInitRef.current) return;
    runSearch().catch((error) => notify(String(error), "error"));
  }, [days, selectedRepo, selectedSource]);

  // Picked source removed from available repos; reset to "all".
  useEffect(() => {
    if (selectedRepo === "all") return;
    if (selectedSource === "all") return;
    const stillAvailable = repoCatalog.some(
      (option) => option.repo === selectedRepo && option.source === selectedSource
    );
    if (!stillAvailable) setSelectedRepo("all");
  }, [repoCatalog, selectedRepo, selectedSource]);

  // Reconcile persisted tag selection: drop tags that no longer exist on any
  // session. Gated on `annotationsLoaded` so an empty initial allTags doesn't
  // wipe the user's choice during the first render.
  useEffect(() => {
    if (!annotationsLoaded) return;
    if (selectedTags.length === 0) return;
    const known = new Set(allTags.map((t) => t.tag));
    const filtered = selectedTags.filter((tag) => known.has(tag));
    if (filtered.length !== selectedTags.length) setSelectedTags(filtered);
  }, [annotationsLoaded, allTags, selectedTags, setSelectedTags]);

  // Switching to a different conversation should always start with a fresh
  // in-session search box — leftover terms from a prior session almost never
  // make sense in the new one.
  useEffect(() => {
    setInSessionQuery("");
  }, [activeSessionKey]);

  useEffect(() => {
    loadRepoOptions().catch(() => undefined);
    loadSourceSummaries().catch(() => undefined);
    loadAnnotationsOnce().catch(() => undefined);
    runSearch({ preferredSessionKey: initialUrlSessionKeyRef.current }).catch((error) =>
      notify(String(error), "error")
    );
    didInitRef.current = true;
  }, []);

  useEffect(() => {
    setTagInput("");
  }, [detail?.session_key]);

  useEffect(() => {
    const handlePopState = () => {
      const sessionKey = getSessionKeyFromUrl();
      if (!sessionKey || sessionKey === activeSessionKey) return;
      openSession(sessionKey, { historyMode: "skip" }).catch((error) => notify(String(error), "error"));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [activeSessionKey, openSession, notify]);

  const hasQuery = submittedTokens.length > 0;

  const handleSidebarOpenSession = useCallback(
    (sessionKey: string) => {
      void openSession(sessionKey, { historyMode: "push" });
      setSidebarOpen(false);
    },
    [openSession]
  );

  const handleSidebarJumpToHit = useCallback(
    (sessionKey: string, segmentIndex: number, hitIndex: number) => {
      handleJumpFromSidebar(sessionKey, segmentIndex, hitIndex);
      setSidebarOpen(false);
    },
    [handleJumpFromSidebar]
  );

  return (
    <div className="relative h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-full min-h-0">
        <div
          className={cn(
            "fixed inset-y-0 left-0 z-50 w-[min(360px,85vw)] transition-transform duration-200 ease-out shadow-editorial-lg",
            "lg:static lg:z-auto lg:h-full lg:w-[352px] lg:shrink-0 lg:translate-x-0 lg:shadow-none",
            sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
          )}
        >
          <Sidebar
            className="h-full w-full"
            query={query}
            setQuery={setQuery}
            onSubmit={() => void runSearch()}
            loading={loading}
            onReindex={() => void reindex()}
            days={days}
            setDays={setDays}
            selectedRepo={selectedRepo}
            setSelectedRepo={setSelectedRepo}
            repoOptions={repoOptions}
            selectedSource={selectedSource}
            setSelectedSource={handleSelectSource}
            sourceSummaries={sourceSummaries}
            onlyStarred={onlyStarred}
            setOnlyStarred={setOnlyStarred}
            selectedTags={selectedTags}
            setSelectedTags={setSelectedTags}
            allTags={allTags}
            tagPickerOpen={tagPickerOpen}
            setTagPickerOpen={setTagPickerOpen}
            filteredCount={filteredResults.length}
            totalCount={results.length}
            hasQuery={hasQuery}
            groupedResults={groupedResults}
            collapsedRepos={collapsedRepos}
            onToggleRepo={handleToggleRepo}
            activeSessionKey={activeSessionKey}
            onOpenSession={handleSidebarOpenSession}
            onToggleStar={toggleStar}
            onJumpToHit={handleSidebarJumpToHit}
            firstLoad={firstLoad}
          />
        </div>

        {sidebarOpen ? (
          <div
            onClick={() => setSidebarOpen(false)}
            aria-hidden
            className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-[2px] animate-fade-in lg:hidden"
          />
        ) : null}

        <SessionView
          className="flex-1 min-w-0"
          onOpenSidebar={() => setSidebarOpen(true)}
          detail={detail}
          detailLoading={detailLoading}
          messageRoleFilter={messageRoleFilter}
          setMessageRoleFilter={setMessageRoleFilter}
          toolBucketCounts={toolBucketCounts}
          queryTokens={detailQueryTokens}
          detailMessageHits={detailMessageHits}
          activeMatch={activeMatch}
          pulseKey={pulseKey}
          onPrevMatch={() => jumpToMatch(activeMatch - 1)}
          onNextMatch={() => jumpToMatch(activeMatch + 1)}
          inSessionQuery={inSessionQuery}
          setInSessionQuery={setInSessionQuery}
          visibleEvents={visibleEvents}
          visibleSubagents={visibleSubagents}
          conversationViewportRef={conversationViewportRef}
          registerEventRef={registerEventRef}
          onToggleStar={() => detail && toggleStar(detail.session_key)}
          onCopySessionId={onCopySessionId}
          onExport={onExport}
          exportLoading={exportLoading}
          onDeleteSession={onDeleteSession}
          tagInput={tagInput}
          setTagInput={setTagInput}
          onAddTag={(value) => (detail ? addTag(detail.session_key, value) : false)}
          onRemoveTag={(tag) => detail && removeTag(detail.session_key, tag)}
          statusText={status}
        />
      </div>

      {detail && exportDialogKind ? (
        <ExportTargetDialog
          open
          onClose={() => setExportDialogKind(null)}
          sessionKey={detail.session_key}
          kind={exportDialogKind}
          onWritten={(info) => handleExportWritten(exportDialogKind, info)}
        />
      ) : null}

      {detail ? <ScrollToTop onClick={scrollToTop} label="回到顶部" /> : null}
    </div>
  );
}
