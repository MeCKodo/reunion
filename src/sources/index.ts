import type { SourceId, SourceRoots } from "../types";
import { createClaudeCodeAdapter } from "./claude-code";
import { createCodexAdapter } from "./codex";
import { createCursorAdapter } from "./cursor";
import type { SourceAdapter } from "./types";

export function createAdapters(roots: SourceRoots): SourceAdapter[] {
  return [
    createCursorAdapter(roots.cursor),
    createClaudeCodeAdapter(roots.claudeCode),
    createCodexAdapter(roots.codex),
  ];
}

export function findAdapter(
  adapters: SourceAdapter[],
  sourceId: SourceId
): SourceAdapter | undefined {
  return adapters.find((adapter) => adapter.id === sourceId);
}

export function adapterSummaries(
  adapters: SourceAdapter[]
): Array<{ id: SourceId; display_name: string; root_dir: string }> {
  return adapters.map((adapter) => ({
    id: adapter.id,
    display_name: adapter.displayName,
    root_dir: adapter.rootDir,
  }));
}

export type { SourceAdapter } from "./types";
