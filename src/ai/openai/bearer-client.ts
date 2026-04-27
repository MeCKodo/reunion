// PoC verdict (2026-04-26): ChatGPT OAuth tokens are scoped only for codex
// usage. api.openai.com/v1/responses returns 401 ("Missing scopes:
// api.responses.write"). The chatgpt.com codex backend works with bare model
// names (gpt-5.5, gpt-5.4-mini, gpt-5.4) and REQUIRES stream=true plus a list
// `input` containing message objects.
//
// Reasoning + service_tier wire format mirrors codex-rs/core/src/client.rs
// (`build_responses_request`): `reasoning: { effort, summary? }`, `include`
// gets `"reasoning.encrypted_content"` when reasoning is set, and `Fast` is
// translated to the wire string `"priority"`.
//
// This module wraps that into a clean async-iterator: callers get a stream of
// text deltas, and we transparently refresh the OAuth token + retry once on
// 401 so users never see "token expired" errors mid-prompt.

import { loadCredentials, refreshCredentials, refreshCredentialsIfNeeded, saveCredentials } from "./auth.js";
import type { Credentials } from "./auth.js";
import type { ReasoningEffort, ServiceTier } from "../settings.js";

export const CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const DEFAULT_OPENAI_INSTRUCTIONS =
  "You are a helpful AI assistant. Answer the user's request clearly and concisely.";

export interface OpenAiRunOptions {
  codexHome: string;
  prompt: string;
  model?: string;
  instructions?: string;
  signal?: AbortSignal;
  /** Reasoning effort to forward; null/undefined = let the server use its default. */
  reasoningEffort?: ReasoningEffort | null;
  /** Service tier; "fast" is sent as wire string "priority". */
  serviceTier?: ServiceTier | null;
}

interface ResponsesPayload {
  model: string;
  instructions: string;
  input: Array<{
    type: "message";
    role: "user" | "system" | "assistant";
    content: Array<{ type: "input_text"; text: string }>;
  }>;
  stream: true;
  store: false;
  reasoning?: { effort: ReasoningEffort; summary?: "auto" | "concise" | "detailed" };
  include?: string[];
  service_tier?: "priority" | "flex";
}

function wireServiceTier(tier: ServiceTier | null | undefined): "priority" | "flex" | undefined {
  if (tier === "fast") return "priority";
  if (tier === "flex") return "flex";
  return undefined;
}

function buildBody(opts: OpenAiRunOptions): ResponsesPayload {
  const body: ResponsesPayload = {
    model: opts.model || DEFAULT_OPENAI_MODEL,
    instructions: opts.instructions || DEFAULT_OPENAI_INSTRUCTIONS,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: opts.prompt }],
      },
    ],
    stream: true,
    store: false,
  };
  if (opts.reasoningEffort) {
    body.reasoning = { effort: opts.reasoningEffort };
    // codex always asks for encrypted reasoning content alongside the deltas
    // so the same conversation can be replayed across turns.
    body.include = ["reasoning.encrypted_content"];
  }
  const tier = wireServiceTier(opts.serviceTier);
  if (tier) body.service_tier = tier;
  return body;
}

function buildHeaders(credentials: Credentials): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.124.0",
  };
  if (credentials.accountId) {
    headers["ChatGPT-Account-Id"] = credentials.accountId;
  }
  return headers;
}

async function postOnce(
  credentials: Credentials,
  body: ResponsesPayload,
  signal: AbortSignal | undefined
): Promise<Response> {
  return await fetch(CHATGPT_RESPONSES_URL, {
    method: "POST",
    headers: buildHeaders(credentials),
    body: JSON.stringify(body),
    signal,
  });
}

interface SseEvent {
  type?: string;
  delta?: string;
  response?: { error?: { message?: string } };
  error?: { message?: string };
}

/**
 * Stream `gpt-5.5` (or any compatible codex model) text deltas.
 * Yields incremental string chunks; throws on auth / API errors.
 */
export async function* streamOpenAi(opts: OpenAiRunOptions): AsyncIterable<string> {
  let credentials = loadCredentials(opts.codexHome);
  credentials = await refreshCredentialsIfNeeded(opts.codexHome, credentials);
  const body = buildBody(opts);

  let response = await postOnce(credentials, body, opts.signal);
  if (response.status === 401 && credentials.refreshToken) {
    // Retry once with a fresh token.
    credentials = await refreshCredentials(credentials);
    saveCredentials(opts.codexHome, credentials);
    response = await postOnce(credentials, body, opts.signal);
  }

  if (response.status === 401) {
    throw new Error("ChatGPT account is not authorized. Please re-login.");
  }
  if (response.status === 403) {
    const text = await response.text();
    throw new Error(
      `ChatGPT account quota exhausted or forbidden (${response.status}): ${text.slice(0, 200)}`
    );
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.body) {
    throw new Error("OpenAI response missing body");
  }

  const decoder = new TextDecoder();
  let buf = "";

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    // SSE frames are separated by blank lines.
    let sep: number;
    while ((sep = indexOfFrameBoundary(buf)) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep).replace(/^\r?\n\r?\n/, "");
      const data = parseDataLines(frame);
      if (!data) continue;
      if (data === "[DONE]") return;
      const evt = safeParseJson<SseEvent>(data);
      if (!evt) continue;
      if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
        yield evt.delta;
      } else if (evt.type === "response.failed" || evt.type === "error") {
        const msg = evt.error?.message || evt.response?.error?.message || "unknown error";
        throw new Error(`OpenAI streaming error: ${msg}`);
      }
    }
  }
}

function indexOfFrameBoundary(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

function parseDataLines(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  let data = "";
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const part = line.slice(5);
    data += part.startsWith(" ") ? part.slice(1) : part;
  }
  return data || null;
}

function safeParseJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Convenience: collect all deltas into a single string. */
export async function runOpenAiToString(opts: OpenAiRunOptions): Promise<string> {
  let out = "";
  for await (const piece of streamOpenAi(opts)) {
    out += piece;
  }
  return out;
}
