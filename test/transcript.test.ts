import "./_env.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  categoryFromRole,
  deriveTitleFromContent,
  extractUserMessagesFromJsonl,
  loadDetailedTranscript,
  normalizeRole,
  parseTranscript,
  readTranscriptContent,
} from "../src/transcript.js";
import { mkTmpDir, rmDir } from "./_helpers.js";

const scratch = mkTmpDir("reunion-tr");
after(async () => rmDir(scratch));

describe("transcript/normalizeRole + categoryFromRole", () => {
  it("normalizes role labels", () => {
    assert.equal(normalizeRole("user"), "user");
    assert.equal(normalizeRole("assistant"), "assistant");
    assert.equal(normalizeRole("anything-else"), "system");
  });
  it("maps role to category", () => {
    assert.equal(categoryFromRole("user"), "user");
    assert.equal(categoryFromRole("assistant"), "assistant");
    assert.equal(categoryFromRole("system"), "system");
  });
});

describe("transcript/parseTranscript", () => {
  it("splits user / assistant blocks and assigns interpolated timestamps", () => {
    const content = "user:\nhi\n\nassistant:\nhello\n\nuser:\nfoo\n";
    const segs = parseTranscript(content, 1000, 1900);
    assert.equal(segs.length, 3);
    assert.deepEqual(
      segs.map((s) => [s.index, s.role, s.text, s.ts]),
      [
        [0, "user", "hi", 1000],
        [1, "assistant", "hello", 1450],
        [2, "user", "foo", 1900],
      ]
    );
  });
  it("returns a single system segment when no role markers are present", () => {
    const segs = parseTranscript("just one blob", 100, 200);
    assert.deepEqual(segs, [{ index: 0, role: "system", text: "just one blob", ts: 100 }]);
  });
  it("uses startedAt for every segment when start == end (no span)", () => {
    const segs = parseTranscript("user:\nA\n\nassistant:\nB", 500, 500);
    assert.equal(segs[0].ts, 500);
    assert.equal(segs[1].ts, 500);
  });
});

describe("transcript/deriveTitleFromContent", () => {
  it("returns the first non-trivial line, ignoring role markers and self-closing tag lines", () => {
    // `deriveTitleFromContent` only filters obvious markers (role tags,
    // tool prefixes, single-line `<...>` blocks). It does NOT walk balanced
    // tags, so the first content line of an XML-ish block becomes the
    // title — that's the behavior the existing code ships with.
    const text = `user:
<role>
real title here
assistant:
nope`;
    assert.equal(deriveTitleFromContent(text), "real title here");
  });
  it("falls back to 'Untitled session' when nothing usable is found", () => {
    assert.equal(deriveTitleFromContent("user:\nassistant:\n"), "Untitled session");
  });
  it("clamps to 120 chars", () => {
    const long = "x".repeat(300);
    const out = deriveTitleFromContent(long);
    assert.equal(out.length, 120);
  });
  it("skips http(s) and tag-only lines", () => {
    const text = `https://example.com
<role>
real title`;
    assert.equal(deriveTitleFromContent(text), "real title");
  });
});

describe("transcript/extractUserMessagesFromJsonl", () => {
  it("pulls out only user-text content in document order", () => {
    const jsonl = [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "first user" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "AI reply" }] } }),
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "  second user  " }] } }),
      "garbage line",
      JSON.stringify({ role: "user", message: { content: [{ type: "tool_use", text: "ignore" }] } }),
    ].join("\n");
    assert.deepEqual(extractUserMessagesFromJsonl(jsonl), ["first user", "second user"]);
  });
});

describe("transcript/readTranscriptContent", () => {
  it("returns plain text as-is for non-jsonl extensions", async () => {
    const target = path.join(scratch, "x.txt");
    await fsp.writeFile(target, "user:\nhi\n\nassistant:\nbye");
    const out = await readTranscriptContent(target);
    assert.equal(out, "user:\nhi\n\nassistant:\nbye");
  });
  it("re-renders jsonl rows into the user:/assistant: text shape", async () => {
    const target = path.join(scratch, "x.jsonl");
    const lines = [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "ask" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "answer" }] } }),
    ].join("\n");
    await fsp.writeFile(target, lines);
    const out = await readTranscriptContent(target);
    assert.match(out, /user:\nask/);
    assert.match(out, /assistant:\nanswer/);
  });
});

describe("transcript/loadDetailedTranscript", () => {
  it("returns one event per text segment for a plain-text transcript", async () => {
    const target = path.join(scratch, "plain.txt");
    await fsp.writeFile(target, "user:\nq?\n\nassistant:\na!");
    const out = await loadDetailedTranscript(target, 1000, 1100, "main:plain");
    assert.equal(out.events.length, 2);
    assert.equal(out.events[0].role, "user");
    assert.equal(out.events[0].kind, "text");
    assert.equal(out.events[1].role, "assistant");
  });

  it("expands jsonl rows into text + tool_use + image events with monotonic timestamps", async () => {
    const target = path.join(scratch, "rich.jsonl");
    const rows = [
      {
        role: "user",
        message: {
          content: [
            { type: "text", text: "user msg" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      },
      {
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "assistant msg" },
            { type: "tool_use", name: "Bash", input: { cmd: "ls" } },
          ],
        },
      },
    ];
    await fsp.writeFile(target, rows.map((r) => JSON.stringify(r)).join("\n"));

    const out = await loadDetailedTranscript(target, 1000, 1200, "main:rich");
    const kinds = out.events.map((e) => `${e.kind}:${e.contentType}`);
    assert.deepEqual(kinds, [
      "text:text",
      "meta:image",
      "text:text",
      "tool_use:tool_use",
    ]);
    // monotonic non-decreasing timestamps within [start, end]
    for (let i = 1; i < out.events.length; i++) {
      assert.ok(
        out.events[i].ts >= out.events[i - 1].ts,
        `events should be monotonic non-decreasing in ts (i=${i})`
      );
      assert.ok(out.events[i].ts >= 1000 && out.events[i].ts <= 1200);
    }
    // Tool input survives round-trip.
    const toolEvent = out.events.find((e) => e.kind === "tool_use")!;
    assert.equal(toolEvent.toolName, "Bash");
    assert.deepEqual(toolEvent.toolInput, { cmd: "ls" });
  });
});
