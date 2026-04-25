import { promises as fs } from "node:fs";
import path from "node:path";
import { categoryFromRole, normalizeRole } from "../transcript";
import { safeJsonStringify } from "../lib/text";
import type {
  DetailedTranscript,
  Session,
  SubagentSessionDetail,
  TimelineEvent,
  TranscriptFileEntry,
} from "../types";
import type { SourceAdapter } from "./types";

const SOURCE_ID = "claude-code" as const;

function buildSessionKey(repo: string, sessionId: string): string {
  return `${SOURCE_ID}:${repo}:${sessionId}`;
}

function isoToEpochSeconds(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

async function peekSessionInfo(filePath: string): Promise<{ cwd?: string; firstTs?: number }> {
  try {
    const fh = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(16384);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytesRead).toString("utf-8");
      const lines = text.split("\n");
      let cwd: string | undefined;
      let firstTs: number | undefined;
      for (const line of lines) {
        if (!line.trim()) continue;
        let row: { cwd?: string; timestamp?: string; type?: string };
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (row.cwd && !cwd) cwd = row.cwd;
        const ts = isoToEpochSeconds(row.timestamp);
        if (ts && !firstTs && (row.type === "user" || row.type === "assistant")) {
          firstTs = ts;
        }
        if (cwd && firstTs) break;
      }
      return { cwd, firstTs };
    } finally {
      await fh.close();
    }
  } catch {
    return {};
  }
}

type ParsedRow = {
  type?: string;
  message?: {
    role?: string;
    content?:
      | string
      | Array<{
          type?: string;
          text?: string;
          name?: string;
          input?: unknown;
          content?: unknown;
          tool_use_id?: string;
          id?: string;
          is_error?: boolean;
        }>;
  };
  timestamp?: string;
};

function parseLine(line: string): ParsedRow | null {
  try {
    return JSON.parse(line) as ParsedRow;
  } catch {
    return null;
  }
}

function collectPlainTextLines(raw: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    const row = parseLine(line);
    if (!row) continue;
    if (row.type !== "user" && row.type !== "assistant") continue;
    const role = normalizeRole(row.message?.role || row.type);
    const content = row.message?.content;
    const texts: string[] = [];

    if (typeof content === "string") {
      const text = content.trim();
      if (text) texts.push(text);
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "text" && typeof item.text === "string") {
          const text = item.text.trim();
          if (text) texts.push(text);
          continue;
        }
        if (item.type === "tool_result") {
          const inner = item.content;
          const text =
            typeof inner === "string"
              ? inner.trim()
              : Array.isArray(inner)
              ? inner
                  .map((piece) =>
                    piece && typeof piece === "object" && typeof (piece as { text?: string }).text === "string"
                      ? (piece as { text: string }).text
                      : ""
                  )
                  .filter(Boolean)
                  .join("\n")
                  .trim()
              : "";
          if (text) texts.push(text);
        }
      }
    }

    if (texts.length === 0) continue;
    out.push(`${role}:`);
    out.push(texts.join("\n"));
    out.push("");
  }
  return out.join("\n").trim();
}

const SYSTEM_INJECTED_PREFIXES = [
  "<local-command-",
  "<command-",
  "<system-reminder>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
];

function isSystemInjectedUserBlock(text: string): boolean {
  const head = text.trim();
  if (!head) return true;
  return SYSTEM_INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix));
}

function pickFirstUserSnippet(content: string): string {
  const lines = content.split(/\r?\n/);
  const blocks: string[][] = [];
  let current: string[] | null = null;
  let activeRole: "user" | "assistant" | "system" | null = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === "user:" || trimmed === "assistant:" || trimmed === "system:") {
      if (current && activeRole === "user") blocks.push(current);
      activeRole = trimmed.slice(0, -1) as "user" | "assistant" | "system";
      current = activeRole === "user" ? [] : null;
      continue;
    }
    if (current && trimmed) current.push(trimmed);
  }
  if (current && activeRole === "user") blocks.push(current);
  for (const block of blocks) {
    const text = block.join(" ").trim();
    if (!text || isSystemInjectedUserBlock(text)) continue;
    return text.slice(0, 120);
  }
  return "Untitled session";
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const candidate = item as { type?: string; text?: string; content?: unknown };
        if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text;
        return safeJsonStringify(candidate, 2);
      })
      .filter(Boolean);
    return parts.join("\n");
  }
  if (value === undefined || value === null) return "";
  return safeJsonStringify(value, 2);
}

