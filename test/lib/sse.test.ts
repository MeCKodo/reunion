import "../_env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { abortSignalFromReq, endSse, openSse, sendSse } from "../../src/lib/sse.js";
import { MockRequest, MockResponse } from "../_helpers.js";

describe("lib/sse/openSse", () => {
  it("sets all the SSE headers expected by the frontend EventSource loop", () => {
    const res = new MockResponse();
    openSse(res as unknown as import("node:http").ServerResponse);
    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(res.getHeader("cache-control"), "no-cache, no-transform");
    assert.equal(res.getHeader("connection"), "keep-alive");
    assert.equal(res.getHeader("x-accel-buffering"), "no");
    // flushHeaders should have been called.
    assert.equal(res.headersSent, true);
  });
});

describe("lib/sse/sendSse + endSse", () => {
  it("emits well-formed SSE frames and a final end frame", () => {
    const res = new MockResponse();
    openSse(res as unknown as import("node:http").ServerResponse);
    sendSse(res as unknown as import("node:http").ServerResponse, "delta", { text: "hi" });
    sendSse(res as unknown as import("node:http").ServerResponse, "delta", { text: "bye" });
    endSse(res as unknown as import("node:http").ServerResponse);

    const out = res.bodyText();
    // Each event is `event: NAME\ndata: JSON\n\n` (no leading newline).
    assert.match(out, /event: delta\ndata: \{"text":"hi"\}\n\n/);
    assert.match(out, /event: delta\ndata: \{"text":"bye"\}\n\n/);
    assert.match(out, /event: end\ndata: \{\}\n\n$/);
    assert.equal(res.ended, true);
  });

  it("silently no-ops when the response is already destroyed", () => {
    const res = new MockResponse();
    openSse(res as unknown as import("node:http").ServerResponse);
    res.destroyed = true;
    sendSse(res as unknown as import("node:http").ServerResponse, "delta", { text: "x" });
    endSse(res as unknown as import("node:http").ServerResponse);
    assert.equal(res.body.length, 0);
  });
});

describe("lib/sse/abortSignalFromReq", () => {
  it("aborts the returned signal when the request emits 'close'", () => {
    const req = new MockRequest();
    const signal = abortSignalFromReq(req as unknown as import("node:http").IncomingMessage);
    assert.equal(signal.aborted, false);
    req.emit("close");
    assert.equal(signal.aborted, true);
  });
});
