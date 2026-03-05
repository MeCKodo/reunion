import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

type Session = {
  sessionKey: string;
  sessionId: string;
  repo: string;
  title: string;
  filePath: string;
  startedAt: number;
  updatedAt: number;
  sizeBytes: number;
  content: string;
};

type Role = "user" | "assistant" | "system";
type ParsedSegment = {
  index: number;
  role: Role;
  text: string;
  ts: number;
};
type ExportKind = "rules" | "skill";

type IndexData = {
  sourceRoot: string;
  generatedAt: number;
  sessions: Session[];
};

type ReindexStats = {
  source_root: string;
  files_found: number;
  sessions_indexed: number;
  elapsed_ms: number;
};

const PROJECT_ROOT = path.resolve(process.cwd());
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const INDEX_FILE = path.join(DATA_DIR, "chat_index.json");
const LEGACY_STATIC_FILE = path.join(PROJECT_ROOT, "static", "index.html");
const FRONTEND_DIST_DIR = path.join(PROJECT_ROOT, "frontend", "dist");
const LEGACY_STATIC_DIR = path.join(PROJECT_ROOT, "static");
const DEFAULT_SOURCE_ROOT = path.join(process.env.HOME || "", ".cursor", "projects");
const CURSOR_WORKSPACE_STORAGE = path.join(
  process.env.HOME || "",
  "Library",
  "Application Support",
  "Cursor",
  "User",
  "workspaceStorage"
);
const execFileAsync = promisify(execFile);

let inMemoryIndex: IndexData | null = null;

function parseArgs(argv: string[]) {
  const cmd = argv[2];
  const options: Record<string, string> = {};

  for (let i = 3; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      options[key.slice(2)] = "true";
      continue;
    }
    options[key.slice(2)] = value;
    i += 1;
  }

  return { cmd, options };
}

function normalizeTs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return fallback;
  if (value > 1_000_000_000_000) return Math.floor(value / 1000);
  return Math.floor(value);
}

