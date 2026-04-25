import { promises as fs } from "node:fs";
import path from "node:path";
import { loadComposerMetadata } from "../composer";
import {
  alignUserTimestamps,
  loadAllCursorGenerations,
} from "../cursor-generations";
import {
  deriveTitleFromContent,
  extractUserMessagesFromJsonl,
  loadDetailedTranscript,
  readTranscriptContent,
} from "../transcript";
import type {
  ComposerMeta,
  DetailedTranscript,
  Session,
  SubagentSessionDetail,
  TranscriptFileEntry,
} from "../types";
import type { SourceAdapter } from "./types";

const SOURCE_ID = "cursor" as const;

/**
 * Read a Cursor jsonl, mine the workspace-scoped `aiService.generations` for
 * matching user-prompt timestamps, and call into the shared transcript
 * builder with those real timestamps as anchors. Plain-text (.txt) Cursor
 * exports don't have any timestamp signal, so we fall through unchanged.
 */
async function loadCursorJsonlWithAlignedClocks(
  filePath: string,
  startedAt: number,
  updatedAt: number,
  sourcePrefix: string
): Promise<DetailedTranscript> {
  if (path.extname(filePath).toLowerCase() !== ".jsonl") {
    return loadDetailedTranscript(filePath, startedAt, updatedAt, sourcePrefix);
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return loadDetailedTranscript(filePath, startedAt, updatedAt, sourcePrefix);
  }

  const userTexts = extractUserMessagesFromJsonl(raw);
  let hints: Array<number | undefined> | undefined;

  if (userTexts.length > 0) {
    try {
      const generations = await loadAllCursorGenerations();
      hints = alignUserTimestamps(userTexts, startedAt, updatedAt, generations);
    } catch {
      hints = undefined;
    }
  }

  return loadDetailedTranscript(filePath, startedAt, updatedAt, sourcePrefix, hints);
}

export function buildCursorSessionKey(repo: string, sessionId: string): string {
  return `${SOURCE_ID}:${repo}:${sessionId}`;
}

async function getProjectDirs(sourceRoot: string): Promise<string[]> {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

export function createCursorAdapter(rootDir: string): SourceAdapter {
  return {
    id: SOURCE_ID,
    displayName: "Cursor",
    rootDir,

    async collectTranscriptFiles(): Promise<TranscriptFileEntry[]> {
      let projectDirs: string[];
      try {
        projectDirs = await getProjectDirs(rootDir);
      } catch {
        return [];
      }

      const bySession = new Map<string, TranscriptFileEntry>();

      await Promise.all(
        projectDirs.map(async (projectDir) => {
          const transcriptDir = path.join(rootDir, projectDir, "agent-transcripts");
          const repoPath = path.join(rootDir, projectDir);
          let entries;
          try {
            entries = await fs.readdir(transcriptDir, { withFileTypes: true });
          } catch {
            return;
          }

          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith(".txt")) {
              const filePath = path.join(transcriptDir, entry.name);
              let stat;
              try {
                stat = await fs.stat(filePath);
              } catch {
                continue;
              }
              const sessionId = path.basename(filePath, ".txt");
              const sessionKey = buildCursorSessionKey(projectDir, sessionId);
              const prev = bySession.get(sessionKey);
              if (!prev || stat.mtimeMs >= prev.mtimeMs) {
                bySession.set(sessionKey, {
                  source: SOURCE_ID,
                  sessionKey,
                  sessionId,
                  repo: projectDir,
                  repoPath,
                  filePath,
                  mtimeMs: stat.mtimeMs,
                  birthtimeMs: stat.birthtimeMs || stat.mtimeMs,
                  size: stat.size,
                });
              }
              continue;
            }

            if (!entry.isDirectory()) continue;

            const nestedDir = path.join(transcriptDir, entry.name);
            let nestedEntries;
            try {
              nestedEntries = await fs.readdir(nestedDir, { withFileTypes: true });
            } catch {
              continue;
            }
            for (const nested of nestedEntries) {
              if (!nested.isFile() || !nested.name.endsWith(".jsonl")) continue;
              const filePath = path.join(nestedDir, nested.name);
              let stat;
              try {
                stat = await fs.stat(filePath);
              } catch {
                continue;
              }
              const sessionId = path.basename(filePath, ".jsonl");
              const sessionKey = buildCursorSessionKey(projectDir, sessionId);
              const prev = bySession.get(sessionKey);
              if (!prev || stat.mtimeMs >= prev.mtimeMs) {
                bySession.set(sessionKey, {
                  source: SOURCE_ID,
                  sessionKey,
                  sessionId,
                  repo: projectDir,
                  repoPath,
                  filePath,
                  mtimeMs: stat.mtimeMs,
                  birthtimeMs: stat.birthtimeMs || stat.mtimeMs,
                  size: stat.size,
                });
              }
            }
          }
        })
      );

      return Array.from(bySession.values());
    },

    async readTranscriptContent(filePath: string): Promise<string> {
      return readTranscriptContent(filePath);
    },

    deriveTitle(content: string): string {
      return deriveTitleFromContent(content);
    },

    async loadDetailedTranscript(
      filePath: string,
      startedAt: number,
      updatedAt: number,
      sourcePrefix: string
    ): Promise<DetailedTranscript> {
      return loadCursorJsonlWithAlignedClocks(filePath, startedAt, updatedAt, sourcePrefix);
    },

    async loadMetadata(): Promise<Map<string, ComposerMeta>> {
      return loadComposerMetadata();
    },

    async loadSubagentSessions(parentSession: Session): Promise<SubagentSessionDetail[]> {
      if (path.extname(parentSession.filePath).toLowerCase() !== ".jsonl") return [];
      const subagentDir = path.join(path.dirname(parentSession.filePath), "subagents");

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
            const detailed = await loadCursorJsonlWithAlignedClocks(
              filePath,
              startedAt,
              updatedAt,
              `subagent:${sessionId}`
            );

            return {
              sessionId,
              title: deriveTitleFromContent(detailed.content),
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