export function createClaudeCodeAdapter(rootDir: string): SourceAdapter {
  return {
    id: SOURCE_ID,
    displayName: "Claude Code",
    rootDir,

    async collectTranscriptFiles(): Promise<TranscriptFileEntry[]> {
      let projectDirs: string[];
      try {
        projectDirs = (await fs.readdir(rootDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }

      const bySession = new Map<string, TranscriptFileEntry>();
      await Promise.all(
        projectDirs.map(async (projectDir) => {
          const projectPath = path.join(rootDir, projectDir);
          let entries;
          try {
            entries = await fs.readdir(projectPath, { withFileTypes: true });
          } catch {
            return;
          }

          for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
            const filePath = path.join(projectPath, entry.name);
            let stat;
            try {
              stat = await fs.stat(filePath);
            } catch {
              continue;
            }

            const sessionId = path.basename(filePath, ".jsonl");
            const peek = await peekSessionInfo(filePath);
            const repoPath = peek.cwd;
            const repo = repoPath ? path.basename(repoPath) : projectDir;
            const sessionKey = buildSessionKey(repo, sessionId);
            const prev = bySession.get(sessionKey);
            if (prev && stat.mtimeMs < prev.mtimeMs) continue;
            bySession.set(sessionKey, {
              source: SOURCE_ID,
              sessionKey,
              sessionId,
              repo,
              repoPath,
              filePath,
              mtimeMs: stat.mtimeMs,
              birthtimeMs: peek.firstTs ? peek.firstTs * 1000 : stat.birthtimeMs || stat.mtimeMs,
              size: stat.size,
            });
          }
        })
      );
      return Array.from(bySession.values());
    },

    async readTranscriptContent(filePath: string): Promise<string> {
      const raw = await fs.readFile(filePath, "utf-8");
      return collectPlainTextLines(raw);
    },

    deriveTitle(content: string): string {
      return pickFirstUserSnippet(content);
    },

    async loadDetailedTranscript(
      filePath: string,
      startedAt: number,
      updatedAt: number,
      sourcePrefix: string
    ): Promise<DetailedTranscript> {
      return parseClaudeCodeJsonl(filePath, startedAt, updatedAt, sourcePrefix);
    },

    async loadSubagentSessions(parent: Session): Promise<SubagentSessionDetail[]> {
      // Claude Code stores sidechain agents in a sibling directory named after
      // the parent sessionId, e.g. <projectDir>/<sessionId>/subagents/agent-*.jsonl.
      // (.meta.json files in the same dir are ignored — they hold scheduling
      // state, not transcript content.)
      const subagentDir = path.join(
        path.dirname(parent.filePath),
        parent.sessionId,
        "subagents"
      );

      let entries;
      try {
        entries = await fs.readdir(subagentDir, { withFileTypes: true, encoding: "utf8" });
      } catch {
        return [];
      }

      const subagents = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map(async (entry) => {
            const filePath = path.join(subagentDir, entry.name);
            const stat = await fs.stat(filePath);
            const sessionId = path.basename(filePath, ".jsonl");
            const startedAt = Math.floor((stat.birthtimeMs || stat.mtimeMs) / 1000);
            const updatedAt = Math.floor(stat.mtimeMs / 1000);
            const detailed = await parseClaudeCodeJsonl(
              filePath,
              startedAt,
              updatedAt,
              `subagent:${sessionId}`
            );

            return {
              sessionId,
              title: pickFirstUserSnippet(detailed.content),
              filePath,
              startedAt,
              updatedAt,
              sizeBytes: stat.size,
              rawContent: detailed.rawContent,
              content: detailed.content,
              events: detailed.events,
            };
          })
      );

      return subagents.sort((a, b) => a.startedAt - b.startedAt);
    },
  };
}

/**
 * Shared Claude Code JSONL parser used by both top-level transcripts and
 * sidechain subagent transcripts (which use the exact same row schema).
 * Recognised content item types: text / tool_use / tool_result / thinking;
 * everything else falls back to a system meta event so nothing is silently
 * dropped.
 */