function decodeEntities(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function toPlainText(text: string): string {
  return decodeEntities(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizeFileName(input: string): string {
  const base = input
    .normalize("NFKD")
    .replace(/[^\w\u4e00-\u9fff-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "conversation";
}

function toAsciiFileName(input: string): string {
  const ascii = input
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii || "conversation";
}

function deriveTitleFromContent(content: string): string {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = decodeEntities(line.trim());
    if (!trimmed) continue;
    if (trimmed === "user:" || trimmed === "assistant:" || trimmed.startsWith("[Tool")) continue;
    if (
      trimmed.startsWith("<manually_attached_skills>") ||
      trimmed.startsWith("<user_query>") ||
      trimmed.startsWith("<environment_context>") ||
      trimmed.startsWith("The user has manually attached")
    ) {
      continue;
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) continue;
    if (trimmed.startsWith("<") && trimmed.endsWith(">")) continue;
    return trimmed.slice(0, 120);
  }
  return "Untitled session";
}

type ComposerMeta = {
  title: string;
  createdAt?: number;
  lastUpdatedAt?: number;
};

async function loadComposerMetadata(): Promise<Map<string, ComposerMeta>> {
  const map = new Map<string, ComposerMeta>();
  let storageDirs: string[] = [];
  try {
    storageDirs = (await fs.readdir(CURSOR_WORKSPACE_STORAGE, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(CURSOR_WORKSPACE_STORAGE, entry.name));
  } catch {
    return map;
  }

  for (const dir of storageDirs) {
    const dbPath = path.join(dir, "state.vscdb");
    try {
      await fs.access(dbPath);
      const { stdout } = await execFileAsync("sqlite3", [
        dbPath,
        "select value from ItemTable where key='composer.composerData';",
      ]);
      const raw = stdout.trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        allComposers?: Array<{
          composerId?: string;
          name?: string;
          createdAt?: number;
          lastUpdatedAt?: number;
        }>;
      };
      for (const item of parsed.allComposers || []) {
        if (!item.composerId) continue;
        map.set(item.composerId, {
          title: (item.name || "").trim(),
          createdAt: item.createdAt,
          lastUpdatedAt: item.lastUpdatedAt,
        });
      }
    } catch {
      continue;
    }
  }

  return map;
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function getProjectDirs(sourceRoot: string): Promise<string[]> {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function normalizeRole(role: string): Role {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "system";
}

function stringifyJsonlContent(raw: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as {
        role?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      const role = normalizeRole(row.role || "system");
      const text = (row.message?.content || [])
        .filter((item) => item && item.type === "text" && typeof item.text === "string")
        .map((item) => item.text || "")
        .join("\n")
        .trim();
      if (!text) continue;
      out.push(`${role}:`);
      out.push(text);
      out.push("");
    } catch {
      continue;
    }
  }
  return out.join("\n").trim();
}

async function readTranscriptContent(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, "utf-8");
  if (path.extname(filePath).toLowerCase() !== ".jsonl") return raw;
  const parsed = stringifyJsonlContent(raw);
  return parsed || raw;
}

async function collectTranscriptFiles(sourceRoot: string): Promise<string[]> {
  const projectDirs = await getProjectDirs(sourceRoot);
  const bySession = new Map<string, { filePath: string; mtimeMs: number }>();

  await Promise.all(
    projectDirs.map(async (projectDir) => {
      const transcriptDir = path.join(sourceRoot, projectDir, "agent-transcripts");
      try {
        const entries = await fs.readdir(transcriptDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(".txt")) {
            const filePath = path.join(transcriptDir, entry.name);
            const stat = await fs.stat(filePath);
            const sessionId = path.basename(filePath, ".txt");
            const sessionKey = `${projectDir}:${sessionId}`;
            const prev = bySession.get(sessionKey);
            if (!prev || stat.mtimeMs >= prev.mtimeMs) {
              bySession.set(sessionKey, { filePath, mtimeMs: stat.mtimeMs });
            }
            continue;
          }
          if (entry.isDirectory()) {
            const nestedDir = path.join(transcriptDir, entry.name);
            const nestedEntries = await fs.readdir(nestedDir, { withFileTypes: true });
            for (const nested of nestedEntries) {
              if (!nested.isFile() || !nested.name.endsWith(".jsonl")) continue;
              const filePath = path.join(nestedDir, nested.name);
              const stat = await fs.stat(filePath);
              const sessionId = path.basename(filePath, ".jsonl");
              const sessionKey = `${projectDir}:${sessionId}`;
              const prev = bySession.get(sessionKey);
              if (!prev || stat.mtimeMs >= prev.mtimeMs) {
                bySession.set(sessionKey, { filePath, mtimeMs: stat.mtimeMs });
              }
            }
          }
        }
      } catch {
        // Ignore project directories without agent-transcripts.
      }
    })
  );

  return Array.from(bySession.values()).map((item) => item.filePath);
}

async function buildIndex(sourceRootInput: string): Promise<ReindexStats> {
  const sourceRoot = path.resolve(sourceRootInput);
  const startedAt = Date.now();

  const files = await collectTranscriptFiles(sourceRoot);
  const composerMeta = await loadComposerMetadata();
  const sessions: Session[] = [];

  await Promise.all(
    files.map(async (filePath) => {
      try {
        const stat = await fs.stat(filePath);
        const content = await readTranscriptContent(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const sessionId = path.basename(filePath, ext);
        const relParts = path.relative(sourceRoot, filePath).split(path.sep).filter(Boolean);
        const repo = relParts[0] || path.basename(path.dirname(path.dirname(filePath)));
        const meta = composerMeta.get(sessionId);
        const mtime = Math.floor(stat.mtimeMs / 1000);
        const fallbackStart = Math.floor((stat.birthtimeMs || stat.mtimeMs) / 1000);
        const startedAt = normalizeTs(meta?.createdAt, fallbackStart);
        const updatedAt = normalizeTs(meta?.lastUpdatedAt, mtime);
        sessions.push({
          sessionKey: `${repo}:${sessionId}`,
          sessionId,
          repo,
          title: meta?.title || deriveTitleFromContent(content),
          filePath,
          startedAt: Math.min(startedAt, updatedAt),
          updatedAt: Math.max(startedAt, updatedAt),
          sizeBytes: stat.size,
          content,
        });
      } catch {
        // Skip unreadable files.
      }
    })
  );

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);

  const indexData: IndexData = {
    sourceRoot,
    generatedAt: Math.floor(Date.now() / 1000),
    sessions,
  };

  await ensureDataDir();
  await fs.writeFile(INDEX_FILE, JSON.stringify(indexData), "utf-8");
  inMemoryIndex = indexData;

  return {
    source_root: sourceRoot,
    files_found: files.length,
    sessions_indexed: sessions.length,
    elapsed_ms: Date.now() - startedAt,
  };
}

async function loadIndex(): Promise<IndexData> {
  if (inMemoryIndex) {
    return inMemoryIndex;
  }

  try {
    const raw = await fs.readFile(INDEX_FILE, "utf-8");
    const parsed = JSON.parse(raw) as IndexData;
    parsed.sessions = parsed.sessions.map((session) => ({
      ...session,
      startedAt: (session as Session).startedAt || session.updatedAt,
      title: (session as Session).title || "Untitled session",
    }));
    inMemoryIndex = parsed;
    return parsed;
  } catch {
    const stats = await buildIndex(DEFAULT_SOURCE_ROOT);
    if (!inMemoryIndex) {
      throw new Error(`index build failed: ${JSON.stringify(stats)}`);
    }
    return inMemoryIndex;
  }
}

function tokenize(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_\-\u4e00-\u9fff]+/g);
  return (matches || []).map((item) => item.toLowerCase());
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildSnippet(content: string, query: string): string {
  const normalized = content.toLowerCase();
  const token = tokenize(query)[0] || query.toLowerCase();
  if (!token) {
    return escapeHtml(content.slice(0, 240));
  }

  const index = normalized.indexOf(token);
  if (index < 0) {
    return escapeHtml(content.slice(0, 240));
  }

  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + 180);
  const raw = content.slice(start, end);

  const escaped = escapeHtml(raw);
  const tokenEscaped = escapeHtml(content.slice(index, index + token.length));
  if (!tokenEscaped) {
    return escaped;
  }

  const markRegex = new RegExp(tokenEscaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return escaped.replace(markRegex, `<mark>${tokenEscaped}</mark>`);
}

function parseTranscript(content: string, startedAt: number, updatedAt: number): ParsedSegment[] {
  const lines = content.split(/\r?\n/);
  const segments: Array<{ role: Role; text: string }> = [];
  let currentRole: Role = "system";
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) {
      segments.push({ role: currentRole, text });
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
    index: idx,
    role: segment.role,
    text: segment.text,
    ts: Math.floor(start + idx * step),
  }));
}

