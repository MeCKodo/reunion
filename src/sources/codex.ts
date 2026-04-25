import { promises as fs } from "node:fs";
import path from "node:path";
import { categoryFromRole, normalizeRole } from "../transcript";
import { safeJsonStringify } from "../lib/text";
import type {
  DetailedTranscript,
  TimelineEvent,
  TranscriptFileEntry,
} from "../types";
import type { SourceAdapter } from "./types";

const SOURCE_ID = "codex" as const;

function buildSessionKey(repo: string, sessionId: string): string {
  return `${SOURCE_ID}:${repo}:${sessionId}`;
}

function isoToEpochSeconds(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

type SessionMeta = {
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
  originator?: string;
  cliVersion?: string;
};

async function readFirstLine(filePath: string): Promise<string | null> {
  let fh;
  try {
    fh = await fs.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const chunkSize = 16384;
    const buf = Buffer.alloc(chunkSize);
    const parts: Buffer[] = [];
    let position = 0;
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, position);
      if (bytesRead <= 0) break;
      const slice = buf.subarray(0, bytesRead);
      const newlineIdx = slice.indexOf(0x0a);
      if (newlineIdx >= 0) {
        parts.push(slice.subarray(0, newlineIdx));
        return Buffer.concat(parts).toString("utf-8");
      }
      parts.push(Buffer.from(slice));
      position += bytesRead;
      if (position > 4 * 1024 * 1024) break;
    }
    if (parts.length === 0) return null;
    return Buffer.concat(parts).toString("utf-8");
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

async function peekSessionMeta(filePath: string): Promise<SessionMeta> {
  const firstLine = await readFirstLine(filePath);
  if (!firstLine || !firstLine.trim()) return {};
  let row: {
    type?: string;
    timestamp?: string;
    payload?: {
      id?: string;
      cwd?: string;
      timestamp?: string;
      originator?: string;
      cli_version?: string;
    };
  };
  try {
    row = JSON.parse(firstLine);
  } catch {
    return {};
  }
  if (row.type !== "session_meta") return {};
  const startedAt =
    isoToEpochSeconds(row.payload?.timestamp) ?? isoToEpochSeconds(row.timestamp) ?? undefined;
  return {
    sessionId: row.payload?.id,
    cwd: row.payload?.cwd,
    startedAt,
    originator: row.payload?.originator,
    cliVersion: row.payload?.cli_version,
  };
}

const INJECTED_PREFIXES = [
  "# AGENTS.md",
  "<permissions",
  "<skill>",
  "<automation",
  "<environment_context>",
  "<user_instructions>",
  "OMX native",
];

function isInjectedSystemText(text: string): boolean {
  const trimmed = text.trimStart();
  for (const prefix of INJECTED_PREFIXES) {
    if (trimmed.startsWith(prefix)) return true;
  }
  return false;
}

type CodexMessageContentItem = {
  type?: string;
  text?: string;
};

type CodexResponsePayload = {
  type?: string;
  role?: string;
  content?: CodexMessageContentItem[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: unknown;
  summary?: Array<{ text?: string }>;
  encrypted_content?: string;
  action?: unknown;
  input?: unknown;
};

type CodexLine = {
  timestamp?: string;
  type?: string;
  payload?: CodexResponsePayload;
};

function parseLine(line: string): CodexLine | null {
  try {
    return JSON.parse(line) as CodexLine;
  } catch {
    return null;
  }
}

function extractMessageText(payload: CodexResponsePayload): string[] {
  if (!Array.isArray(payload.content)) return [];
  const texts: string[] = [];
  for (const item of payload.content) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string" && item.text.trim()) {
      texts.push(item.text);
    }
  }
  return texts;
}

function shouldKeepMessage(role: string, texts: string[]): boolean {
  if (role === "developer" || role === "system") return false;
  if (role === "user") {
    if (texts.length === 0) return false;
    const joined = texts.join("\n");
    if (isInjectedSystemText(joined)) return false;
  }
  return texts.some((item) => item.trim().length > 0);
}

