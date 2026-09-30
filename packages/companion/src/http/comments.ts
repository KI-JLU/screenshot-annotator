import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isEditable } from "@website-review/shared";
import type { Comment, CreateCommentRequest, UpdateCommentRequest } from "@website-review/shared";
import { newId } from "../ids.ts";
import { Store } from "../store/store.ts";
import { conflict, HttpError, notFound } from "./errors.ts";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function decodePng(base64: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new HttpError(400, "validation", "Ungültiges PNG-Bild");
  }
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new HttpError(400, "validation", "Ungültiges PNG-Bild");
  return bytes;
}

export class CommentsService {
  constructor(readonly store: Store) {}
  create(reviewId: string, input: CreateCommentRequest): Comment {
    if (!this.store.getReview(reviewId)) notFound("Review");
    const id = newId(); const time = new Date().toISOString();
    const comment: Comment = { id, reviewId, revision: 1, text: input.text, markKind: input.markKind,
      context: input.context, ...(input.screenshot ? { screenshot: input.screenshot } : {}),
      state: "draft", questions: [], createdAt: time, updatedAt: time };
    let path: string | undefined;
    try {
      return this.store.transaction(() => {
        if (input.clientRequestId) {
          const existing = this.store.findCommentByClientRequestId(reviewId, input.clientRequestId);
          if (existing) return existing;
        }
        path = input.imagePngBase64 ? this.store.imagePath(id, 1) : undefined;
        if (path) writeFileSync(path, decodePng(input.imagePngBase64!), { mode: 0o600, flag: "wx" });
        return this.store.insertComment(comment, path, input.clientRequestId);
      });
    } catch (error) { if (path) rmSync(path, { force: true }); throw error; }
  }
  update(id: string, input: UpdateCommentRequest): Comment {
    let newPath: string | undefined;
    try {
      return this.store.transaction(() => {
        const current = this.store.getComment(id);
        if (!current) notFound("Kommentar");
        if (!isEditable(current.state)) conflict("Kommentar kann in diesem Zustand nicht bearbeitet werden");
        if (current.revision !== input.baseRevision) conflict("Kommentar wurde inzwischen geändert");
        if (input.screenshot && !input.imagePngBase64) throw new HttpError(400, "validation", "PNG-Bild zum Screenshot fehlt");
        if (input.imagePngBase64 && !input.screenshot && !current.screenshot) {
          throw new HttpError(400, "validation", "Screenshot-Angaben fehlen");
        }
        const revision = current.revision + 1;
        const previousPath = this.store.getImagePath(id);
        if (input.imagePngBase64 || previousPath) {
          newPath = this.store.imagePath(id, revision);
          if (input.imagePngBase64) writeFileSync(newPath, decodePng(input.imagePngBase64), { mode: 0o600, flag: "wx" });
          else copyFileSync(previousPath!, newPath);
        }
        return this.store.updateComment(id, {
          revision, text: input.text ?? current.text,
          context: { ...current.context, ...input.context }, screenshot: input.screenshot ?? current.screenshot,
          state: "draft", stateDetail: undefined, questions: [], pendingDecision: undefined, analysis: undefined, mergeGroupId: undefined,
        }, input.baseRevision, newPath);
      });
    } catch (error) { if (newPath) rmSync(newPath, { force: true }); throw error; }
  }
  image(id: string): Buffer {
    if (!this.store.getComment(id)) notFound("Kommentar");
    const path = this.store.getImagePath(id);
    if (!path) notFound("Bild");
    try { return readFileSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") notFound("Bild"); throw error; }
  }
}