function escapeRegex(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightWithTokens(text: string, tokens: string[]): string {
  if (!tokens.length) return escapeHtml(text);
  const escapedTokens = Array.from(new Set(tokens.map((token) => token.trim()).filter(Boolean)))
    .sort((a, b) => b.length - a.length)
    .map((token) => escapeRegex(token));
  if (!escapedTokens.length) return escapeHtml(text);
  const regex = new RegExp(`(${escapedTokens.join("|")})`, "gi");
  return escapeHtml(text).replace(regex, "<mark>$1</mark>");
}

function buildSegmentPreview(text: string, tokens: string[]): string {
  const plain = decodeEntities(text).replace(/\s+/g, " ").trim();
  if (!plain) return "";
  const normalized = plain.toLowerCase();
  let hitIndex = -1;
  for (const token of tokens) {
    const idx = normalized.indexOf(token);
    if (idx >= 0 && (hitIndex < 0 || idx < hitIndex)) hitIndex = idx;
  }
  if (hitIndex < 0) return highlightWithTokens(plain.slice(0, 220), tokens);
  const start = Math.max(0, hitIndex - 70);
  const end = Math.min(plain.length, hitIndex + 170);
  return highlightWithTokens(plain.slice(start, end), tokens);
}

function extractConstraintLines(segments: ParsedSegment[]): string[] {
  const lines = segments
    .filter((segment) => segment.role === "user")
    .flatMap((segment) => decodeEntities(segment.text).split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line.length >= 4 && line.length <= 140);
  const picked = lines.filter((line) =>
    /(必须|需要|禁止|不要|优先|should|must|cannot|can't|avoid|require)/i.test(line)
  );
  return Array.from(new Set((picked.length ? picked : lines).slice(0, 8)));
}

function extractWorkflowLines(segments: ParsedSegment[]): string[] {
  const lines = segments
    .filter((segment) => segment.role === "assistant")
    .flatMap((segment) => decodeEntities(segment.text).split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line.length >= 4 && line.length <= 160);
  const picked = lines.filter((line) => /^(\d+[.)]|[-*])\s+/.test(line));
  return Array.from(new Set((picked.length ? picked : lines).slice(0, 8)));
}

function buildRulesMarkdown(session: Session): string {
  const segments = parseTranscript(session.content, session.startedAt, session.updatedAt);
  const title = toPlainText(session.title || session.sessionId);
  const userGoal = toPlainText(segments.find((segment) => segment.role === "user")?.text || "").slice(0, 400);
  const constraints = extractConstraintLines(segments);
  const workflow = extractWorkflowLines(segments);
  const updated = new Date(session.updatedAt * 1000).toISOString().slice(0, 10);

  return `# ${title} Rules

## Metadata
- source_repo: ${session.repo}
- source_session_key: ${session.sessionKey}
- updated: ${updated}

## Objective
${userGoal || "从该对话提炼执行规则。"}

## Rules
${constraints.length ? constraints.map((line) => `- ${line}`).join("\n") : "- 保持与用户需求一致，优先执行明确要求。"}

## Workflow
${workflow.length ? workflow.map((line) => `- ${line.replace(/^(\d+[.)]|[-*])\s+/, "")}`).join("\n") : "- 读取上下文 -> 制定方案 -> 执行并验证 -> 输出结果。"}

## Source Transcript
\`${session.filePath}\`
`;
}

