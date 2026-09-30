/**
 * HTTP contract between extension and companion.
 * Base: http://127.0.0.1:47821 (configurable). All bodies JSON unless noted.
 * Every route except POST /v1/pair and GET /v1/health requires
 *   Authorization: Bearer <token>
 * and an Origin header equal to the paired chrome-extension://<id>.
 * Errors: non-2xx with body ApiError.
 */
import type {
  CaptureContext,
  Comment,
  DecisionInput,
  MarkKind,
  ProjectView,
  ReviewDetail,
  ReviewSummary,
  ScreenshotMeta,
} from "./domain.ts";
import type { ProjectConfig } from "./projectConfig.ts";

export const DEFAULT_COMPANION_PORT = 47821;
export const API_PREFIX = "/v1";

export interface ApiError {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}
export type ApiErrorCode =
  | "unauthorized"
  | "forbidden_origin"
  | "invalid_pairing_code"
  | "not_found"
  | "validation"
  | "conflict" // e.g. stale revision, comment not editable
  | "preflight_failed"
  | "kan_error"
  | "internal";

// GET /v1/health (no auth)
export interface HealthResponse {
  ok: true;
  version: string;
  paired: boolean;
}

// POST /v1/pair (no auth; Origin must be chrome-extension://…). Code is printed by `website-review-companion pair`.
export interface PairRequest {
  code: string;
}
export interface PairResponse {
  token: string;
}

// GET /v1/status
export interface StatusResponse {
  version: string;
  codex: { available: boolean; version?: string; problem?: string };
}

// ---------- Projects ----------
// GET    /v1/projects                         -> ProjectView[]
// POST   /v1/projects          ProjectConfig  -> ProjectView   (create; 409 if projectId exists)
// POST   /v1/projects/import   ImportProjectRequest -> ProjectView
// PUT    /v1/projects/:projectId ProjectConfig -> ProjectView  (update shareable part)
// DELETE /v1/projects/:projectId              -> 204 (also deletes its local reviews)
// GET    /v1/projects/:projectId/export       -> ProjectConfig (exactly the shareable fields)
// PUT    /v1/projects/:projectId/checkouts  SetCheckoutsRequest -> ProjectView
// POST   /v1/projects/:projectId/check        -> ProjectView (re-validates checkouts + Kan now)
// POST   /v1/match             MatchRequest   -> MatchResponse
export interface ImportProjectRequest {
  config: unknown; // validated server-side with ProjectConfigSchema
  /** When a project with the same projectId exists: replace its shareable config, keep local mapping. */
  replaceExisting?: boolean;
}
export interface SetCheckoutsRequest {
  checkouts: Record<string, string>; // alias -> absolute local path
}
export interface MatchRequest {
  url: string;
}
export interface MatchResponse {
  projectIds: string[];
}

// ---------- Kan connection & target selection ----------
// PUT  /v1/kan/credentials  SetKanCredentialRequest -> KanCredentialStatus  (validates token against Kan)
// GET  /v1/kan/credentials                          -> KanCredentialStatus[]
// GET  /v1/kan/workspaces?baseUrl=…                 -> KanWorkspace[]
// GET  /v1/kan/workspaces/:ws/boards?baseUrl=…      -> KanBoard[]
// GET  /v1/kan/boards/:board/lists?baseUrl=…        -> KanList[]
export interface SetKanCredentialRequest {
  baseUrl: string;
  apiToken: string;
}
export interface KanCredentialStatus {
  baseUrl: string;
  configured: boolean;
  valid?: boolean;
  problem?: string;
}
export interface KanWorkspace {
  publicId: string;
  name: string;
}
export interface KanBoard {
  publicId: string;
  name: string;
}
export interface KanList {
  publicId: string;
  name: string;
}

// ---------- Reviews ----------
// GET    /v1/reviews?projectId=…            -> ReviewSummary[]
// POST   /v1/reviews   CreateReviewRequest  -> ReviewDetail
// GET    /v1/reviews/:reviewId              -> ReviewDetail
// DELETE /v1/reviews/:reviewId              -> 204 (local comments + images; external tickets stay)
// POST   /v1/reviews/:reviewId/process      -> ProcessResponse (409 preflight_failed with details: PreflightProblem[])
export interface CreateReviewRequest {
  projectId: string;
  title?: string;
}
export interface PreflightProblem {
  kind: "checkout" | "codex" | "kan_token" | "kan_target";
  message: string;
}
export interface ProcessResponse {
  started: string[]; // comment ids picked up
}

// ---------- Comments ----------
// POST   /v1/reviews/:reviewId/comments CreateCommentRequest -> Comment
// PUT    /v1/comments/:commentId  UpdateCommentRequest -> Comment (new revision; 409 if not editable or stale)
// DELETE /v1/comments/:commentId               -> 204
// GET    /v1/comments/:commentId/image         -> image/png
// POST   /v1/comments/:commentId/answer   AnswerRequest   -> Comment
// POST   /v1/comments/:commentId/decision DecisionInput   -> Comment
// POST   /v1/comments/:commentId/retry                    -> Comment (only missing steps)
// POST   /v1/comments/:commentId/reconcile ReconcileRequest -> Comment
export interface CreateCommentRequest {
  /** Idempotency key (UUID per capture). A retried POST with the same id returns the existing comment. */
  clientRequestId?: string;
  text: string;
  markKind: MarkKind;
  context: CaptureContext;
  screenshot?: ScreenshotMeta;
  /** Final approved PNG (cropped, marker drawn) as base64 without data: prefix. Required iff screenshot is set. */
  imagePngBase64?: string;
}
export interface UpdateCommentRequest {
  /** Revision the client edited; 409 conflict if the server has moved on. */
  baseRevision: number;
  text?: string;
  context?: Partial<Pick<CaptureContext, "extraContext">>;
  screenshot?: ScreenshotMeta;
  imagePngBase64?: string;
}
export interface AnswerRequest {
  questionId: string;
  answer: string;
}
export type { DecisionInput };
export type ReconcileRequest =
  | { action: "recheck" } // run automatic reconciliation against Kan again
  | { action: "confirm_exists"; cardPublicId: string } // user found the card; link it, continue with missing steps
  | { action: "confirm_absent" }; // user verified no card exists; allow a new create attempt

// ---------- Events ----------
// GET /v1/events  -> text/event-stream. Clients refetch the affected resource on each event.
export type CompanionEvent =
  | { type: "review.updated"; reviewId: string }
  | { type: "comment.updated"; reviewId: string; commentId: string }
  | { type: "projects.updated" }
  | { type: "ping" };

export type { Comment, ProjectConfig, ProjectView, ReviewDetail, ReviewSummary };
