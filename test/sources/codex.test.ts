import "../_env.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { createCodexAdapter } from "../../src/sources/codex.js";
import { mkTmpDir, rmDir } from "../_helpers.js";

const scratch = mkTmpDir("reunion-codex");
after(async () => rmDir(scratch));

interface CodexLine {
  type: string;
  timestamp?: string;
  payload?: unknown;
}

async function writeCodexFile(target: string, lines: CodexLine[]) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, lines.map((row) => JSON.stringify(row)).join("\n"));
}

describe("sources/codex adapter", () => {
  it("walks year/month/day and groups files by sessionId from session_meta", async () => {
    const root = path.join(scratch, "codex-root");
    const day1 = path.join(root, "2026", "05", "01");
    await writeCodexFile(path.join(day1, "file-a.jsonl"), [
      {
        type: "session_meta",
        timestamp: "2026-05-01T10:00:00.000Z",
        payload: {
          id: "sess-codex-1",
          cwd: "/Users/me/work/cool-app",
          timestamp: "2026-05-01T10:00:00.000Z",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-05-01T10:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "text", text: "hi codex" }],
        },
      },
    ]);

    const day2 = path.join(root, "2026", "05", "02");
    await writeCodexFile(path.join(day2, "file-b.jsonl"), [
      {
        type: "session_meta",
        timestamp: "2026-05-02T10:00:00.000Z",
        payload: {
          id: "sess-codex-2",
          cwd: "/Users/me/work/another-app",
          timestamp: "2026-05-02T10:00:00.000Z",
        },
      },
    ]);

    const adapter = createCodexAdapter(root);
    const entries = await adapter.collectTranscriptFiles();
    assert.equal(entries.length, 2);
    const ids = entries.map((e) => e.sessionId).sort();
    assert.deepEqual(ids, ["sess-codex-1", "sess-codex-2"]);
    const repos = entries.map((e) => e.repo).sort();
    assert.deepEqual(repos, ["another-app", "cool-app"]);
  });

  it("falls back to filename + 'unknown' repo when session_meta is missing", async () => {
    const root = path.join(scratch, "codex-noid");
    const day = path.join(root, "2026", "06", "01");
    await writeCodexFile(path.join(day, "no-meta.jsonl"), [
      {
        type: "response_item",
        timestamp: "2026-06-01T10:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "text", text: "ask without meta" }],
        },
      },
    ]);

    const adapter = createCodexAdapter(root);
    const entries = await adapter.collectTranscriptFiles();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].sessionId, "no-meta");
    assert.equal(entries[0].repo, "unknown");
  });

  it("readTranscriptContent collects only kept user/assistant message text", async () => {
    const root = path.join(scratch, "codex-read");
    const day = path.join(root, "2026", "07", "01");
    const file = path.join(day, "session.jsonl");
    await writeCodexFile(file, [
      {
        type: "session_meta",
        timestamp: "2026-07-01T10:00:00.000Z",
        payload: { id: "session" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-01T10:00:01.000Z",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "text", text: "system prompt — should be filtered" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-01T10:00:02.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "text", text: "real user msg" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-01T10:00:03.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "real assistant reply" }],
        },
      },
    ]);

    const adapter = createCodexAdapter(root);
    const text = await adapter.readTranscriptContent(file);
    assert.ok(!text.includes("developer"));
    assert.match(text, /user:\nreal user msg/);
    assert.match(text, /assistant:\nreal assistant reply/);
  });

  it("loadDetailedTranscript captures function_call / function_call_output / reasoning events", async () => {
    const root = path.join(scratch, "codex-detail");
    const day = path.join(root, "2026", "07", "02");
    const file = path.join(day, "rich.jsonl");
    await writeCodexFile(file, [
      {
        type: "session_meta",
        timestamp: "2026-07-02T10:00:00.000Z",
        payload: { id: "rich" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-02T10:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "text", text: "do a thing" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-02T10:00:02.000Z",
        payload: {
          type: "function_call",
          call_id: "fc-1",
          name: "shell",
          arguments: '{"cmd":"ls"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-02T10:00:03.000Z",
        payload: {
          type: "function_call_output",
          call_id: "fc-1",
          output: "file-1.txt\nfile-2.txt",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-02T10:00:04.000Z",
        payload: {
          type: "reasoning",
          summary: [{ text: "think step" }],
        },
      },
    ]);

    const adapter = createCodexAdapter(root);
    const detailed = await adapter.loadDetailedTranscript(file, 0, 0, "main:rich");
    const kinds = detailed.events.map((e) => `${e.kind}:${e.contentType}`);
    assert.deepEqual(kinds, [
      "text:text",
      "tool_use:tool_use",
      "meta:tool_result",
      "meta:reasoning",
    ]);
    const fc = detailed.events.find((e) => e.kind === "tool_use")!;
    const fco = detailed.events.find((e) => e.contentType === "tool_result")!;
    assert.equal(fc.toolCallId, "fc-1");
    assert.equal(fco.toolCallId, "fc-1");
    assert.deepEqual(fc.toolInput, { cmd: "ls" });
  });

  it("returns [] for missing source root", async () => {
    const adapter = createCodexAdapter(path.join(scratch, "codex-missing"));
    const entries = await adapter.collectTranscriptFiles();
    assert.deepEqual(entries, []);
  });
});
