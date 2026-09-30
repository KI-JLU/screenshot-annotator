import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ready, setup, type Fixture } from "./helpers.ts";
import { commentInput } from "../core/helpers.ts";
import { KanError } from "../../src/kan/types.ts";

let f: Fixture;
beforeEach(async () => { f = await setup(); });
afterEach(async () => { await f.close(); });
const state = (id: string) => f.app.store.getComment(id)!;
const post = (id: string, route: string, input?: unknown) => f.request(`/v1/comments/${id}/${route}`, input);

it("preserves individual question and duplicate outcomes when rejecting a merge after restart", async () => {
  const a = await f.create(); const b = await f.create(); f.kan.seed();
  f.analyze(async (input) => ({ ok: true, threadId: "thread", output: input.comments[0]!.commentId === a.id
    ? { ...ready(), outcome: "question", questions: ["Welcher Filter?"], mergeWith: [{ commentId: b.id, reason: "Gleich" }] }
    : { ...ready(), outcome: "duplicate", duplicates: [{ cardPublicId: "existing", reason: "Gleich" }] } }));
  await f.process(); await f.idle(); const proposal = f.app.store.listMergeProposals(f.review.id)[0]!;
  await f.restart();
  expect((await post(b.id, "decision", { kind: "merge", proposalId: proposal.id, action: "reject" })).status).toBe(200);
  await f.idle(); expect(state(a.id).state).toBe("question_open"); expect(state(b.id)).toMatchObject({ state: "decision_open", pendingDecision: { kind: "duplicate" } });
  expect(f.kan.createCard).not.toHaveBeenCalled(); expect(f.runner.analyze).toHaveBeenCalledTimes(2);
});

it("accepts a merge while another individual analysis is running without publishing its stale result", async () => {
  const a = await f.create(); const b = await f.create(); let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.analyze(async (input) => {
    if (input.comments.length === 1 && input.comments[0]!.commentId === b.id) await gate;
    return { ok: true, threadId: "thread", output: { ...ready(), mergeWith: input.comments.length === 1 && input.comments[0]!.commentId === a.id ? [{ commentId: b.id, reason: "Gleich" }] : [] } };
  });
  await f.process(); await vi.waitFor(() => expect(f.runner.analyze).toHaveBeenCalledTimes(2));
  const proposal = f.app.store.listMergeProposals(f.review.id)[0]!;
  try { expect((await post(b.id, "decision", { kind: "merge", proposalId: proposal.id, action: "accept" })).status).toBe(200); }
  finally { release(); }
  await f.idle(); expect(state(a.id).state).toBe("published"); expect(state(a.id).ticket).toEqual(state(b.id).ticket);
  expect(f.kan.createCard).toHaveBeenCalledTimes(1); expect(f.runner.analyze).toHaveBeenCalledTimes(3);
});

it("does not publish an old question analysis after a failed reanalysis", async () => {
  const c = await f.create(); let attempt = 0;
  f.analyze(async () => {
    attempt++;
    if (attempt === 2) return { ok: false, error: "Codex ist ausgefallen", retryable: true };
    return { ok: true, threadId: "thread", output: attempt === 1 ? { ...ready(), outcome: "question", questions: ["Welche Seite?"] } : ready() };
  });
  await f.process(); await f.idle();
  await post(c.id, "answer", { questionId: state(c.id).questions[0]!.id, answer: "Startseite" }); await f.idle();
  expect(state(c.id).state).toBe("failed"); expect(state(c.id).analysis).toBeUndefined();
  await post(c.id, "retry"); await f.idle(); expect(state(c.id).state).toBe("published");
  expect(f.runner.analyze).toHaveBeenCalledTimes(3); expect(f.kan.createCard).toHaveBeenCalledTimes(1);
});

it("invalidates a merge when a member is edited and permits fresh individual processing", async () => {
  const a = await f.create(); const b = await f.create();
  f.analyze(async (input) => ({ ok: true, threadId: "thread", output: { ...ready(), mergeWith: input.comments[0]!.commentId === a.id ? [{ commentId: b.id, reason: "Gleich" }] : [] } }));
  await f.process(); await f.idle();
  const proposal = f.app.store.listMergeProposals(f.review.id)[0]!;
  expect((await f.request(`/v1/comments/${b.id}`, { baseRevision: 1, text: "Anderer Wunsch" }, "PUT")).status).toBe(200);
  expect(f.app.store.getMergeProposal(proposal.id)?.status).toBe("rejected"); expect(state(a.id).state).toBe("draft");
  f.analyze(async () => ({ ok: true, threadId: "thread", output: ready() }));
  await f.process(); await f.idle(); expect(f.kan.createCard).toHaveBeenCalledTimes(2);
});

it("keeps a created card fixed while retrying a failed upload", async () => {
  const c = await f.create(commentInput(true)); f.kan.uploadFailure = new KanError("failed", "validation", 400, false);
  await f.process(); await f.idle();
  expect((await f.request(`/v1/comments/${c.id}`, { baseRevision: 1, text: "Neuer Wunsch" }, "PUT")).status).toBe(409);
  await f.restart(); await post(c.id, "retry"); await f.idle();
  expect(state(c.id).state).toBe("published"); expect(f.kan.createCard).toHaveBeenCalledTimes(1);
});

it("uses a corrected target only after a definite failure", async () => {
  const c = await f.create(); f.kan.createFailure = { error: new KanError("missing list", "not_found", 404, false), store: false };
  await f.process(); await f.idle(); expect(state(c.id).state).toBe("failed");
  const project = f.app.store.getProject("example")!;
  f.app.store.saveProject({ ...project, target: { ...project.target, listPublicId: "corrected-list" } });
  await post(c.id, "retry"); await f.idle();
  expect(state(c.id).state).toBe("published"); expect(f.kan.createCard.mock.calls[1]![0].listPublicId).toBe("corrected-list");
  expect(f.runner.analyze).toHaveBeenCalledTimes(1);
});

it("resumes only the missing upload when a card is known even without a saved analysis", async () => {
  const c = await f.create(commentInput(true)); f.kan.seed();
  f.app.store.updateComment(c.id, { state: "ticket_created", ticket: { cardPublicId: "existing", url: f.kan.cardUrl("existing"), title: "Ticket", mode: "created", attachmentUploaded: false } });
  await f.restart(); await f.idle();
  expect(state(c.id).state).toBe("published"); expect(f.kan.createCard).not.toHaveBeenCalled(); expect(f.runner.analyze).not.toHaveBeenCalled(); expect(f.kan.uploadAttachment).toHaveBeenCalledTimes(1);
});

it("reconciles a sent upload on restart even when no publication plan was persisted", async () => {
  const c = await f.create(commentInput(true)); f.kan.seed();
  f.app.store.updateComment(c.id, { state: "ticket_created", ticket: { cardPublicId: "existing", url: f.kan.cardUrl("existing"), title: "Ticket", mode: "created", attachmentUploaded: false } });
  f.app.store.insertOp({ commentId: c.id, revision: 1, kind: "upload_attachment", state: "sent", cardPublicId: "existing" });
  f.kan.cards.get("existing")!.attachments.push({ publicId: "already-uploaded", filename: `review-${c.id}-r1.png` });
  await f.restart(); await f.idle();
  expect(state(c.id).state).toBe("published"); expect(f.kan.uploadAttachment).not.toHaveBeenCalled(); expect(f.kan.createCard).not.toHaveBeenCalled();
});
