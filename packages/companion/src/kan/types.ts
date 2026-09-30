/**
 * Seam between the companion and Kan. Implemented by `kanClient.ts` (REST, https://<baseUrl>/api/v1).
 * See docs/architecture.md "Gateway MCP … and publishing" and docs/reference/kan-api/.
 */
import type { KanBoard, KanList, KanWorkspace } from "@website-review/shared";

export interface KanCardSummary {
  publicId: string;
  title: string;
  description: string | null;
  listPublicId?: string;
  listName?: string;
}

export interface KanBoardDetail {
  publicId: string;
  name: string;
  lists: (KanList & { cards: KanCardSummary[] })[];
}

export interface KanCardDetail {
  publicId: string;
  title: string;
  description: string | null;
  listName?: string;
  attachments: { publicId: string; filename: string; originalFilename?: string }[];
  /** Comment texts found in the card's activities (for reconciliation). */
  comments: { publicId: string; comment: string }[];
}

export interface KanCreateCardInput {
  listPublicId: string;
  title: string;
  description: string;
}

export interface KanUploadInput {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface KanClient {
  readonly baseUrl: string;
  /** Link shown to users: `${baseUrl}/cards/${publicId}`. */
  cardUrl(cardPublicId: string): string;
  listWorkspaces(): Promise<KanWorkspace[]>;
  listBoards(workspacePublicId: string): Promise<KanBoard[]>;
  getBoard(boardPublicId: string): Promise<KanBoardDetail>;
  searchCards(workspacePublicId: string, query: string, limit?: number): Promise<KanCardSummary[]>;
  getCard(cardPublicId: string): Promise<KanCardDetail>;
  createCard(input: KanCreateCardInput): Promise<{ publicId: string }>;
  addComment(cardPublicId: string, comment: string): Promise<{ publicId: string }>;
  /** upload-url → PUT bytes → confirm. Returns the confirmed attachment. */
  uploadAttachment(cardPublicId: string, input: KanUploadInput): Promise<{ publicId: string }>;
}

/**
 * kind semantics for the publisher:
 * - "auth" (401/403), "not_found" (404), "validation" (400): definite failure, nothing was written.
 * - "timeout", "network", "server" (5xx): if `requestSent` the write MAY have happened → op becomes "unclear".
 * - "rate_limited" (429): nothing written; reads are retried internally, writes surface this error.
 */
export type KanErrorKind = "auth" | "not_found" | "validation" | "rate_limited" | "server" | "network" | "timeout";

export class KanError extends Error {
  constructor(
    message: string,
    readonly kind: KanErrorKind,
    readonly status: number | undefined,
    readonly requestSent: boolean,
  ) {
    super(message);
    this.name = "KanError";
  }
}

export interface KanClientOptions {
  baseUrl: string;
  apiToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number; // default 20000
}
