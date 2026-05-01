import "../_env.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { createClaudeCodeAdapter } from "../../src/sources/claude-code.js";
import { mkTmpDir, rmDir } from "../_helpers.js";

const scratch = mkTmpDir("reunion-claude");
after(async () => rmDir(scratch));

describe("sources/claude-code adapter", () => {
  it("collects jsonl files and uses the cwd basename as the repo label", async () => {
    const root = path.join(scratch, "claude-root");
    const projectDir = path.join(root, "claude-proj");
    await fsp.mkdir(projectDir, { recursive: true });
    const sessFile = path.join(projectDir, "sess-A.jsonl");
    const rows = [
      {
        type: "user",
        cwd: "/Users/test/repos/my-app",
        message: { role: "user", content: [{ type: "text", text: "claude q" }] },
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "assistant",
        cwd: "/Users/test/repos/my-app",
        message: { role: "assistant", content: [{ type: "text", text: "claude a" }] },
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ];
    await fsp.writeFile(sessFile, rows.map((r) => JSON.stringify(r)).join("\n"));

    const adapter = createClaudeCodeAdapter(root);
    const entries = await adapter.collectTranscriptFiles();
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.source, "claude-code");
    assert.equal(entry.sessionId, "sess-A");
    assert.equal(entry.repo, "my-app");
    assert.equal(entry.repoPath, "/Users/test/repos/my-app");
    assert.equal(entry.sessionKey, "claude-code:my-app:sess-A");
  });

  it("falls back to the project directory name when the file has no cwd", async () => {
    const root = path.join(scratch, "claude-no-cwd");
    const projectDir = path.join(root, "fallback-proj");
    await fsp.mkdir(projectDir, { recursive: true });
    const sessFile = path.join(projectDir, "sess-B.jsonl");
    const rows = [
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "no cwd" }] },
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ];
    await fsp.writeFile(sessFile, rows.map((r) => JSON.stringify(r)).join("\n"));

    const adapter = createClaudeCodeAdapter(root);
    const entries = await adapter.collectTranscriptFiles();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].repo, "fallback-proj");
    assert.equal(entries[0].repoPath, undefined);
  });

  it("readTranscriptContent flattens jsonl rows into role-tagged plain text", async () => {
    const root = path.join(scratch, "claude-read");
    const projectDir = path.join(root, "p");
    await fsp.mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, "s.jsonl");
    const rows = [
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hey claude" }] },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi human" }] },
      },
    ];
    await fsp.writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n"));

    const adapter = createClaudeCodeAdapter(root);
    const text = await adapter.readTranscriptContent(file);
    assert.match(text, /user:\nhey claude/);
    assert.match(text, /assistant:\nhi human/);
  });

  it("loadDetailedTranscript surfaces text + tool_use + tool_result events", async () => {
    const root = path.join(scratch, "claude-detail");
    const projectDir = path.join(root, "p");
    await fsp.mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, "s.jsonl");
    const rows = [
      {
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "do work" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "running tool" },
            { type: "tool_use", id: "tu-1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-1",
              content: [{ type: "text", text: "ok" }],
              is_error: false,
            },
          ],
        },
      },
    ];
    await fsp.writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n"));

    const adapter = createClaudeCodeAdapter(root);
    const detailed = await adapter.loadDetailedTranscript(file, 1000, 2000, "main:s");
    const kinds = detailed.events.map((e) => `${e.kind}:${e.contentType}`);
    assert.deepEqual(kinds, [
      "text:text",
      "text:text",
      "tool_use:tool_use",
      "meta:tool_result",
    ]);
    const toolUse = detailed.events.find((e) => e.kind === "tool_use")!;
    const toolResult = detailed.events.find((e) => e.contentType === "tool_result")!;
    assert.equal(toolUse.toolCallId, "tu-1");
    assert.equal(toolResult.toolCallId, "tu-1");
  });
});
