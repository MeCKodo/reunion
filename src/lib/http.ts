import { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { FRONTEND_DIST_DIR, LEGACY_STATIC_DIR } from "../config";
import { tryReadFile } from "./fs";

export function json(res: ServerResponse, status: number, payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(body.length));
  res.end(body);
}

export function html(res: ServerResponse, status: number, bodyText: string) {
  const body = Buffer.from(bodyText);
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", String(body.length));
  res.end(body);
}

export async function readJsonBody<T>(req: IncomingMessage, fallback: T): Promise<T> {
  return await new Promise<T>((resolve) => {
    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        body = body.slice(0, 64 * 1024);
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve(fallback);
        return;
      }
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        resolve(fallback);
      }
    });
    req.on("error", () => resolve(fallback));
  });
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function contentTypeByExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function safeResolve(rootDir: string, reqPath: string): string {
  const normalized = path.posix.normalize(reqPath).replace(/^\/+/, "");
  const resolved = path.resolve(rootDir, normalized);
  if (!resolved.startsWith(rootDir)) {
    throw new Error("invalid path");
  }
  return resolved;
}

export async function serveSpaOrAsset(reqPath: string, res: ServerResponse): Promise<boolean> {
  const hasExt = path.posix.extname(reqPath) !== "";
  const candidateRoots = [FRONTEND_DIST_DIR, LEGACY_STATIC_DIR];

  if (!hasExt) {
    for (const root of candidateRoots) {
      const indexPath = path.join(root, "index.html");
      const data = await tryReadFile(indexPath);
      if (data) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Content-Length", String(data.length));
        res.end(data);
        return true;
      }
    }
    return false;
  }

  for (const root of candidateRoots) {
    try {
      const filePath = safeResolve(root, reqPath);
      const data = await tryReadFile(filePath);
      if (data) {
        res.statusCode = 200;
        res.setHeader("Content-Type", contentTypeByExt(filePath));
        res.setHeader("Content-Length", String(data.length));
        res.end(data);
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}
