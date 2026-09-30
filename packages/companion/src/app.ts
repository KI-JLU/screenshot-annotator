import { createInternalServer } from "./native/internalSocket.ts";
import { join } from "node:path";
import {
  type AnswerRequest, type Comment, type DecisionInput, type KanCredentialStatus,
  type PreflightProblem, type ProcessResponse, type ReconcileRequest,
} from "@website-review/shared";
import { EventBus } from "./events/eventBus.ts";
import { CommentsService } from "./http/comments.ts";
import { HttpError, notFound } from "./http/errors.ts";
import { COMMENT_JSON_LIMIT, Router, dataHandler, validate, type DataHandler } from "./http/router.ts";
import {
  AnswerSchema, CreateCommentSchema, CredentialSchema, DecisionSchema, ImportSchema, MatchSchema,
  ReconcileSchema, ReviewSchema, SetCheckoutsSchema, UpdateCommentSchema,
} from "./http/schemas.ts";
import { randomToken } from "./ids.ts";
import { getPaths } from "./paths.ts";
import { kanProblem, ProjectsService, type KanClientFactory } from "./projects/projects.ts";
import { normalizeBaseUrl, Secrets } from "./secrets/secrets.ts";
import { Store } from "./store/store.ts";
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
  runtimeDir?: string;
  kanClientFactory: KanClientFactory;
  processing?: ProcessingService;
  analysisRunner?: AnalysisRunner;
  cliPath?: string;
}

export const VERSION = "0.1.0";

