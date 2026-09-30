import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerClient } from "../../src/codex/appServerClient.ts";
import { createAnalysisRunner } from "../../src/codex/analysisRunner.ts";
import { AnalysisOutputSchema, analysisOutputJsonSchema } from "../../src/codex/analysisSchema.ts";
import { buildAnalysisPrompt, developerInstructions } from "../../src/codex/prompts.ts";
import type { AnalysisInput, AnalysisRunner } from "../../src/codex/types.ts";

const fixture = fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url));
const clients: { close(): Promise<void> }[] = [];
const input = (): AnalysisInput => ({
  review: { id: "review", projectName: "Testprojekt" },
  checkouts: [{ alias: "frontend", path: "/tmp/frontend", headCommit: "abcdef0123", branch: "main", hasUncommittedChanges: true }],
  comments: [{ commentId: "comment", revision: 1, text: "Hier mehr Luft", markKind: "element", imagePath: "/tmp/approved.png",
    context: { url: "https://staging.test/page", pageTitle: "Seite", viewport: { width: 1000, height: 700, devicePixelRatio: 2 }, scroll: { x: 0, y: 20 }, elementText: "Filter", extraContext: "Ergebnisliste" },
    questions: [{ id: "q", text: "Welcher Bereich?", answer: "Filterbereich" }],
  }],
  otherComments: [{ commentId: "other", text: "Ähnlicher Wunsch", url: "https://staging.test/other" }],
  gateway: { command: "gateway", args: ["mcp"], env: { INTERNAL_TOKEN: "secret" } },
});
function client(mode = "normal", timeoutMs = 1000) {
  const result = new AppServerClient({ command: process.execPath, args: [fixture], env: { FAKE_MODE: mode, TEST_ENV: "passed" }, requestTimeoutMs: timeoutMs });
  clients.push(result); return result;
}
function runner(mode = "normal", turnTimeoutMs = 2000): { runner: AnalysisRunner; client: AppServerClient } {
  const transport = client(mode);
  const runner = createAnalysisRunner({ client: transport, command: process.execPath, probeArgs: [fixture], turnTimeoutMs });
  return { runner, client: transport };
}
interface Transcript { transcript: { method?: string; params?: Record<string, unknown> }[]; approvalResponses: { id: string; result?: unknown; error?: { code: number } }[] }
afterEach(async () => { await Promise.all(clients.splice(0).map((item) => item.close())); });

describe("app-server stdio", () => {
  it("handshakes once, correlates requests, passes env, and decodes chunked UTF-8 lines", async () => {
    const transport = client();
    const results = await Promise.all([transport.request("ping"), transport.request("ping")]);
    expect(results).toEqual([{ pong: true, inherited: true, env: "passed" }, { pong: true, inherited: true, env: "passed" }]);
    await expect(transport.request("chunked")).resolves.toBe("Größe ✓");
    const { transcript } = await transport.request<Transcript>("inspect");
    expect(transcript.filter((entry) => entry.method === "initialize")).toHaveLength(1);
    expect(transcript[1]?.method).toBe("initialized");
  });
  it("declines all approval variants with protocol-specific responses and errors on unknown methods", async () => {
    const transport = client();
    await transport.request("approvals");
    let responses: Transcript["approvalResponses"] = [];
    await vi.waitFor(async () => {
      responses = (await transport.request<Transcript>("inspect")).approvalResponses;
      expect(responses).toHaveLength(7);
    });
    expect(responses.map((item) => item.result ?? item.error)).toEqual([
      { decision: "decline" }, { decision: "decline" }, { permissions: {}, scope: "turn" },
      { decision: { denied: { rejection: "Website-Review erlaubt nur lesenden Zugriff." } } },
      { decision: { denied: { rejection: "Website-Review erlaubt nur lesenden Zugriff." } } },
      { action: "decline", content: null, _meta: null },
      { code: -32601, message: "Methode wird vom Review-Client nicht unterstützt" },
    ]);
  });
  it("times out pending requests and remains usable", async () => {
    const transport = client();
    await expect(transport.request("silence", {}, { timeoutMs: 25 })).rejects.toThrow("Zeitüberschreitung");
    await expect(transport.request("ping")).resolves.toMatchObject({ pong: true });
  });
  it("rejects pending requests on exit and lazily respawns", async () => {
    const transport = client();
    const exits = vi.fn(); transport.on("exit", exits);
    const results = await Promise.allSettled([transport.request("silence"), transport.request("crash")]);
    expect(results.every((item) => item.status === "rejected")).toBe(true);
    expect(exits).toHaveBeenCalledTimes(1);
    await expect(transport.request("ping")).resolves.toMatchObject({ pong: true });
    await transport.restart();
    await expect(transport.request("ping")).resolves.toMatchObject({ pong: true });
  });
  it("fails malformed protocol data and can respawn", async () => {
    const transport = client();
    await expect(transport.request("malformed")).rejects.toThrow("Protokollnachricht");
    await expect(transport.request("ping")).resolves.toMatchObject({ pong: true });
  });
  it("reports spawn failures without an unhandled error", async () => {
    const transport = new AppServerClient({ command: "/does-not-exist/codex" }); clients.push(transport);
    await expect(transport.request("ping")).rejects.toThrow("nicht gestartet");
  });
});

