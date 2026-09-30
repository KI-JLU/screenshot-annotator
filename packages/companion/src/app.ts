import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_COMPANION_PORT,
  type AnswerRequest, type Comment, type DecisionInput, type KanCredentialStatus,
  type PreflightProblem, type ProcessResponse, type ReconcileRequest,
} from "@website-review/shared";
import { EventBus } from "./events/eventBus.ts";
import { authenticateExtension, authenticateInternal, isExtensionOrigin } from "./http/auth.ts";
import { CommentsService } from "./http/comments.ts";
import { HttpError, notFound } from "./http/errors.ts";
import { COMMENT_JSON_LIMIT, Router, sendJson, type Handler } from "./http/router.ts";
import {
  AnswerSchema, CreateCommentSchema, CredentialSchema, DecisionSchema, ImportSchema, MatchSchema,
  PairSchema, ReconcileSchema, ReviewSchema, SetCheckoutsSchema, UpdateCommentSchema,
} from "./http/schemas.ts";
import { hashSecret, randomToken } from "./ids.ts";
import { getPaths } from "./paths.ts";
import { kanProblem, ProjectsService, type KanClientFactory } from "./projects/projects.ts";
import { normalizeBaseUrl, Secrets } from "./secrets/secrets.ts";
import { Store } from "./store/store.ts";
import { z } from "zod";
import { createAnalysisRunner } from "./codex/analysisRunner.ts";
import type { AnalysisRunner } from "./codex/types.ts";
import { ReviewProcessingService } from "./processing/service.ts";
import { registerGatewayHandlers } from "./mcp/gateway.ts";

type MaybePromise<T> = T | Promise<T>;
export interface ProcessingService {
  processReview(reviewId: string): MaybePromise<ProcessResponse>;
  answer(commentId: string, req: AnswerRequest): MaybePromise<Comment>;
  decide(commentId: string, input: DecisionInput): MaybePromise<Comment>;
  retry(commentId: string): MaybePromise<Comment>;
  reconcile(commentId: string, req: ReconcileRequest): MaybePromise<Comment>;
  preflight(reviewId: string): MaybePromise<PreflightProblem[]>;
  resume?(): Promise<void>;
  close?(): Promise<void>;
}

export interface AppOptions {
  dataDir?: string;
  configDir?: string;
  port?: number;
  kanClientFactory: KanClientFactory;
  processing?: ProcessingService;
  analysisRunner?: AnalysisRunner;
  cliPath?: string;
}

const VERSION = "0.1.0";

