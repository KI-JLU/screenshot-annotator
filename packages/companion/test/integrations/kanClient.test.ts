import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKanClient } from "../../src/kan/kanClient.ts";
import { KanError } from "../../src/kan/types.ts";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const createInput = { listPublicId: "list", title: "Titel", description: "Wunsch" };
function setup() {
  const fetcher = vi.fn<typeof fetch>();
  const client = createKanClient({ baseUrl: "https://kan.test/", apiToken: "private-token", fetch: fetcher, timeoutMs: 100 });
  return { fetcher, client };
}
async function finish<T>(promise: Promise<T>): Promise<T> {
  // Attach rejection handling before advancing timers.
  const result = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  const settled = await result;
  if ("error" in settled) throw settled.error;
  return settled.value;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Kan client", () => {
  it.each([[400, "validation", false], [401, "auth", false], [403, "auth", false], [404, "not_found", false], [429, "rate_limited", false], [500, "server", true], [503, "server", true]] as const)("maps HTTP %s and never retries writes", async (status, kind, requestSent) => {
    const { fetcher, client } = setup();
    fetcher.mockResolvedValue(response({}, status));
    await expect(finish(client.createCard(createInput))).rejects.toMatchObject({ name: "KanError", kind, status, requestSent });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("maps network errors after fetch was called", async () => {
    const { fetcher, client } = setup();
    fetcher.mockRejectedValue(new TypeError("connection reset"));
    await expect(finish(client.createCard(createInput))).rejects.toMatchObject({ kind: "network", requestSent: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("aborts and times out even when a fetch implementation ignores its signal", async () => {
    const { fetcher, client } = setup();
    fetcher.mockImplementation(() => new Promise(() => {}));
    await expect(finish(client.createCard(createInput))).rejects.toMatchObject({ kind: "timeout", requestSent: true });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it("retries reads on 429 and 5xx, at most three attempts", async () => {
    const { fetcher, client } = setup();
    fetcher.mockResolvedValueOnce(response({}, 429)).mockResolvedValueOnce(response({}, 503)).mockResolvedValueOnce(response([{ role: "admin", workspace: { publicId: "ws", name: "Team" } }]));
    await expect(finish(client.listWorkspaces())).resolves.toEqual([{ publicId: "ws", name: "Team" }]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockImplementation(async () => response({}, 500));
    await expect(finish(client.listWorkspaces())).rejects.toBeInstanceOf(KanError);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it("does not retry other read errors", async () => {
    const { fetcher, client } = setup();
    fetcher.mockResolvedValue(response({}, 401));
    await expect(finish(client.listWorkspaces())).rejects.toMatchObject({ kind: "auth" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("serializes and spaces concurrent requests; a failed request does not poison the queue", async () => {
    const { fetcher, client } = setup();
    const times: number[] = [];
    let active = 0;
    let maximum = 0;
    fetcher.mockImplementation(async () => {
      times.push(Date.now()); active++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 30)); active--;
      return response([], times.length === 1 ? 401 : 200);
    });
    const results = await finish(Promise.allSettled([client.listWorkspaces(), client.listBoards("ws"), client.listWorkspaces()]));
    expect(results.map((item) => item.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(maximum).toBe(1);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(601);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(601);
  });
  it("unwraps workspace memberships and maps board listings from the documented API shape", async () => {
    const { fetcher, client } = setup();
    fetcher.mockResolvedValueOnce(response([{ role: "admin", workspace: { publicId: "ws", name: "Team", slug: "team", plan: "free", deletedAt: null } }]))
      .mockResolvedValueOnce(response([{ publicId: "board", name: "Review", favorite: true, lists: [] }]));
    expect(await finish(client.listWorkspaces())).toEqual([{ publicId: "ws", name: "Team" }]);
    expect(await finish(client.listBoards("ws"))).toEqual([{ publicId: "board", name: "Review" }]);
  });
  it("maps boards, cards, nested activity comments and attachment filenames", async () => {
    const { fetcher, client } = setup();
    fetcher.mockResolvedValueOnce(response({ publicId: "board", name: "Board", lists: [{ publicId: "done", name: "Erledigt", cards: [{ publicId: "card", title: "Ticket", description: "Review-Referenz: wr-old" }] }] }));
    const board = await finish(client.getBoard("board"));
    expect(board.lists[0]?.cards[0]).toEqual({ publicId: "card", title: "Ticket", description: "Review-Referenz: wr-old", listPublicId: "done", listName: "Erledigt" });
    const comment = { publicId: "comment", comment: "Review-Referenz: wr-123", deletedAt: null };
    fetcher.mockResolvedValueOnce(response({ publicId: "card", title: "Ticket", description: null, list: { publicId: "done", name: "Erledigt" },
      attachments: [{ publicId: "a", originalFilename: "review-c-r1.png", s3Key: "some/key" }, { publicId: "b", s3Key: "path/file.png" }],
      activities: [{ type: "comment.created", comment }, { comment }, { comment: null }, null, { comment: "bad shape" }, { comment: { ...comment, publicId: "deleted", deletedAt: "2026-01-01" } }],
    }));
    const detail = await finish(client.getCard("card"));
    expect(detail.comments).toEqual([{ publicId: "comment", comment: "Review-Referenz: wr-123" }]);
    expect(detail.attachments.map((item) => item.filename)).toEqual(["review-c-r1.png", "file.png"]);
    expect(detail.listName).toBe("Erledigt");
  });
  it("searches cards only and encodes query/path components", async () => {
    const { fetcher, client } = setup();
    fetcher.mockResolvedValue(response([{ publicId: "b", title: "Board", description: null, type: "board" }, { publicId: "c", title: "Card", description: null, type: "card", listName: "Todo" }]));
    expect(await finish(client.searchCards("a/b", "A & B", 8))).toEqual([{ publicId: "c", title: "Card", description: null, listName: "Todo" }]);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://kan.test/api/v1/workspaces/a%2Fb/search?query=A+%26+B&limit=8");
    expect(client.cardUrl("card")).toBe("https://kan.test/cards/card");
  });
  it("sends deterministic creation and comment bodies", async () => {
    const { fetcher, client } = setup();
    fetcher.mockImplementation(async () => response({ publicId: "created" }));
    await finish(client.createCard(createInput)); await finish(client.addComment("created", "Ergänzung"));
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ ...createInput, labelPublicIds: [], memberPublicIds: [], position: "end" });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ comment: "Ergänzung" });
  });
  it("uploads bytes and confirms, without leaking Authorization to the presigned URL", async () => {
    const { fetcher, client } = setup();
    fetcher.mockResolvedValueOnce(response({ url: "https://s3.test/signed", key: "key/image" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 })).mockResolvedValueOnce(response({ publicId: "attachment" }));
    await expect(finish(client.uploadAttachment("card", { filename: "review.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) }))).resolves.toEqual({ publicId: "attachment" });
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["https://kan.test/api/v1/cards/card/attachments/upload-url", "POST"], ["https://s3.test/signed", "PUT"], ["https://kan.test/api/v1/cards/card/attachments/confirm", "POST"],
    ]);
    const put = fetcher.mock.calls[1]?.[1];
    expect(put?.headers).toEqual({ "Content-Type": "image/png" });
    expect(put?.body).toEqual(Buffer.from([1, 2, 3]));
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer private-token" });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ filename: "review.png", originalFilename: "review.png", contentType: "image/png", size: 3, s3Key: "key/image" });
  });
  it("never retries a failed upload PUT or confirms it", async () => {
    const { fetcher, client } = setup();
    fetcher.mockResolvedValueOnce(response({ url: "https://s3.test/signed", key: "key" })).mockResolvedValueOnce(response({}, 503));
    await expect(finish(client.uploadAttachment("card", { filename: "image.png", contentType: "image/png", bytes: new Uint8Array([1]) }))).rejects.toMatchObject({ kind: "server", requestSent: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
