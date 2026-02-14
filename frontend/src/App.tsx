import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Download,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type SearchResult = {
  session_key: string;
  session_id: string;
  repo: string;
  title: string;
  file_path: string;
  started_at: number;
  updated_at: number;
  duration_sec: number;
  size_bytes: number;
  snippet: string;
  match_count: number;
  message_hits: Array<{
    segment_index: number;
    role: Role;
    ts: number;
    preview: string;
  }>;
};

type SessionDetail = SearchResult & { content: string };
type Role = "user" | "assistant" | "system";
type Segment = { index: number; role: Role; text: string; ts: number };
type RepoGroup = { repo: string; sessions: SearchResult[] };
type MessageRoleFilter = "all" | "user" | "assistant";

const DAY_OPTIONS = [
  { value: "0", label: "All time" },
  { value: "7", label: "Last 7d" },
  { value: "30", label: "Last 30d" },
  { value: "60", label: "Last 60d" },
  { value: "90", label: "Last 90d" },
];

function prettifyRepoName(repo: string): string {
  return repo.replace(/^Users-bytedance-/, "").replace(/^workspaces-/, "").replaceAll("-", " ");
}

function decodeEntities(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function stripHtml(text: string): string {
  return decodeEntities(text).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function tokenizeQuery(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_\-\u4e00-\u9fff]+/g);
  return Array.from(new Set((matches || []).map((item) => item.toLowerCase())));
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderHighlightedText(text: string, tokens: string[]) {
  if (!tokens.length) return text;
  const regex = new RegExp(`(${tokens.map((token) => escapeRegex(token)).join("|")})`, "gi");
  const parts = text.split(regex);
  return parts.map((part, index) => {
    const matched = tokens.some((token) => part.toLowerCase() === token.toLowerCase());
    if (!matched) return <Fragment key={`${part}-${index}`}>{part}</Fragment>;
    return (
      <mark key={`${part}-${index}`} className="rounded bg-[#f5cb5c]/55 px-0.5 text-[#1a1f2b]">
        {part}
      </mark>
    );
  });
}

function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function formatClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(durationSec: number): string {
  const t = Math.max(0, durationSec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function relativeTime(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - ts);
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d`;
  return `${Math.floor(delta / (86400 * 30))}mo`;
}

function roleMeta(role: Role) {
  if (role === "user") {
    return {
      label: "User",
      wrapper: "justify-end",
      bubble: "bg-[#43495a] border-[#5f6a80] text-[#f6f8fd]",
      badge: "bg-[#556a92]/35 text-[#c8dafc] border-[#7a95c2]",
    };
  }
  if (role === "assistant") {
    return {
      label: "Cursor",
      wrapper: "justify-start",
      bubble: "bg-[#1f2632] border-[#394358] text-[#e9eef8]",
      badge: "bg-[#3f6b58]/35 text-[#c8f4e0] border-[#5a9679]",
    };
  }
  return {
    label: "System",
    wrapper: "justify-start",
    bubble: "bg-[#2d3442] border-[#485269] text-[#dde5f5]",
    badge: "bg-[#5c677a]/30 text-[#dbe3f0] border-[#7a869d]",
  };
}

function parseTranscript(content: string, startedAt: number, updatedAt: number): Segment[] {
  const lines = content.split(/\r?\n/);
  const segments: Segment[] = [];
  let currentRole: Role = "system";
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) {
      segments.push({ index: segments.length, role: currentRole, text, ts: startedAt });
    }
    buffer = [];
  };

  for (const line of lines) {
    const marker = line.trim();
    if (marker === "user:") {
      flush();
      currentRole = "user";
      continue;
    }
    if (marker === "assistant:") {
      flush();
      currentRole = "assistant";
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (segments.length === 0) {
    return [{ index: 0, role: "system", text: content, ts: startedAt }];
  }

  const start = startedAt || updatedAt;
  const end = updatedAt || startedAt;
  const span = Math.max(0, end - start);
  const step = segments.length > 1 ? span / (segments.length - 1) : 0;

  return segments.map((segment, idx) => ({
    ...segment,
    index: idx,
    ts: Math.floor(start + idx * step),
  }));
}

export default function App() {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [repoOptions, setRepoOptions] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [days, setDays] = useState("30");
  const [selectedRepo, setSelectedRepo] = useState("all");
  const [activeSessionKey, setActiveSessionKey] = useState("");
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [status, setStatus] = useState("Ready");
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"parsed" | "raw">("parsed");
  const [messageRoleFilter, setMessageRoleFilter] = useState<MessageRoleFilter>("all");
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});
  const [activeMatch, setActiveMatch] = useState(0);
  const [pendingJumpSegment, setPendingJumpSegment] = useState<number | null>(null);
  const [exportLoading, setExportLoading] = useState<"" | "rules" | "skill">("");
  const segmentRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const conversationViewportRef = useRef<HTMLDivElement | null>(null);

  const queryTokens = useMemo(() => tokenizeQuery(query), [query]);
  const activeResult = useMemo(
    () => results.find((item) => item.session_key === activeSessionKey) || null,
    [results, activeSessionKey]
  );

  const parsedSegments = useMemo(
    () => (detail ? parseTranscript(detail.content, detail.started_at, detail.updated_at) : []),
    [detail]
  );

  const visibleSegments = useMemo(() => {
    if (messageRoleFilter === "all") return parsedSegments;
    return parsedSegments.filter((segment) => segment.role === messageRoleFilter);
  }, [parsedSegments, messageRoleFilter]);

  const detailMessageHits = useMemo(() => {
    if (!detail) return [];
    if (activeResult?.message_hits?.length) {
      return messageRoleFilter === "all"
        ? activeResult.message_hits
        : activeResult.message_hits.filter((item) => item.role === messageRoleFilter);
    }
    if (!queryTokens.length) return [];
    return visibleSegments
      .filter((segment) => {
        const haystack = decodeEntities(segment.text).toLowerCase();
        return queryTokens.every((token) => haystack.includes(token));
      })
      .map((segment) => ({
        segment_index: segment.index,
        role: segment.role,
        ts: segment.ts,
        preview: stripHtml(segment.text).slice(0, 220),
      }));
  }, [detail, activeResult, visibleSegments, queryTokens, messageRoleFilter]);

  const groupedResults = useMemo<RepoGroup[]>(() => {
    const map = new Map<string, SearchResult[]>();
    for (const item of results) {
      const list = map.get(item.repo) ?? [];
      list.push(item);
      map.set(item.repo, list);
    }
    return Array.from(map.entries())
      .map(([repo, sessions]) => ({ repo, sessions: sessions.sort((a, b) => b.updated_at - a.updated_at) }))
      .sort((a, b) => b.sessions.length - a.sessions.length);
  }, [results]);

  useEffect(() => {
    setCollapsedRepos((prev) => {
      const next = { ...prev };
      for (const group of groupedResults) {
        if (next[group.repo] === undefined) next[group.repo] = false;
      }
      return next;
    });
  }, [groupedResults]);

  async function openSession(sessionKey: string, targetSegment?: number) {
    setActiveSessionKey(sessionKey);
    if (typeof targetSegment === "number") {
      setMessageRoleFilter("all");
      setPendingJumpSegment(targetSegment);
    }
    const res = await fetch(`/api/session/${encodeURIComponent(sessionKey)}`);
    if (!res.ok) {
      setStatus("Failed to load session");
      return;
    }
    const data = (await res.json()) as SessionDetail;
    setDetail(data);
  }

  async function runSearch() {
    setLoading(true);
    setStatus("Searching...");
    try {
      const u = new URL("/api/search", window.location.origin);
      u.searchParams.set("q", query);
      u.searchParams.set("days", days);
      u.searchParams.set("repo", selectedRepo === "all" ? "" : selectedRepo);
      u.searchParams.set("limit", "300");

      const res = await fetch(u.toString());
      const data = await res.json();
      const items = (data.results || []) as SearchResult[];
      setResults(items);
      setStatus(`${data.count || 0} results`);

      const hasActive = items.some((item) => item.session_key === activeSessionKey);
      if (items.length > 0 && (!activeSessionKey || !hasActive)) {
        await openSession(items[0].session_key);
        setActiveMatch(0);
      }
    } catch (error) {
      setStatus(String(error));
    } finally {
      setLoading(false);
    }
  }

  async function openSourceFile(sessionKey: string) {
    const res = await fetch(`/api/open-file/${encodeURIComponent(sessionKey)}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(`Open failed: ${data.error || "unknown"}`);
      return;
    }
    setStatus("Opened transcript file");
  }

  function parseFilenameFromContentDisposition(header: string | null, fallback: string): string {
    if (!header) return fallback;
    const match = header.match(/filename="([^"]+)"/i);
    return match?.[1] || fallback;
  }

  async function exportConversation(kind: "rules" | "skill") {
    if (!detail) return;
    setExportLoading(kind);
    try {
      const u = new URL(`/api/export/${encodeURIComponent(detail.session_key)}`, window.location.origin);
      u.searchParams.set("type", kind);
      u.searchParams.set("mode", "smart");
      const res = await fetch(u.toString());
      if (!res.ok) {
        setStatus(`Export failed: ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const mode = res.headers.get("X-Export-Mode") || "basic";
      const warning = res.headers.get("X-Export-Warning");
      const decodedWarning = warning ? decodeURIComponent(warning) : "";
      const fallbackName = `${decodeEntities(detail.title || detail.session_id)}-${kind.toUpperCase()}.md`;
      const filename = parseFilenameFromContentDisposition(res.headers.get("Content-Disposition"), fallbackName);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setStatus(
        mode === "smart"
          ? `Exported ${kind.toUpperCase()} (smart)`
          : `Exported ${kind.toUpperCase()} (fallback template)${decodedWarning ? `: ${decodedWarning}` : ""}`
      );
    } catch (error) {
      setStatus(`Export failed: ${String(error)}`);
    } finally {
      setExportLoading("");
    }
  }

  async function reindex() {
    setStatus("Indexing...");
    const res = await fetch("/api/reindex", { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(`Reindex failed: ${data.error || "unknown"}`);
      return;
    }
    setStatus(`Indexed ${data.stats.sessions_indexed} sessions`);
    await loadRepoOptions();
    await runSearch();
  }

  async function loadRepoOptions() {
    try {
      const res = await fetch("/api/repos");
      if (!res.ok) return;
      const data = await res.json();
      const repos = ((data.repos || []) as Array<{ repo: string }>).map((item) => item.repo);
      setRepoOptions(repos);
    } catch {
      // no-op
    }
  }

  function toggleRepo(repo: string) {
    setCollapsedRepos((prev) => ({ ...prev, [repo]: !prev[repo] }));
  }

  function jumpToMatch(nextIndex: number) {
    if (!detailMessageHits.length) return;
    const normalized = ((nextIndex % detailMessageHits.length) + detailMessageHits.length) % detailMessageHits.length;
    setActiveMatch(normalized);
    setPendingJumpSegment(detailMessageHits[normalized].segment_index);
  }

  function scrollToSegmentInViewport(segmentIndex: number) {
    const viewport = conversationViewportRef.current;
    const target = segmentRefs.current[segmentIndex];
    if (!viewport || !target) return;
    const viewportRect = viewport.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const nextTop = viewport.scrollTop + (targetRect.top - viewportRect.top) - 96;
    viewport.scrollTo({ top: Math.max(0, nextTop), behavior: "smooth" });
  }

  function scrollConversationToTop() {
    conversationViewportRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  useEffect(() => {
    if (detailMessageHits.length > 0) {
      setActiveMatch((prev) => Math.min(prev, detailMessageHits.length - 1));
    } else {
      setActiveMatch(0);
    }
  }, [detailMessageHits.length]);

  useEffect(() => {
    if (pendingJumpSegment === null) return;
    scrollToSegmentInViewport(pendingJumpSegment);
    setPendingJumpSegment(null);
  }, [pendingJumpSegment, parsedSegments, viewMode, messageRoleFilter]);

  useEffect(() => {
    runSearch().catch((error) => setStatus(String(error)));
  }, [days, selectedRepo]);

  useEffect(() => {
    loadRepoOptions().catch(() => undefined);
    runSearch().catch((error) => setStatus(String(error)));
  }, []);

  return (
    <div className="h-screen overflow-hidden grid grid-cols-[352px_1fr]">
      <aside className="bg-[#2b3037] border-r border-[#434a57] text-[#edf2fb] flex flex-col min-h-0">
        <div className="px-4 py-4 border-b border-[#434a57]">
          <div className="flex items-center gap-2 text-[16px] font-semibold tracking-[0.01em]">
            <Sparkles className="h-4 w-4 text-[#8db9ff]" /> Cursor Conversations
          </div>

          <div className="mt-3 space-y-2.5">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") runSearch();
              }}
              placeholder="Search all repos"
              className="bg-[#272c33] border-[#555f72] text-[#f4f7fd] placeholder:text-[#aab4c6] h-10 focus-visible:ring-2 focus-visible:ring-[#6b9bff]"
            />

            <div className="space-y-2">
              <Select value={selectedRepo} onValueChange={setSelectedRepo}>
                <SelectTrigger className="bg-[#272c33] border-[#555f72] text-[#eef3fd] h-10 focus:ring-2 focus:ring-[#6b9bff]">
                  <SelectValue placeholder="Filter project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All projects</SelectItem>
                  {repoOptions.map((repo) => (
                    <SelectItem key={repo} value={repo}>
                      {prettifyRepoName(repo)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div className="flex gap-2">
              <div className="w-[130px]">
                <Select value={days} onValueChange={setDays}>
                  <SelectTrigger className="bg-[#272c33] border-[#555f72] text-[#eef3fd] h-10 focus:ring-2 focus:ring-[#6b9bff]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DAY_OPTIONS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                onClick={runSearch}
                className="bg-[#669bff] text-[#0f1420] hover:bg-[#79a9ff] gap-1.5 h-10 px-4 shadow-[0_8px_18px_rgba(20,88,255,0.26)]"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
              </Button>

              <Button
                variant="ghost"
                className="text-[#dce4f3] hover:bg-[#454c59] h-10 w-10 px-0 rounded-md focus-visible:ring-2 focus-visible:ring-[#6b9bff]"
                onClick={reindex}
                title="Reindex"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="px-4 py-2.5 text-sm text-[#c1cadc] border-b border-[#434a57]">Threads · {results.length}</div>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-2 py-3 space-y-2">
            {groupedResults.map((group) => {
              const collapsed = collapsedRepos[group.repo] ?? false;
              const repoLabel = prettifyRepoName(group.repo);
              return (
                <div key={group.repo} className="rounded-lg">
                  <button
                    className="w-full flex items-center gap-2 px-2 py-2 rounded-md hover:bg-[#454c59] text-[#edf2fb] transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-[#6b9bff]"
                    onClick={() => toggleRepo(group.repo)}
                  >
                    {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    <Folder className="h-4 w-4 text-[#c8d1e2]" />
                    <span className="truncate text-[14px] font-semibold">{repoLabel}</span>
                    <span className="ml-auto text-xs text-[#b5bed1]">{group.sessions.length}</span>
                  </button>

                  {!collapsed ? (
                    <div className="mt-1 pl-7 space-y-1">
                      {group.sessions.map((item) => {
                        const selected = item.session_key === activeSessionKey;
                        const title = decodeEntities(item.title || stripHtml(item.snippet) || item.session_id);
                        const hasQuery = queryTokens.length > 0;
                        return (
                          <div
                            key={item.session_key}
                            className={`w-full text-left px-2.5 py-2 rounded-md transition-colors duration-150 ${
                              selected ? "bg-[#5f6677]/90 ring-1 ring-[#88a1d0]" : "hover:bg-[#424955]"
                            }`}
                          >
                            <button className="w-full text-left" onClick={() => openSession(item.session_key)}>
                              <div className="flex items-start gap-2">
                                <div className="truncate text-[14px] leading-5 text-[#f5f8fd] flex-1">{title}</div>
                                <div className="text-[12px] text-[#bcc5d8] shrink-0">{relativeTime(item.updated_at)}</div>
                              </div>
                              <div className="mt-1 flex items-center gap-2 text-[12px] text-[#a5afc4]">
                                <Clock3 className="h-3 w-3" />
                                <span>{formatDuration(item.duration_sec)}</span>
                                <span>·</span>
                                <span className="truncate">{formatTs(item.started_at)}</span>
                              </div>
                            </button>
                            {hasQuery ? (
                              <div className="mt-1.5 space-y-1.5">
                                <div className="flex items-center justify-between text-[11px]">
                                <span className="text-[#8eb5ff]">命中消息 {item.match_count || 0} 条</span>
                                </div>
                                {item.message_hits.slice(0, 2).map((hit, hitIndex) => (
                                  <button
                                    key={`${item.session_key}-${hit.segment_index}-${hitIndex}`}
                                    onClick={() => {
                                      setActiveMatch(hitIndex);
                                      openSession(item.session_key, hit.segment_index);
                                    }}
                                    className="w-full text-left rounded border border-[#566176] bg-[#2d3442]/80 px-2 py-1.5 text-[11px] text-[#dce5f6] hover:bg-[#394357]"
                                  >
                                    <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[#9cb0d0]">
                                      <span>{hit.role === "assistant" ? "Cursor" : hit.role}</span>
                                      <span>·</span>
                                      <span>{formatClock(hit.ts)}</span>
                                    </div>
                                    <div className="line-clamp-2" dangerouslySetInnerHTML={{ __html: hit.preview }} />
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </aside>

      <section className="bg-[#12161d] text-[#ebeff8] h-full flex flex-col overflow-hidden">
        <div className="sticky top-0 z-30 h-[62px] border-b border-[#2a3140] px-5 flex items-center gap-3 bg-[#12161d]/95 backdrop-blur">
          {detail ? (
            <>
              <div className="truncate text-[19px] font-semibold tracking-[0.01em]">{decodeEntities(detail.title || detail.session_id)}</div>
              <Badge variant="outline" className="border-[#414b5f] text-[#b3bdd0]">
                {prettifyRepoName(detail.repo)}
              </Badge>
              <div className="ml-auto text-[13px] text-[#99a7bf]">Started {formatTs(detail.started_at)}</div>
              <div className="text-[13px] text-[#99a7bf]">Duration {formatDuration(detail.duration_sec)}</div>
              <Button
                size="sm"
                variant="outline"
                className="border-[#445064] bg-[#1a212d] hover:bg-[#263246] focus-visible:ring-2 focus-visible:ring-[#6b9bff]"
                onClick={() => openSourceFile(detail.session_key)}
              >
                <FileText className="h-4 w-4" /> Open
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-[#445064] bg-[#1a212d] hover:bg-[#263246] focus-visible:ring-2 focus-visible:ring-[#6b9bff]"
                onClick={() => exportConversation("rules")}
                disabled={exportLoading !== ""}
              >
                {exportLoading === "rules" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Smart Rules
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-[#445064] bg-[#1a212d] hover:bg-[#263246] focus-visible:ring-2 focus-visible:ring-[#6b9bff]"
                onClick={() => exportConversation("skill")}
                disabled={exportLoading !== ""}
              >
                {exportLoading === "skill" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Smart Skill
              </Button>
            </>
          ) : (
            <div className="text-[15px] text-[#919bad]">Select a thread from the left panel.</div>
          )}
        </div>

        {!detail ? (
          <div className="h-full flex items-center justify-center text-[#8f98aa] text-[15px]">No session selected.</div>
        ) : (
          <>
            <div className="sticky top-[62px] z-20 h-[52px] border-b border-[#2a3140] px-5 flex items-center gap-2 bg-[#131b29]/95 backdrop-blur">
              <Button
                size="sm"
                variant={viewMode === "parsed" ? "default" : "ghost"}
                className={viewMode === "parsed" ? "bg-[#669bff] text-[#111726] hover:bg-[#79a9ff]" : "hover:bg-[#25324a]"}
                onClick={() => setViewMode("parsed")}
              >
                Conversation
              </Button>
              <Button
                size="sm"
                variant={viewMode === "raw" ? "default" : "ghost"}
                className={viewMode === "raw" ? "bg-[#669bff] text-[#111726] hover:bg-[#79a9ff]" : "hover:bg-[#25324a]"}
                onClick={() => setViewMode("raw")}
              >
                Raw
              </Button>
              {viewMode === "parsed" ? (
                <div className="ml-2 inline-flex items-center rounded-md border border-[#3a455a] bg-[#1a2435] p-0.5">
                  <button
                    className={`px-2.5 py-1 text-[12px] rounded ${
                      messageRoleFilter === "all" ? "bg-[#2e4b78] text-[#e6f0ff]" : "text-[#9db0d1] hover:bg-[#23304a]"
                    }`}
                    onClick={() => setMessageRoleFilter("all")}
                  >
                    全部
                  </button>
                  <button
                    className={`px-2.5 py-1 text-[12px] rounded ${
                      messageRoleFilter === "user" ? "bg-[#2e4b78] text-[#e6f0ff]" : "text-[#9db0d1] hover:bg-[#23304a]"
                    }`}
                    onClick={() => setMessageRoleFilter("user")}
                  >
                    User
                  </button>
                  <button
                    className={`px-2.5 py-1 text-[12px] rounded ${
                      messageRoleFilter === "assistant"
                        ? "bg-[#2e4b78] text-[#e6f0ff]"
                        : "text-[#9db0d1] hover:bg-[#23304a]"
                    }`}
                    onClick={() => setMessageRoleFilter("assistant")}
                  >
                    Cursor
                  </button>
                </div>
              ) : null}
              <div className="text-[12px] text-[#8492ab] ml-1">message timestamps are interpolated</div>
              {viewMode === "parsed" && queryTokens.length > 0 ? (
                <div className="ml-2 flex items-center gap-1.5 rounded-md border border-[#3a455a] bg-[#1a2435] px-2 py-1 text-[12px] text-[#b7c8e9]">
                  <span>命中 {detailMessageHits.length} 条</span>
                  {detailMessageHits.length > 0 ? (
                    <>
                      <button
                        className="rounded p-0.5 hover:bg-[#2f3f5d]"
                        onClick={() => jumpToMatch(activeMatch - 1)}
                        title="Previous match"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        className="rounded p-0.5 hover:bg-[#2f3f5d]"
                        onClick={() => jumpToMatch(activeMatch + 1)}
                        title="Next match"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                      <span className="text-[#89a3d5]">
                        {detailMessageHits.length ? activeMatch + 1 : 0}/{detailMessageHits.length}
                      </span>
                    </>
                  ) : null}
                </div>
              ) : null}
              <div className="ml-auto text-[13px] text-[#94a2bc]">{status}</div>
            </div>

            <div className="relative h-[calc(100%-112px)]">
              <ScrollArea className="h-full" viewportRef={conversationViewportRef}>
                {viewMode === "raw" ? (
                  <pre className="transcript-body p-6 text-[14px] text-[#dee6f6]">{detail.content}</pre>
                ) : (
                  <div className="max-w-[980px] mx-auto p-6 space-y-5">
                    {visibleSegments.map((segment, index) => {
                      const meta = roleMeta(segment.role);
                      const isMatch = detailMessageHits.some((hit) => hit.segment_index === segment.index);
                      const isActiveMatch =
                        detailMessageHits[activeMatch] && detailMessageHits[activeMatch].segment_index === segment.index;
                      return (
                        <div
                          key={`${segment.role}-${index}`}
                          className={`flex ${meta.wrapper}`}
                          ref={(node) => {
                            segmentRefs.current[segment.index] = node;
                          }}
                        >
                          <div className="max-w-[86%]">
                            <Badge
                              variant="outline"
                              className={`${meta.badge} mb-2 ${isActiveMatch ? "ring-2 ring-[#7ab3ff]" : ""}`}
                            >
                              {meta.label} · {formatClock(segment.ts)}
                            </Badge>
                            <Card
                              className={`border ${meta.bubble} p-4 transcript-body text-[15px] shadow-[0_10px_24px_rgba(0,0,0,0.2)] ${
                                isMatch ? "ring-1 ring-[#6fa8ff]/70" : ""
                              } ${isActiveMatch ? "ring-2 ring-[#7ab3ff]" : ""}`}
                            >
                              {renderHighlightedText(segment.text, queryTokens)}
                            </Card>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            </div>
          </>
        )}
      </section>
      {detail ? (
        <Button
          onClick={scrollConversationToTop}
          size="sm"
          className="fixed bottom-6 right-6 z-[80] h-10 px-3 rounded-full bg-[#2d4d80] text-[#e6f0ff] hover:bg-[#3c629e] shadow-[0_12px_30px_rgba(6,12,22,0.55)] border border-[#4c75b6]/60"
        >
          <ArrowUp className="h-4 w-4 mr-1" />
          回到顶部
        </Button>
      ) : null}
    </div>
  );
}
