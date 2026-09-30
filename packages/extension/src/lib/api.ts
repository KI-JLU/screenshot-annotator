/**
 * Typed client for the companion HTTP API (packages/shared/src/api.ts).
 * All routes except /v1/pair and /v1/health send `Authorization: Bearer <token>`; the browser adds
 * the chrome-extension:// Origin header itself.
 */
import { API_PREFIX, DEFAULT_COMPANION_PORT } from "@website-review/shared";
import type {
  AnswerRequest,
  ApiError,
  ApiErrorCode,
  Comment,
  CompanionEvent,
  CreateCommentRequest,
  CreateReviewRequest,
  DecisionInput,
  HealthResponse,
  ImportProjectRequest,
  KanBoard,
  KanCredentialStatus,
  KanList,
  KanWorkspace,
  MatchResponse,
  PairResponse,
  PreflightProblem,
  ProcessResponse,
  ProjectConfig,
  ProjectView,
  ReconcileRequest,
  ReviewDetail,
  ReviewSummary,
  SetKanCredentialRequest,
  StatusResponse,
  UpdateCommentRequest,
} from "@website-review/shared";
import { SseParser, toCompanionEvent } from "./sse.ts";

export const DEFAULT_BASE_URL = `http://127.0.0.1:${DEFAULT_COMPANION_PORT}`;

export interface CompanionSettings {
  baseUrl: string;
  token?: string;
}

/** Client-side codes in addition to the server's ApiErrorCode. */
export type ClientErrorCode = ApiErrorCode | "network" | "timeout" | "bad_response";

export class CompanionError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ClientErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CompanionError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** The companion is not reachable at all (not running, wrong URL). */
  get unreachable(): boolean {
    return this.code === "network" || this.code === "timeout";
  }

  /** Token rejected or extension not the paired one: re-pairing is required. */
  get authProblem(): boolean {
    return this.code === "unauthorized" || this.code === "forbidden_origin";
  }
}

export function isCompanionError(e: unknown): e is CompanionError {
  return e instanceof CompanionError;
}

/** Details of a 409 preflight_failed answer of POST /v1/reviews/:id/process. */
export function preflightProblems(e: unknown): PreflightProblem[] | null {
  if (!isCompanionError(e) || e.code !== "preflight_failed") return null;
  const list = Array.isArray(e.details) ? e.details : [];
  return list.filter(
    (p): p is PreflightProblem =>
      !!p && typeof p === "object" && typeof (p as PreflightProblem).message === "string",
  );
}

