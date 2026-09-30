/**
 * Typed client for the companion API (packages/shared/src/api.ts). Transport: Chrome Native
 * Messaging through the background worker (panelConnection.ts); responses carry HTTP-style status
 * codes, errors an ApiError body.
 */
import { API_PREFIX } from "@website-review/shared";
import type {
  AnswerRequest,
  ApiError,
  ApiErrorCode,
  Comment,
  CreateCommentRequest,
  CreateReviewRequest,
  DecisionInput,
  HealthResponse,
  ImageResponse,
  ImportProjectRequest,
  KanBoard,
  KanCredentialStatus,
  KanList,
  KanWorkspace,
  MatchResponse,
  NativeMethod,
  NativeResponse,
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
import type { Transport } from "./panelConnection.ts";

/**
 * Client-side codes in addition to the server's ApiErrorCode:
 * - unavailable: host not installed/crashed/not ready (incl. 503 while another profile runs it)
 * - timeout: no answer in time
 * - bad_response: malformed answer
 */
export type ClientErrorCode = ApiErrorCode | "unavailable" | "timeout" | "bad_response";

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

  /** The companion cannot serve right now (see the host status for why). */
  get unreachable(): boolean {
    return this.code === "unavailable" || this.code === "timeout";
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
      case "unavailable":
        return e.status === 503 ? `Begleitdienst nicht bereit: ${e.message}` : e.message;
      case "timeout":
        return "Zeitüberschreitung bei der Anfrage an den Begleitdienst.";
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
  404: "not_found",
  409: "conflict",
  422: "validation",
};

interface RequestOptions {
  query?: Record<string, string>;
  timeoutMs?: number;
}

const enc = encodeURIComponent;

export class CompanionClient {
  private readonly images = new Map<string, Promise<string>>();

  constructor(private readonly transport: Transport) {}

  private async request<T>(method: NativeMethod, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
    const res = await this.transport.request(method, `${API_PREFIX}${path}${qs}`, body, opts.timeoutMs ?? 30_000);
    if (res.status >= 400) throw toError(res);
    return res.body as T;
  }

  // ---------- Connection ----------
  health(): Promise<HealthResponse> {
    return this.request("GET", "/health", undefined, { timeoutMs: 5_000 });
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

  /** GET /v1/comments/:id/image ({ pngBase64 }) as blob: URL, cached per comment revision. */
  commentImageUrl(commentId: string, revision: number): Promise<string> {
    const key = `${commentId}@${revision}`;
    let p = this.images.get(key);
    if (!p) {
      p = this.request<ImageResponse>("GET", `/comments/${enc(commentId)}/image`).then((img) => {
        if (!img || typeof img.pngBase64 !== "string") throw new CompanionError(200, "bad_response", "Bild fehlt in der Antwort");
        return URL.createObjectURL(base64ToBlob(img.pngBase64, "image/png"));
      });
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
}

export function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function toError(res: NativeResponse): CompanionError {
  const body = (res.body ?? undefined) as Partial<ApiError> | undefined;
  const message = body?.error?.message ?? `Fehler ${res.status}`;
  // 503: this host process cannot serve (e.g. another browser profile runs the companion).
  if (res.status === 503) return new CompanionError(503, "unavailable", message, body?.error?.details);
  const code: ApiErrorCode = body?.error?.code ?? STATUS_CODES[res.status] ?? "internal";
  return new CompanionError(res.status, code, message, body?.error?.details);
}
