import { readFileSync } from "node:fs";
import type { Comment, CommentAnalysis, KanTarget, PublicationKind, PublicationOp, ReconcileRequest, TicketLink } from "@website-review/shared";
import { conflict, notFound } from "../http/errors.ts";
import { KanError, type KanClient } from "../kan/types.ts";
import type { ProjectsService } from "../projects/projects.ts";
import type { CommentUpdate, Store } from "../store/store.ts";
import { renderAppendComment, renderCardDescription, renderCardTitle } from "../ticket/render.ts";
import { attachmentFilename, findWrite } from "./reconcile.ts";

interface Upload { filename: string; imagePath: string; opId?: string }
export interface PublicationPlan {
  revision: number;
  target: KanTarget;
  comments: Comment[];
  analysis?: CommentAnalysis;
  mode: TicketLink["mode"];
  cardPublicId?: string;
  title: string;
  uploads: Upload[];
}
export function publicationProblem(error: unknown): string {
  if (error instanceof KanError) {
    if (error.kind === "auth") return "Kan-Zugang ungültig – Verbindung prüfen";
    if (error.kind === "not_found") return "Zielboard oder Zielspalte fehlt – Ziel korrigieren";
    if (error.kind === "rate_limited") return "Kan-Anfragelimit erreicht – später erneut versuchen";
  }
  return "Veröffentlichung bei Kan fehlgeschlagen – erneut versuchen";
}