function formatReasoningText(payload: CodexResponsePayload): string {
  const parts: string[] = [];
  if (Array.isArray(payload.summary)) {
    for (const entry of payload.summary) {
      if (entry && typeof entry === "object" && typeof entry.text === "string" && entry.text.trim()) {
        parts.push(entry.text.trim());
      }
    }
  }
  if (typeof payload.content === "string" && (payload.content as unknown as string).trim()) {
    parts.push((payload.content as unknown as string).trim());
  }
  return parts.join("\n");
}

function stringifyFunctionArguments(raw: unknown): { text: string; parsed: unknown } {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { text: "", parsed: undefined };
    try {
      const parsed = JSON.parse(trimmed);
      return { text: safeJsonStringify(parsed, 2), parsed };
    } catch {
      return { text: trimmed, parsed: trimmed };
    }
  }
  if (raw === undefined || raw === null) return { text: "", parsed: undefined };
  return { text: safeJsonStringify(raw, 2), parsed: raw };
}

function stringifyFunctionOutput(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw === undefined || raw === null) return "";
  return safeJsonStringify(raw, 2);
}

function collectPlainContent(raw: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    const row = parseLine(line);
    if (!row || row.type !== "response_item") continue;
    const payload = row.payload;
    if (!payload || payload.type !== "message") continue;
    const role = typeof payload.role === "string" ? payload.role : "user";
    const texts = extractMessageText(payload);
    if (!shouldKeepMessage(role, texts)) continue;
    const mappedRole = normalizeRole(role);
    out.push(`${mappedRole}:`);
    out.push(texts.join("\n"));
    out.push("");
  }
  return out.join("\n").trim();
}

function pickFirstUserSnippet(content: string): string {
  const lines = content.split(/\r?\n/);
  let inUser = false;
  const buffer: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === "user:") {
      if (buffer.length > 0) break;
      inUser = true;
      continue;
    }
    if (trimmed === "assistant:" || trimmed === "system:") {
      if (buffer.length > 0) break;
      inUser = false;
      continue;
    }
    if (inUser && trimmed) buffer.push(trimmed);
  }
  const text = buffer.join(" ").trim();
  return text ? text.slice(0, 120) : "Untitled session";
}