function buildSkillMarkdown(session: Session): string {
  const segments = parseTranscript(session.content, session.startedAt, session.updatedAt);
  const title = toPlainText(session.title || session.sessionId);
  const userGoal = toPlainText(segments.find((segment) => segment.role === "user")?.text || "").slice(0, 260);
  const constraints = extractConstraintLines(segments);
  const workflow = extractWorkflowLines(segments);
  const safeName = sanitizeFileName(title).toLowerCase();

  return `---
name: ${safeName}
description: "${userGoal || `Derived from ${session.repo} conversation`}"
---

# ${title} Skill

## Purpose
${userGoal || "复用该对话中的执行能力与约束。"}

## When to Use
- 当需求与该对话目标相似时使用
- 需要复用同类流程、约束或产出结构时使用

## Inputs
- user request
- project context

## Constraints
${constraints.length ? constraints.map((line) => `- ${line}`).join("\n") : "- 遵循用户显式要求和仓库约束。"}

## Workflow
${workflow.length ? workflow.map((line, index) => `${index + 1}. ${line.replace(/^(\d+[.)]|[-*])\s+/, "")}`).join("\n") : "1. 读取上下文\n2. 设计最小可行方案\n3. 实施并验证\n4. 汇报结果"}

## Outputs
- 可执行修改
- 必要的验证结果

## Source Transcript
\`${session.filePath}\`
`;
}

