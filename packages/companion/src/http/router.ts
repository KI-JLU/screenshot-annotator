import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import { HttpError } from "./errors.ts";

export const JSON_LIMIT = 1024 * 1024;
export const COMMENT_JSON_LIMIT = 25 * 1024 * 1024;

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  json<T>(schema: z.ZodType<T>, limit?: number): Promise<T>;
}
export type Handler = (context: RequestContext) => unknown | Promise<unknown>;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage, schema: z.ZodType<T>, limit: number): Promise<T> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(400, "validation", "JSON-Anfrage erforderlich");
  }
  if (Number(req.headers["content-length"]) > limit) throw new HttpError(413, "validation", "Anfrage ist zu groß");
  const chunks: Buffer[] = []; let length = 0;
  // Reading with data listeners keeps the connection alive long enough to send a 413.
  const body = await new Promise<Buffer>((resolve, reject) => {
    const cleanup = () => { req.off("data", data); req.off("end", end); req.off("error", error); req.off("aborted", aborted); };
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > limit) { cleanup(); req.resume(); reject(new HttpError(413, "validation", "Anfrage ist zu groß")); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const error = () => { cleanup(); reject(new HttpError(400, "validation", "Anfrage konnte nicht gelesen werden")); };
    const aborted = () => error();
    req.on("data", data); req.on("end", end); req.on("error", error); req.on("aborted", aborted);
  });
  let input: unknown;
  try { input = JSON.parse(body.toString("utf8")); }
  catch { throw new HttpError(400, "validation", "Ungültiges JSON"); }
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, "validation", "Ungültige Anfrage");
  return result.data;
}

export class Router {
  private readonly routes: { method: string; segments: string[]; handler: Handler }[] = [];
  register(method: string, path: string, handler: Handler): void {
    if (!path.startsWith("/")) throw new Error("Route benötigt einen absoluten Pfad");
    this.routes.push({ method: method.toUpperCase(), segments: path.split("/"), handler });
  }
  async dispatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const segments = url.pathname.split("/");
    for (const route of this.routes) {
      if (route.method !== req.method || route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {}; let matches = true;
      for (let i = 0; i < segments.length; i++) {
        const expected = route.segments[i]!; const value = segments[i]!;
        if (expected.startsWith(":")) {
          try { params[expected.slice(1)] = decodeURIComponent(value); }
          catch { throw new HttpError(400, "validation", "Ungültiger URL-Pfad"); }
        } else if (expected !== value) { matches = false; break; }
      }
      if (!matches) continue;
      const result = await route.handler({ req, res, url, params, json: (schema, limit = JSON_LIMIT) => readJson(req, schema, limit) });
      if (!res.headersSent && !res.writableEnded) {
        if (result === undefined) { res.writeHead(204); res.end(); }
        else sendJson(res, 200, result);
      }
      return;
    }
    throw new HttpError(404, "not_found", "Route nicht gefunden");
  }
}
