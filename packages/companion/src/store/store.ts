import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { chmodSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  Comment, CommentAnalysis, CommentState, CompanionEvent, MergeProposal, OpenQuestion,
  PendingDecision, ProjectConfig, PublicationKind, PublicationOp, PublicationOpState,
  Review, ReviewDetail, ReviewSummary, TicketLink,
} from "@website-review/shared";
import { EventBus } from "../events/eventBus.ts";
import { conflict, notFound } from "../http/errors.ts";
import { hashSecret, newId, newPairingCode } from "../ids.ts";
import { ensurePrivateDir } from "../paths.ts";
import { migrate } from "./schema.ts";

type Row = Record<string, unknown>;
const json = (value: unknown): string | null => value === undefined ? null : JSON.stringify(value);
const parse = <T>(value: unknown): T | undefined => value == null ? undefined : JSON.parse(String(value)) as T;
const now = (): string => new Date().toISOString();

function readReview(row: Row): Review {
  return { id: String(row.id), projectId: String(row.project_id), title: String(row.title),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ...(row.codex_thread_id == null ? {} : { codexThreadId: String(row.codex_thread_id) }) };
}
function readComment(row: Row): Comment {
  const optional = {
    screenshot: parse<Comment["screenshot"]>(row.screenshot_json),
    stateDetail: row.state_detail == null ? undefined : String(row.state_detail),
    pendingDecision: parse<PendingDecision>(row.pending_decision_json),
    mergeGroupId: row.merge_group_id == null ? undefined : String(row.merge_group_id),
    analysis: parse<CommentAnalysis>(row.analysis_json), ticket: parse<TicketLink>(row.ticket_json),
  };
  return { id: String(row.id), reviewId: String(row.review_id), revision: Number(row.revision),
    text: String(row.text), markKind: row.mark_kind as Comment["markKind"], context: parse<Comment["context"]>(row.context_json)!,
    state: row.state as CommentState, questions: parse<OpenQuestion[]>(row.questions_json)!,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)) };
}
function readOp(row: Row): PublicationOp {
  return { id: String(row.id), commentId: String(row.comment_id), revision: Number(row.revision),
    kind: row.kind as PublicationKind, reference: String(row.reference), state: row.state as PublicationOpState,
    ...(row.card_public_id == null ? {} : { cardPublicId: String(row.card_public_id) }),
    ...(row.external_id == null ? {} : { externalId: String(row.external_id) }),
    ...(row.error == null ? {} : { error: String(row.error) }),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

export type CommentUpdate = Partial<Omit<Comment, "id" | "reviewId" | "createdAt">>;
export type NewOp = Pick<PublicationOp, "commentId" | "revision" | "kind"> & Partial<Omit<PublicationOp, "commentId" | "revision" | "kind">>;

/** Synchronous DB operations. Transactions buffer events and file cleanup until commit. */
export class Store {
  readonly db: DatabaseSync;
  readonly imagesDir: string;
  private frames: { events: CompanionEvent[]; cleanup: (() => void)[] }[] = [];
  private savepoint = 0;

  constructor(readonly dataDir: string, readonly events = new EventBus()) {
    ensurePrivateDir(dataDir);
    this.imagesDir = join(dataDir, "images");
    ensurePrivateDir(this.imagesDir);
    const filename = join(dataDir, "companion.db");
    this.db = new DatabaseSync(filename);
    try { chmodSync(filename, 0o600); migrate(this.db); }
    catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }

  transaction<T>(fn: () => T): T {
    const nested = this.frames.length > 0;
    const name = `store_${++this.savepoint}`;
    const frame = { events: [] as CompanionEvent[], cleanup: [] as (() => void)[] };
    this.db.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
    this.frames.push(frame);
    let result: T;
    try {
      result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("Store.transaction benötigt eine synchrone Funktion");
      }
      this.db.exec(nested ? `RELEASE ${name}` : "COMMIT");
    } catch (error) {
      this.db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
      this.frames.pop();
      throw error;
    }
    this.frames.pop();
    const parent = this.frames.at(-1);
    if (parent) { parent.events.push(...frame.events); parent.cleanup.push(...frame.cleanup); }
    else {
      for (const cleanup of frame.cleanup) cleanup();
      for (const event of frame.events) this.events.emit(event);
    }
    return result;
  }
  private emit(event: CompanionEvent): void {
    const frame = this.frames.at(-1);
    if (frame) frame.events.push(event); else this.events.emit(event);
  }
  private afterCommit(action: () => void): void {
    const frame = this.frames.at(-1);
    if (frame) frame.cleanup.push(action); else action();
  }
  private commentChanged(comment: Comment): void {
    this.db.prepare("UPDATE reviews SET updated_at = ? WHERE id = ?").run(now(), comment.reviewId);
    this.emit({ type: "comment.updated", reviewId: comment.reviewId, commentId: comment.id });
    this.emit({ type: "review.updated", reviewId: comment.reviewId });
  }

  listProjects(): ProjectConfig[] {
    return this.db.prepare("SELECT config_json FROM projects ORDER BY project_id").all().map((r) => parse<ProjectConfig>(r.config_json)!);
  }
  getProject(id: string): ProjectConfig | undefined {
    return parse<ProjectConfig>(this.db.prepare("SELECT config_json FROM projects WHERE project_id = ?").get(id)?.config_json);
  }
  saveProject(config: ProjectConfig): void {
    this.db.prepare("INSERT INTO projects VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET config_json = excluded.config_json")
      .run(config.projectId, JSON.stringify(config));
    this.emit({ type: "projects.updated" });
  }
  deleteProject(id: string): void {
    if (!this.getProject(id)) notFound("Projekt");
    this.transaction(() => {
      for (const review of this.listReviews(id)) this.deleteReview(review.id);
      this.db.prepare("DELETE FROM projects WHERE project_id = ?").run(id);
      this.emit({ type: "projects.updated" });
    });
  }
  getCheckouts(projectId: string): Record<string, string> {
    const mappings: Record<string, string> = Object.create(null);
    for (const row of this.db.prepare("SELECT alias, path FROM checkouts WHERE project_id = ?").all(projectId)) {
      mappings[String(row.alias)] = String(row.path);
    }
    return mappings;
  }
  setCheckouts(projectId: string, checkouts: Record<string, string>): void {
    if (!this.getProject(projectId)) notFound("Projekt");
    this.transaction(() => {
      this.db.prepare("DELETE FROM checkouts WHERE project_id = ?").run(projectId);
      const insert = this.db.prepare("INSERT INTO checkouts VALUES (?, ?, ?)");
      for (const [alias, path] of Object.entries(checkouts)) insert.run(projectId, alias, path);
      this.emit({ type: "projects.updated" });
    });
  }

  getPairing(): { extensionOrigin: string; tokenHash: string } | undefined {
    const row = this.db.prepare("SELECT * FROM pairing WHERE id = 1").get();
    return row ? { extensionOrigin: String(row.extension_origin), tokenHash: String(row.token_hash) } : undefined;
  }
  createPairingCode(time = Date.now()): string {
    const code = newPairingCode();
    this.transaction(() => {
      this.db.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?").run(time);
      this.db.prepare("INSERT INTO pairing_codes VALUES (?, ?)").run(hashSecret(code), time + 10 * 60_000);
    });
    return code;
  }
  pair(code: string, origin: string, token: string, time = Date.now()): boolean {
    return this.transaction(() => {
      const consumed = this.db.prepare("DELETE FROM pairing_codes WHERE code_hash = ? AND expires_at > ?")
        .run(hashSecret(code), time);
      if (!consumed.changes) return false;
      this.db.prepare("INSERT INTO pairing VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET extension_origin = excluded.extension_origin, token_hash = excluded.token_hash")
        .run(origin, hashSecret(token));
      // Re-pairing invalidates any other outstanding code as well as the old token.
      this.db.exec("DELETE FROM pairing_codes");
      return true;
    });
  }

  createReview(projectId: string, title = "Website-Review"): ReviewDetail {
    if (!this.getProject(projectId)) notFound("Projekt");
    const id = newId(); const time = now();
    this.db.prepare("INSERT INTO reviews (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, projectId, title, time, time);
    this.emit({ type: "review.updated", reviewId: id });
    return this.getReviewDetail(id)!;
  }
  getReview(id: string): Review | undefined {
    const row = this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(id);
    return row ? readReview(row) : undefined;
  }
  listReviews(projectId?: string): ReviewSummary[] {
    const rows = projectId === undefined ? this.db.prepare("SELECT * FROM reviews ORDER BY created_at, id").all()
      : this.db.prepare("SELECT * FROM reviews WHERE project_id = ? ORDER BY created_at, id").all(projectId);
    return rows.map((row) => {
      const review = readReview(row);
      const counts = Object.fromEntries(this.db.prepare("SELECT state, COUNT(*) AS count FROM comments WHERE review_id = ? GROUP BY state")
        .all(review.id).map((r) => [String(r.state), Number(r.count)]));
      return { ...review, counts };
    });
  }
  getReviewDetail(id: string): ReviewDetail | undefined {
    const review = this.getReview(id);
    if (!review) return undefined;
    const comments = this.listComments(id);
    return { ...review, comments, mergeProposals: this.listMergeProposals(id),
      processing: comments.some((c) => c.state === "processing" || c.state === "publishing") };
  }
  setCodexThreadId(id: string, threadId: string): void {
    if (!this.getReview(id)) notFound("Review");
    this.db.prepare("UPDATE reviews SET codex_thread_id = ?, updated_at = ? WHERE id = ?").run(threadId, now(), id);
    this.emit({ type: "review.updated", reviewId: id });
  }
  deleteReview(id: string): void {
    if (!this.getReview(id)) notFound("Review");
    this.transaction(() => {
      for (const comment of this.listComments(id)) this.deleteComment(comment.id);
      this.db.prepare("DELETE FROM reviews WHERE id = ?").run(id);
      this.emit({ type: "review.updated", reviewId: id });
    });
  }

  getComment(id: string): Comment | undefined {
    const row = this.db.prepare("SELECT * FROM comments WHERE id = ?").get(id);
    return row ? readComment(row) : undefined;
  }
  listComments(reviewId: string): Comment[] {
    return this.db.prepare("SELECT * FROM comments WHERE review_id = ? ORDER BY created_at, id").all(reviewId).map(readComment);
  }
  findCommentByClientRequestId(reviewId: string, clientRequestId: string): Comment | undefined {
    const row = this.db.prepare("SELECT * FROM comments WHERE review_id = ? AND client_request_id = ?").get(reviewId, clientRequestId);
    return row ? readComment(row) : undefined;
  }
  getImagePath(id: string): string | undefined {
    const path = this.db.prepare("SELECT image_path FROM comments WHERE id = ?").get(id)?.image_path;
    return path == null ? undefined : String(path);
  }
  imagePath(id: string, revision: number): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !Number.isSafeInteger(revision) || revision < 1) throw new Error("Ungültige Bildreferenz");
    return join(this.imagesDir, `${id}-r${revision}.png`);
  }
  insertComment(comment: Comment, imagePath?: string, clientRequestId?: string): Comment {
    this.db.prepare(`INSERT INTO comments (id, review_id, revision, text, mark_kind, context_json,
      screenshot_json, image_path, state, state_detail, questions_json, pending_decision_json,
      merge_group_id, analysis_json, ticket_json, created_at, updated_at, client_request_id) VALUES (${Array(18).fill("?").join(",")})`)
      .run(comment.id, comment.reviewId, comment.revision, comment.text, comment.markKind, json(comment.context),
        json(comment.screenshot), imagePath ?? null, comment.state, comment.stateDetail ?? null, json(comment.questions),
        json(comment.pendingDecision), comment.mergeGroupId ?? null, json(comment.analysis), json(comment.ticket), comment.createdAt, comment.updatedAt, clientRequestId ?? null);
    this.commentChanged(comment);
    return this.getComment(comment.id)!;
  }
  updateComment(id: string, patch: CommentUpdate, expectedRevision?: number, imagePath?: string): Comment {
    const current = this.getComment(id);
    if (!current) notFound("Kommentar");
    if (expectedRevision !== undefined && current.revision !== expectedRevision) conflict("Kommentar wurde inzwischen geändert");
    const fields: Record<string, [string, boolean]> = {
      revision: ["revision", false], text: ["text", false], markKind: ["mark_kind", false], context: ["context_json", true],
      screenshot: ["screenshot_json", true], state: ["state", false], stateDetail: ["state_detail", false],
      questions: ["questions_json", true], pendingDecision: ["pending_decision_json", true], mergeGroupId: ["merge_group_id", false],
      analysis: ["analysis_json", true], ticket: ["ticket_json", true],
    };
    const assignments: string[] = ["updated_at = ?"];
    const args: SQLInputValue[] = [patch.updatedAt ?? now()];
    for (const [key, value] of Object.entries(patch)) {
      const field = fields[key];
      if (!field) continue;
      assignments.push(`${field[0]} = ?`);
      args.push(field[1] ? json(value) : (value ?? null) as SQLInputValue);
    }
    if (imagePath !== undefined) { assignments.push("image_path = ?"); args.push(imagePath); }
    this.db.prepare(`UPDATE comments SET ${assignments.join(",")} WHERE id = ?`).run(...args, id);
    const updated = this.getComment(id)!;
    this.commentChanged(updated);
    return updated;
  }
  updateCommentState(id: string, state: CommentState, detail?: string): Comment {
    return this.updateComment(id, { state, stateDetail: detail });
  }
  setAnalysis(id: string, analysis?: CommentAnalysis): Comment { return this.updateComment(id, { analysis }); }
  setQuestions(id: string, questions: OpenQuestion[]): Comment { return this.updateComment(id, { questions }); }
  setPendingDecision(id: string, pendingDecision?: PendingDecision): Comment { return this.updateComment(id, { pendingDecision }); }
  setTicket(id: string, ticket?: TicketLink): Comment { return this.updateComment(id, { ticket }); }
  deleteComment(id: string): void {
    const comment = this.getComment(id);
    if (!comment) notFound("Kommentar");
    this.transaction(() => {
      // Remove proposals mentioning the deleted comment so a future decision cannot target it.
      for (const proposal of this.listMergeProposals(comment.reviewId)) {
        if (!proposal.commentIds.includes(id)) continue;
        this.db.prepare("DELETE FROM merge_proposals WHERE id = ?").run(proposal.id);
        for (const otherId of proposal.commentIds.filter((c) => c !== id)) {
          const other = this.getComment(otherId);
          if (other?.pendingDecision?.kind === "merge" && other.pendingDecision.proposalId === proposal.id) {
            this.updateComment(otherId, { pendingDecision: undefined, ...(other.state === "decision_open" ? { state: "draft" } : {}) });
          }
        }
      }
      this.db.prepare("DELETE FROM comments WHERE id = ?").run(id);
      this.afterCommit(() => {
        for (const file of readdirSync(this.imagesDir)) {
          if (file.startsWith(`${id}-r`) && /^.+-r\d+\.png$/.test(file)) rmSync(join(this.imagesDir, file), { force: true });
        }
      });
      this.commentChanged(comment);
    });
  }

  listMergeProposals(reviewId: string): MergeProposal[] {
    return this.db.prepare("SELECT * FROM merge_proposals WHERE review_id = ? ORDER BY id").all(reviewId).map((r) => ({
      id: String(r.id), reviewId: String(r.review_id), commentIds: parse<string[]>(r.comment_ids_json)!,
      reason: String(r.reason), status: r.status as MergeProposal["status"],
    }));
  }
  getMergeProposal(id: string): MergeProposal | undefined {
    const row = this.db.prepare("SELECT review_id FROM merge_proposals WHERE id = ?").get(id);
    return row ? this.listMergeProposals(String(row.review_id)).find((p) => p.id === id) : undefined;
  }
  insertMergeProposal(proposal: MergeProposal): MergeProposal {
    this.db.prepare("INSERT INTO merge_proposals VALUES (?, ?, ?, ?, ?)")
      .run(proposal.id, proposal.reviewId, json(proposal.commentIds), proposal.reason, proposal.status);
    this.emit({ type: "review.updated", reviewId: proposal.reviewId });
    return proposal;
  }
  updateMergeProposal(id: string, status: MergeProposal["status"]): MergeProposal {
    const proposal = this.getMergeProposal(id);
    if (!proposal) notFound("Zusammenfassungsvorschlag");
    this.db.prepare("UPDATE merge_proposals SET status = ? WHERE id = ?").run(status, id);
    this.emit({ type: "review.updated", reviewId: proposal.reviewId });
    return { ...proposal, status };
  }

  insertOp(input: NewOp): PublicationOp {
    const id = input.id ?? newId(); const time = now();
    const op: PublicationOp = { ...input, id, reference: input.reference ?? `wr-${id}`,
      state: input.state ?? "intended", createdAt: input.createdAt ?? time, updatedAt: input.updatedAt ?? time };
    this.db.prepare("INSERT INTO publication_ops VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(op.id, op.commentId, op.revision, op.kind, op.reference, op.state, op.cardPublicId ?? null,
        op.externalId ?? null, op.error ?? null, op.createdAt, op.updatedAt);
    this.commentChanged(this.getComment(op.commentId)!);
    return op;
  }
  getOp(id: string): PublicationOp | undefined {
    const row = this.db.prepare("SELECT * FROM publication_ops WHERE id = ?").get(id);
    return row ? readOp(row) : undefined;
  }
  markOp(id: string, state: PublicationOpState, patch: Partial<Pick<PublicationOp, "cardPublicId" | "externalId" | "error">> = {}): PublicationOp {
    const op = this.getOp(id);
    if (!op) notFound("Veröffentlichungsvorgang");
    const updated = { ...op, ...patch, state, updatedAt: now() };
    this.db.prepare("UPDATE publication_ops SET state = ?, card_public_id = ?, external_id = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(state, updated.cardPublicId ?? null, updated.externalId ?? null, updated.error ?? null, updated.updatedAt, id);
    this.commentChanged(this.getComment(op.commentId)!);
    return updated;
  }
  listOpsForComment(commentId: string, revision?: number): PublicationOp[] {
    return this.db.prepare(`SELECT * FROM publication_ops WHERE comment_id = ?${revision === undefined ? "" : " AND revision = ?"} ORDER BY created_at, id`)
      .all(...(revision === undefined ? [commentId] : [commentId, revision])).map(readOp);
  }
  getActiveOp(commentId: string, revision: number, kind: PublicationKind): PublicationOp | undefined {
    const row = this.db.prepare("SELECT * FROM publication_ops WHERE comment_id = ? AND revision = ? AND kind = ? AND state IN ('intended','sent','unclear')")
      .get(commentId, revision, kind);
    return row ? readOp(row) : undefined;
  }
}
