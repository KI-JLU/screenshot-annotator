import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMENT_STATES, isEditable, type Comment, type ReviewDetail, type CommentAnalysis } from "@website-review/shared";
import { commentInput, config, fixture, PNG, type Fixture } from "./helpers.ts";

describe("comments, revisions and local deletion", () => {
  let f: Fixture;
  let reviewId: string;
  beforeEach(async () => {
    f = await fixture(); await f.call("POST", "/v1/projects", config());
    reviewId = (await (await f.call("POST", "/v1/reviews", { projectId: "example" })).json() as ReviewDetail).id;
  });
  afterEach(async () => { await f.close(); });
  async function create(withImage = false): Promise<Comment> {
    const response = await f.call("POST", `/v1/reviews/${reviewId}/comments`, commentInput(withImage));
    expect(response.status).toBe(200);
    return await response.json() as Comment;
  }

  it("persists draft context and returns a base64 PNG", async () => {
    const comment = await create(true);
    expect(comment).toMatchObject({ revision: 1, state: "draft", questions: [], context: commentInput().context });
    expect(comment).not.toHaveProperty("imagePath");
    const image = await f.call("GET", `/v1/comments/${comment.id}/image`);
    expect(Buffer.from((await image.json() as { pngBase64: string }).pngBase64, "base64")).toEqual(PNG);
    expect(f.app.store.getImagePath(comment.id)).toBe(f.app.store.imagePath(comment.id, 1));
    const counts = await (await f.call("GET", "/v1/reviews?projectId=example")).json() as { counts: Record<string, number> }[];
    expect(counts[0]?.counts).toEqual({ draft: 1 });
  });

  it("creates a new revision, resets analysis/decisions and rejects stale edits", async () => {
    const comment = await create(true);
    const analysis: CommentAnalysis = { revision: 1, ticket: { title: "Ticket", desiredChange: "Mehr Luft", openPoints: [], implementationIdeas: [] }, findings: [], checkouts: [], analyzedAt: new Date().toISOString() };
    f.app.store.updateComment(comment.id, { state: "decision_open", analysis, pendingDecision: { kind: "duplicate", candidates: [] } });
    const edited = await f.call("PUT", `/v1/comments/${comment.id}`, { baseRevision: 1, text: "Mehr Abstand", context: { extraContext: "Neuer Kontext" } });
    expect(edited.status).toBe(200);
    const next = await edited.json() as Comment;
    expect(next).toMatchObject({ revision: 2, state: "draft", text: "Mehr Abstand", context: { extraContext: "Neuer Kontext" } });
    expect(next.analysis).toBeUndefined(); expect(next.pendingDecision).toBeUndefined();
    expect(await readFile(f.app.store.imagePath(comment.id, 2))).toEqual(PNG);
    const stale = await f.call("PUT", `/v1/comments/${comment.id}`, { baseRevision: 1, text: "Veraltet" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "conflict" } });
    expect(f.app.store.getComment(comment.id)?.text).toBe("Mehr Abstand");
    expect(await readdir(f.app.store.imagesDir)).toHaveLength(2);
  });

  it.each(COMMENT_STATES)("permits editing exactly according to shared isEditable: %s", async (state) => {
    const comment = await create();
    f.app.store.updateCommentState(comment.id, state);
    const edited = await f.call("PUT", `/v1/comments/${comment.id}`, { baseRevision: 1, text: "Änderung" });
    expect(edited.status).toBe(isEditable(state) ? 200 : 409);
    expect(f.app.store.getComment(comment.id)?.revision).toBe(isEditable(state) ? 2 : 1);
  });

  it("rejects invalid PNGs and incomplete screenshot requests without saving images", async () => {
    const valid = commentInput(true);
    for (const invalid of [
      { ...valid, imagePngBase64: Buffer.from("not png").toString("base64") },
      { ...valid, imagePngBase64: "invalid!!!" }, { ...valid, imagePngBase64: undefined },
      { ...valid, screenshot: undefined },
    ]) {
      const response = await f.call("POST", `/v1/reviews/${reviewId}/comments`, invalid);
      expect(response.status).toBe(400);
    }
    expect(await readdir(f.app.store.imagesDir)).toEqual([]);
    expect(f.app.store.listComments(reviewId)).toEqual([]);
  });

  it("returns the existing comment when a capture POST is retried", async () => {
    const input = { ...commentInput(true), clientRequestId: randomUUID() };
    const first = await (await f.call("POST", `/v1/reviews/${reviewId}/comments`, input)).json() as Comment;
    const second = await (await f.call("POST", `/v1/reviews/${reviewId}/comments`, input)).json() as Comment;
    expect(second).toEqual(first);
    expect(f.app.store.listComments(reviewId)).toHaveLength(1);
    expect(await readdir(f.app.store.imagesDir)).toHaveLength(1);
  });

  it("deletes every image revision and operation when deleting a review", async () => {
    const first = await create(true); const second = await create(true);
    await f.call("PUT", `/v1/comments/${first.id}`, { baseRevision: 1, text: "Neu" });
    const op = f.app.store.insertOp({ commentId: first.id, revision: 2, kind: "create_card" });
    f.app.store.updateCommentState(second.id, "published");
    expect(await readdir(f.app.store.imagesDir)).toHaveLength(3);
    expect((await f.call("DELETE", `/v1/reviews/${reviewId}`)).status).toBe(204);
    expect(await readdir(f.app.store.imagesDir)).toEqual([]);
    expect(f.app.store.getReview(reviewId)).toBeUndefined();
    expect(f.app.store.getComment(first.id)).toBeUndefined();
    expect(f.app.store.getOp(op.id)).toBeUndefined();
    expect(f.kan.createCard).not.toHaveBeenCalled();
    expect((await f.call("GET", `/v1/comments/${first.id}/image`)).status).toBe(404);
  });

  it("deletes published comments locally and cascades project deletion", async () => {
    const comment = await create(true);
    f.app.store.updateCommentState(comment.id, "published");
    expect((await f.call("DELETE", `/v1/comments/${comment.id}`)).status).toBe(204);
    expect(f.app.store.getReview(reviewId)).toBeDefined();
    await create(true);
    expect((await f.call("DELETE", "/v1/projects/example")).status).toBe(204);
    expect(await readdir(f.app.store.imagesDir)).toEqual([]);
    expect(f.app.store.getReview(reviewId)).toBeUndefined();
  });
});
