import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixture, ORIGIN, OTHER_ORIGIN, type Fixture } from "./helpers.ts";
import { hashSecret } from "../../src/ids.ts";

describe("pairing and HTTP authentication", () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.close(); });

  it("binds only to loopback and makes health available before pairing", async () => {
    expect(f.app.server.address()).toMatchObject({ address: "127.0.0.1", port: f.port });
    const response = await fetch(f.url + "/v1/health");
    expect(await response.json()).toMatchObject({ ok: true, paired: false });
    expect((await f.request("GET", "/v1/projects")).status).toBe(401);
  });

  it("issues a 256-bit token, stores only hashes, and consumes the code once", async () => {
    const code = f.app.store.createPairingCode();
    expect(code).toHaveLength(8);
    const rows = f.app.store.db.prepare("SELECT * FROM pairing_codes").all();
    expect(JSON.stringify(rows)).not.toContain(code);
    const response = await f.request("POST", "/v1/pair", { code });
    const { token } = await response.json() as { token: string };
    expect(Buffer.from(token, "hex")).toHaveLength(32);
    expect(f.app.store.getPairing()).toEqual({ extensionOrigin: ORIGIN, tokenHash: hashSecret(token) });
    const repeated = await f.request("POST", "/v1/pair", { code });
    expect(repeated.status).toBe(401);
    expect(await repeated.json()).toMatchObject({ error: { code: "invalid_pairing_code" } });
  });

  it("enforces paired Origin independently of the bearer token", async () => {
    const token = await f.pair();
    expect((await f.request("GET", "/v1/projects")).status).toBe(200);
    for (const origin of ["https://example.org", OTHER_ORIGIN]) {
      const response = await f.request("GET", "/v1/projects", undefined, { Origin: origin });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    const missing = await fetch(f.url + "/v1/projects", { headers: { Authorization: `Bearer ${token}` } });
    expect(missing.status).toBe(403);
    expect((await f.request("GET", "/v1/projects", undefined, { Authorization: "Bearer invalid" })).status).toBe(401);
  });

  it("rejects expired codes and pairing by web pages", async () => {
    const code = f.app.store.createPairingCode(Date.now() - 601_000);
    expect((await f.request("POST", "/v1/pair", { code })).status).toBe(401);
    const valid = f.app.store.createPairingCode();
    expect((await f.request("POST", "/v1/pair", { code: valid }, { Origin: "https://example.org" })).status).toBe(403);
    expect((await f.request("POST", "/v1/pair", { code: valid })).status).toBe(200);
  });

  it("allows preflight only for the paired origin or extension pairing", async () => {
    const initial = await f.request("OPTIONS", "/v1/pair", undefined, { Origin: OTHER_ORIGIN, "Access-Control-Request-Method": "POST" });
    expect(initial.status).toBe(204);
    expect(initial.headers.get("access-control-allow-origin")).toBe(OTHER_ORIGIN);
    expect((await f.request("OPTIONS", "/v1/projects")).status).toBe(403);
    await f.pair();
    const paired = await f.request("OPTIONS", "/v1/projects", undefined, { "Access-Control-Request-Headers": "authorization, content-type" });
    expect(paired.status).toBe(204);
    expect(paired.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(paired.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("re-pairing revokes the old token and extension", async () => {
    const old = await f.pair();
    const response = await f.request("POST", "/v1/pair", { code: f.app.store.createPairingCode() }, { Origin: OTHER_ORIGIN });
    const { token } = await response.json() as { token: string };
    expect((await f.request("GET", "/v1/projects", undefined, { Authorization: `Bearer ${old}` })).status).toBe(401);
    expect((await f.request("GET", "/v1/projects", undefined, { Authorization: `Bearer ${token}` })).status).toBe(403);
    expect((await f.request("GET", "/v1/projects", undefined, { Authorization: `Bearer ${token}`, Origin: OTHER_ORIGIN })).status).toBe(200);
  });

  it("authenticates registered internal handlers with a separate token", async () => {
    await f.pair();
    f.app.registerInternal("GET", "/internal/example", () => ({ ok: true }));
    expect((await f.request("GET", "/internal/example")).status).toBe(401);
    const response = await fetch(f.url + "/internal/example", { headers: { Authorization: `Bearer ${f.app.internalToken}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect((await f.request("GET", "/v1/projects", undefined, { Authorization: `Bearer ${f.app.internalToken}` })).status).toBe(401);
    expect(() => f.app.registerInternal("GET", "/v1/unsafe", () => ({}))).toThrow();
  });
});
