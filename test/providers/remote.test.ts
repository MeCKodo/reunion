import "../_env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RemoteAuthError,
  RemoteDataProvider,
  RemoteUnreachableError,
  extractGitHost,
  isRowAllowedByHosts,
  parseRemoteSessionKey,
} from "../../src/providers/remote.js";

type FetchCall = { url: string; init: RequestInit | undefined };

function makeFetchStub(responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[i] || responses[responses.length - 1];
    i += 1;
    return typeof next === "function" ? await next() : next;
  }) as typeof fetch;
  return { fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("providers/remote/RemoteDataProvider", () => {
  it("listSessions sends bearer token and translates rows to Sessions", async () => {
    const { fn, calls } = makeFetchStub([
      jsonResponse({
        items: [
          {
            sessionId: "abc",
            aiClient: "claude_code",
            clientVersion: "0.1.0",
            projectName: "demo",
            gitRepo: "git@example.com:org/demo.git",
            gitBranch: "main",
            model: "claude-sonnet",
            sessionStart: "2026-04-01T00:00:00Z",
            sessionEnd: "2026-04-01T00:30:00Z",
            lastCreatedAt: "2026-04-01T00:31:00Z",
            totalDurationSec: 1800,
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 25,
            cacheCreationTokens: 5,
            cacheHitRate: 0.2,
            promptCount: 5,
            assistantTurns: 6,
            toolCallsTotal: 7,
            versionCount: 3,
          },
        ],
        page: 1,
        pageSize: 50,
        from: "2026-03-02T00:00:00Z",
        to: "2026-04-01T00:31:00Z",
      }),
    ]);
    const provider = new RemoteDataProvider({
      baseUrl: "https://ingest.example.com",
      token: "secret",
      fetchFn: fn,
    });
    const result = await provider.listSessions({ pageSize: 50 });

    assert.equal(calls.length, 1);
    const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
    assert.equal(auth, "Bearer secret");
    assert.match(calls[0].url, /\/sessions\?/);
    assert.match(calls[0].url, /pageSize=50/);
    assert.match(calls[0].url, /from=/);
    assert.match(calls[0].url, /to=/);

    assert.equal(result.results.length, 1);
    const session = result.results[0].session;
    assert.equal(session.provider, "remote");
    assert.equal(session.source, "claude-code");
    assert.equal(session.sessionKey, "team:claude-code:abc");
    assert.equal(session.repo, "demo");
    assert.equal(session.filePath, undefined);
  });

  it("getSessionDetail returns mapped events + metrics + hint", async () => {
    const { fn } = makeFetchStub([
      jsonResponse({
        sessionId: "xyz",
        aiClient: "cursor",
        clientVersion: "0.5",
        projectName: "demo",
        gitRepo: "https://github.com/org/demo",
        gitBranch: "main",
        model: "claude-opus",
        sessionStart: "2026-04-01T00:00:00Z",
        sessionEnd: "2026-04-01T00:10:00Z",
        lastCreatedAt: "2026-04-01T00:10:30Z",
        lastUploadTime: "2026-04-01T00:10:30Z",
        totalDurationSec: 600,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 800,
        cacheCreationTokens: 0,
        cacheHitRate: 0.444,
        promptCount: 1,
        assistantTurns: 2,
        toolCallsTotal: 0,
        versionCount: 5,
        truncated: false,
        hint: "no_conversations_layer",
        events: [],
      }),
    ]);
    const provider = new RemoteDataProvider({
      baseUrl: "https://ingest.example.com/",
      token: "secret",
      fetchFn: fn,
    });
    const detail = await provider.getSessionDetail("team:cursor:xyz");
    assert.ok(detail);
    assert.equal(detail!.session.sessionId, "xyz");
    assert.equal(detail!.session.source, "cursor");
    assert.equal(detail!.metrics?.versionCount, 5);
    assert.equal(detail!.metrics?.cacheHitRate, 0.444);
    assert.equal(detail!.hint, "no_conversations_layer");
    assert.equal(detail!.detail.events.length, 0);
  });

  it("getSessionDetail returns null for non-team session keys", async () => {
    const { fn } = makeFetchStub([
      jsonResponse({}, 200),
    ]);
    const provider = new RemoteDataProvider({
      baseUrl: "https://ingest.example.com",
      token: "x",
      fetchFn: fn,
    });
    assert.equal(await provider.getSessionDetail("local:demo:abc"), null);
  });

  it("session title prefers chatTitle over the timestamp fallback", async () => {
    const { fn } = makeFetchStub([
      jsonResponse({
        items: [
          {
            sessionId: "with-title",
            aiClient: "claude_code",
            clientVersion: "0.1",
            projectName: "demo",
            gitRepo: "git@example.com:org/demo.git",
            gitBranch: "main",
            model: "claude",
            chatTitle: "fix the auth bug",
            sessionStart: "2026-04-01T00:00:00Z",
            sessionEnd: "2026-04-01T00:30:00Z",
            lastCreatedAt: "2026-04-01T00:31:00Z",
            totalDurationSec: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cacheHitRate: 0,
            promptCount: 0,
            assistantTurns: 0,
            toolCallsTotal: 0,
            versionCount: 1,
          },
          {
            sessionId: "no-title",
            aiClient: "claude_code",
            clientVersion: "0.1",
            projectName: "demo",
            gitRepo: "git@example.com:org/demo.git",
            gitBranch: "main",
            model: "claude",
            sessionStart: "2026-04-01T00:00:00Z",
            sessionEnd: "2026-04-01T00:30:00Z",
            lastCreatedAt: "2026-04-01T00:31:00Z",
            totalDurationSec: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cacheHitRate: 0,
            promptCount: 0,
            assistantTurns: 0,
            toolCallsTotal: 0,
            versionCount: 1,
          },
        ],
        page: 1,
        pageSize: 50,
        from: "f",
        to: "t",
      }),
    ]);
    const provider = new RemoteDataProvider({
      baseUrl: "https://ingest.example.com",
      token: "x",
      fetchFn: fn,
    });
    const result = await provider.listSessions({ pageSize: 50 });
    assert.equal(result.results[0].session.title, "fix the auth bug");
    // Falls back to a non-empty timestamp string (locale-dependent format,
    // so just assert it's not the project label or empty).
    assert.notEqual(result.results[1].session.title, "demo");
    assert.notEqual(result.results[1].session.title, "");
  });

  describe("repo host gating", () => {
    it("extractGitHost handles https / ssh / git+ssh shapes", () => {
      assert.equal(extractGitHost("https://code.byted.org/a/b.git"), "code.byted.org");
      assert.equal(extractGitHost("git@code.byted.org:a/b.git"), "code.byted.org");
      assert.equal(extractGitHost("git+ssh://git@gitlab.x.com:22/a/b"), "gitlab.x.com");
      assert.equal(extractGitHost("git@CODE.Byted.org:a/b.git"), "code.byted.org");
      assert.equal(extractGitHost(""), null);
      assert.equal(extractGitHost(null), null);
      assert.equal(extractGitHost("not a url"), null);
    });

    it("empty allowlist permits everything (legacy behaviour)", () => {
      assert.equal(isRowAllowedByHosts("git@github.com:me/x.git", []), true);
      assert.equal(isRowAllowedByHosts(undefined, []), true);
    });

    it("non-empty allowlist drops other hosts and missing remotes", () => {
      const list = ["code.byted.org"];
      assert.equal(isRowAllowedByHosts("git@code.byted.org:t/x.git", list), true);
      assert.equal(isRowAllowedByHosts("https://code.byted.org/t/x.git", list), true);
      assert.equal(isRowAllowedByHosts("https://github.com/me/x.git", list), false);
      assert.equal(isRowAllowedByHosts("", list), false);
      assert.equal(isRowAllowedByHosts(undefined, list), false);
    });
  });

  it("listRepos hits /repos with the same auth", async () => {
    const { fn, calls } = makeFetchStub([
      jsonResponse({ items: ["git@a", "git@b"], from: "f", to: "t" }),
    ]);
    const provider = new RemoteDataProvider({
      baseUrl: "https://ingest.example.com",
      token: "tok",
      fetchFn: fn,
    });
    const repos = await provider.listRepos();
    assert.equal(repos.length, 2);
    assert.equal(repos[0].repo, "git@a");
    assert.match(calls[0].url, /\/repos$/);
  });

  describe("clientTag filter", () => {
    it("listSessions appends ?tag= when filter is a canonical role", async () => {
      const { fn, calls } = makeFetchStub([
        jsonResponse({
          items: [],
          page: 1,
          pageSize: 50,
          from: "f",
          to: "t",
        }),
      ]);
      const provider = new RemoteDataProvider({
        baseUrl: "https://ingest.example.com",
        token: "tok",
        fetchFn: fn,
      });
      await provider.listSessions({ clientTag: "server" });
      const url = new URL(calls[0].url);
      assert.equal(url.searchParams.get("tag"), "server");
    });

    it("listSessions passes the __none__ sentinel through verbatim", async () => {
      const { fn, calls } = makeFetchStub([
        jsonResponse({ items: [], page: 1, pageSize: 50, from: "f", to: "t" }),
      ]);
      const provider = new RemoteDataProvider({
        baseUrl: "https://ingest.example.com",
        token: "tok",
        fetchFn: fn,
      });
      await provider.listSessions({ clientTag: "__none__" });
      const url = new URL(calls[0].url);
      assert.equal(url.searchParams.get("tag"), "__none__");
    });

    it("listSessions omits ?tag= when filter is empty / undefined / whitespace", async () => {
      const { fn, calls } = makeFetchStub([
        jsonResponse({ items: [], page: 1, pageSize: 50, from: "f", to: "t" }),
        jsonResponse({ items: [], page: 1, pageSize: 50, from: "f", to: "t" }),
        jsonResponse({ items: [], page: 1, pageSize: 50, from: "f", to: "t" }),
      ]);
      const provider = new RemoteDataProvider({
        baseUrl: "https://ingest.example.com",
        token: "tok",
        fetchFn: fn,
      });
      await provider.listSessions({});
      await provider.listSessions({ clientTag: "" });
      await provider.listSessions({ clientTag: "   " });
      for (const call of calls) {
        const url = new URL(call.url);
        assert.equal(
          url.searchParams.has("tag"),
          false,
          `expected no ?tag= in ${call.url}`
        );
      }
    });

    it("listRepos appends ?tag= so the picker tracks the active role", async () => {
      const { fn, calls } = makeFetchStub([
        jsonResponse({ items: ["git@a"], from: "f", to: "t" }),
      ]);
      const provider = new RemoteDataProvider({
        baseUrl: "https://ingest.example.com",
        token: "tok",
        fetchFn: fn,
      });
      await provider.listRepos({ clientTag: "frontend" });
      const url = new URL(calls[0].url);
      assert.equal(url.searchParams.get("tag"), "frontend");
    });

    it("session row maps row.clientTag onto session.clientTag", async () => {
      const { fn } = makeFetchStub([
        jsonResponse({
          items: [
            {
              sessionId: "tagged",
              aiClient: "claude_code",
              clientVersion: "0.1",
              projectName: "demo",
              gitRepo: "git@example.com:org/demo.git",
              gitBranch: "main",
              model: "claude",
              chatTitle: "with tag",
              clientTag: "server",
              sessionStart: "2026-04-01T00:00:00Z",
              sessionEnd: "2026-04-01T00:30:00Z",
              lastCreatedAt: "2026-04-01T00:31:00Z",
              totalDurationSec: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              cacheHitRate: 0,
              promptCount: 0,
              assistantTurns: 0,
              toolCallsTotal: 0,
              versionCount: 1,
            },
            {
              sessionId: "untagged",
              aiClient: "claude_code",
              clientVersion: "0.1",
              projectName: "demo",
              gitRepo: "git@example.com:org/demo.git",
              gitBranch: "main",
              model: "claude",
              chatTitle: "no tag",
              sessionStart: "2026-04-01T00:00:00Z",
              sessionEnd: "2026-04-01T00:30:00Z",
              lastCreatedAt: "2026-04-01T00:31:00Z",
              totalDurationSec: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              cacheHitRate: 0,
              promptCount: 0,
              assistantTurns: 0,
              toolCallsTotal: 0,
              versionCount: 1,
            },
          ],
          page: 1,
          pageSize: 50,
          from: "f",
          to: "t",
        }),
      ]);
      const provider = new RemoteDataProvider({
        baseUrl: "https://ingest.example.com",
        token: "tok",
        fetchFn: fn,
      });
      const result = await provider.listSessions({});
      assert.equal(result.results[0].session.clientTag, "server");
      // Empty / missing on the wire collapses to undefined so the chip
      // renderer can use a single `if (clientTag)` gate.
      assert.equal(result.results[1].session.clientTag, undefined);
    });
  });

  it("translates 401 to RemoteAuthError", async () => {
    const { fn } = makeFetchStub([
      new Response("nope", { status: 401 }),
    ]);
    const provider = new RemoteDataProvider({
      baseUrl: "https://ingest.example.com",
      token: "bad",
      fetchFn: fn,
    });
    await assert.rejects(() => provider.listSessions({}), RemoteAuthError);
  });

  it("translates network errors to RemoteUnreachableError", async () => {
    const fn = (async () => {
      throw new Error("dns failure");
    }) as typeof fetch;
    const provider = new RemoteDataProvider({
      baseUrl: "https://ingest.example.com",
      token: "x",
      fetchFn: fn,
    });
    await assert.rejects(() => provider.listRepos(), RemoteUnreachableError);
  });

  it("parseRemoteSessionKey extracts the session uuid", () => {
    assert.equal(parseRemoteSessionKey("team:claude-code:abc-123"), "abc-123");
    assert.equal(parseRemoteSessionKey("team:cursor:xyz"), "xyz");
    assert.equal(parseRemoteSessionKey("local:foo:abc"), null);
    assert.equal(parseRemoteSessionKey("team:bare"), null);
  });

  it("uses default 30-day window when no time bounds are given", async () => {
    const { fn, calls } = makeFetchStub([
      jsonResponse({ items: [], page: 1, pageSize: 50, from: "x", to: "y" }),
    ]);
    const provider = new RemoteDataProvider({
      baseUrl: "https://ingest.example.com",
      token: "tok",
      fetchFn: fn,
    });
    await provider.listSessions({});
    const url = new URL(calls[0].url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    assert.ok(from && to);
    const fromMs = Date.parse(from!);
    const toMs = Date.parse(to!);
    const expected = 30 * 24 * 60 * 60 * 1000;
    // Allow ±1 minute slack.
    assert.ok(Math.abs(toMs - fromMs - expected) < 60_000);
  });
});
