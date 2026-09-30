import { describe, expect, it } from "vitest";
import type { NativeResponse } from "@website-review/shared";
import {
  ChunkAssembler,
  HOST_NOT_FOUND,
  PendingRequests,
  backoffMs,
  routeFrame,
  splitIntoChunks,
  statusFromDisconnect,
  statusFromHello,
} from "./nativeTransport.ts";

const big: NativeResponse = { type: "response", id: "req-1", status: 200, body: { pngBase64: "A".repeat(5000) } };

describe("ChunkAssembler", () => {
  it("reassembles chunks received out of order", () => {
    const chunks = splitIntoChunks(big, 1000);
    expect(chunks.length).toBeGreaterThan(3);
    const a = new ChunkAssembler();
    const shuffled = [chunks[2], chunks[0], ...chunks.slice(3), chunks[1]];
    const results = shuffled.map((c) => a.push(c!));
    expect(results.slice(0, -1).every((r) => r.kind === "pending")).toBe(true);
    expect(results.at(-1)).toEqual({ kind: "complete", response: big });
    expect(a.inProgress).toBe(0);
  });

  it("keeps interleaved responses apart", () => {
    const other: NativeResponse = { type: "response", id: "req-2", status: 404, body: { error: { code: "not_found", message: "x" } } };
    const c1 = splitIntoChunks(big, 2000);
    const c2 = splitIntoChunks(other, 20);
    const a = new ChunkAssembler();
    const done: NativeResponse[] = [];
    const max = Math.max(c1.length, c2.length);
    for (let i = 0; i < max; i++) {
      for (const c of [c1[i], c2[i]]) {
        if (!c) continue;
        const r = a.push(c);
        if (r.kind === "complete") done.push(r.response);
      }
    }
    expect(done.map((r) => r.id).sort()).toEqual(["req-1", "req-2"]);
    expect(done.find((r) => r.id === "req-2")).toEqual(other);
  });

  it("ignores a repeated chunk and handles a single-chunk response", () => {
    const chunks = splitIntoChunks(big, 3000);
    const a = new ChunkAssembler();
    expect(a.push(chunks[0]!).kind).toBe("pending");
    expect(a.push(chunks[0]!).kind).toBe("pending");
    expect(a.push(chunks[1]!)).toEqual({ kind: "complete", response: big });
    const single = splitIntoChunks({ type: "response", id: "s", status: 204 }, 1000);
    expect(single).toHaveLength(1);
    expect(a.push(single[0]!)).toEqual({ kind: "complete", response: { type: "response", id: "s", status: 204 } });
  });

  it("rejects inconsistent or invalid chunks", () => {
    const a = new ChunkAssembler();
    expect(a.push({ type: "chunk", id: "x", index: 3, count: 2, data: "" }).kind).toBe("error");
    expect(a.push({ type: "chunk", id: "y", index: 0, count: 2, data: "{" }).kind).toBe("pending");
    expect(a.push({ type: "chunk", id: "y", index: 1, count: 3, data: "}" }).kind).toBe("error");
    expect(a.push({ type: "chunk", id: "z", index: 0, count: 1, data: "not json" }).kind).toBe("error");
    // Payload whose id does not match the chunk id.
    const wrong = JSON.stringify({ type: "response", id: "other", status: 200 });
    expect(a.push({ type: "chunk", id: "w", index: 0, count: 1, data: wrong }).kind).toBe("error");
    expect(a.inProgress).toBe(0);
  });
});

describe("PendingRequests", () => {
  it("correlates responses by id and ignores unknown ids", () => {
    const p = new PendingRequests<string>();
    p.add("a", "panel-1");
    p.add("b", "panel-2");
    expect(() => p.add("a", "again")).toThrow();
    expect(p.take("b")).toBe("panel-2");
    expect(p.take("b")).toBeUndefined();
    expect(p.take("unknown")).toBeUndefined();
    expect(p.size).toBe(1);
  });

  it("drains all entries after a disconnect and removes a closed panel's requests", () => {
    const p = new PendingRequests<{ port: number }>();
    p.add("a", { port: 1 });
    p.add("b", { port: 2 });
    p.add("c", { port: 1 });
    p.removeWhere((e) => e.port === 1);
    expect(p.drain()).toEqual([["b", { port: 2 }]]);
    expect(p.size).toBe(0);
  });
});

describe("routeFrame", () => {
  it("classifies responses, events, hello and chunks", () => {
    const a = new ChunkAssembler();
    expect(routeFrame({ type: "response", id: "1", status: 200, body: [] }, a)).toEqual({
      kind: "response",
      response: { type: "response", id: "1", status: 200, body: [] },
    });
    expect(routeFrame({ type: "event", event: { type: "projects.updated" } }, a)).toEqual({
      kind: "event",
      event: { type: "projects.updated" },
    });
    expect(routeFrame({ type: "hello", version: "1.0" }, a)).toEqual({ kind: "hello", hello: { type: "hello", version: "1.0" } });
    const [c0, c1] = splitIntoChunks(big, Math.ceil(JSON.stringify(big).length / 2));
    expect(routeFrame(c0, a)).toEqual({ kind: "pending" });
    expect(routeFrame(c1, a)).toEqual({ kind: "response", response: big });
    expect(routeFrame({ type: "bogus" }, a).kind).toBe("error");
    expect(routeFrame(null, a).kind).toBe("error");
  });
});

describe("host status", () => {
  it("distinguishes a missing host from a crash", () => {
    expect(statusFromDisconnect(HOST_NOT_FOUND).state).toBe("not_installed");
    expect(statusFromDisconnect("Native host has exited.")).toEqual({ state: "disconnected", detail: "Native host has exited." });
    expect(statusFromDisconnect(undefined).state).toBe("disconnected");
  });

  it("maps hello frames", () => {
    expect(statusFromHello({ type: "hello", version: "0.2.0" })).toEqual({ state: "connected", version: "0.2.0" });
    expect(statusFromHello({ type: "hello", version: "0.2.0", problem: "Läuft bereits (PID 12)" })).toEqual({
      state: "problem",
      version: "0.2.0",
      problem: "Läuft bereits (PID 12)",
    });
  });

  it("backs off exponentially up to 30 s", () => {
    expect([0, 1, 2, 5, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 30000, 30000]);
  });
});
