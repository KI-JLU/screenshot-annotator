import type { z } from "zod";
import { HttpError } from "./errors.ts";

export const JSON_LIMIT = 1024 * 1024;
export const COMMENT_JSON_LIMIT = 25 * 1024 * 1024;
export interface RequestContext {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
}
export interface DispatchRequest { method: string; path: string; body?: unknown }
export interface DispatchResponse { status: number; body?: unknown }
export type Handler = (context: RequestContext) => DispatchResponse | Promise<DispatchResponse>;
export type DataHandler = (context: RequestContext) => unknown | Promise<unknown>;
export function dataHandler(handler: DataHandler): Handler {
  return async (ctx) => {
    const body = await handler(ctx);
    return body === undefined ? { status: 204 } : { status: 200, body };
  };
}
export function validate<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, "validation", "Ungültige Anfrage");
  return result.data;
}
export function errorResponse(error: unknown): DispatchResponse {
  const safe = error instanceof HttpError ? error : new HttpError(500, "internal", "Interner Fehler im Begleitdienst");
  return { status: safe.status, body: safe.toJSON() };
}
export class Router {
  private readonly routes: { method: string; segments: string[]; handler: Handler; limit: number }[] = [];
  register(method: string, path: string, handler: Handler, limit = JSON_LIMIT): void {
    if (!path.startsWith("/")) throw new Error("Route benötigt einen absoluten Pfad");
    this.routes.push({ method: method.toUpperCase(), segments: path.split("/"), handler, limit });
  }
  async dispatch(request: DispatchRequest, frameLength = Buffer.byteLength(JSON.stringify(request))): Promise<DispatchResponse> {
    try {
      if (!request.path.startsWith("/") || request.path.startsWith("//")) throw new HttpError(400, "validation", "Ungültiger URL-Pfad");
      const url = new URL(request.path, "http://native");
      const segments = url.pathname.split("/");
      for (const route of this.routes) {
        if (route.method !== request.method || route.segments.length !== segments.length) continue;
        const params: Record<string, string> = {}; let matches = true;
        for (let i = 0; i < segments.length; i++) {
          const expected = route.segments[i]!; const value = segments[i]!;
          if (expected.startsWith(":")) {
            try { params[expected.slice(1)] = decodeURIComponent(value); }
            catch { throw new HttpError(400, "validation", "Ungültiger URL-Pfad"); }
          } else if (expected !== value) { matches = false; break; }
        }
        if (!matches) continue;
        if (frameLength > route.limit) throw new HttpError(413, "validation", "Anfrage ist zu groß");
        return await route.handler({ method: request.method, path: url.pathname, query: url.searchParams, params, body: request.body });
      }
      throw new HttpError(404, "not_found", "Route nicht gefunden");
    } catch (error) { return errorResponse(error); }
  }
}
