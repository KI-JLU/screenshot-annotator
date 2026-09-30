import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, fixture, type Fixture } from "./helpers.ts";
import { COMMENT_JSON_LIMIT, JSON_LIMIT } from "../../src/http/router.ts";
import { Store } from "../../src/store/store.ts";

describe("transport-neutral request limits and errors", () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.close(); });
  it("measures the full UTF-8 frame and applies each route's limit", async () => {
    const response = await f.call("POST", "/v1/reviews/missing/comments", { text: "x".repeat(COMMENT_JSON_LIMIT) });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "validation" } });
    expect((await f.call("PUT", "/v1/comments/missing", { text: "x".repeat(COMMENT_JSON_LIMIT) })).status).toBe(413);
    expect((await f.call("POST", "/v1/projects", { name: "ü".repeat(JSON_LIMIT / 2) })).status).toBe(413);
    expect((await f.app.dispatch({ method: "GET", path: "/v1/health" }, JSON_LIMIT + 1)).status).toBe(413);
    expect((await f.app.dispatch({ method: "GET", path: "/v1/health" }, JSON_LIMIT)).status).toBe(200);
    expect(f.app.store.listReviews()).toEqual([]);
  });
  it("never returns arbitrary internal errors or secrets", async () => {
    vi.spyOn(f.app.projects, "list").mockImplementation(() => { throw new Error("private-api-token"); });
    const response = await f.call("GET", "/v1/projects");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "Interner Fehler im Begleitdienst" } });
  });
  it("keeps internal routes, removed routes and malformed paths out of the native API", async () => {
    f.app.registerInternal("GET", "/internal/example", () => ({ ok: true }));
    for (const path of ["/internal/example", "/v1/pair", "/v1/events"]) expect((await f.call("GET", path)).status).toBe(404);
    expect((await f.call("GET", "/v1/reviews/%XX")).status).toBe(400);
    expect((await f.call("POST", "/v1/reviews", {})).status).toBe(400);
  });
  it("retains persisted projects after a restart", async () => {
    await f.call("POST", "/v1/projects", config());
    const secondStore = new Store(f.app.store.dataDir);
    try { expect(secondStore.getProject("example")).toEqual(config()); }
    finally { secondStore.close(); }
  });
});