describe("analysis runner", () => {
  it.each(["normal", "legacy", "completion-items"])("analyzes end to end (%s), including early events and protocol assertions in the fixture", async (mode) => {
    const { runner: analysis, client: transport } = runner(mode);
    const result = await analysis.analyze(input());
    expect(result).toMatchObject({ ok: true, threadId: "thread-1", output: { outcome: "ready", ticket: { title: "Mehr Abstand" } } });
    const transcript = await transport.request<Transcript>("inspect");
    expect(transcript.transcript.find((entry) => entry.method === "turn/start")?.params?.outputSchema).toEqual(analysisOutputJsonSchema);
    expect(transport.listenerCount("notification")).toBe(0);
    expect(transport.listenerCount("exit")).toBe(0);
  });
  it.each(["existing", "missing"])("resumes %s and falls back to start only on failure", async (threadId) => {
    const { runner: analysis, client: transport } = runner();
    const data = input(); data.review.codexThreadId = threadId;
    expect(await analysis.analyze(data)).toMatchObject({ ok: true, threadId: threadId === "existing" ? "existing" : "thread-1" });
    const methods = (await transport.request<Transcript>("inspect")).transcript.map((entry) => entry.method);
    expect(methods).toContain("thread/resume");
    expect(methods.includes("thread/start")).toBe(threadId === "missing");
  });
  it.each(["bad-json", "invalid-output", "failed-turn", "crash-turn"])("returns retryable failure on %s", async (mode) => {
    const { runner: analysis } = runner(mode);
    expect(await analysis.analyze(input())).toMatchObject({ ok: false, retryable: true });
  });
  it("times out a turn and sends turn/interrupt", async () => {
    const { runner: analysis, client: transport } = runner("hang-turn", 1500);
    expect(await analysis.analyze(input())).toMatchObject({ ok: false, retryable: true, error: expect.stringContaining("Zeitüberschreitung") });
    // The interrupt is sent asynchronously (possibly only once turn/start has answered), so poll for it.
    await vi.waitFor(async () => {
      const log = await transport.request<Transcript>("inspect");
      expect(log.transcript).toContainEqual(expect.objectContaining({ method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } }));
    });
  });
  it.each(["hang-turn", "late-start"])("interrupts an aborted turn even with %s", async (mode) => {
    const { runner: analysis, client: transport } = runner(mode);
    const controller = new AbortController();
    const unsubscribe = transport.subscribe((notification) => { if (notification.method === "fixture/turnReceived") controller.abort(); });
    expect(await analysis.analyze({ ...input(), signal: controller.signal })).toMatchObject({ ok: false, retryable: true, error: expect.stringContaining("abgebrochen") });
    await vi.waitFor(async () => {
      expect((await transport.request<Transcript>("inspect")).transcript).toContainEqual(expect.objectContaining({ method: "turn/interrupt" }));
    });
    unsubscribe();
  });
  it("honors an already aborted signal without spawning", async () => {
    const { runner: analysis, client: transport } = runner();
    expect(await analysis.analyze({ ...input(), signal: AbortSignal.abort() })).toMatchObject({ ok: false, retryable: true });
    expect(transport.listenerCount("notification")).toBe(0);
  });
  it("enforces the overall timeout even during initialization", async () => {
    const { runner: analysis } = runner("hang-init", 50);
    expect(await analysis.analyze(input())).toMatchObject({ ok: false, retryable: true, error: expect.stringContaining("Zeitüberschreitung") });
  });
  it("probes the configured command and reports unavailable executables", async () => {
    const { runner: analysis } = runner();
    expect(await analysis.probe()).toEqual({ available: true, version: "codex-cli 0.159.2 (fixture)" });
    const missing = createAnalysisRunner({ command: "/does-not-exist/codex" });
    expect(await missing.probe()).toMatchObject({ available: false, problem: expect.any(String) });
    await missing.close();
  });
  it("requires checkout and comments, and keeps prompts self-contained without gateway secrets", async () => {
    const { runner: analysis } = runner();
    expect(await analysis.analyze({ ...input(), checkouts: [] })).toMatchObject({ ok: false, retryable: false });
    const prompt = buildAnalysisPrompt(input());
    for (const text of ["Testprojekt", "/tmp/frontend", "abcdef0123", "hasUncommittedChanges", "Hier mehr Luft", "staging.test/page", "1000", "Filter", "Ergebnisliste", "Welcher Bereich?", "Filterbereich", "Ähnlicher Wunsch"]) expect(prompt).toContain(text);
    expect(prompt).not.toContain("secret");
    for (const text of ["kan_search_cards", "kan_list_board_cards", "kan_get_card", "tatsächlich gelesene", "qualitativer Wunsch", "Daten", "Pixelwerte"]) expect(developerInstructions).toContain(text);
  });
});