async function parseClaudeCodeJsonl(
  filePath: string,
  startedAt: number,
  updatedAt: number,
  sourcePrefix: string
): Promise<DetailedTranscript> {
  const raw = await fs.readFile(filePath, "utf-8");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const flatContent: string[] = [];
  const events: TimelineEvent[] = [];
  let legacySegmentIndex = 0;
  let firstTs: number | null = null;
  let eventIndex = 0;

  for (const line of lines) {
    const row = parseLine(line);
    if (!row) continue;
    if (row.type !== "user" && row.type !== "assistant") continue;

    const ts = isoToEpochSeconds(row.timestamp);
    if (ts !== null && firstTs === null) firstTs = ts;

    const role = normalizeRole(row.message?.role || row.type);
    const content = row.message?.content;
    const rowTextItems: string[] = [];
    const tsValue = ts ?? 0;

    if (typeof content === "string") {
      const text = content.trim();
      if (text) {
        events.push({
          eventId: `${sourcePrefix}:${eventIndex++}`,
          category: categoryFromRole(role),
          role,
          kind: "text",
          contentType: "text",
          text,
          ts: tsValue,
          legacySegmentIndex,
        });
        rowTextItems.push(text);
      }
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const itemType = typeof item.type === "string" ? item.type : "unknown";

        if (itemType === "text" && typeof item.text === "string") {
          const text = item.text.trim();
          if (!text) continue;
          events.push({
            eventId: `${sourcePrefix}:${eventIndex++}`,
            category: categoryFromRole(role),
            role,
            kind: "text",
            contentType: "text",
            text,
            ts: tsValue,
            legacySegmentIndex,
          });
          rowTextItems.push(text);
          continue;
        }

        if (itemType === "tool_use") {
          const name = typeof item.name === "string" ? item.name : "Tool";
          const inputPayload = item.input === undefined ? "" : safeJsonStringify(item.input, 2);
          const toolCallId = typeof item.id === "string" ? item.id : undefined;
          events.push({
            eventId: `${sourcePrefix}:${eventIndex++}`,
            category: "tool",
            role,
            kind: "tool_use",
            contentType: "tool_use",
            text: inputPayload ? `${name}\n${inputPayload}` : name,
            toolName: name,
            toolInput: item.input,
            toolCallId,
            ts: tsValue,
          });
          continue;
        }

        if (itemType === "tool_result") {
          const text = stringifyToolResult(item.content);
          if (!text.trim()) continue;
          const toolCallId = typeof item.tool_use_id === "string" ? item.tool_use_id : undefined;
          const isError = item.is_error === true;
          events.push({
            eventId: `${sourcePrefix}:${eventIndex++}`,
            category: "tool",
            role,
            kind: "meta",
            contentType: "tool_result",
            text,
            ts: tsValue,
            toolCallId,
            isError: isError || undefined,
          });
          continue;
        }

        if (itemType === "thinking" && typeof item.text === "string") {
          const text = item.text.trim();
          if (!text) continue;
          events.push({
            eventId: `${sourcePrefix}:${eventIndex++}`,
            category: "system",
            role,
            kind: "meta",
            contentType: "thinking",
            text,
            ts: tsValue,
          });
          continue;
        }

        const metaText = safeJsonStringify(item, 2);
        if (!metaText) continue;
        events.push({
          eventId: `${sourcePrefix}:${eventIndex++}`,
          category: "system",
          role,
          kind: "meta",
          contentType: itemType,
          text: metaText,
          ts: tsValue,
        });
      }
    }

    if (rowTextItems.length > 0) {
      flatContent.push(`${role}:`);
      flatContent.push(rowTextItems.join("\n"));
      flatContent.push("");
      legacySegmentIndex += 1;
    }
  }

  const fallbackTs = firstTs ?? (startedAt > 0 ? startedAt : updatedAt) ?? Math.floor(Date.now() / 1000);
  for (const event of events) {
    if (!event.ts) event.ts = fallbackTs;
  }

  return {
    rawContent: raw,
    content: flatContent.join("\n").trim(),
    events,
  };
}
