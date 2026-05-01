import "../_env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { contentTypeByExt, html, json, readJsonBody } from "../../src/lib/http.js";
import { MockRequest, MockResponse } from "../_helpers.js";

describe("lib/http/json", () => {
  it("serializes payload, sets headers and Content-Length", () => {
    const res = new MockResponse();
    json(res as unknown as import("node:http").ServerResponse, 201, { ok: true });
    assert.equal(res.statusCode, 201);
    assert.equal(res.getHeader("content-type"), "application/json; charset=utf-8");
    assert.equal(res.getHeader("content-length"), String(Buffer.byteLength(JSON.stringify({ ok: true }))));
    assert.equal(res.bodyText(), '{"ok":true}');
    assert.equal(res.ended, true);
  });
});

describe("lib/http/html", () => {
  it("writes html body with correct headers", () => {
    const res = new MockResponse();
    html(res as unknown as import("node:http").ServerResponse, 404, "<h1>nope</h1>");
    assert.equal(res.statusCode, 404);
    assert.equal(res.getHeader("content-type"), "text/html; charset=utf-8");
    assert.equal(res.bodyText(), "<h1>nope</h1>");
  });
});

describe("lib/http/readJsonBody", () => {
  it("returns parsed payload when body is valid JSON", async () => {
    const req = new MockRequest({ body: '{"x":1,"y":"two"}' });
    const promise = readJsonBody<{ x: number; y: string }>(req as unknown as import("node:http").IncomingMessage, { x: -1, y: "" });
    req.emitBody();
    const out = await promise;
    assert.deepEqual(out, { x: 1, y: "two" });
  });

  it("returns the fallback when body is empty", async () => {
    const req = new MockRequest({ body: "" });
    const promise = readJsonBody<{ x: number }>(req as unknown as import("node:http").IncomingMessage, { x: 99 });
    req.emitBody();
    const out = await promise;
    assert.deepEqual(out, { x: 99 });
  });

  it("returns the fallback when body is malformed JSON", async () => {
    const req = new MockRequest({ body: "{not valid" });
    const promise = readJsonBody(req as unknown as import("node:http").IncomingMessage, { fallback: true });
    req.emitBody();
    const out = await promise;
    assert.deepEqual(out, { fallback: true });
  });

  it("does not blow up the process when a body exceeds the 64KiB cap", async () => {
    const big = "a".repeat(80 * 1024);
    const req = new MockRequest({ body: JSON.stringify({ big }) });
    const promise = readJsonBody(req as unknown as import("node:http").IncomingMessage, { fallback: true });
    req.emitBody();
    const out = await promise;
    // Implementation truncates at 64KB then attempts JSON.parse — the
    // truncated body is invalid so we expect the fallback.
    assert.deepEqual(out, { fallback: true });
  });
});

describe("lib/http/contentTypeByExt", () => {
  it("maps known extensions to canonical mime types", () => {
    assert.equal(contentTypeByExt("/foo/bar.html"), "text/html; charset=utf-8");
    assert.equal(contentTypeByExt("file.JS"), "application/javascript; charset=utf-8");
    assert.equal(contentTypeByExt("style.css"), "text/css; charset=utf-8");
    assert.equal(contentTypeByExt("logo.svg"), "image/svg+xml");
  });
  it("returns octet-stream for unknown extensions", () => {
    assert.equal(contentTypeByExt("notes.bin"), "application/octet-stream");
    assert.equal(contentTypeByExt("README"), "application/octet-stream");
  });
});
