import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config, fixture, ORIGIN, type Fixture } from "./helpers.ts";

describe("SSE events", () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); await f.pair(); });
  afterEach(async () => { await f.close(); });

  it("streams committed project events over authenticated HTTP", async () => {
    const controller = new AbortController();
    const response = await fetch(f.url + "/v1/events", { headers: { Origin: ORIGIN, Authorization: `Bearer ${f.token}` },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    try {
      const initial = await reader.read();
      expect(new TextDecoder().decode(initial.value)).toContain(": connected");
      await f.request("POST", "/v1/projects", config());
      let received = "";
      while (!received.includes("event: projects.updated")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE ended before event");
        received += new TextDecoder().decode(chunk.value);
      }
      expect(received).toContain('data: {"type":"projects.updated"}');
    } finally { await reader.cancel(); controller.abort(); }
  });

  it("closes previous streams on re-pairing", async () => {
    const response = await fetch(f.url + "/v1/events", { headers: { Origin: ORIGIN, Authorization: `Bearer ${f.token}` }, signal: AbortSignal.timeout(3000) });
    const reader = response.body!.getReader();
    await reader.read();
    await f.pair();
    expect((await reader.read()).done).toBe(true);
    await reader.cancel();
  });
});