async function listJsonlFiles(rootDir: string): Promise<string[]> {
  let years: string[];
  try {
    years = (await fs.readdir(rootDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const files: string[] = [];
  await Promise.all(
    years.map(async (year) => {
      const yearDir = path.join(rootDir, year);
      let months: string[];
      try {
        months = (await fs.readdir(yearDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return;
      }
      await Promise.all(
        months.map(async (month) => {
          const monthDir = path.join(yearDir, month);
          let days: string[];
          try {
            days = (await fs.readdir(monthDir, { withFileTypes: true }))
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name);
          } catch {
            return;
          }
          await Promise.all(
            days.map(async (day) => {
              const dayDir = path.join(monthDir, day);
              let entries;
              try {
                entries = await fs.readdir(dayDir, { withFileTypes: true });
              } catch {
                return;
              }
              for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
                files.push(path.join(dayDir, entry.name));
              }
            })
          );
        })
      );
    })
  );

  return files;
}

export function createCodexAdapter(rootDir: string): SourceAdapter {
  return {
    id: SOURCE_ID,
    displayName: "Codex",
    rootDir,

    async collectTranscriptFiles(): Promise<TranscriptFileEntry[]> {
      const files = await listJsonlFiles(rootDir);
      const bySession = new Map<string, TranscriptFileEntry>();

      await Promise.all(
        files.map(async (filePath) => {
          let stat;
          try {
            stat = await fs.stat(filePath);
          } catch {
            return;
          }
          const meta = await peekSessionMeta(filePath);
          const sessionId = meta.sessionId || path.basename(filePath, ".jsonl");
          const repoPath = meta.cwd;
          const repo = repoPath ? path.basename(repoPath) : "unknown";
          const sessionKey = buildSessionKey(repo, sessionId);
          const prev = bySession.get(sessionKey);
          if (prev && stat.mtimeMs < prev.mtimeMs) return;
          bySession.set(sessionKey, {
            source: SOURCE_ID,
            sessionKey,
            sessionId,
            repo,
            repoPath,
            filePath,
            mtimeMs: stat.mtimeMs,
            birthtimeMs: meta.startedAt ? meta.startedAt * 1000 : stat.birthtimeMs || stat.mtimeMs,
            size: stat.size,
          });
        })
      );

      return Array.from(bySession.values());
    },

    async readTranscriptContent(filePath: string): Promise<string> {
      const raw = await fs.readFile(filePath, "utf-8");
      return collectPlainContent(raw);
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
        const ts = isoToEpochSeconds(row.timestamp);
        if (ts !== null && firstTs === null) firstTs = ts;
        const tsValue = ts ?? 0;

        if (row.type !== "response_item") continue;
        const payload = row.payload;
        if (!payload || typeof payload !== "object") continue;

        if (payload.type === "message") {
          const role = typeof payload.role === "string" ? payload.role : "user";
          const texts = extractMessageText(payload);
          if (!shouldKeepMessage(role, texts)) continue;
          const mappedRole = normalizeRole(role);
          const joined = texts.join("\n").trim();
          if (!joined) continue;
          events.push({
            eventId: `${sourcePrefix}:${eventIndex++}`,
            category: categoryFromRole(mappedRole),
            role: mappedRole,
            kind: "text",
            contentType: "text",
            text: joined,
            ts: tsValue,
            legacySegmentIndex,
          });
          flatContent.push(`${mappedRole}:`);
          flatContent.push(joined);
          flatContent.push("");
          legacySegmentIndex += 1;
          continue;
        }

        if (payload.type === "function_call" || payload.type === "custom_tool_call") {
          const name = typeof payload.name === "string" ? payload.name : payload.type;
          const { text: argsText, parsed: argsParsed } = stringifyFunctionArguments(payload.arguments);
          const toolCallId = typeof payload.call_id === "string" ? payload.call_id : undefined;
          events.push({
            eventId: `${sourcePrefix}:${eventIndex++}`,
            category: "tool",
            role: "assistant",
            kind: "tool_use",
            contentType: "tool_use",
            text: argsText ? `${name}\n${argsText}` : name,
            toolName: name,
            toolInput: argsParsed,
            toolCallId,
            ts: tsValue,
          });
          continue;
        }

        if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
          const outputText = stringifyFunctionOutput(payload.output);
          if (!outputText.trim()) continue;
          const toolCallId = typeof payload.call_id === "string" ? payload.call_id : undefined;
          events.push({
            eventId: `${sourcePrefix}:${eventIndex++}`,
            category: "tool",
            role: "user",
            kind: "meta",
            contentType: "tool_result",
            text: outputText,
            ts: tsValue,
            toolCallId,
          });
          continue;
        }

        if (payload.type === "web_search_call") {
          const text = safeJsonStringify(payload.action, 2) || "web_search";
          events.push({
            eventId: `${sourcePrefix}:${eventIndex++}`,
            category: "tool",
            role: "assistant",
            kind: "tool_use",
            contentType: "tool_use",
            text: `web_search\n${text}`,
            toolName: "web_search",
            toolInput: payload.action,
            ts: tsValue,
          });
          continue;
        }

        if (payload.type === "reasoning") {
          const reasoningText = formatReasoningText(payload);
          if (!reasoningText.trim()) continue;
          events.push({
            eventId: `${sourcePrefix}:${eventIndex++}`,
            category: "system",
            role: "assistant",
            kind: "meta",
            contentType: "reasoning",
            text: reasoningText,
            ts: tsValue,
          });
          continue;
        }
      }

      const fallbackTs =
        firstTs ?? (startedAt > 0 ? startedAt : updatedAt) ?? Math.floor(Date.now() / 1000);
      for (const event of events) {
        if (!event.ts) event.ts = fallbackTs;
      }

      return {
        rawContent: raw,
        content: flatContent.join("\n").trim(),
        events,
      };
    },
  };
}