/** German, user-facing text for any error thrown by the client. */
export function errorText(e: unknown): string {
  if (isCompanionError(e)) {
    switch (e.code) {
      case "network":
        return "Begleitdienst nicht erreichbar. Läuft „website-review-companion serve“?";
      case "timeout":
        return "Zeitüberschreitung bei der Anfrage an den Begleitdienst.";
      case "unauthorized":
      case "forbidden_origin":
        return `Kopplung ungültig – bitte die Extension neu koppeln. (${e.message})`;
      case "bad_response":
        return `Unerwartete Antwort des Begleitdienstes: ${e.message}`;
      default:
        return e.message || `Fehler ${e.status}`;
    }
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: "validation",
  401: "unauthorized",
  403: "forbidden_origin",
  404: "not_found",
  409: "conflict",
  422: "validation",
};

interface RequestOptions {
  auth?: boolean;
  query?: Record<string, string>;
  timeoutMs?: number;
}

const enc = encodeURIComponent;

export class CompanionClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly images = new Map<string, Promise<string>>();

  constructor(settings: CompanionSettings) {
    this.baseUrl = normalizeBaseUrl(settings.baseUrl);
    this.token = settings.token;
  }

  get paired(): boolean {
    return !!this.token;
  }

  private url(path: string, query?: Record<string, string>): string {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
    return `${this.baseUrl}${API_PREFIX}${path}${qs}`;
  }

  private headers(auth: boolean, json: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    if (auth && this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async fetchRaw(method: string, path: string, body: unknown, opts: RequestOptions): Promise<Response> {
    const auth = opts.auth ?? true;
    let res: Response;
    try {
      res = await fetch(this.url(path, opts.query), {
        method,
        headers: this.headers(auth, body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (e) {
      const timeout = e instanceof DOMException && e.name === "TimeoutError";
      throw new CompanionError(0, timeout ? "timeout" : "network", e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw await toError(res);
    return res;
  }

  private async request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const res = await this.fetchRaw(method, path, body, opts);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CompanionError(res.status, "bad_response", "Antwort ist kein JSON");
    }
  }

  // ---------- Connection ----------
  health(): Promise<HealthResponse> {
    return this.request("GET", "/health", undefined, { auth: false, timeoutMs: 5_000 });
  }
  pair(code: string): Promise<PairResponse> {
    return this.request("POST", "/pair", { code }, { auth: false });
  }
  status(): Promise<StatusResponse> {
    return this.request("GET", "/status", undefined, { timeoutMs: 10_000 });
  }

  // ---------- Projects ----------
  listProjects(): Promise<ProjectView[]> {
    return this.request("GET", "/projects");
  }
  createProject(config: ProjectConfig): Promise<ProjectView> {
    return this.request("POST", "/projects", config);
  }
  importProject(req: ImportProjectRequest): Promise<ProjectView> {
    return this.request("POST", "/projects/import", req);
  }
  updateProject(projectId: string, config: ProjectConfig): Promise<ProjectView> {
    return this.request("PUT", `/projects/${enc(projectId)}`, config);
  }
  deleteProject(projectId: string): Promise<void> {
    return this.request("DELETE", `/projects/${enc(projectId)}`);
  }
  exportProject(projectId: string): Promise<ProjectConfig> {
    return this.request("GET", `/projects/${enc(projectId)}/export`);
  }
  setCheckouts(projectId: string, checkouts: Record<string, string>): Promise<ProjectView> {
    return this.request("PUT", `/projects/${enc(projectId)}/checkouts`, { checkouts });
  }
  checkProject(projectId: string): Promise<ProjectView> {
    return this.request("POST", `/projects/${enc(projectId)}/check`, undefined, { timeoutMs: 60_000 });
  }
  match(url: string): Promise<MatchResponse> {
    return this.request("POST", "/match", { url });
  }

  // ---------- Kan ----------
  setKanCredential(req: SetKanCredentialRequest): Promise<KanCredentialStatus> {
    return this.request("PUT", "/kan/credentials", req, { timeoutMs: 30_000 });
  }
  listKanCredentials(): Promise<KanCredentialStatus[]> {
    return this.request("GET", "/kan/credentials");
  }
  listKanWorkspaces(baseUrl: string): Promise<KanWorkspace[]> {
    return this.request("GET", "/kan/workspaces", undefined, { query: { baseUrl } });
  }
  listKanBoards(baseUrl: string, workspacePublicId: string): Promise<KanBoard[]> {
    return this.request("GET", `/kan/workspaces/${enc(workspacePublicId)}/boards`, undefined, { query: { baseUrl } });
  }
  listKanLists(baseUrl: string, boardPublicId: string): Promise<KanList[]> {
    return this.request("GET", `/kan/boards/${enc(boardPublicId)}/lists`, undefined, { query: { baseUrl } });
  }

  // ---------- Reviews ----------
  listReviews(projectId: string): Promise<ReviewSummary[]> {
    return this.request("GET", "/reviews", undefined, { query: { projectId } });
  }
  createReview(req: CreateReviewRequest): Promise<ReviewDetail> {
    return this.request("POST", "/reviews", req);
  }
  getReview(reviewId: string): Promise<ReviewDetail> {
    return this.request("GET", `/reviews/${enc(reviewId)}`);
  }
  deleteReview(reviewId: string): Promise<void> {
    return this.request("DELETE", `/reviews/${enc(reviewId)}`);
  }
  processReview(reviewId: string): Promise<ProcessResponse> {
    return this.request("POST", `/reviews/${enc(reviewId)}/process`, undefined, { timeoutMs: 60_000 });
  }

  // ---------- Comments ----------
  createComment(reviewId: string, req: CreateCommentRequest): Promise<Comment> {
    return this.request("POST", `/reviews/${enc(reviewId)}/comments`, req, { timeoutMs: 120_000 });
  }
  updateComment(commentId: string, req: UpdateCommentRequest): Promise<Comment> {
    return this.request("PUT", `/comments/${enc(commentId)}`, req, { timeoutMs: 120_000 });
  }
  deleteComment(commentId: string): Promise<void> {
    return this.request("DELETE", `/comments/${enc(commentId)}`);
  }
  answer(commentId: string, req: AnswerRequest): Promise<Comment> {
    return this.request("POST", `/comments/${enc(commentId)}/answer`, req);
  }
  decide(commentId: string, decision: DecisionInput): Promise<Comment> {
    return this.request("POST", `/comments/${enc(commentId)}/decision`, decision);
  }
  retry(commentId: string): Promise<Comment> {
    return this.request("POST", `/comments/${enc(commentId)}/retry`);
  }
  reconcile(commentId: string, req: ReconcileRequest): Promise<Comment> {
    return this.request("POST", `/comments/${enc(commentId)}/reconcile`, req, { timeoutMs: 60_000 });
  }

  /** GET /v1/comments/:id/image as blob: URL (cached per comment revision). */
  commentImageUrl(commentId: string, revision: number): Promise<string> {
    const key = `${commentId}@${revision}`;
    let p = this.images.get(key);
    if (!p) {
      p = this.fetchRaw("GET", `/comments/${enc(commentId)}/image`, undefined, { timeoutMs: 30_000 })
        .then((res) => res.blob())
        .then((blob) => URL.createObjectURL(blob));
      p.catch(() => this.images.delete(key));
      this.images.set(key, p);
    }
    return p;
  }

  /** Releases cached blob: URLs. */
  dispose(): void {
    for (const p of this.images.values()) p.then((u) => URL.revokeObjectURL(u), () => undefined);
    this.images.clear();
  }

  /**
   * GET /v1/events via fetch streaming (EventSource cannot send Authorization headers).
   * Reconnects with exponential backoff; returns a function that stops the subscription.
   */
  subscribeEvents(handlers: {
    onEvent: (e: CompanionEvent) => void;
    onOpen?: () => void;
    onError?: (e: CompanionError) => void;
  }): () => void {
    const controller = new AbortController();
    const { signal } = controller;
    let delay = 1_000;
    const IDLE_MS = 90_000;

    const run = async () => {
      while (!signal.aborted) {
        const attempt = new AbortController();
        const abortAttempt = () => attempt.abort();
        signal.addEventListener("abort", abortAttempt, { once: true });
        let idle: ReturnType<typeof setTimeout> | undefined;
        const armIdle = () => {
          clearTimeout(idle);
          idle = setTimeout(() => attempt.abort(), IDLE_MS);
        };
        try {
          let res: Response;
          try {
            res = await fetch(this.url("/events"), {
              headers: { ...this.headers(true, false), Accept: "text/event-stream" },
              cache: "no-store",
              signal: attempt.signal,
            });
          } catch (e) {
            throw new CompanionError(0, "network", e instanceof Error ? e.message : String(e));
          }
          if (!res.ok) throw await toError(res);
          if (!res.body) throw new CompanionError(res.status, "bad_response", "Kein Ereignisstrom");
          delay = 1_000;
          handlers.onOpen?.();
          armIdle();
          const parser = new SseParser();
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            armIdle();
            for (const msg of parser.push(value)) {
              const ev = toCompanionEvent(msg);
              if (ev) handlers.onEvent(ev);
            }
          }
          if (!signal.aborted) throw new CompanionError(0, "network", "Ereignisstrom beendet");
        } catch (e) {
          if (signal.aborted) return;
          const err = isCompanionError(e) ? e : new CompanionError(0, "network", e instanceof Error ? e.message : String(e));
          handlers.onError?.(err);
          // Auth problems will not heal by retrying quickly.
          if (err.authProblem) delay = 30_000;
        } finally {
          clearTimeout(idle);
          signal.removeEventListener("abort", abortAttempt);
        }
        await sleep(delay, signal);
        delay = Math.min(delay * 2, 30_000);
      }
    };
    void run();
    return () => controller.abort();
  }
}

export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_BASE_URL;
}

async function toError(res: Response): Promise<CompanionError> {
  let body: Partial<ApiError> | undefined;
  try {
    body = (await res.json()) as Partial<ApiError>;
  } catch {
    body = undefined;
  }
  const code: ApiErrorCode = body?.error?.code ?? STATUS_CODES[res.status] ?? "internal";
  const message = body?.error?.message ?? `HTTP ${res.status} ${res.statusText}`.trim();
  return new CompanionError(res.status, code, message, body?.error?.details);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
