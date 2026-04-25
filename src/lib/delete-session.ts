import { promises as fs } from "node:fs";
import path from "node:path";
import type { Session, SourceId, SourceRoots } from "../types";

export class DeletePathOutsideRootError extends Error {
  constructor(target: string, root: string) {
    super(`refuse to delete path "${target}" outside source root "${root}"`);
    this.name = "DeletePathOutsideRootError";
  }
}

function isPathInside(child: string, parent: string): boolean {
  const childAbs = path.resolve(child);
  const parentAbs = path.resolve(parent);
  if (childAbs === parentAbs) return false;
  const rel = path.relative(parentAbs, childAbs);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function rootForSource(source: SourceId, roots: SourceRoots): string {
  switch (source) {
    case "cursor":
      return roots.cursor;
    case "claude-code":
      return roots.claudeCode;
    case "codex":
      return roots.codex;
    default:
      return "";
  }
}

/**
 * Enumerate everything on disk that "belongs to" a single session.
 *
 * We are deliberately conservative — we do NOT try to delete the parent
 * `agent-transcripts/` or `<projectDir>/` directories even if they end up
 * empty, because they're shared across sessions and the index expects them
 * to keep existing.
 */
function listCandidatePaths(session: Session): string[] {
  const filePath = session.filePath;
  const fileDir = path.dirname(filePath);

  switch (session.source) {
    case "cursor": {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".jsonl" && path.basename(fileDir) === session.sessionId) {
        // New jsonl layout stores subagents under the same `<sessionId>/`
        // directory; nuking the directory wipes both the transcript and the
        // sidechain agents in one shot.
        return [fileDir];
      }
      return [filePath];
    }
    case "claude-code": {
      // Claude Code keeps the main transcript at `<projectDir>/<sessionId>.jsonl`
      // and any sidechain agents under `<projectDir>/<sessionId>/`. Both
      // need to go for a complete wipe.
      const sidechainDir = path.join(fileDir, session.sessionId);
      return [filePath, sidechainDir];
    }
    case "codex":
    default:
      return [filePath];
  }
}

async function safeRemove(target: string): Promise<{ removed: boolean; existed: boolean }> {
  try {
    const stat = await fs.lstat(target);
    if (!stat) return { removed: false, existed: false };
  } catch {
    return { removed: false, existed: false };
  }
  await fs.rm(target, { recursive: true, force: true });
  return { removed: true, existed: true };
}

export type DeleteSessionResult = {
  removedPaths: string[];
  missingPaths: string[];
};

export async function deleteSessionFiles(
  session: Session,
  roots: SourceRoots
): Promise<DeleteSessionResult> {
  const root = rootForSource(session.source, roots);
  if (!root) {
    throw new Error(`unknown source for session: ${session.source}`);
  }

  const candidates = listCandidatePaths(session);
  const removedPaths: string[] = [];
  const missingPaths: string[] = [];

  for (const target of candidates) {
    if (!isPathInside(target, root)) {
      throw new DeletePathOutsideRootError(target, root);
    }
    const result = await safeRemove(target);
    if (result.removed) {
      removedPaths.push(target);
    } else if (!result.existed) {
      missingPaths.push(target);
    }
  }

  return { removedPaths, missingPaths };
}