export class Publisher {
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly store: Store, private readonly projects: ProjectsService) {}

  plan(id: string): PublicationPlan | undefined { return this.store.getProcessingRecord(id, "publication"); }
  prepare(comments: Comment[], target: KanTarget, mode: TicketLink["mode"] = "created", cardPublicId?: string, title?: string): void {
    const primary = comments[0]!;
    if (!primary.ticket && comments.some((c) => c.analysis?.revision !== c.revision)) conflict("Aktuelle Codeanalyse fehlt");
    const existing = this.plan(primary.id);
    if (existing?.revision === primary.revision) {
      // A corrected target applies to a new attempt only after definite failures.
      // Uncertain and confirmed writes must retain their original destination.
      if (existing.mode === "created" && !primary.ticket &&
          this.store.listOpsForComment(primary.id, primary.revision).every((op) => op.state === "failed")) {
        this.save(primary.id, { ...existing, target });
      }
      return;
    }
    this.save(primary.id, { revision: primary.revision, target, comments, analysis: primary.analysis,
      mode: primary.ticket?.mode ?? mode, cardPublicId: primary.ticket?.cardPublicId ?? cardPublicId,
      title: title ?? primary.ticket?.title ?? renderCardTitle(primary.analysis!.ticket), uploads: comments.flatMap((c) => {
        const imagePath = this.store.getImagePath(c.id) ?? this.store.imagePath(c.id, c.revision);
        const previous = comments.length === 1 ? this.store.listOpsForComment(c.id, c.revision).filter((op) => op.kind === "upload_attachment").at(-1) : undefined;
        return c.screenshot ? [{ filename: attachmentFilename(c.id, c.revision), imagePath, opId: previous?.id }] : [];
      }) });
  }
  private save(id: string, plan: PublicationPlan): void { this.store.setProcessingRecord(id, "publication", plan); }
  private mirror(id: string, patch: CommentUpdate): void {
    const plan = this.plan(id);
    this.store.transaction(() => {
      for (const member of plan?.comments ?? [this.store.getComment(id)!]) {
        const current = this.store.getComment(member.id);
        if (current?.revision === member.revision) this.store.updateComment(member.id, patch);
      }
    });
  }
  private current(id: string, plan: PublicationPlan): boolean {
    return plan.comments.every((c) => this.store.getComment(c.id)?.revision === c.revision) && !!this.store.getComment(id);
  }
  private locked(id: string, action: () => Promise<void>): Promise<void> {
    const pending = this.running.get(id);
    if (pending) return pending;
    const work = Promise.resolve().then(action).finally(() => { this.running.delete(id); });
    this.running.set(id, work);
    return work;
  }
  publish(id: string): Promise<void> { return this.locked(id, () => this.run(id)); }

  private ticket(id: string, plan: PublicationPlan, cardId: string, uploaded = false): void {
    this.mirror(id, { state: uploaded ? "published" : "ticket_created", stateDetail: undefined, pendingDecision: undefined,
      ticket: { cardPublicId: cardId, url: `${plan.target.baseUrl.replace(/\/+$/, "")}/cards/${encodeURIComponent(cardId)}`,
        title: plan.title, mode: plan.mode, attachmentUploaded: uploaded && plan.uploads.length > 0 } });
  }
  private intend(id: string, plan: PublicationPlan, kind: PublicationKind, cardPublicId?: string, upload?: Upload): PublicationOp {
    return this.store.transaction(() => {
      if (!this.current(id, plan)) conflict("Kommentar wurde inzwischen geändert");
      const active = this.store.getActiveOp(id, plan.revision, kind);
      if (active) return active;
      const op = this.store.insertOp({ commentId: id, revision: plan.revision, kind, cardPublicId });
      if (upload) { upload.opId = op.id; this.save(id, plan); }
      return op;
    });
  }
  private async check(id: string, plan: PublicationPlan, client: KanClient, op: PublicationOp): Promise<boolean> {
    try {
      const found = await findWrite(client, plan.target.boardPublicId, op, plan.uploads.find((u) => u.opId === op.id)?.filename
        ?? attachmentFilename(id, op.revision));
      if (found && this.store.getOp(op.id)) {
        this.store.markOp(op.id, "confirmed", { ...found, error: undefined });
        return true;
      }
    } catch { /* Keep the uncertain operation, including on read/auth failure. */ }
    if (this.store.getOp(op.id)) {
      this.store.markOp(op.id, "unclear", { error: "Ergebnis nicht nachweisbar – erneut abgleichen oder Vorhandensein bestätigen" });
      this.mirror(id, { state: "outcome_unclear", stateDetail: "Ergebnis nicht nachweisbar – erneut abgleichen oder Vorhandensein bestätigen" });
    }
    return false;
  }
  private async write(id: string, plan: PublicationPlan, client: KanClient, op: PublicationOp, call: () => Promise<{ cardPublicId?: string; externalId?: string }>): Promise<boolean> {
    if (op.state === "confirmed") return true;
    if (op.state === "unclear") { this.mirror(id, { state: "outcome_unclear", stateDetail: op.error }); return false; }
    if (op.state === "sent") {
      this.store.markOp(op.id, "unclear");
      this.mirror(id, { state: "outcome_unclear", stateDetail: "Veröffentlichung wurde unterbrochen – Ergebnis wird abgeglichen" });
      return this.check(id, plan, client, op);
    }
    const claimed = this.store.transaction(() => {
      if (!this.current(id, plan) || this.store.getOp(op.id)?.state !== "intended") return false;
      this.store.markOp(op.id, "sent");
      return true;
    });
    if (!claimed) return false;
    try {
      const result = await call();
      if (!this.store.getOp(op.id)) return false;
      this.store.markOp(op.id, "confirmed", { ...result, error: undefined });
      return true;
    } catch (error) {
      if (!this.store.getOp(op.id)) return false;
      // An unexpected exception after calling the transport is also uncertain.
      const unclear = !(error instanceof KanError) || (error.requestSent && ["timeout", "network", "server"].includes(error.kind));
      const detail = unclear ? "Ergebnis der Kan-Anfrage unklar – Abgleich erforderlich" : publicationProblem(error);
      this.store.markOp(op.id, unclear ? "unclear" : "failed", { error: detail });
      this.mirror(id, { state: unclear ? "outcome_unclear" : "failed", stateDetail: detail });
      return unclear ? this.check(id, plan, client, this.store.getOp(op.id)!) : false;
    }
  }
  private async run(id: string): Promise<void> {
    const plan = this.plan(id);
    if (!plan || !this.current(id, plan)) return;
    let client: KanClient;
    try { client = this.projects.client(plan.target.baseUrl); }
    catch { this.mirror(id, { state: "failed", stateDetail: "Kan-Zugang ungültig – Verbindung prüfen" }); return; }
    const kind = plan.mode === "created" ? "create_card" : "add_comment";
    const ops = this.store.listOpsForComment(id, plan.revision);
    let op = ops.find((o) => o.kind === kind && o.state === "confirmed")
      ?? this.store.getActiveOp(id, plan.revision, kind);
    // Legacy recovery can have a known ticket without a local confirmed operation.
    let cardId = this.store.getComment(id)?.ticket?.cardPublicId;
    if (!cardId || op && op.state !== "confirmed") {
      if (!plan.analysis) { this.mirror(id, { state: "failed", stateDetail: "Aktuelle Codeanalyse fehlt" }); return; }
      op ??= this.intend(id, plan, kind, plan.cardPublicId);
      if (op.state === "unclear") { this.mirror(id, { state: "outcome_unclear", stateDetail: op.error }); return; }
      const input = { comments: plan.comments, analysis: plan.analysis, reference: op.reference };
      let body: string;
      try { body = kind === "create_card" ? renderCardDescription(input) : renderAppendComment(input); }
      catch { this.store.markOp(op.id, "failed", { error: "Ticketinhalt kann nicht dargestellt werden" }); this.mirror(id, { state: "failed", stateDetail: "Ticketinhalt kann nicht dargestellt werden" }); return; }
      this.mirror(id, { state: "publishing", stateDetail: undefined });
      if (!await this.write(id, plan, client, op, async () => {
        if (kind === "create_card") return { cardPublicId: (await client.createCard({ title: plan.title, description: body, listPublicId: plan.target.listPublicId })).publicId };
        return { cardPublicId: plan.cardPublicId!, externalId: (await client.addComment(plan.cardPublicId!, body)).publicId };
      })) return;
      cardId = this.store.getOp(op.id)?.cardPublicId;
    }
    cardId ??= op?.cardPublicId;
    if (!cardId || !this.current(id, plan)) return;
    this.ticket(id, plan, cardId);
    for (const upload of plan.uploads) {
      let uploadOp = upload.opId ? this.store.getOp(upload.opId) : undefined;
      if (uploadOp?.state === "confirmed") continue;
      let bytes: Buffer;
      try { bytes = readFileSync(upload.imagePath); }
      catch { this.mirror(id, { state: "failed", stateDetail: "Screenshot fehlt oder ist nicht lesbar" }); return; }
      if (!uploadOp || uploadOp.state === "failed") uploadOp = this.intend(id, plan, "upload_attachment", cardId, upload);
      if (!await this.write(id, plan, client, uploadOp, async () => ({ cardPublicId: cardId,
        externalId: (await client.uploadAttachment(cardId!, { filename: upload.filename, contentType: "image/png", bytes })).publicId }))) return;
    }
    this.ticket(id, plan, cardId, true);
  }

  reconcile(id: string, request: ReconcileRequest): Promise<void> {
    return this.locked(id, async () => {
      const plan = this.plan(id);
      if (!plan) notFound("Veröffentlichungsplan");
      const op = this.store.listOpsForComment(id, plan.revision).find((o) => o.state === "unclear" || o.state === "sent");
      if (!op) conflict("Kein unklarer Veröffentlichungsvorgang vorhanden");
      const client = this.projects.client(plan.target.baseUrl);
      if (request.action === "confirm_absent") {
        this.store.markOp(op.id, "failed", { error: "vom Nutzer als nicht vorhanden bestätigt" });
      } else if (request.action === "confirm_exists") {
        const card = await client.getCard(request.cardPublicId);
        if (op.kind !== "create_card" && card.publicId !== op.cardPublicId) conflict("Die Karte gehört nicht zu diesem Vorgang");
        if (op.kind === "upload_attachment") {
          if (!await this.check(id, plan, client, op)) return;
        } else {
          plan.title = card.title; this.save(id, plan);
          this.store.markOp(op.id, "confirmed", { cardPublicId: card.publicId, error: undefined });
        }
      } else if (!await this.check(id, plan, client, op)) return;
      await this.run(id);
    });
  }
}