describe("analysis schema", () => {
  const valid = () => ({ outcome: "ready", ticket: { title: "Titel", desiredChange: "Wunsch", openPoints: [], implementationIdeas: [] }, findings: [], questions: [], duplicates: [], mergeWith: [] });
  it("enforces both iff rules in both directions", () => {
    expect(AnalysisOutputSchema.safeParse(valid()).success).toBe(true);
    for (const value of [
      { ...valid(), outcome: "question" }, { ...valid(), questions: ["Was?"] },
      { ...valid(), outcome: "duplicate" }, { ...valid(), duplicates: [{ cardPublicId: "c", reason: "gleich" }] },
      { ...valid(), outcome: "question", questions: ["Was?"], duplicates: [{ cardPublicId: "c", reason: "gleich" }] },
    ]) expect(AnalysisOutputSchema.safeParse(value).success).toBe(false);
    expect(AnalysisOutputSchema.safeParse({ ...valid(), outcome: "question", questions: ["Was?"] }).success).toBe(true);
    expect(AnalysisOutputSchema.safeParse({ ...valid(), outcome: "duplicate", duplicates: [{ cardPublicId: "c", reason: "gleich" }] }).success).toBe(true);
  });
  it("rejects unknown or missing properties and accepts nullable lines", () => {
    expect(AnalysisOutputSchema.safeParse({ ...valid(), extra: true }).success).toBe(false);
    expect(AnalysisOutputSchema.safeParse({ ...valid(), mergeWith: undefined }).success).toBe(false);
    expect(AnalysisOutputSchema.safeParse({ ...valid(), ticket: { ...valid().ticket, priority: "high" } }).success).toBe(false);
    expect(AnalysisOutputSchema.safeParse({ ...valid(), findings: [{ repository: "repo", path: "page.ts", lineStart: null, lineEnd: 10, note: "gefunden" }] }).success).toBe(true);
    function check(node: unknown): void {
      if (!node || typeof node !== "object") return;
      const schema = node as Record<string, unknown>;
      if (schema.type === "object") {
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toEqual(Object.keys(schema.properties as object));
      }
      for (const child of Object.values(schema)) check(child);
    }
    check(analysisOutputJsonSchema);
  });
});
