import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KanError } from "../../src/kan/types.ts";
import { commentInput, config } from "../core/helpers.ts";
import { ready, setup, type Fixture } from "./helpers.ts";

let f: Fixture;
beforeEach(async () => { f = await setup(); });
afterEach(async () => { await f.close(); });
const state = (id: string) => f.app.store.getComment(id)!;
const post = (id: string, route: string, input?: unknown) => f.request(`/v1/comments/${id}/${route}`, input);
const remove = (id: string) => f.request(`/v1/comments/${id}`, undefined, "DELETE");
const timeout = () => new KanError("timeout", "timeout", undefined, true);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function propose() {
  const a = await f.create(); const b = await f.create();
  f.analyze(async (input) => ({ ok: true, threadId: "thread", output: {
    ...ready(), mergeWith: input.comments.length === 1 && input.comments[0]!.commentId === a.id ? [{ commentId: b.id, reason: "Gleich" }] : [],
  } }));
  await f.process(); await f.idle();
  const proposal = f.app.store.listMergeProposals(f.review.id)[0]!;
  return { a, b, proposal };
}
async function accept(a: { id: string }, proposal: { id: string }) {
  expect((await post(a.id, "decision", { kind: "merge", proposalId: proposal.id, action: "accept" })).status).toBe(200);
}

it("protects the primary and its operation after Kan creates a merged card but before the response is persisted", async () => {
  const { a, b, proposal } = await propose(); const response = gate(); const created = gate();
  const create = f.kan.createCard.getMockImplementation()!;
  f.kan.createCard.mockImplementationOnce(async (input) => {
    await create(input); created.release(); await response.promise; throw timeout();
  });
  await accept(a, proposal); await created.promise;
  try {
    expect((await remove(a.id)).status).toBe(409);
    expect(f.app.store.getMergeProposal(proposal.id)?.status).toBe("accepted");
    expect(f.app.store.listOpsForComment(a.id)[0]?.state).toBe("sent");
  } finally { response.release(); }
  await f.idle(); await f.restart(); await f.idle();
  expect(state(a.id).state).toBe("published"); expect(state(b.id).ticket).toEqual(state(a.id).ticket);
  expect(f.kan.createCard).toHaveBeenCalledTimes(1);
});

it("protects a failed merge member so the primary can retry after a 401", async () => {
  const { a, b, proposal } = await propose();
  f.kan.createFailure = { error: new KanError("auth", "auth", 401, false), store: false };
  await accept(a, proposal); await f.idle();
  expect(state(a.id).state).toBe("failed");
  expect((await remove(b.id)).status).toBe(409);
  expect((await post(a.id, "retry")).status).toBe(200); await f.idle();
  expect(state(a.id).state).toBe("published"); expect(state(b.id).ticket).toEqual(state(a.id).ticket);
  expect(f.kan.createCard).toHaveBeenCalledTimes(2);
});

it.each(["processing", "publishing", "ticket_created", "outcome_unclear"] as const)("refuses single deletion in %s but allows whole-review deletion", async (status) => {
  const c = await f.create(commentInput(true)); f.app.store.updateCommentState(c.id, status);
  expect((await remove(c.id)).status).toBe(409);
  expect((await f.request(`/v1/reviews/${f.review.id}`, undefined, "DELETE")).status).toBe(204);
  expect(f.app.store.getComment(c.id)).toBeUndefined();
});

it("rejects an open proposal before deleting a member and leaves the survivor processable", async () => {
  const { a, b, proposal } = await propose();
  expect((await remove(b.id)).status).toBe(204);
  expect(f.app.store.getMergeProposal(proposal.id)?.status).toBe("rejected");
  expect(state(a.id)).toMatchObject({ state: "draft" });
  expect(state(a.id).pendingDecision).toBeUndefined();
  f.analyze(async () => ({ ok: true, threadId: "thread", output: ready() }));
  await f.process(); await f.idle(); expect(state(a.id).state).toBe("published");
});

it("allows deleting a fully published merge member and restarting with the survivor", async () => {
  const { a, b, proposal } = await propose(); await accept(a, proposal); await f.idle();
  expect((await remove(a.id)).status).toBe(204);
  await f.restart(); await f.idle(); expect(state(b.id).state).toBe("published");
  expect(f.kan.createCard).toHaveBeenCalledTimes(1);
});

