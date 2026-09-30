import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config, fixture, type Fixture } from "./helpers.ts";
import { COMMENT_JSON_LIMIT } from "../../src/http/router.ts";
import { Store } from "../../src/store/store.ts";

describe("HTTP request limits and errors", () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); await f.pair(); });
  afterEach(async () => { await f.close(); });

  it("rejects oversized comment bodies before parsing or storing", async () => {
    const response = await f.request("POST", "/v1/reviews/missing/comments", { text: "x".repeat(COMMENT_JSON_LIMIT) });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "validation" } });
    expect(f.app.store.listReviews()).toEqual([]);
  });

  it("rejects malformed JSON with an ApiError", async () => {
    const response = await fetch(f.url + "/v1/projects", { method: "POST", headers: {
      Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", Authorization: `Bearer ${f.token}`, "Content-Type": "application/json",
    }, body: "{" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "validation", message: "Ungültiges JSON" } });
  });

  it("never returns arbitrary internal errors or secret values", async () => {
    f.app.registerInternal("GET", "/internal/error", () => { throw new Error("private-api-token"); });
    const response = await f.request("GET", "/internal/error", undefined, { Authorization: `Bearer ${f.app.internalToken}` });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "Interner Fehler im Begleitdienst" } });
  });

  it("retains persisted projects and pairing after a restart", async () => {
    await f.request("POST", "/v1/projects", config());
    const secondStore = new Store(f.app.store.dataDir);
    try {
      expect(secondStore.getProject("example")).toEqual(config());
      expect(secondStore.getPairing()).toEqual(f.app.store.getPairing());
    } finally { secondStore.close(); }
  });
});
