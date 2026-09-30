import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { EXTENSION_ID, type NativeOutgoing } from "@website-review/shared";
import { createApp, VERSION, type CompanionApp } from "../app.ts";
import { createKanClient } from "../kan/kanClient.ts";
import { getPaths } from "../paths.ts";
import { FrameDecoder, outgoingFrames } from "./codec.ts";
import { acquireLock } from "./lock.ts";
import { errorResponse } from "../http/router.ts";

const requestSchema = z.object({ type: z.literal("request"), id: z.string(), method: z.enum(["GET", "POST", "PUT", "DELETE"]), path: z.string(), body: z.unknown().optional() });
export const INSTANCE_PROBLEM = "Der Begleitdienst läuft bereits in einem anderen Browserprofil. Bitte schließen Sie dort die Verbindung und versuchen Sie es erneut.";
export function verifyCaller(origin: string | undefined): void {
  // The launcher pins the id chosen at install time (install-native-host --extension-id).
  const allowed = process.env.WEBSITE_REVIEW_EXTENSION_ID || EXTENSION_ID;
  if (origin !== `chrome-extension://${allowed}/`) throw new Error("Unzulässiger Aufrufer des Native-Messaging-Hosts");
}

/** The stream owns the app lifetime. Requests may complete in a different order. */
export async function runHostLoop(input: Readable, output: Writable, app?: Pick<CompanionApp, "events" | "dispatch" | "start" | "stop">, problem?: string): Promise<void> {
  let closed = false;
  const pending = new Set<Promise<void>>();
  let writeQueue = Promise.resolve();
  const send = (message: NativeOutgoing) => {
    writeQueue = writeQueue.then(async () => {
      if (output.destroyed) return;
      for (const frame of outgoingFrames(message)) {
        await new Promise<void>((resolve, reject) => output.write(frame, (error) => error ? reject(error) : resolve()));
      }
    });
    void writeQueue.catch(() => finish());
  };
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => { finish = () => { if (!closed) { closed = true; input.pause(); resolve(); } }; });
  const onError = () => finish();
  input.on("error", onError); output.on("error", onError);
  input.once("end", finish); input.once("close", finish);
  const unsubscribe = app?.events.subscribe((event) => send({ type: "event", event }));
  send({ type: "hello", version: VERSION, ...(problem ? { problem, problemCode: "locked" as const } : {}) });
  const ready = app?.start() ?? Promise.resolve();
  void ready.catch(() => {
    send({ type: "hello", version: VERSION, problem: "Der Begleitdienst konnte nicht gestartet werden. Bitte prüfen Sie das Fehlerprotokoll.", problemCode: "startup_failed" });
    finish();
  });
  const decoder = new FrameDecoder((message, frameLength) => {
    const parsed = requestSchema.safeParse(message);
    if (!parsed.success) throw new Error("Ungültige Native-Messaging-Anfrage");
    const req = parsed.data;
    const work = (async () => {
      await ready;
      const result = app ? await app.dispatch(req, frameLength) : { status: 503, body: { error: { code: "internal", message: problem ?? INSTANCE_PROBLEM } } };
      send({ type: "response", id: req.id, ...result });
    })().catch((error) => send({ type: "response", id: req.id, ...errorResponse(error) }));
    pending.add(work); void work.finally(() => pending.delete(work));
  });
  const data = (chunk: Buffer) => { try { decoder.push(chunk); } catch { finish(); } };
  input.on("data", data);
  const signal = () => finish();
  process.once("SIGINT", signal); process.once("SIGTERM", signal);
  try {
    await ended;
    await ready.catch(() => {});
    await Promise.allSettled(pending);
    await writeQueue.catch(() => {});
  } finally {
    unsubscribe?.(); input.off("data", data); input.off("error", onError); input.off("end", finish); input.off("close", finish);
    process.off("SIGINT", signal); process.off("SIGTERM", signal);
    try { await app?.stop(); } finally { output.off("error", onError); }
  }
}

export async function startNativeHost(origin: string | undefined): Promise<void> {
  verifyCaller(origin);
  const paths = getPaths();
  const release = acquireLock(paths.runtimeDir);
  if (!release) { await runHostLoop(process.stdin, process.stdout, undefined, INSTANCE_PROBLEM); return; }
  process.once("exit", release);
  try {
    const app = createApp({ ...paths, kanClientFactory: createKanClient, cliPath: process.argv[1] });
    await runHostLoop(process.stdin, process.stdout, app);
  } finally { release(); process.off("exit", release); }
}