it("abandons combined reanalysis if editing a member invalidates approval during answer preflight", async () => {
  const { a, b, proposal } = await propose();
  f.analyze(async () => ({ ok: true, threadId: "thread", output: { ...ready(), outcome: "question", questions: ["Welcher Bereich?"] } }));
  await accept(a, proposal); await f.idle();
  const preflight = gate(); const entered = gate();
  vi.mocked(f.runner.probe).mockImplementationOnce(async () => { entered.release(); await preflight.promise; return { available: true }; });
  f.analyze(async () => ({ ok: true, threadId: "thread", output: ready() }));
  const calls = vi.mocked(f.runner.analyze).mock.calls.length;
  const answer = post(a.id, "answer", { questionId: state(a.id).questions[0]!.id, answer: "Filter" });
  await entered.promise;
  try {
    expect((await f.request(`/v1/comments/${b.id}`, { baseRevision: 1, text: "Anderer Wunsch" }, "PUT")).status).toBe(200);
  } finally { preflight.release(); }
  await answer; await f.idle();
  expect(f.app.store.getMergeProposal(proposal.id)?.status).toBe("rejected");
  expect(state(a.id).state).toBe("draft"); expect(state(b.id)).toMatchObject({ state: "draft", revision: 2 });
  expect(f.runner.analyze).toHaveBeenCalledTimes(calls); expect(f.kan.createCard).not.toHaveBeenCalled();
});

it("requires the appended reference when the user confirms an existing card", async () => {
  const c = await f.create(); f.kan.seed();
  f.analyze(async () => ({ ok: true, threadId: "thread", output: { ...ready(), outcome: "duplicate", duplicates: [{ cardPublicId: "existing", reason: "Gleich" }] } }));
  await f.process(); await f.idle(); f.kan.commentFailure = { error: timeout(), store: false };
  await post(c.id, "decision", { kind: "duplicate", action: "append", cardPublicId: "existing" }); await f.idle();
  const response = await post(c.id, "reconcile", { action: "confirm_exists", cardPublicId: "existing" });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { message: "Der Kommentar mit der Review-Referenz wurde auf der Karte nicht gefunden" } });
  expect(state(c.id).state).toBe("outcome_unclear");
  const op = f.app.store.listOpsForComment(c.id)[0]!; expect(op.state).toBe("unclear");
  f.kan.cards.get("existing")!.comments.push({ publicId: "found", comment: `Feedback\nReview-Referenz: ${op.reference}` });
  expect((await post(c.id, "reconcile", { action: "confirm_exists", cardPublicId: "existing" })).status).toBe(200);
  expect(state(c.id).state).toBe("published"); expect(f.kan.addComment).toHaveBeenCalledTimes(1);
});

it("requires the attachment filename when confirming an upload", async () => {
  const c = await f.create(commentInput(true)); f.kan.uploadFailure = timeout();
  await f.process(); await f.idle(); const cardId = state(c.id).ticket!.cardPublicId;
  expect((await post(c.id, "reconcile", { action: "confirm_exists", cardPublicId: cardId })).status).toBe(409);
  expect(state(c.id).state).toBe("outcome_unclear");
  f.kan.cards.get(cardId)!.attachments.push({ publicId: "found", filename: "stored.png", originalFilename: `review-${c.id}-r1.png` });
  expect((await post(c.id, "reconcile", { action: "confirm_exists", cardPublicId: cardId })).status).toBe(200);
  expect(state(c.id).state).toBe("published"); expect(f.kan.uploadAttachment).toHaveBeenCalledTimes(1);
});

it("rejects confirmation of a created card outside the target board", async () => {
  const c = await f.create(); f.kan.createFailure = { error: timeout(), store: false };
  await f.process(); await f.idle(); f.kan.seed("elsewhere");
  f.kan.getBoard.mockResolvedValue({ publicId: "board", name: "Board", lists: [{ publicId: "list", name: "List", cards: [] }] });
  expect((await post(c.id, "reconcile", { action: "confirm_exists", cardPublicId: "elsewhere" })).status).toBe(409);
  expect(state(c.id).state).toBe("outcome_unclear"); expect(f.app.store.listOpsForComment(c.id)[0]?.state).toBe("unclear");
});

it("publishes a duplicate decision while another Codex turn is blocked", async () => {
  const a = await f.create(); f.kan.seed();
  f.analyze(async () => ({ ok: true, threadId: "thread", output: { ...ready(), outcome: "duplicate", duplicates: [{ cardPublicId: "existing", reason: "Gleich" }] } }));
  await f.process(); await f.idle();
  const b = await f.create(); const turn = gate(); const entered = gate();
  f.analyze(async () => { entered.release(); await turn.promise; return { ok: true, threadId: "thread", output: ready() }; });
  await f.process(); await entered.promise;
  try {
    expect((await post(a.id, "decision", { kind: "duplicate", action: "append", cardPublicId: "existing" })).status).toBe(200);
    await vi.waitFor(() => expect(state(a.id).state).toBe("published"));
    expect(state(b.id).state).toBe("processing");
  } finally { turn.release(); }
  await f.idle();
});

