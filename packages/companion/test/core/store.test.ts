import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Comment, CompanionEvent } from "@website-review/shared";
import { Store } from "../../src/store/store.ts";
import { config, commentInput } from "./helpers.ts";
import { newId } from "../../src/ids.ts";

describe("SQLite persistence and transactions", () => {
  let dir: string; let store: Store; let comment: Comment;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "review-store-")); store = new Store(dir);
    store.saveProject(config()); const review = store.createReview("example");
    const time = new Date().toISOString(); const input = commentInput();
    comment = { id: newId(), reviewId: review.id, revision: 1, text: input.text, context: input.context, markKind: input.markKind,
      state: "draft", questions: [], createdAt: time, updatedAt: time };
    store.insertComment(comment);
  });
  afterEach(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  it("uses WAL, migration version 2 and reopens durable data", () => {
    expect(store.db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    store.setCodexThreadId(comment.reviewId, "thread");
    store.setQuestions(comment.id, [{ id: "q", text: "Welcher Bereich?", answer: "Filter" }]);
    store.close(); store = new Store(dir);
    expect(store.getReview(comment.reviewId)?.codexThreadId).toBe("thread");
    expect(store.getComment(comment.id)?.questions).toEqual([{ id: "q", text: "Welcher Bereich?", answer: "Filter" }]);
  });

  it("migrates a version 1 database without losing comments or operations", () => {
    const op = store.insertOp({ commentId: comment.id, revision: 1, kind: "create_card" });
    store.db.exec("DROP INDEX comments_client_request; ALTER TABLE comments DROP COLUMN client_request_id; PRAGMA user_version = 1;");
    store.close(); store = new Store(dir);
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    expect(store.getComment(comment.id)).toEqual(comment);
    expect(store.getOp(op.id)).toEqual(op);
  });

  it("enforces one active publication op per comment/revision/kind", () => {
    const input = { commentId: comment.id, revision: 1, kind: "create_card" as const };
    const first = store.insertOp(input);
    expect(store.getActiveOp(comment.id, 1, "create_card")).toEqual(first);
    expect(() => store.insertOp(input)).toThrow();
    store.markOp(first.id, "sent"); store.markOp(first.id, "unclear", { error: "Zeitüberschreitung" });
    expect(() => store.insertOp(input)).toThrow();
    store.markOp(first.id, "confirmed", { cardPublicId: "card", error: undefined });
    const second = store.insertOp(input);
    expect(store.getActiveOp(comment.id, 1, "create_card")?.id).toBe(second.id);
    expect(store.listOpsForComment(comment.id)).toHaveLength(2);
    expect(store.getOp(first.id)).toMatchObject({ state: "confirmed", cardPublicId: "card" });
  });

  it("emits only committed changes, including nested transaction rollback", () => {
    const events: CompanionEvent[] = []; store.events.subscribe((event) => events.push(event));
    expect(() => store.transaction(() => { store.updateCommentState(comment.id, "processing"); throw new Error("abort"); })).toThrow("abort");
    expect(store.getComment(comment.id)?.state).toBe("draft"); expect(events).toEqual([]);
    store.transaction(() => {
      store.updateCommentState(comment.id, "processing");
      expect(events).toEqual([]);
      try { store.transaction(() => { store.updateCommentState(comment.id, "failed"); throw new Error("nested"); }); } catch { /* expected */ }
      expect(store.getComment(comment.id)?.state).toBe("processing");
    });
    expect(events).toEqual([{ type: "comment.updated", reviewId: comment.reviewId, commentId: comment.id }, { type: "review.updated", reviewId: comment.reviewId }]);
  });

  it("allows the pair CLI and server to share the WAL database", () => {
    const second = new Store(dir);
    try {
      const code = second.createPairingCode();
      expect(store.pair(code, "chrome-extension://abc", "token")).toBe(true);
      expect(second.getPairing()?.extensionOrigin).toBe("chrome-extension://abc");
    } finally { second.close(); }
  });
});