function stripCodeFence(text: string): string {
  return text
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function buildSmartPrompt(session: Session, kind: ExportKind, fallbackMarkdown: string): string {
  const segments = parseTranscript(session.content, session.startedAt, session.updatedAt);
  const compactTranscript = segments
    .slice(0, 24)
    .map((segment) => `[${segment.role}] ${toPlainText(segment.text).slice(0, 320)}`)
    .join("\n");
  const outputTarget = kind === "skill" ? "SKILL.md" : "RULES.md";
  const schemaHint =
    kind === "skill"
      ? `必须包含: frontmatter(name/description), # Title, ## Purpose, ## When to Use, ## Inputs, ## Constraints, ## Workflow, ## Outputs, ## Source Transcript`
      : `必须包含: # Title, ## Metadata, ## Objective, ## Rules, ## Workflow, ## Source Transcript`;

  return [
    `你是资深工程团队规范提炼助手。请把一次 Cursor 对话转成可复用的 ${outputTarget} 文档。`,
    `要求:`,
    `1) 输出纯 Markdown，不要代码围栏。`,
    `2) 内容必须可执行，避免空话。`,
    `3) ${schemaHint}`,
    `4) 优先保留用户约束、禁止项、验收标准。`,
    `5) 如果信息不足，用“待补充”明确标注，不要编造。`,
    ``,
    `上下文:`,
    `- repo: ${session.repo}`,
    `- session_key: ${session.sessionKey}`,
    `- title: ${toPlainText(session.title || session.sessionId)}`,
    `- source transcript path: ${session.filePath}`,
    ``,
    `对话片段(已压缩):`,
    compactTranscript,
    ``,
    `可参考的基础草稿(可重写，但结构需更优):`,
    fallbackMarkdown,
  ].join("\n");
}

async function runCursorAgent(prompt: string): Promise<string> {
  const cmd = (process.env.CURSOR_AGENT_CMD || "cursor-agent").trim();
  const args = ["--print", "--output-format", "text", prompt];
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("cursor-agent timeout after 45s"));
    }, 45_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `cursor-agent exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function isValidSmartMarkdown(kind: ExportKind, markdown: string): boolean {
  const text = markdown.toLowerCase();
  if (kind === "skill") {
    return (
      text.includes("## purpose") &&
      text.includes("## workflow") &&
      text.includes("## constraints") &&
      text.includes("## outputs")
    );
  }
  return text.includes("## objective") && text.includes("## rules") && text.includes("## workflow");
}

async function generateExportMarkdown(
  session: Session,
  kind: ExportKind,
  mode: "smart" | "basic"
): Promise<{ markdown: string; mode: "smart" | "basic"; warning?: string }> {
  const fallback = kind === "skill" ? buildSkillMarkdown(session) : buildRulesMarkdown(session);
  if (mode !== "smart") {
    return { markdown: fallback, mode: "basic" };
  }
  try {
    const prompt = buildSmartPrompt(session, kind, fallback);
    const generated = stripCodeFence(await runCursorAgent(prompt));
    if (!generated || generated.length < 120 || !isValidSmartMarkdown(kind, generated)) {
      return {
        markdown: fallback,
        mode: "basic",
        warning: "smart generation returned low-confidence content, fallback applied",
      };
    }
    return { markdown: generated, mode: "smart" };
  } catch (error) {
    return { markdown: fallback, mode: "basic", warning: String(error) };
  }
}

function searchSessions(indexData: IndexData, query: string, repo: string, limit: number, days: number) {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const normalizedRepo = repo.trim();
  const normalizedQuery = query.trim();
  const tokens = tokenize(normalizedQuery);
  const safeDays = Math.max(0, days);
  const minUpdatedAt = safeDays > 0 ? Math.floor(Date.now() / 1000) - safeDays * 24 * 60 * 60 : 0;

  let candidates = indexData.sessions;
  if (normalizedRepo) {
    candidates = candidates.filter((session) => session.repo === normalizedRepo);
  }
  if (minUpdatedAt > 0) {
    candidates = candidates.filter((session) => session.updatedAt >= minUpdatedAt);
  }
  if (!normalizedQuery) {
    return candidates.slice(0, safeLimit).map((session) => ({
      session_key: session.sessionKey,
      session_id: session.sessionId,
      repo: session.repo,
      title: session.title,
      file_path: session.filePath,
      started_at: session.startedAt,
      updated_at: session.updatedAt,
      duration_sec: Math.max(0, session.updatedAt - session.startedAt),
      size_bytes: session.sizeBytes,
      snippet: escapeHtml(session.content.slice(0, 240)),
      match_count: 0,
      message_hits: [],
    }));
  }

  const ranked = candidates
    .map((session) => {
      const segments = parseTranscript(session.content, session.startedAt, session.updatedAt);
      const hits = segments
        .filter((segment) => {
          const haystack = decodeEntities(segment.text).toLowerCase();
          return tokens.every((token) => haystack.includes(token));
        })
        .map((segment) => ({
          segment_index: segment.index,
          role: segment.role,
          ts: segment.ts,
          preview: buildSegmentPreview(segment.text, tokens),
        }));
      return { session, hits };
    })
    .filter((item) => item.hits.length > 0)
    .sort((a, b) => {
      if (b.hits.length !== a.hits.length) return b.hits.length - a.hits.length;
      return b.session.updatedAt - a.session.updatedAt;
    });

  return ranked.slice(0, safeLimit).map(({ session, hits }) => ({
    session_key: session.sessionKey,
    session_id: session.sessionId,
    repo: session.repo,
    title: session.title,
    file_path: session.filePath,
    started_at: session.startedAt,
    updated_at: session.updatedAt,
    duration_sec: Math.max(0, session.updatedAt - session.startedAt),
    size_bytes: session.sizeBytes,
    snippet: hits[0]?.preview || buildSnippet(session.content, normalizedQuery),
    match_count: hits.length,
    message_hits: hits.slice(0, 5),
  }));
}

async function openFileInSystem(filePath: string): Promise<void> {
  await fs.access(filePath);
  const platform = process.platform;
  let command = "open";
  if (platform === "linux") {
    command = "xdg-open";
  } else if (platform === "win32") {
    command = "cmd";
  }

  await new Promise<void>((resolve, reject) => {
    const child =
      platform === "win32"
        ? spawn(command, ["/c", "start", "", filePath], { stdio: "ignore", windowsHide: true })
        : spawn(command, [filePath], { stdio: "ignore" });

    child.on("error", reject);
    child.on("spawn", () => resolve());
  });
}

function json(res: ServerResponse, status: number, payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(body.length));
  res.end(body);
}

function html(res: ServerResponse, status: number, bodyText: string) {
  const body = Buffer.from(bodyText);
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", String(body.length));
  res.end(body);
}

function contentTypeByExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return map[ext] || "application/octet-stream";
}

function safeResolve(rootDir: string, reqPath: string): string {
  const normalized = path.posix.normalize(reqPath).replace(/^\/+/, "");
  const resolved = path.resolve(rootDir, normalized);
  if (!resolved.startsWith(rootDir)) {
    throw new Error("invalid path");
  }
  return resolved;
}

async function tryReadFile(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

async function serveSpaOrAsset(reqPath: string, res: ServerResponse): Promise<boolean> {
  const hasExt = path.posix.extname(reqPath) !== "";
  const candidateRoots = [FRONTEND_DIST_DIR, LEGACY_STATIC_DIR];

  if (!hasExt) {
    for (const root of candidateRoots) {
      const indexPath = path.join(root, "index.html");
      const data = await tryReadFile(indexPath);
      if (data) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Content-Length", String(data.length));
        res.end(data);
        return true;
      }
    }
    return false;
  }

  for (const root of candidateRoots) {
    try {
      const filePath = safeResolve(root, reqPath);
      const data = await tryReadFile(filePath);
      if (data) {
        res.statusCode = 200;
        res.setHeader("Content-Type", contentTypeByExt(filePath));
        res.setHeader("Content-Length", String(data.length));
        res.end(data);
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

async function getRepos(indexData: IndexData) {
  const map = new Map<string, { session_count: number; last_updated_at: number }>();
  for (const session of indexData.sessions) {
    const curr = map.get(session.repo);
    if (!curr) {
      map.set(session.repo, { session_count: 1, last_updated_at: session.updatedAt });
    } else {
      curr.session_count += 1;
      curr.last_updated_at = Math.max(curr.last_updated_at, session.updatedAt);
    }
  }

  return Array.from(map.entries())
    .map(([repo, value]) => ({ repo, ...value }))
    .sort((a, b) => {
      if (b.session_count !== a.session_count) {
        return b.session_count - a.session_count;
      }
      return a.repo.localeCompare(b.repo);
    });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, sourceRoot: string) {
  const reqUrl = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "GET" && !reqUrl.pathname.startsWith("/api/")) {
    const served = await serveSpaOrAsset(reqUrl.pathname, res);
    if (!served) {
      try {
        const page = await fs.readFile(LEGACY_STATIC_FILE, "utf-8");
        html(res, 200, page);
      } catch {
        html(res, 404, "index.html not found");
      }
    }
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/repos") {
    const indexData = await loadIndex();
    const repos = await getRepos(indexData);
    json(res, 200, { repos });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/search") {
    const indexData = await loadIndex();
    const query = reqUrl.searchParams.get("q") || "";
    const repo = reqUrl.searchParams.get("repo") || "";
    const limitRaw = reqUrl.searchParams.get("limit") || "100";
    const daysRaw = reqUrl.searchParams.get("days") || "0";
    const limit = Number.parseInt(limitRaw, 10);
    const days = Number.parseInt(daysRaw, 10);
    const results = searchSessions(
      indexData,
      query,
      repo,
      Number.isNaN(limit) ? 100 : limit,
      Number.isNaN(days) ? 0 : days
    );
    json(res, 200, { count: results.length, results });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname.startsWith("/api/session/")) {
    const indexData = await loadIndex();
    const sessionKey = decodeURIComponent(reqUrl.pathname.replace("/api/session/", ""));
    const session = indexData.sessions.find((item) => item.sessionKey === sessionKey);
    if (!session) {
      json(res, 404, { error: "session not found" });
      return;
    }
    json(res, 200, {
      session_key: session.sessionKey,
      session_id: session.sessionId,
      repo: session.repo,
      title: session.title,
      file_path: session.filePath,
      started_at: session.startedAt,
      updated_at: session.updatedAt,
      duration_sec: Math.max(0, session.updatedAt - session.startedAt),
      size_bytes: session.sizeBytes,
      content: session.content,
    });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/reindex") {
    try {
      const stats = await buildIndex(sourceRoot);
      json(res, 200, { ok: true, stats });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error) });
    }
    return;
  }

  if (req.method === "POST" && reqUrl.pathname.startsWith("/api/open-file/")) {
    const indexData = await loadIndex();
    const sessionKey = decodeURIComponent(reqUrl.pathname.replace("/api/open-file/", ""));
    const session = indexData.sessions.find((item) => item.sessionKey === sessionKey);
    if (!session) {
      json(res, 404, { ok: false, error: "session not found" });
      return;
    }

    try {
      await openFileInSystem(session.filePath);
      json(res, 200, { ok: true, file_path: session.filePath });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error) });
    }
    return;
  }

  if (req.method === "GET" && reqUrl.pathname.startsWith("/api/export/")) {
    const indexData = await loadIndex();
    const sessionKey = decodeURIComponent(reqUrl.pathname.replace("/api/export/", ""));
    const session = indexData.sessions.find((item) => item.sessionKey === sessionKey);
    if (!session) {
      json(res, 404, { error: "session not found" });
      return;
    }
    const kind = ((reqUrl.searchParams.get("type") || "rules").toLowerCase() === "skill" ? "skill" : "rules") as ExportKind;
    const mode = ((reqUrl.searchParams.get("mode") || "basic").toLowerCase() === "smart" ? "smart" : "basic") as
      | "smart"
      | "basic";
    const safeTitle = sanitizeFileName(session.title || session.sessionId);
    const fileName = `${safeTitle}-${kind === "skill" ? "SKILL" : "RULES"}.md`;
    const generated = await generateExportMarkdown(session, kind, mode);
    const body = generated.markdown;
    const data = Buffer.from(body, "utf-8");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    const asciiName = toAsciiFileName(fileName);
    const utf8Name = encodeURIComponent(fileName);
    res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`);
    res.setHeader("X-Export-Mode", generated.mode);
    if (generated.warning) {
      res.setHeader("X-Export-Warning", encodeURIComponent(generated.warning.slice(0, 300)));
    }
    res.setHeader("Content-Length", String(data.length));
    res.end(data);
    return;
  }

  json(res, 404, { error: "not found" });
}

async function runServe(host: string, port: number, sourceRoot: string) {
  await ensureDataDir();
  await loadIndex();

  const server = createServer((req, res) => {
    handleRequest(req, res, sourceRoot).catch((error) => {
      json(res, 500, { error: String(error) });
    });
  });

  server.listen(port, host, () => {
    console.log(`chat explorer running: http://${host}:${port}`);
    console.log(`source_root: ${sourceRoot}`);
  });
}

async function main() {
  const { cmd, options } = parseArgs(process.argv);
  const sourceRoot = path.resolve(options["source-root"] || DEFAULT_SOURCE_ROOT);

  if (cmd === "index") {
    const stats = await buildIndex(sourceRoot);
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  if (cmd === "serve") {
    const host = options.host || "127.0.0.1";
    const port = Number.parseInt(options.port || "8765", 10);
    await runServe(host, Number.isNaN(port) ? 8765 : port, sourceRoot);
    return;
  }

  console.error("Usage: tsx src/server.ts <index|serve> [--source-root <path>] [--port <n>] [--host <host>]");
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
