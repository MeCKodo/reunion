import type { IncomingMessage, ServerResponse } from "node:http";
import type { SourceRoots } from "../types.js";

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  roots: SourceRoots;
};
