import { createServer } from "node:http";
import { chmodSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { hashSecret, matchesHash } from "../ids.ts";
import { ensurePrivateDir } from "../paths.ts";
import { HttpError } from "../http/errors.ts";
import { errorResponse, JSON_LIMIT, type Router } from "../http/router.ts";

export function createInternalServer(router: Router, token: string, socketPath: string) {
  const tokenHash = hashSecret(token);
  const server = createServer(async (req, res) => {
    try {
      const path = req.url ?? "/";
      if (!path.startsWith("/internal/")) throw new HttpError(404, "not_found", "Route nicht gefunden");
      const supplied = req.headers["x-website-review-token"];
      if (typeof supplied !== "string" || !matchesHash(supplied, tokenHash)) throw new HttpError(401, "internal", "Interner Zugang ungültig");
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > JSON_LIMIT) throw new HttpError(413, "validation", "Anfrage ist zu groß");
        chunks.push(chunk);
      }
      let body: unknown;
      if (length) {
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new HttpError(400, "validation", "Ungültiges JSON"); }
      }
      const result = await router.dispatch({ method: req.method ?? "GET", path, body }, length);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.body === undefined ? undefined : JSON.stringify(result.body));
    } catch (error) {
      const result = errorResponse(error);
      if (!res.destroyed) { res.writeHead(result.status, { "Content-Type": "application/json" }); res.end(JSON.stringify(result.body)); }
    } finally { if (!req.complete) req.resume(); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return {
    async start(): Promise<void> {
      ensurePrivateDir(dirname(socketPath));
      rmSync(socketPath, { force: true });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => { server.off("error", reject); resolve(); });
      });
      chmodSync(socketPath, 0o600);
    },
    async stop(): Promise<void> {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      rmSync(socketPath, { force: true });
    },
  };
}
