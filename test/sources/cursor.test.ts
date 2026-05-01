import "../_env.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { createCursorAdapter } from "../../src/sources/cursor.js";
import { mkTmpDir, rmDir } from "../_helpers.js";

const scratch = mkTmpDir("reunion-cursor");
after(async () => rmDir(scratch));

describe("sources/cursor adapter", () => {
  it("collects both legacy .txt and new <sessionId>/<sessionId>.jsonl files", async () => {
    const root = path.join(scratch, "root");
    const projectDir = path.join(root, "myproject", "agent-transcripts");
    const newSessionDir = path.join(projectDir, "sess-new");
    await fsp.mkdir(newSessionDir, { recursive: true });

    // legacy .txt
    await fsp.writeFile(
      path.join(projectDir, "sess-old.txt"),
      "user:\nold session\n\nassistant:\nold reply"
    );
    // new jsonl
    const rows = [
      { role: "user", message: { content: [{ type: "text", text: "new ask" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "new reply" }] } },
    ];
    await fsp.writeFile(
      path.join(newSessionDir, "sess-new.jsonl"),
      rows.map((r) => JSON.stringify(r)).join("\n")
    );

    const adapter = createCursorAdapter(root);
    const entries = await adapter.collectTranscriptFiles();
    const ids = entries.map((e) => e.sessionId).sort();
    assert.deepEqual(ids, ["sess-new", "sess-old"]);
    for (const entry of entries) {
      assert.equal(entry.source, "cursor");
      assert.equal(entry.repo, "myproject");
      assert.equal(entry.sessionKey, `cursor:myproject:${entry.sessionId}`);
      assert.ok(entry.size > 0);
      assert.ok(entry.mtimeMs > 0);
    }
  });

  it("returns [] when the source root does not exist", async () => {
    const adapter = createCursorAdapter(path.join(scratch, "missing"));
    const entries = await adapter.collectTranscriptFiles();
    assert.deepEqual(entries, []);
  });

  it("readTranscriptContent returns text for .txt and rebuilds it for .jsonl", async () => {
    const root = path.join(scratch, "read-root");
    const projectDir = path.join(root, "p", "agent-transcripts");
    await fsp.mkdir(projectDir, { recursive: true });
    const txt = path.join(projectDir, "x.txt");
    await fsp.writeFile(txt, "user:\nhello\n\nassistant:\nhi");

    const jsonlDir = path.join(projectDir, "y");
    await fsp.mkdir(jsonlDir);
    const jsonl = path.join(jsonlDir, "y.jsonl");
    const rows = [
      { role: "user", message: { content: [{ type: "text", text: "hey" }] } },
    ];
    await fsp.writeFile(jsonl, rows.map((r) => JSON.stringify(r)).join("\n"));

    const adapter = createCursorAdapter(root);
    const t = await adapter.readTranscriptContent(txt);
    assert.match(t, /user:\nhello/);

    const j = await adapter.readTranscriptContent(jsonl);
    assert.match(j, /user:\nhey/);
  });

  it("deriveTitle returns first non-trivial line", () => {
    const adapter = createCursorAdapter("/tmp/anything");
    assert.equal(adapter.deriveTitle("user:\nhi there\nassistant:\nyo"), "hi there");
    assert.equal(adapter.deriveTitle(""), "Untitled session");
  });

  it("loadDetailedTranscript yields events for a real jsonl on disk", async () => {
    const root = path.join(scratch, "detail");
    const sessDir = path.join(root, "p", "agent-transcripts", "abc");
    await fsp.mkdir(sessDir, { recursive: true });
    const filePath = path.join(sessDir, "abc.jsonl");
    const rows = [
      { role: "user", message: { content: [{ type: "text", text: "ask one" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "answer one" }] } },
    ];
    await fsp.writeFile(filePath, rows.map((r) => JSON.stringify(r)).join("\n"));

    const adapter = createCursorAdapter(root);
    const detailed = await adapter.loadDetailedTranscript(filePath, 1000, 1100, "main:abc");
    assert.equal(detailed.events.length, 2);
    assert.equal(detailed.events[0].text, "ask one");
    assert.equal(detailed.events[1].text, "answer one");
  });
});
