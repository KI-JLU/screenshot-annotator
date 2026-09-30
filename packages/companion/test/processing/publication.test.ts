import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommentAnalysis } from "@website-review/shared";
import { KanError } from "../../src/kan/types.ts";
import { commentInput, config } from "../core/helpers.ts";
import { ready, setup, type Fixture } from "./helpers.ts";

let f: Fixture;
beforeEach(async () => { f = await setup(); });
afterEach(async () => { await f.close(); });
const state = (id: string) => f.app.store.getComment(id)!;
const post = (id: string, route: string, input?: unknown) => f.request(`/v1/comments/${id}/${route}`, input);
async function run() { expect((await f.process()).status).toBe(200); await f.idle(); }
const timeout = () => new KanError("Zeitüberschreitung", "timeout", undefined, true);
const analysis = (): CommentAnalysis => ({ revision: 1, ticket: ready().ticket, findings: [], checkouts: [{ alias: "frontend", headCommit: "abc1234", hasUncommittedChanges: false }], analyzedAt: new Date().toISOString() });

describe("publication and reconciliation", () => {
  it("records intended before sent and confirms both writes with a reference and deterministic filename", async () => {
    const c = await f.create(commentInput(true));
    const transitions: string[] = [];
    f.app.events.subscribe((event) => {
      if (event.type === "comment.updated") {
        for (const op of f.app.store.listOpsForComment(c.id)) transitions.push(`${op.kind}:${op.state}`);
      }
    });
    const create = f.kan.createCard.getMockImplementation()!;
    f.kan.createCard.mockImplementation(async (input) => {
      const op = f.app.store.listOpsForComment(c.id)[0]!;
      expect(op.state).toBe("sent"); expect(input.description.endsWith(`Review-Referenz: ${op.reference}`)).toBe(true);
      return create(input);
    });
    await run();
    const ops = f.app.store.listOpsForComment(c.id);
    expect(ops.map((o) => [o.kind, o.state])).toEqual([["create_card", "confirmed"], ["upload_attachment", "confirmed"]]);
    for (const kind of ["create_card", "upload_attachment"]) {
      expect(transitions.indexOf(`${kind}:intended`)).toBeLessThan(transitions.indexOf(`${kind}:sent`));
      expect(transitions.indexOf(`${kind}:sent`)).toBeLessThan(transitions.indexOf(`${kind}:confirmed`));
    }
    expect(f.kan.uploadAttachment.mock.calls[0]![1].filename).toBe(`review-${c.id}-r1.png`);
  });
  it("automatically finds a card whose create response timed out, without a second create", async () => {
    const c = await f.create(commentInput(true)); const states: string[] = [];
    f.app.events.subscribe((e) => { if (e.type === "comment.updated") states.push(state(c.id).state); });
    f.kan.createFailure = { error: timeout(), store: true };
    await run();
    expect(states).toContain("outcome_unclear"); expect(state(c.id).state).toBe("published");
    expect(f.kan.createCard).toHaveBeenCalledTimes(1); expect(f.kan.cards.size).toBe(1);
    expect(f.app.store.listOpsForComment(c.id)[0]).toMatchObject({ state: "confirmed", cardPublicId: "card-1" });
  });
  it("keeps absent results unclear until explicit confirmation permits exactly one new create", async () => {
    const c = await f.create(); f.kan.createFailure = { error: timeout(), store: false };
    await run(); expect(state(c.id).state).toBe("outcome_unclear");
    expect((await post(c.id, "retry")).status).toBe(409);
    await f.process(); await f.idle(); expect(f.kan.createCard).toHaveBeenCalledTimes(1);
    await post(c.id, "reconcile", { action: "recheck" }); expect(state(c.id).state).toBe("outcome_unclear");
    await f.restart(); await f.idle(); expect(f.kan.createCard).toHaveBeenCalledTimes(1);
    await Promise.all([post(c.id, "reconcile", { action: "confirm_absent" }), post(c.id, "reconcile", { action: "confirm_absent" })]);
    expect(state(c.id).state).toBe("published"); expect(f.kan.createCard).toHaveBeenCalledTimes(2);
    expect(f.app.store.listOpsForComment(c.id)[0]).toMatchObject({ state: "failed", error: "vom Nutzer als nicht vorhanden bestätigt" });
    expect((await post(c.id, "reconcile", { action: "confirm_absent" })).status).toBe(409);
  });
  it("verifies a user-supplied card before linking it and uploading", async () => {
    const c = await f.create(commentInput(true)); f.kan.createFailure = { error: timeout(), store: false };
    await run();
    expect((await post(c.id, "reconcile", { action: "confirm_exists", cardPublicId: "missing" })).status).not.toBe(200);
    expect(state(c.id).state).toBe("outcome_unclear");
    f.kan.seed("found");
    expect((await post(c.id, "reconcile", { action: "confirm_exists", cardPublicId: "found" })).status).toBe(200);
    expect(state(c.id)).toMatchObject({ state: "published", ticket: { cardPublicId: "found", title: "Titel von Kan", attachmentUploaded: true } });
    expect(f.kan.createCard).toHaveBeenCalledTimes(1); expect(f.kan.uploadAttachment).toHaveBeenCalledTimes(1);
  });
  it("retries only a failed upload, retaining the card link and analysis", async () => {
    const c = await f.create(commentInput(true)); f.kan.uploadFailure = new KanError("Ungültig", "validation", 400, false);
    await run(); expect(state(c.id)).toMatchObject({ state: "failed", ticket: { cardPublicId: "card-1", attachmentUploaded: false } });
    expect((await post(c.id, "retry")).status).toBe(200); await f.idle();
    expect(state(c.id)).toMatchObject({ state: "published", ticket: { cardPublicId: "card-1", attachmentUploaded: true } });
    expect(f.kan.createCard).toHaveBeenCalledTimes(1); expect(f.runner.analyze).toHaveBeenCalledTimes(1); expect(f.kan.uploadAttachment).toHaveBeenCalledTimes(2);
  });
  it("reconciles lost append and attachment responses", async () => {
    const c = await f.create(commentInput(true)); f.kan.seed();
    f.analyze(async () => ({ ok: true, threadId: "thread", output: { ...ready(), outcome: "duplicate", duplicates: [{ cardPublicId: "existing", reason: "Doppelt" }] } }));
    f.kan.commentFailure = { error: timeout(), store: true };
    const upload = f.kan.uploadAttachment.getMockImplementation()!;
    f.kan.uploadAttachment.mockImplementationOnce(async (id, input) => { await upload(id, input); throw timeout(); });
    await run(); await post(c.id, "decision", { kind: "duplicate", action: "append", cardPublicId: "existing" }); await f.idle();
    expect(state(c.id)).toMatchObject({ state: "published", ticket: { mode: "appended", attachmentUploaded: true } });
    expect(f.kan.addComment).toHaveBeenCalledTimes(1); expect(f.kan.uploadAttachment).toHaveBeenCalledTimes(1); expect(f.kan.createCard).not.toHaveBeenCalled();
  });
  it.each(["auth", "not_found", "network"] as const)("classifies definite %s failures and retries without another analysis", async (kind) => {
    const c = await f.create(); f.kan.createFailure = { error: new KanError("private-token", kind, kind === "auth" ? 401 : 404, false), store: false };
    await run(); expect(state(c.id).state).toBe("failed"); expect(state(c.id).stateDetail).not.toContain("private-token");
    if (kind === "auth") expect(state(c.id).stateDetail).toBe("Kan-Zugang ungültig – Verbindung prüfen");
    if (kind === "not_found") expect(state(c.id).stateDetail).toBe("Zielboard oder Zielspalte fehlt – Ziel korrigieren");
    await post(c.id, "retry"); await f.idle(); expect(state(c.id).state).toBe("published"); expect(f.runner.analyze).toHaveBeenCalledTimes(1);
  });
  it("reconciles a sent operation on restart using the persisted target", async () => {
    const c = await f.create(commentInput(true));
    f.app.store.updateComment(c.id, { state: "publishing", analysis: analysis() });
    f.processing().publisher.prepare([state(c.id)], config().target);
    const op = f.app.store.insertOp({ commentId: c.id, revision: 1, kind: "create_card", state: "sent" });
    f.kan.seed("already-created"); f.kan.cards.get("already-created")!.description = `Review-Referenz: ${op.reference}`;
    await f.restart(); await f.idle();
    expect(state(c.id)).toMatchObject({ state: "published", ticket: { cardPublicId: "already-created", attachmentUploaded: true } });
    expect(f.kan.createCard).not.toHaveBeenCalled(); expect(f.runner.analyze).not.toHaveBeenCalled();
  });
  it("resumes a confirmed create and ticket_created upload after restart", async () => {
    const c = await f.create(commentInput(true)); f.kan.seed();
    f.app.store.updateComment(c.id, { state: "ticket_created", analysis: analysis(), ticket: { cardPublicId: "existing", url: f.kan.cardUrl("existing"), title: "Ticket", mode: "created", attachmentUploaded: false } });
    f.app.store.insertOp({ commentId: c.id, revision: 1, kind: "create_card", state: "confirmed", cardPublicId: "existing" });
    await f.restart(); await f.idle(); expect(state(c.id).state).toBe("published");
    expect(f.kan.createCard).not.toHaveBeenCalled(); expect(f.kan.uploadAttachment).toHaveBeenCalledTimes(1);
  });
  it("re-enqueues analysis interrupted by restart", async () => {
    const c = await f.create(); f.app.store.updateCommentState(c.id, "processing");
    await f.restart(); await f.idle(); expect(state(c.id).state).toBe("published"); expect(f.runner.analyze).toHaveBeenCalledTimes(1);
  });
  it("guards simultaneous process requests against duplicate writes", async () => {
    const c = await f.create(); await Promise.all([f.process(), f.process(), f.process()]); await f.idle();
    expect(state(c.id).state).toBe("published"); expect(f.kan.createCard).toHaveBeenCalledTimes(1);
  });
});
