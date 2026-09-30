import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comment } from "@website-review/shared";
import { KanError } from "../../src/kan/types.ts";
import { commentInput } from "../core/helpers.ts";
import { ready, setup, type Fixture } from "./helpers.ts";

let f: Fixture;
beforeEach(async () => { f = await setup(); });
afterEach(async () => { await f.close(); });
const state = (id: string) => f.app.store.getComment(id)!;
const post = (id: string, route: string, input?: unknown) => f.request(`/v1/comments/${id}/${route}`, input);
async function process() { expect((await f.process()).status).toBe(200); await f.idle(); }

describe("processing over HTTP", () => {
  it("rechecks checkouts and never creates without code analysis", async () => {
    const c = await f.create();
    await f.app.projects.view("example"); rmSync(f.checkout, { recursive: true });
    const response = await f.process();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "preflight_failed", details: [{ kind: "checkout", message: expect.stringContaining("Ordner fehlt") }] } });
    expect(state(c.id).state).toBe("draft"); expect(f.kan.createCard).not.toHaveBeenCalled(); expect(f.runner.analyze).not.toHaveBeenCalled();
  });
  it("checks Codex, credentials and the actual list before processing", async () => {
    await f.create();
    vi.mocked(f.runner.probe).mockResolvedValue({ available: false, problem: "Codex fehlt" });
    f.kan.listWorkspaces.mockRejectedValue(new KanError("secret", "auth", 401, false));
    let response = await f.process(); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: [{ kind: "codex" }, { kind: "kan_token" }] } });
    vi.mocked(f.runner.probe).mockResolvedValue({ available: true });
    f.kan.listWorkspaces.mockResolvedValue([{ publicId: "workspace", name: "Workspace" }]);
    f.kan.getBoard.mockResolvedValue({ publicId: "board", name: "Board", lists: [] });
    response = await f.process(); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: [{ kind: "kan_target" }] } });
    expect(f.kan.createCard).not.toHaveBeenCalled();
  });
  it("publishes nine comments while one waits, then resumes on its last answer", async () => {
    const comments = await Promise.all(Array.from({ length: 10 }, (_, i) => f.create({ ...commentInput(true), text: `Kommentar ${i}` })));
    const waiting = comments[3]!;
    f.analyze(async (input) => ({ ok: true, threadId: "thread-42", output: input.comments[0]!.commentId === waiting.id && !input.comments[0]!.questions.length
      ? { ...ready(), outcome: "question", questions: ["Welcher Bereich?", "Welche Seite?"] } : ready() }));
    const events: string[] = []; f.app.events.subscribe((e) => events.push(e.type));
    await process();
    expect(f.app.store.listComments(f.review.id).filter((c) => c.state === "published")).toHaveLength(9);
    expect(state(waiting.id).state).toBe("question_open"); expect(f.kan.createCard).toHaveBeenCalledTimes(9);
    for (const q of state(waiting.id).questions) expect((await post(waiting.id, "answer", { questionId: q.id, answer: "Filter" })).status).toBe(200);
    await f.idle(); expect(state(waiting.id).state).toBe("published"); expect(f.kan.createCard).toHaveBeenCalledTimes(10);
    expect(f.kan.uploadAttachment).toHaveBeenCalledTimes(10);
    expect(f.app.store.getReview(f.review.id)?.codexThreadId).toBe("thread-42");
    const first = vi.mocked(f.runner.analyze).mock.calls[0]![0];
    expect(first.checkouts[0]).toMatchObject({ alias: "frontend", path: f.checkout, headCommit: expect.stringMatching(/^[a-f0-9]+$/) });
    expect(first.comments[0]?.imagePath).toContain("-r1.png"); expect(first.otherComments).toHaveLength(9);
    expect(first.gateway).toMatchObject({ command: processExecPath(), args: ["/test/cli.js", "mcp"], env: { WEBSITE_REVIEW_COMPANION_URL: f.url, WEBSITE_REVIEW_REVIEW_ID: f.review.id } });
    expect(JSON.stringify(first)).not.toContain("private-kan-token"); expect(events).toContain("comment.updated"); expect(events).toContain("review.updated");
  });
  it("isolates analysis failures and retries only the failed analysis", async () => {
    const bad = await f.create(); const good = await f.create();
    f.analyze(async (input) => input.comments[0]!.commentId === bad.id ? { ok: false, error: "Codex-Analyse fehlgeschlagen", retryable: true } : { ok: true, threadId: "thread", output: ready() });
    await process(); expect(state(bad.id).state).toBe("failed"); expect(state(good.id).state).toBe("published");
    f.analyze(async () => ({ ok: true, threadId: "thread", output: ready() }));
    await post(bad.id, "retry"); await f.idle(); expect(state(bad.id).state).toBe("published"); expect(f.kan.createCard).toHaveBeenCalledTimes(2);
  });
  it.each(["append", "create_new"] as const)("honors duplicate choice %s using Kan titles and URLs", async (action) => {
    f.kan.seed(); const c = await f.create(commentInput(true));
    f.analyze(async () => ({ ok: true, threadId: "thread", output: { ...ready(), outcome: "duplicate", duplicates: [{ cardPublicId: "existing", reason: "Gleicher Bereich" }] } }));
    await process();
    expect(state(c.id)).toMatchObject({ state: "decision_open", pendingDecision: { kind: "duplicate", candidates: [{ cardPublicId: "existing", title: "Titel von Kan", url: f.kan.cardUrl("existing"), reason: "Gleicher Bereich" }] } });
    expect((await post(c.id, "decision", { kind: "duplicate", action: "append", cardPublicId: "unoffered" })).status).toBe(409);
    expect((await post(c.id, "decision", { kind: "duplicate", action, ...(action === "append" ? { cardPublicId: "existing" } : {}) })).status).toBe(200);
    await f.idle(); expect(state(c.id)).toMatchObject({ state: "published", ticket: { mode: action === "append" ? "appended" : "created", attachmentUploaded: true } });
    expect(f.kan.createCard).toHaveBeenCalledTimes(action === "append" ? 0 : 1); expect(f.kan.addComment).toHaveBeenCalledTimes(action === "append" ? 1 : 0);
    expect(f.kan.cards.get("existing")?.description).toBe("Originalbeschreibung");
  });
  it.each(["accept", "reject"] as const)("settles a merge from any member: %s", async (action) => {
    const a = await f.create({ ...commentInput(true), text: "Erster Wunsch" });
    const b = await f.create({ ...commentInput(true), text: "Zweiter Wunsch" });
    f.analyze(async (input) => ({ ok: true, threadId: "thread", output: { ...ready(), ticket: { ...ready().ticket, title: input.comments.length > 1 ? "Gemeinsam" : input.comments[0]!.text },
      mergeWith: input.comments.length === 1 && input.comments[0]!.commentId === a.id ? [{ commentId: b.id, reason: "Zusammengehörig" }] : [] } }));
    await process();
    expect(state(a.id).state).toBe("decision_open"); expect(state(b.id).state).toBe("decision_open");
    expect(state(a.id).analysis?.ticket.title).toBe("Erster Wunsch"); expect(state(b.id).analysis?.ticket.title).toBe("Zweiter Wunsch");
    const proposal = f.app.store.listMergeProposals(f.review.id)[0]!;
    expect((await post(b.id, "decision", { kind: "merge", proposalId: proposal.id, action })).status).toBe(200);
    await f.idle(); expect(state(a.id).state).toBe("published"); expect(state(b.id).state).toBe("published");
    expect(f.kan.createCard).toHaveBeenCalledTimes(action === "accept" ? 1 : 2);
    expect(f.kan.uploadAttachment).toHaveBeenCalledTimes(2);
    if (action === "accept") {
      expect(state(a.id).ticket).toEqual(state(b.id).ticket);
      const combined = vi.mocked(f.runner.analyze).mock.calls.filter(([input]) => input.comments.length === 2);
      expect(combined).toHaveLength(1); expect(combined[0]![0].otherComments).toEqual([]);
      expect([...f.kan.cards.values()][0]!.description).toContain("Erster Wunsch"); expect([...f.kan.cards.values()][0]!.description).toContain("Zweiter Wunsch");
      expect(f.app.store.listOpsForComment(b.id)).toEqual([]);
    } else expect(state(a.id).ticket?.cardPublicId).not.toBe(state(b.id).ticket?.cardPublicId);
    expect((await post(a.id, "decision", { kind: "merge", proposalId: proposal.id, action })).status).toBe(409);
  });
  it("drops escaped, missing and symlinked findings, retaining real checkout files", async () => {
    const outside = join(f.dir, "outside.ts"); writeFileSync(outside, "secret"); symlinkSync(outside, join(f.checkout, "link.ts"));
    const c = await f.create();
    f.analyze(async () => ({ ok: true, threadId: "thread", output: { ...ready(), findings: ["page.ts", "../outside.ts", outside, "link.ts", "missing.ts", "C:\\file.ts"].map((path) => ({ repository: "frontend", path, note: "Fundstelle", lineStart: null, lineEnd: null })) } }));
    await process(); expect(state(c.id).analysis?.findings).toEqual([{ repository: "frontend", path: "page.ts", note: "Fundstelle" }]);
  });
  it("discards results from a revision changed during analysis", async () => {
    const c = await f.create(); let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    f.analyze(async () => { await blocked; return { ok: true, threadId: "thread", output: ready() }; });
    await f.process(); await vi.waitFor(() => expect(f.runner.analyze).toHaveBeenCalled());
    f.app.store.updateComment(c.id, { revision: 2, text: "Neuer Wunsch", state: "draft" });
    release(); await f.idle(); expect(state(c.id)).toMatchObject({ revision: 2, state: "draft" });
    expect(state(c.id).analysis).toBeUndefined(); expect(f.kan.createCard).not.toHaveBeenCalled();
  });
  it("persists idempotent capture IDs per review, including concurrent HTTP retries and restart", async () => {
    const input = { ...commentInput(true), clientRequestId: randomUUID() };
    const [a, b] = await Promise.all([f.create(input), f.create(input)]); expect(a.id).toBe(b.id);
    await f.restart(); expect((await f.create(input)).id).toBe(a.id);
    const other = f.app.store.createReview("example");
    const response = await f.request(`/v1/reviews/${other.id}/comments`, input);
    expect((await response.json() as Comment).id).not.toBe(a.id);
  });
});
function processExecPath() { return globalThis.process.execPath; }