export function createApp(options: AppOptions) {
  const paths = getPaths();
  const runtimeDir = options.runtimeDir ?? (options.dataDir ? options.dataDir : paths.runtimeDir);
  const socketPath = join(runtimeDir, "internal.sock");
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
  const processing = options.processing ?? new ReviewProcessingService({ store, projects, runner, internalToken,
    socketPath: () => socketPath, cliPath: options.cliPath });
  const router = new Router();
  const internalRouter = new Router();
  const register = (method: string, path: string, handler: DataHandler, limit?: number) => router.register(method, path, dataHandler(handler), limit);
  const credentialChecks = new Map<string, KanCredentialStatus>();
  let stopped = false;
  let starting: Promise<void> | undefined;

  register("GET", "/v1/health", () => ({ ok: true, version: VERSION }));
  register("GET", "/v1/status", async () => ({ version: VERSION, codex: await runner.probe() }));

  register("GET", "/v1/projects", () => projects.list());
  register("POST", "/v1/projects", async (ctx) => projects.create(ctx.body));
  register("POST", "/v1/projects/import", async (ctx) => {
    const body = validate(ImportSchema, ctx.body);
    return projects.import(body.config, body.replaceExisting);
  });
  register("PUT", "/v1/projects/:projectId", async (ctx) => projects.update(ctx.params.projectId!, ctx.body));
  register("DELETE", "/v1/projects/:projectId", (ctx) => projects.delete(ctx.params.projectId!));
  register("GET", "/v1/projects/:projectId/export", (ctx) => projects.export(ctx.params.projectId!));
  register("PUT", "/v1/projects/:projectId/checkouts", async (ctx) => {
    const body = validate(SetCheckoutsSchema, ctx.body);
    return projects.setCheckouts(ctx.params.projectId!, body.checkouts);
  });
  register("POST", "/v1/projects/:projectId/check", async (ctx) => {
    const view = await projects.view(ctx.params.projectId!, true);
    events.emit({ type: "projects.updated" });
    return view;
  });
  register("POST", "/v1/match", async (ctx) => ({ projectIds: projects.match((validate(MatchSchema, ctx.body)).url) }));

  const withKan = async <T>(baseUrl: string, fn: (client: ReturnType<ProjectsService["client"]>) => Promise<T>): Promise<T> => {
    try { return await fn(projects.client(baseUrl)); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "kan_error", kanProblem(error));
    }
  };
  const queryBaseUrl = (query: URLSearchParams): string => {
    const value = query.get("baseUrl");
    if (!value) throw new HttpError(400, "validation", "Kan-Adresse fehlt");
    return normalizeBaseUrl(value);
  };
  register("PUT", "/v1/kan/credentials", async (ctx) => {
    const body = validate(CredentialSchema, ctx.body);
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    try { await options.kanClientFactory({ baseUrl, apiToken: body.apiToken }).listWorkspaces(); }
    catch (error) { throw new HttpError(502, "kan_error", kanProblem(error)); }
    secrets.set(baseUrl, body.apiToken);
    const result: KanCredentialStatus = { baseUrl, configured: true, valid: true };
    credentialChecks.set(baseUrl, result); projects.invalidate();
    events.emit({ type: "projects.updated" });
    return result;
  });
  register("GET", "/v1/kan/credentials", () => secrets.listBaseUrls().map((baseUrl) =>
    credentialChecks.get(baseUrl) ?? { baseUrl, configured: true }));
  register("GET", "/v1/kan/workspaces", (ctx) => withKan(queryBaseUrl(ctx.query), (client) => client.listWorkspaces()));
  register("GET", "/v1/kan/workspaces/:ws/boards", (ctx) => withKan(queryBaseUrl(ctx.query), (client) => client.listBoards(ctx.params.ws!)));
  register("GET", "/v1/kan/boards/:board/lists", (ctx) => withKan(queryBaseUrl(ctx.query), async (client) =>
    (await client.getBoard(ctx.params.board!)).lists.map(({ publicId, name }) => ({ publicId, name }))));

  const requireReview = (id: string) => store.getReviewDetail(id) ?? notFound("Review");
  const requireComment = (id: string) => store.getComment(id) ?? notFound("Kommentar");
  register("GET", "/v1/reviews", (ctx) => store.listReviews(ctx.query.get("projectId") ?? undefined));
  register("POST", "/v1/reviews", async (ctx) => {
    const body = validate(ReviewSchema, ctx.body);
    return store.createReview(body.projectId, body.title);
  });
  register("GET", "/v1/reviews/:reviewId", (ctx) => requireReview(ctx.params.reviewId!));
  register("DELETE", "/v1/reviews/:reviewId", (ctx) => store.deleteReview(ctx.params.reviewId!));
  register("POST", "/v1/reviews/:reviewId/process", async (ctx) => {
    const id = ctx.params.reviewId!; requireReview(id);
    const problems = options.processing ? await processing.preflight(id) : [];
    if (problems.length) throw new HttpError(409, "preflight_failed", "Verarbeitung nicht möglich: Voraussetzungen fehlen", problems);
    return processing.processReview(id);
  });
  register("POST", "/v1/reviews/:reviewId/comments", async (ctx) =>
    comments.create(ctx.params.reviewId!, validate(CreateCommentSchema, ctx.body)), COMMENT_JSON_LIMIT);
  register("PUT", "/v1/comments/:commentId", async (ctx) =>
    comments.update(ctx.params.commentId!, validate(UpdateCommentSchema, ctx.body)), COMMENT_JSON_LIMIT);
  register("DELETE", "/v1/comments/:commentId", (ctx) => store.deleteComment(ctx.params.commentId!));
  register("GET", "/v1/comments/:commentId/image", (ctx) => {
    const bytes = comments.image(ctx.params.commentId!);
    return { pngBase64: bytes.toString("base64") };
  });
  register("POST", "/v1/comments/:commentId/answer", async (ctx) => {
    const id = ctx.params.commentId!; requireComment(id);
    return processing.answer(id, validate(AnswerSchema, ctx.body));
  });
  register("POST", "/v1/comments/:commentId/decision", async (ctx) => {
    const id = ctx.params.commentId!; requireComment(id);
    return processing.decide(id, validate(DecisionSchema, ctx.body));
  });
  register("POST", "/v1/comments/:commentId/retry", (ctx) => {
    const id = ctx.params.commentId!; requireComment(id); return processing.retry(id);
  });
  register("POST", "/v1/comments/:commentId/reconcile", async (ctx) => {
    const id = ctx.params.commentId!; requireComment(id);
    return processing.reconcile(id, validate(ReconcileSchema, ctx.body));
  });

  const server = createInternalServer(internalRouter, internalToken, socketPath);

  const app = {
    store, secrets, projects, events, comments, processing, internalToken, server, socketPath,
    dispatch: router.dispatch.bind(router),
    registerInternal(method: string, path: string, handler: DataHandler): void {
      if (!path.startsWith("/internal/")) throw new Error("Interne Route muss mit /internal/ beginnen");
      internalRouter.register(method, path, dataHandler(handler));
    },
    start(): Promise<void> {
      if (stopped) return Promise.reject(new Error("Begleitdienst wurde beendet"));
      if (starting) return starting;
      starting = server.start().then(async () => { await processing.resume?.(); });
      return starting;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (starting) await starting.catch(() => {});
      try { await server.stop(); }
      finally {
        try { await processing.close?.(); }
        finally { try { if (options.processing) await runner.close(); } finally { store.close(); } }
      }
    },
  };
  registerGatewayHandlers(app.registerInternal, store, projects);
  return app;
}

export type CompanionApp = ReturnType<typeof createApp>;
