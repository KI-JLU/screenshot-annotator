import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comment, PreflightProblem, ReviewDetail } from "@website-review/shared";
import type { ProcessingService } from "../../src/app.ts";
import { commentInput, config, fixture, type Fixture } from "./helpers.ts";

describe("processing service seam", () => {
  let f: Fixture; let reviewId: string; let comment: Comment; let processing: ProcessingService;
  beforeEach(async () => {
    processing = {
      preflight: vi.fn(async () => []),
      processReview: vi.fn(async () => ({ started: [comment.id] })),
      answer: vi.fn(async () => comment), decide: vi.fn(async () => comment),
      retry: vi.fn(async () => comment), reconcile: vi.fn(async () => comment),
    };
    f = await fixture(processing);
    await f.call("POST", "/v1/projects", config());
    reviewId = (await (await f.call("POST", "/v1/reviews", { projectId: "example" })).json() as ReviewDetail).id;
    comment = await (await f.call("POST", `/v1/reviews/${reviewId}/comments`, commentInput())).json() as Comment;
  });
  afterEach(async () => { await f.close(); });

  it("delegates processing, answers, decisions, retries and reconciliation", async () => {
    const response = await f.call("POST", `/v1/reviews/${reviewId}/process`);
    expect(await response.json()).toEqual({ started: [comment.id] });
    expect(processing.preflight).toHaveBeenCalledWith(reviewId);
    expect(processing.processReview).toHaveBeenCalledWith(reviewId);
    const answer = { questionId: "question", answer: "Filterbereich" };
    expect((await f.call("POST", `/v1/comments/${comment.id}/answer`, answer)).status).toBe(200);
    expect(processing.answer).toHaveBeenCalledWith(comment.id, answer);
    const decision = { kind: "duplicate", action: "append", cardPublicId: "card" };
    expect((await f.call("POST", `/v1/comments/${comment.id}/decision`, decision)).status).toBe(200);
    expect(processing.decide).toHaveBeenCalledWith(comment.id, decision);
    expect((await f.call("POST", `/v1/comments/${comment.id}/retry`)).status).toBe(200);
    expect(processing.retry).toHaveBeenCalledWith(comment.id);
    const reconcile = { action: "confirm_exists", cardPublicId: "card" };
    expect((await f.call("POST", `/v1/comments/${comment.id}/reconcile`, reconcile)).status).toBe(200);
    expect(processing.reconcile).toHaveBeenCalledWith(comment.id, reconcile);
  });

  it("returns structured preflight problems without starting processing", async () => {
    const problems: PreflightProblem[] = [{ kind: "checkout", message: "Checkout fehlt" }];
    vi.mocked(processing.preflight).mockResolvedValue(problems);
    const response = await f.call("POST", `/v1/reviews/${reviewId}/process`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "preflight_failed", details: problems } });
    expect(processing.processReview).not.toHaveBeenCalled();
  });

  it("validates inputs and resource existence before delegating", async () => {
    expect((await f.call("POST", `/v1/comments/${comment.id}/decision`, { kind: "duplicate", action: "append" })).status).toBe(400);
    expect(processing.decide).not.toHaveBeenCalled();
    expect((await f.call("POST", "/v1/comments/missing/retry")).status).toBe(404);
    expect(processing.retry).not.toHaveBeenCalled();
  });

  it("uses real processing by default and reports missing prerequisites", async () => {
    const stub = await fixture();
    try {
      await stub.call("POST", "/v1/projects", config());
      const review = await (await stub.call("POST", "/v1/reviews", { projectId: "example" })).json() as ReviewDetail;
      const response = await stub.call("POST", `/v1/reviews/${review.id}/process`);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "preflight_failed", details: expect.arrayContaining([{ kind: "checkout", message: "frontend: Checkout fehlt" }]) } });
    } finally { await stub.close(); }
  });
});
