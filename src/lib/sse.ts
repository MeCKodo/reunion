import { IncomingMessage, ServerResponse } from "node:http";

export function openSse(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

export function sendSse(res: ServerResponse, event: string, data: unknown): void {
  if (res.destroyed) return;
  const payload = JSON.stringify(data);
  res.write(`event: ${event}\n`);
  res.write(`data: ${payload}\n\n`);
}

export function endSse(res: ServerResponse): void {
  if (res.destroyed) return;
  try {
    res.write("event: end\ndata: {}\n\n");
    res.end();
  } catch {
    // ignore close races
  }
}

export function abortSignalFromReq(req: IncomingMessage): AbortSignal {
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  return ac.signal;
}
