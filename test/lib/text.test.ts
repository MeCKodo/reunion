import "../_env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decodeEntities,
  escapeHtml,
  escapeRegex,
  normalizeTs,
  safeJsonStringify,
  sanitizeFileName,
  toAsciiFileName,
  tokenize,
  toPlainText,
} from "../../src/lib/text.js";

describe("lib/text/normalizeTs", () => {
  it("returns fallback for non-numeric / NaN / non-positive input", () => {
    assert.equal(normalizeTs(undefined, 99), 99);
    assert.equal(normalizeTs(null, 99), 99);
    assert.equal(normalizeTs("abc", 99), 99);
    assert.equal(normalizeTs(Number.NaN, 99), 99);
    assert.equal(normalizeTs(0, 99), 99);
    assert.equal(normalizeTs(-1, 99), 99);
  });

  it("converts millisecond inputs to seconds", () => {
    assert.equal(normalizeTs(1_700_000_000_123, 0), 1_700_000_000);
  });

  it("preserves second-precision numbers", () => {
    assert.equal(normalizeTs(1_700_000_000, 0), 1_700_000_000);
    assert.equal(normalizeTs(1_700_000_000.6, 0), 1_700_000_000);
  });
});

describe("lib/text/decodeEntities + escapeHtml", () => {
  it("round-trips a full set of named entities", () => {
    const input = `<a href="x">'a' & "b"</a>`;
    const escaped = escapeHtml(input);
    assert.equal(escaped, "&lt;a href=&quot;x&quot;&gt;&#39;a&#39; &amp; &quot;b&quot;&lt;/a&gt;");
    assert.equal(decodeEntities(escaped), input);
  });

  it("handles strings without entities unchanged", () => {
    assert.equal(decodeEntities("plain"), "plain");
    assert.equal(escapeHtml("plain"), "plain");
  });
});

describe("lib/text/toPlainText", () => {
  it("strips html tags and collapses whitespace", () => {
    assert.equal(toPlainText("<p>hello\nworld   foo</p>"), "hello world foo");
  });
  it("decodes entities before stripping", () => {
    assert.equal(toPlainText("&lt;b&gt;bold&lt;/b&gt;"), "bold");
  });
});

describe("lib/text/escapeRegex", () => {
  it("escapes every regex metacharacter", () => {
    const sample = ".*+?^${}()|[]\\";
    const escaped = escapeRegex(sample);
    assert.equal(escaped, "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
    // Round-trip: an escaped string should match itself literally.
    assert.ok(new RegExp(escaped).test(sample));
  });
});

describe("lib/text/tokenize", () => {
  it("lowercases and keeps alpha-num + cjk runs", () => {
    assert.deepEqual(tokenize("Hello, 世界!  refactor-001"), [
      "hello",
      "世界",
      "refactor-001",
    ]);
  });
  it("returns empty array for empty / punctuation-only input", () => {
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize("!!! ??"), []);
  });
});

describe("lib/text/sanitizeFileName", () => {
  it("replaces unsupported characters with single dashes", () => {
    assert.equal(sanitizeFileName("Hello, world!! / OK?"), "Hello-world-OK");
  });
  it("preserves CJK characters and word chars", () => {
    assert.equal(sanitizeFileName("聊天 abc_123"), "聊天-abc_123");
  });
  it("falls back to a default token when result is empty", () => {
    assert.equal(sanitizeFileName("???"), "conversation");
    assert.equal(sanitizeFileName(""), "conversation");
  });
});

describe("lib/text/toAsciiFileName", () => {
  it("strips non-ASCII / non-filename-safe characters", () => {
    assert.equal(toAsciiFileName("会话-abc.md"), "abc.md");
  });
  it("falls back when fully stripped", () => {
    assert.equal(toAsciiFileName("纯中文"), "conversation");
  });
});

describe("lib/text/safeJsonStringify", () => {
  it("formats objects with the given indent", () => {
    const out = safeJsonStringify({ a: 1 }, 2);
    assert.equal(out, "{\n  \"a\": 1\n}");
  });
  it("falls back to String() on circular structures", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    const out = safeJsonStringify(obj);
    assert.equal(typeof out, "string");
    assert.ok(out.includes("[object Object]") || out.length > 0);
  });
});