export function createApp(options: AppOptions) {
  const paths = getPaths();
  const port = options.port ?? DEFAULT_COMPANION_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Ungültiger Port");
  const events = new EventBus();
  const secrets = new Secrets(options.configDir ?? paths.configDir);
  const store = new Store(options.dataDir ?? paths.dataDir, events);
  // Share the Kan client's request queue across processing and gateway reads.
  const clients = new Map<string, { token: string; client: ReturnType<KanClientFactory> }>();
  const projects = new ProjectsService(store, secrets, (input) => {
    const cached = clients.get(input.baseUrl);
    if (cached?.token === input.apiToken) return cached.client;
    const client = options.kanClientFactory(input);
    clients.set(input.baseUrl, { token: input.apiToken, client });
    return client;
  });
  const comments = new CommentsService(store);
  const internalToken = randomToken();
  const runner = options.analysisRunner ?? createAnalysisRunner();
  let companionUrl = `http://127.0.0.1:${port}`;
  const processing = options.processing ?? new ReviewProcessingService({ store, projects, runner, internalToken,
    companionUrl: () => companionUrl, cliPath: options.cliPath });
  const internalTokenHash = hashSecret(internalToken);
  const router = new Router();
  const streams = new Set<() => void>();
  const credentialChecks = new Map<string, KanCredentialStatus>();
  let stopped = false;
  let starting: Promise<{ port: number; url: string }> | undefined;

  router.register("GET", "/v1/health", () => ({ ok: true, version: VERSION, paired: !!store.getPairing() }));
  router.register("POST", "/v1/pair", async (ctx) => {
    const origin = ctx.req.headers.origin;
    if (!isExtensionOrigin(origin)) throw new HttpError(403, "forbidden_origin", "Kopplung ist nur für Chrome-Extensions möglich");
    const { code } = await ctx.json(PairSchema);
    const token = randomToken();
    if (!store.pair(code, origin, token)) throw new HttpError(401, "invalid_pairing_code", "Kopplungscode ungültig oder abgelaufen");
    for (const close of streams) close();
    return { token };
  });
  router.register("GET", "/v1/status", async () => ({ version: VERSION, codex: await runner.probe() }));

  router.register("GET", "/v1/projects", () => projects.list());
  router.register("POST", "/v1/projects", async (ctx) => projects.create(await ctx.json(z.unknown())));
  router.register("POST", "/v1/projects/import", async (ctx) => {
    const body = await ctx.json(ImportSchema);
    return projects.import(body.config, body.replaceExisting);
  });
  router.register("PUT", "/v1/projects/:projectId", async (ctx) => projects.update(ctx.params.projectId!, await ctx.json(z.unknown())));
  router.register("DELETE", "/v1/projects/:projectId", (ctx) => projects.delete(ctx.params.projectId!));
  router.register("GET", "/v1/projects/:projectId/export", (ctx) => projects.export(ctx.params.projectId!));
  router.register("PUT", "/v1/projects/:projectId/checkouts", async (ctx) => {
    const body = await ctx.json(SetCheckoutsSchema);
    return projects.setCheckouts(ctx.params.projectId!, body.checkouts);
  });
  router.register("POST", "/v1/projects/:projectId/check", async (ctx) => {
    const view = await projects.view(ctx.params.projectId!, true);
    events.emit({ type: "projects.updated" });
    return view;
  });
  router.register("POST", "/v1/match", async (ctx) => ({ projectIds: projects.match((await ctx.json(MatchSchema)).url) }));

  const withKan = async <T>(baseUrl: string, fn: (client: ReturnType<ProjectsService["client"]>) => Promise<T>): Promise<T> => {
    try { return await fn(projects.client(baseUrl)); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "kan_error", kanProblem(error));
    }
  };
  const queryBaseUrl = (url: URL): string => {
    const value = url.searchParams.get("baseUrl");
    if (!value) throw new HttpError(400, "validation", "Kan-Adresse fehlt");
    return normalizeBaseUrl(value);
  };
  router.register("PUT", "/v1/kan/credentials", async (ctx) => {
    const body = await ctx.json(CredentialSchema);
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    try { await options.kanClientFactory({ baseUrl, apiToken: body.apiToken }).listWorkspaces(); }
    catch (error) { throw new HttpError(502, "kan_error", kanProblem(error)); }
    secrets.set(baseUrl, body.apiToken);
    const result: KanCredentialStatus = { baseUrl, configured: true, valid: true };
    credentialChecks.set(baseUrl, result); projects.invalidate();
    events.emit({ type: "projects.updated" });
    return result;
  });
  router.register("GET", "/v1/kan/credentials", () => secrets.listBaseUrls().map((baseUrl) =>
    credentialChecks.get(baseUrl) ?? { baseUrl, configured: true }));
  router.register("GET", "/v1/kan/workspaces", (ctx) => withKan(queryBaseUrl(ctx.url), (client) => client.listWorkspaces()));
  router.register("GET", "/v1/kan/workspaces/:ws/boards", (ctx) => withKan(queryBaseUrl(ctx.url), (client) => client.listBoards(ctx.params.ws!)));
  router.register("GET", "/v1/kan/boards/:board/lists", (ctx) => withKan(queryBaseUrl(ctx.url), async (client) =>
    (await client.getBoard(ctx.params.board!)).lists.map(({ publicId, name }) => ({ publicId, name }))));

  const requireReview = (id: string) => store.getReviewDetail(id) ?? notFound("Review");
  const requireComment = (id: string) => store.getComment(id) ?? notFound("Kommentar");
  router.register("GET", "/v1/reviews", (ctx) => store.listReviews(ctx.url.searchParams.get("projectId") ?? undefined));
  router.register("POST", "/v1/reviews", async (ctx) => {
    const body = await ctx.json(ReviewSchema);
    return store.createReview(body.projectId, body.title);
  });
  router.register("GET", "/v1/reviews/:reviewId", (ctx) => requireReview(ctx.params.reviewId!));
  router.register("DELETE", "/v1/reviews/:reviewId", (ctx) => store.deleteReview(ctx.params.reviewId!));
  router.register("POST", "/v1/reviews/:reviewId/process", async (ctx) => {
    const id = ctx.params.reviewId!; requireReview(id);
    const problems = options.processing ? await processing.preflight(id) : [];
    if (problems.length) throw new HttpError(409, "preflight_failed", "Verarbeitung nicht möglich: Voraussetzungen fehlen", problems);
    return processing.processReview(id);
  });
  router.register("POST", "/v1/reviews/:reviewId/comments", async (ctx) =>
    comments.create(ctx.params.reviewId!, await ctx.json(CreateCommentSchema, COMMENT_JSON_LIMIT)));
  router.register("PUT", "/v1/comments/:commentId", async (ctx) =>
    comments.update(ctx.params.commentId!, await ctx.json(UpdateCommentSchema, COMMENT_JSON_LIMIT)));
  router.register("DELETE", "/v1/comments/:commentId", (ctx) => store.deleteComment(ctx.params.commentId!));
  router.register("GET", "/v1/comments/:commentId/image", (ctx) => {
    const bytes = comments.image(ctx.params.commentId!);
    ctx.res.writeHead(200, { "Content-Type": "image/png", "Content-Length": bytes.length, "Cache-Control": "no-store" });
    ctx.res.end(bytes);
  });
  router.register("POST", "/v1/comments/:commentId/answer", async (ctx) => {
    const id = ctx.params.commentId!; requireComment(id);
    return processing.answer(id, await ctx.json(AnswerSchema));
  });
  router.register("POST", "/v1/comments/:commentId/decision", async (ctx) => {
    const id = ctx.params.commentId!; requireComment(id);
    return processing.decide(id, await ctx.json(DecisionSchema));
  });
  router.register("POST", "/v1/comments/:commentId/retry", (ctx) => {
    const id = ctx.params.commentId!; requireComment(id); return processing.retry(id);
  });
  router.register("POST", "/v1/comments/:commentId/reconcile", async (ctx) => {
    const id = ctx.params.commentId!; requireComment(id);
    return processing.reconcile(id, await ctx.json(ReconcileSchema));
  });

  router.register("GET", "/v1/events", (ctx) => {
    ctx.res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    ctx.res.flushHeaders();
    ctx.res.write(": connected\n\n");
    let unsubscribe = () => {};
    let timer: NodeJS.Timeout;
    const close = () => { clearInterval(timer); unsubscribe(); streams.delete(close); ctx.res.end(); };
    const send = (event: Parameters<EventBus["emit"]>[0]) => {
      try { authenticateExtension(ctx.req, store); } catch { close(); return; }
      // A stalled client must not accumulate unbounded events in memory.
      if (!ctx.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) close();
    };
    unsubscribe = events.subscribe(send);
    timer = setInterval(() => send({ type: "ping" }), 25_000); timer.unref();
    streams.add(close); ctx.res.once("close", close);
  });

  const server = createServer(async (req, res) => {
    res.setHeader("Vary", "Origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const internal = url.pathname === "/internal" || url.pathname.startsWith("/internal/");
      const pairingRoute = url.pathname === "/v1/pair";
      const origin = req.headers.origin;
      const allowedOrigin = !internal && isExtensionOrigin(origin) &&
        (pairingRoute || origin === store.getPairing()?.extensionOrigin);
      if (allowedOrigin) res.setHeader("Access-Control-Allow-Origin", origin);
      if (req.method === "OPTIONS" && !internal) {
        if (!allowedOrigin) throw new HttpError(403, "forbidden_origin", "Extension ist nicht gekoppelt");
        res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "600" });
        res.end(); return;
      }
      if (internal) authenticateInternal(req, internalTokenHash);
      else if (!(url.pathname === "/v1/health" && req.method === "GET") && !(pairingRoute && req.method === "POST")) {
        authenticateExtension(req, store);
      }
      await router.dispatch(req, res, url);
    } catch (error) {
      // Never serialize arbitrary upstream errors: they may contain credentials or request headers.
      const safe = error instanceof HttpError ? error : new HttpError(500, "internal", "Interner Fehler im Begleitdienst");
      if (!res.headersSent) sendJson(res, safe.status, safe.toJSON());
      else if (!res.writableEnded) res.end();
    } finally { if (!req.complete) req.resume(); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  const app = {
    store, secrets, projects, events, comments, processing, internalToken, server,
    registerInternal(method: string, path: string, handler: Handler): void {
      if (!path.startsWith("/internal/")) throw new Error("Interne Route muss mit /internal/ beginnen");
      router.register(method, path, handler);
    },
    start(): Promise<{ port: number; url: string }> {
      if (stopped) return Promise.reject(new Error("Begleitdienst wurde beendet"));
      if (starting) return starting;
      starting = new Promise((resolve, reject) => {
        const failed = (error: Error) => { starting = undefined; reject(error); };
        server.once("error", failed);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", failed);
          const address = server.address() as AddressInfo;
          companionUrl = `http://127.0.0.1:${address.port}`;
          Promise.resolve(processing.resume?.()).then(() => resolve({ port: address.port, url: companionUrl }), reject);
        });
      });
      return starting;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (starting) await starting.catch(() => {});
      for (const close of streams) close();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
      await processing.close?.();
      if (options.processing) await runner.close();
      store.close();
    },
  };
  registerGatewayHandlers(app.registerInternal, store, projects);
  return app;
}

export type CompanionApp = ReturnType<typeof createApp>;
