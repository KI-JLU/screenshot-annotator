import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { AppServerClient, type AppServerClientOptions, type AppServerNotification } from "./appServerClient.ts";
import { AnalysisOutputSchema, analysisOutputJsonSchema } from "./analysisSchema.ts";
import { buildAnalysisPrompt, developerInstructions } from "./prompts.ts";
import type { AnalysisInput, AnalysisResult, AnalysisRunner } from "./types.ts";

export interface AnalysisRunnerOptions extends AppServerClientOptions {
  client?: AppServerClient;
  turnTimeoutMs?: number;
  probeTimeoutMs?: number;
  /** Prefix arguments for wrappers; the normal probe is command --version. */
  probeArgs?: string[];
}
const threadResponse = z.object({ thread: z.object({ id: z.string().min(1) }) });
const turnResponse = z.object({ turn: z.object({ id: z.string().min(1) }) });
const agentMessage = z.object({ type: z.literal("agentMessage"), text: z.string(), phase: z.enum(["commentary", "final_answer"]).nullish() });
const itemEvent = z.object({ threadId: z.string(), turnId: z.string(), item: z.unknown() });
const completedEvent = z.object({ threadId: z.string(), turn: z.object({
  id: z.string(), status: z.string(), items: z.array(z.unknown()).optional(),
}) });

export function createAnalysisRunner(options: AnalysisRunnerOptions = {}): AnalysisRunner {
  const client = options.client ?? new AppServerClient(options);
  let queue: Promise<unknown> = Promise.resolve();

  async function run(input: AnalysisInput): Promise<AnalysisResult> {
    let threadId: string | undefined;
    let turnId: string | undefined;
    let cancelled = false;
    let interrupted = false;
    const controller = new AbortController();
    let rejectCancelled!: (error: Error) => void;
    const cancellation = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    // Cancellation can happen during thread creation, before the turn starts waiting for it.
    void cancellation.catch(() => undefined);
    const interrupt = () => {
      if (!threadId || !turnId || interrupted) return;
      interrupted = true;
      void client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    };
    const cancel = (message: string) => {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
      interrupt();
      rejectCancelled(new Error(message));
    };
    const abort = () => cancel("Codex-Analyse abgebrochen.");
    const timer = setTimeout(() => cancel("Zeitüberschreitung bei der Codex-Analyse."), options.turnTimeoutMs ?? 15 * 60_000);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    let unsubscribe = () => {};
    let onExit: ((error: Error) => void) | undefined;
    try {
      if (cancelled) return { ok: false, error: "Codex-Analyse abgebrochen.", retryable: true };
      const first = input.checkouts[0];
      if (!first || input.checkouts.some((checkout) => !isAbsolute(checkout.path)) || !input.comments.length) {
        return { ok: false, error: "Für die Analyse fehlen Kommentare oder absolute Checkout-Pfade.", retryable: false };
      }
      const settings = {
        cwd: first.path, sandbox: "read-only", approvalPolicy: "never", developerInstructions,
        config: { mcp_servers: { review: input.gateway } },
      };
      const requestThread = (method: string, params: unknown) => Promise.race([
        client.request(method, params, { signal: controller.signal }), cancellation,
      ]);
      if (input.review.codexThreadId) {
        try {
          threadId = threadResponse.parse(await requestThread("thread/resume", { ...settings, threadId: input.review.codexThreadId })).thread.id;
        } catch (error) { if (cancelled) throw error; }
      }
      if (!threadId) threadId = threadResponse.parse(await requestThread("thread/start", settings)).thread.id;

      let finalText: string | undefined;
      let legacyText: string | undefined;
      const buffered: AppServerNotification[] = [];
      let resolveTurn!: (text: string) => void;
      let rejectTurn!: (error: Error) => void;
      const finished = new Promise<string>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
      void finished.catch(() => undefined);
      const record = (item: unknown) => {
        const parsed = agentMessage.safeParse(item);
        if (!parsed.success) return;
        if (parsed.data.phase === "final_answer") finalText = parsed.data.text;
        else if (parsed.data.phase == null) legacyText = parsed.data.text;
      };
      const receive = (event: AppServerNotification) => {
        if (event.method !== "item/completed" && event.method !== "turn/completed") return;
        if (!turnId) { buffered.push(event); return; }
        if (event.method === "item/completed") {
          const parsed = itemEvent.safeParse(event.params);
          if (parsed.success && parsed.data.threadId === threadId && parsed.data.turnId === turnId) record(parsed.data.item);
        } else {
          const parsed = completedEvent.safeParse(event.params);
          if (!parsed.success || parsed.data.threadId !== threadId || parsed.data.turn.id !== turnId) return;
          if (parsed.data.turn.status !== "completed") {
            rejectTurn(new Error("Codex hat die Analyse nicht erfolgreich abgeschlossen."));
            return;
          }
          for (const item of parsed.data.turn.items ?? []) record(item);
          const text = finalText ?? legacyText;
          if (text === undefined) rejectTurn(new Error("Codex hat keine abschließende Analyse geliefert."));
          else resolveTurn(text);
        }
      };
      unsubscribe = client.subscribe(receive);
      onExit = () => rejectTurn(new Error("Die Verbindung zu Codex wurde während der Analyse beendet."));
      client.on("exit", onExit);
      const start = client.request("turn/start", {
        threadId,
        input: [
          { type: "text", text: buildAnalysisPrompt(input), text_elements: [] },
          ...input.comments.flatMap((comment) => comment.imagePath ? [{ type: "localImage", path: comment.imagePath }] : []),
        ],
        outputSchema: analysisOutputJsonSchema,
      }).then((response) => {
        turnId = turnResponse.parse(response).turn.id;
        // An abort may precede the turn/start response. Interrupt as soon as the id is known.
        if (cancelled) interrupt();
        else for (const event of buffered) receive(event);
        buffered.length = 0;
      });
      await Promise.race([start, cancellation, finished.then(() => undefined)]);
      const text = await Promise.race([finished, cancellation]);
      let output;
      try { output = AnalysisOutputSchema.parse(JSON.parse(text)); }
      catch { return { ok: false, threadId, error: "Codex hat eine ungültige Analyse geliefert. Bitte erneut versuchen.", retryable: true }; }
      if (input.comments.length > 1 && output.mergeWith.length) {
        return { ok: false, threadId, error: "Codex hat für eine bestätigte Zusammenfassung weitere Zusammenfassungen vorgeschlagen.", retryable: true };
      }
      return { ok: true, threadId, output };
    } catch (error) {
      return { ok: false, threadId, error: error instanceof z.ZodError ? "Codex hat eine ungültige Protokollantwort geliefert." : error instanceof Error ? error.message : "Codex-Analyse fehlgeschlagen.", retryable: true };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      unsubscribe();
      if (onExit) client.off("exit", onExit);
    }
  }
  return {
    analyze(input) {
      // Avoid competing turns in one review thread, including after a resumed analysis.
      const result = queue.then(() => run(input));
      queue = result.catch(() => undefined);
      return result;
    },
    probe() {
      return new Promise((resolve) => {
        execFile(options.command ?? "codex", [...(options.probeArgs ?? []), "--version"], {
          env: { ...process.env, ...options.env }, timeout: options.probeTimeoutMs ?? 10_000, maxBuffer: 64 * 1024,
        }, (error, stdout) => {
          if (error) resolve({ available: false, problem: "Codex ist nicht erreichbar oder antwortet nicht." });
          else resolve({ available: true, version: stdout.trim() });
        });
      });
    },
    close: () => client.close(),
  };
}