it("fails a duplicate check without publishing and reanalyzes on retry", async () => {
  const c = await f.create();
  f.analyze(async () => ({ ok: true, threadId: "thread", output: { ...ready(), duplicateCheck: "failed" } }));
  await f.process(); await f.idle();
  expect(state(c.id)).toMatchObject({ state: "failed", stateDetail: "Duplikatprüfung in Kan fehlgeschlagen – bitte erneut versuchen" });
  expect(state(c.id).analysis).toBeUndefined(); expect(f.kan.createCard).not.toHaveBeenCalled();
  f.analyze(async () => ({ ok: true, threadId: "thread", output: ready() }));
  expect((await post(c.id, "retry")).status).toBe(200); await f.idle();
  expect(state(c.id).state).toBe("published"); expect(f.runner.analyze).toHaveBeenCalledTimes(2);
});

it.each(["missing", "stale"])("leaves a visible failure for a %s publication plan", async (kind) => {
  const a = await f.create();
  if (kind === "stale") {
    f.app.store.setAnalysis(a.id, { revision: 1, ticket: ready().ticket, findings: [], checkouts: [], analyzedAt: new Date().toISOString() });
    f.processing().publisher.prepare([state(a.id)], config().target);
    f.app.store.updateComment(a.id, { revision: 2 });
  }
  f.app.store.updateCommentState(a.id, "ready"); await f.processing().publisher.publish(a.id);
  expect(state(a.id)).toMatchObject({ state: "failed", stateDetail: expect.any(String) });
  expect(f.kan.createCard).not.toHaveBeenCalled();
});

it("keeps analysis running during an upload and excludes queued publications from new merge proposals", async () => {
  const first = await f.create(commentInput(true)); const second = await f.create(); const third = await f.create();
  const uploadGate = gate(); const uploading = gate(); const proposed = gate();
  const upload = f.kan.uploadAttachment.getMockImplementation()!;
  f.kan.uploadAttachment.mockImplementationOnce(async (id, input) => {
    uploading.release(); await uploadGate.promise; return upload(id, input);
  });
  f.analyze(async (input) => {
    const id = input.comments[0]!.commentId;
    if (id === second.id) await uploading.promise;
    if (id === third.id) proposed.release();
    return { ok: true, threadId: "thread", output: { ...ready(), mergeWith: id === third.id ? [{ commentId: second.id, reason: "Gleich" }] : [] } };
  });
  await f.process();
  try {
    await vi.waitFor(() => expect(f.runner.analyze).toHaveBeenCalledTimes(3));
    await proposed.promise;
    // Wait for the third analysis result to be settled while the publication queue remains blocked.
    await vi.waitFor(() => expect(state(third.id).state).not.toBe("processing"));
    expect(state(first.id).state).toBe("ticket_created");
    expect(state(second.id).state).toBe("ready");
    expect(f.app.store.listMergeProposals(f.review.id)).toEqual([]);
  } finally { uploadGate.release(); }
  await f.idle();
  expect([first, second, third].map((c) => state(c.id).state)).toEqual(["published", "published", "published"]);
});

it("deletes an entire accepted group during a pending write without retaining operations or plans", async () => {
  const { a, b, proposal } = await propose(); const response = gate(); const sent = gate();
  const create = f.kan.createCard.getMockImplementation()!;
  f.kan.createCard.mockImplementationOnce(async (input) => { const result = await create(input); sent.release(); await response.promise; return result; });
  await accept(a, proposal); await sent.promise;
  try {
    expect((await f.request(`/v1/reviews/${f.review.id}`, undefined, "DELETE")).status).toBe(204);
    expect(f.app.store.getComment(a.id)).toBeUndefined(); expect(f.app.store.getComment(b.id)).toBeUndefined();
    expect(f.app.store.listOpsForComment(a.id)).toEqual([]); expect(f.processing().publisher.plan(a.id)).toBeUndefined();
  } finally { response.release(); }
  await f.idle(); await f.restart(); await f.idle(); expect(f.kan.createCard).toHaveBeenCalledTimes(1);
});
