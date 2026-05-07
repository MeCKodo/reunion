import "../_env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildContentFromEvents,
  mapRemoteEventsToTimeline,
  type RemoteEvent,
} from "../../src/providers/remote-mapper.js";

describe("providers/remote-mapper", () => {
  it("maps text events for both roles into TimelineEvent.text", () => {
    const events: RemoteEvent[] = [
      { role: "user", kind: "text", content: "hello", timestamp: "2026-01-01T00:00:00Z" },
      { role: "assistant", kind: "text", content: "hi", timestamp: "2026-01-01T00:01:00Z" },
    ];
    const timeline = mapRemoteEventsToTimeline(events, "sess-1");
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].kind, "text");
    assert.equal(timeline[0].role, "user");
    assert.equal(timeline[0].text, "hello");
    assert.equal(timeline[0].category, "user");
    assert.equal(timeline[1].text, "hi");
    assert.equal(timeline[1].category, "assistant");
    assert.equal(timeline[0].eventId, "remote:sess-1:0");
  });

  it("parses tool_use input as JSON when possible and falls back to raw string", () => {
    const events: RemoteEvent[] = [
      {
        role: "assistant",
        kind: "tool_use",
        tool: "Bash",
        id: "tool-1",
        input: '{"cmd":"ls"}',
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        role: "assistant",
        kind: "tool_use",
        tool: "Bash",
        id: "tool-2",
        // Already truncated by the sampler — must not crash, must not parse.
        input: '{"cmd":"ls -',
        timestamp: "2026-01-01T00:00:01Z",
      },
    ];
    const timeline = mapRemoteEventsToTimeline(events, "sess-2");
    assert.deepEqual(timeline[0].toolInput, { cmd: "ls" });
    assert.equal(timeline[0].toolName, "Bash");
    assert.equal(timeline[0].toolCallId, "tool-1");
    // Fallback path keeps the raw string so the UI can still render it.
    assert.equal(timeline[1].toolInput, '{"cmd":"ls -');
  });

  it("maps tool_result into a meta event with the originating tool_use id", () => {
    const events: RemoteEvent[] = [
      {
        role: "user",
        kind: "tool_result",
        tool_use_id: "tool-1",
        content: "OK",
        is_error: false,
        timestamp: "2026-01-01T00:00:02Z",
      },
      {
        role: "user",
        kind: "tool_result",
        tool_use_id: "tool-2",
        content: "boom",
        is_error: true,
        timestamp: "2026-01-01T00:00:03Z",
      },
    ];
    const timeline = mapRemoteEventsToTimeline(events, "sess-3");
    assert.equal(timeline[0].kind, "meta");
    assert.equal(timeline[0].contentType, "tool_result");
    assert.equal(timeline[0].toolCallId, "tool-1");
    assert.equal(timeline[0].isError, false);
    assert.equal(timeline[1].isError, true);
  });

  it("maps Cursor agent_thought events into thinking meta", () => {
    const events: RemoteEvent[] = [
      {
        role: "assistant",
        kind: "agent_thought",
        content: "thinking about the plan",
        duration_ms: 250,
        timestamp: "2026-01-01T00:00:04Z",
      },
    ];
    const timeline = mapRemoteEventsToTimeline(events, "sess-cursor");
    assert.equal(timeline[0].kind, "meta");
    assert.equal(timeline[0].contentType, "thinking");
    assert.match(timeline[0].text, /thinking about the plan/);
    assert.match(timeline[0].text, /duration: 250 ms/);
  });

  it("falls back to monotonic timestamps when input has no timestamp", () => {
    const events: RemoteEvent[] = [
      { role: "user", kind: "text", content: "first" },
      { role: "assistant", kind: "text", content: "second" },
    ];
    const timeline = mapRemoteEventsToTimeline(events, "no-ts");
    assert.ok(timeline[0].ts >= 0);
    assert.ok(timeline[1].ts >= timeline[0].ts);
  });

  it("preserves unknown event kinds as system meta", () => {
    const events: RemoteEvent[] = [
      // Future collector version emits a brand-new kind we don't yet know.
      { role: "user", kind: "future_kind" as string, content: "hello" } as RemoteEvent,
    ];
    const timeline = mapRemoteEventsToTimeline(events, "sess-future");
    assert.equal(timeline[0].kind, "meta");
    assert.equal(timeline[0].contentType, "future_kind");
    assert.equal(timeline[0].category, "system");
  });

  it("buildContentFromEvents joins user/assistant text into a flat transcript", () => {
    const text = buildContentFromEvents([
      {
        eventId: "1",
        category: "user",
        role: "user",
        kind: "text",
        contentType: "text",
        text: "hi",
        ts: 1,
      },
      {
        eventId: "2",
        category: "assistant",
        role: "assistant",
        kind: "text",
        contentType: "text",
        text: "hello",
        ts: 2,
      },
      // Tool calls / metas are skipped by the legacy fallback formatter.
      {
        eventId: "3",
        category: "tool",
        role: "user",
        kind: "meta",
        contentType: "tool_result",
        text: "result",
        ts: 3,
      },
    ]);
    assert.match(text, /^user:\nhi/);
    assert.match(text, /\nassistant:\nhello/);
    assert.equal(text.includes("result"), false);
  });
});
