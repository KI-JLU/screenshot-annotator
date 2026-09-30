import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGatewayHandlers } from "../../src/mcp/gateway.ts";
import { setup, type Fixture } from "./helpers.ts";
let f: Fixture;
beforeEach(async () => { f = await setup(); });
afterEach(async () => { await f.close(); });
const env = () => ({ WEBSITE_REVIEW_COMPANION_SOCKET: f.socketPath, WEBSITE_REVIEW_INTERNAL_TOKEN: f.app.internalToken, WEBSITE_REVIEW_REVIEW_ID: f.review.id, WEBSITE_REVIEW_PROJECT_ID: "example" });
describe("read-only gateway", () => {
  it("runs all four handlers against the authenticated Unix socket routes", async () => {
    const c = await f.create(); f.kan.seed(); const tools = createGatewayHandlers(env());
    expect(Object.keys(tools)).toEqual(["kan_search_cards", "kan_list_board_cards", "kan_get_card", "review_list_comments"]);
    expect(await tools.kan_search_cards({ query: "Titel" })).toMatchObject([{ publicId: "existing" }]);
    expect(f.kan.searchCards).toHaveBeenCalledWith("workspace", "Titel");
    expect(await tools.kan_list_board_cards()).toMatchObject([{ publicId: "existing", listName: "To do", listPublicId: "list" }]);
    expect(await tools.kan_get_card({ cardPublicId: "existing" })).toMatchObject({ title: "Titel von Kan", comments: [], attachments: [] });
    expect(await tools.review_list_comments()).toEqual([{ commentId: c.id, text: c.text, url: c.context.url, state: "draft" }]);
    expect(f.kan.createCard).not.toHaveBeenCalled(); expect(f.kan.addComment).not.toHaveBeenCalled();
  });
  it("rejects wrong internal tokens and review/project mismatches", async () => {
    await expect(createGatewayHandlers({ ...env(), WEBSITE_REVIEW_INTERNAL_TOKEN: "wrong" }).review_list_comments()).rejects.toThrow("Begleitdienst");
    await expect(createGatewayHandlers({ ...env(), WEBSITE_REVIEW_PROJECT_ID: "other" }).review_list_comments()).rejects.toThrow("Begleitdienst");
    await expect(createGatewayHandlers({ ...env(), WEBSITE_REVIEW_COMPANION_SOCKET: "https://external.test" }).review_list_comments()).rejects.toThrow("Adresse");
  });
  it("exposes only internal routes on the socket and requires the process token", async () => {
    const call = (path: string, token?: string) => new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: f.socketPath, path, headers: token ? { "X-Website-Review-Token": token } : {} }, (res) => {
        res.resume(); res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject); req.end();
    });
    expect(await call("/v1/health", f.app.internalToken)).toBe(404);
    expect(await call(`/internal/projects/example/reviews/${f.review.id}/comments`)).toBe(401);
    expect(await call(`/internal/projects/example/reviews/${f.review.id}/comments`, f.app.internalToken)).toBe(200);
  });
});
