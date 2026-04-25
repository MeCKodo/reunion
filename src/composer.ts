import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CURSOR_WORKSPACE_STORAGE } from "./config";
import type { ComposerMeta } from "./types";

const execFileAsync = promisify(execFile);

export async function loadComposerMetadata(): Promise<Map<string, ComposerMeta>> {
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
