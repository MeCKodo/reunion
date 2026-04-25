import path from "node:path";
import {
  DEFAULT_CLAUDE_ROOT,
  DEFAULT_CODEX_ROOT,
  DEFAULT_CURSOR_ROOT,
  DEFAULT_HOST,
  DEFAULT_PORT,
} from "./config.js";
import { buildIndex } from "./index-store.js";
import { runServe } from "./http-server.js";
import type { SourceRoots } from "./types.js";

type ParsedArgs = { cmd: string | undefined; options: Record<string, string> };

function parseArgs(argv: string[]): ParsedArgs {
  const cmd = argv[2];
  const options: Record<string, string> = {};

  for (let i = 3; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
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

function resolveRoots(options: Record<string, string>): SourceRoots {
  const cursor = path.resolve(
    options["cursor-root"] || options["source-root"] || DEFAULT_CURSOR_ROOT
  );
  const claudeCode = path.resolve(options["claude-root"] || DEFAULT_CLAUDE_ROOT);
  const codex = path.resolve(options["codex-root"] || DEFAULT_CODEX_ROOT);
  return { cursor, claudeCode, codex };
}

async function runIndexCommand(roots: SourceRoots): Promise<void> {
  const stats = await buildIndex(roots, null);
  console.log(JSON.stringify(stats, null, 2));
}

async function main(): Promise<void> {
  const { cmd, options } = parseArgs(process.argv);
  const roots = resolveRoots(options);

  if (cmd === "index") {
    await runIndexCommand(roots);
    return;
  }

  if (cmd === "serve") {
    const host = options.host || DEFAULT_HOST;
    const portRaw = Number.parseInt(options.port || String(DEFAULT_PORT), 10);
    const port = Number.isNaN(portRaw) ? DEFAULT_PORT : portRaw;
    await runServe(host, port, roots);
    return;
  }

  console.error(
    [
      "Usage: tsx src/server.ts <index|serve>",
      "  [--cursor-root <path>] (default ~/.cursor/projects)",
      "  [--claude-root <path>] (default ~/.claude/projects)",
      "  [--codex-root <path>]  (default ~/.codex/sessions)",
      "  [--source-root <path>] (alias for --cursor-root)",
      "  [--port <n>] [--host <host>]",
    ].join("\n")
  );
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
