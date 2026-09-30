/**
 * Pure pieces of the Native Messaging transport (no chrome.* access; unit-tested):
 * - ChunkAssembler: reassembles NativeChunk frames into the NativeResponse they encode.
 * - PendingRequests: correlates responses with requests by id.
 * - routeFrame: classifies incoming host frames.
 * - Worker ↔ side panel message protocol and host status.
 */
import type {
  CompanionEvent,
  NativeChunk,
  NativeHello,
  NativeMethod,
  NativeOutgoing,
  NativeRequest,
  NativeResponse,
} from "@website-review/shared";

/** runtime.connect port name used by side panels to reach the worker. */
export const PANEL_PORT_NAME = "companion";

/** Exact lastError text Chrome reports when no host manifest is installed. */
export const HOST_NOT_FOUND = "Specified native messaging host not found.";

// ---------- Host status (worker → panels) ----------

export type HostStatus =
  | { state: "connecting" }
  | { state: "connected"; version: string }
  /** hello.problem: this host process cannot serve, e.g. another browser profile runs the companion. */
  | { state: "problem"; version: string; problem: string; problemCode?: NativeHello["problemCode"] }
  | { state: "not_installed"; detail: string }
  | { state: "disconnected"; detail: string; retryInMs?: number };

export function statusFromHello(hello: NativeHello): HostStatus {
  return hello.problem
    ? { state: "problem", version: hello.version, problem: hello.problem, problemCode: hello.problemCode }
    : { state: "connected", version: hello.version };
}

/** Classifies chrome.runtime.lastError of a native port disconnect. */
export function statusFromDisconnect(lastError: string | undefined): HostStatus {
  const detail = lastError ?? "Native host has exited.";
  if (detail.includes(HOST_NOT_FOUND) || /native messaging host not found/i.test(detail)) {
    return { state: "not_installed", detail };
  }
  return { state: "disconnected", detail };
}

/** German message for requests that failed because the host went away. */
export function transportFailureMessage(status: HostStatus): string {
  switch (status.state) {
    case "not_installed":
      return "Der Begleitdienst ist nicht installiert. Bitte „install-native-host“ ausführen und erneut versuchen.";
    case "problem":
      return `Der Begleitdienst ist nicht bereit: ${status.problem}`;
    case "disconnected":
      return `Die Verbindung zum Begleitdienst wurde unterbrochen (${status.detail}). Bitte erneut versuchen.`;
    default:
      return "Die Verbindung zum Begleitdienst wurde unterbrochen. Bitte erneut versuchen.";
  }
}

/** Reconnect delays: 1 s, 2 s, 4 s … capped at 30 s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}

// ---------- Panel ↔ worker protocol ----------

export type PanelToWorkerMessage =
  | NativeRequest
  | { type: "reconnect" }
  /** Panel gave up waiting (timeout): the worker forgets the request. */
  | { type: "abandon"; id: string };

export type WorkerToPanelMessage =
  | NativeResponse
  | { type: "event"; event: CompanionEvent }
  | { type: "status"; status: HostStatus }
  /** The request could not be delivered or the host went away before answering. */
  | { type: "transport_error"; id: string; message: string };

export function makeRequest(id: string, method: NativeMethod, path: string, body?: unknown): NativeRequest {
  const req: NativeRequest = { type: "request", id, method, path };
  if (body !== undefined) req.body = body;
  return req;
}

// ---------- Chunk reassembly ----------

export type ChunkResult =
  | { kind: "pending" }
  | { kind: "complete"; response: NativeResponse }
  | { kind: "error"; id: string; message: string };

interface ChunkParts {
  count: number;
  parts: (string | undefined)[];
  received: number;
}

export class ChunkAssembler {
  private readonly partial = new Map<string, ChunkParts>();

  push(chunk: NativeChunk): ChunkResult {
    const { id, index, count } = chunk;
    if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) {
      this.partial.delete(id);
      return { kind: "error", id, message: `Ungültiges Teilstück ${index}/${count}` };
    }
    let p = this.partial.get(id);
    if (!p) {
      p = { count, parts: new Array<string | undefined>(count).fill(undefined), received: 0 };
      this.partial.set(id, p);
    } else if (p.count !== count) {
      this.partial.delete(id);
      return { kind: "error", id, message: `Teilstückanzahl geändert (${p.count} → ${count})` };
    }
    if (p.parts[index] === undefined) p.received++;
    p.parts[index] = chunk.data;
    if (p.received < p.count) return { kind: "pending" };
    this.partial.delete(id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(p.parts.join(""));
    } catch {
      return { kind: "error", id, message: "Zusammengesetzte Antwort ist kein JSON" };
    }
    const response = parsed as Partial<NativeResponse> | null;
    if (!response || response.type !== "response" || response.id !== id || typeof response.status !== "number") {
      return { kind: "error", id, message: "Zusammengesetzte Antwort ist keine gültige Antwort" };
    }
    return { kind: "complete", response: response as NativeResponse };
  }

  /** Discards partial data, e.g. after a disconnect. */
  clear(): void {
    this.partial.clear();
  }

  get inProgress(): number {
    return this.partial.size;
  }
}

// ---------- Request correlation ----------

export class PendingRequests<T> {
  private readonly entries = new Map<string, T>();

  add(id: string, entry: T): void {
    if (this.entries.has(id)) throw new Error(`Doppelte Anfrage-ID ${id}`);
    this.entries.set(id, entry);
  }

  /** Returns and removes the entry for a response; undefined for unknown/late ids. */
  take(id: string): T | undefined {
    const e = this.entries.get(id);
    this.entries.delete(id);
    return e;
  }

  /** Removes entries matching a predicate (e.g. all requests of a closed panel). */
  removeWhere(pred: (entry: T, id: string) => boolean): void {
    for (const [id, e] of this.entries) if (pred(e, id)) this.entries.delete(id);
  }

  /** Returns and removes all entries, e.g. to fail them after a disconnect. */
  drain(): [string, T][] {
    const all = [...this.entries];
    this.entries.clear();
    return all;
  }

  get size(): number {
    return this.entries.size;
  }
}

// ---------- Incoming host frames ----------

export type RoutedFrame =
  | { kind: "response"; response: NativeResponse }
  | { kind: "event"; event: CompanionEvent }
  | { kind: "hello"; hello: NativeHello }
  | { kind: "pending" }
  | { kind: "error"; id?: string; message: string };

/** Classifies one host frame; chunks are fed into the assembler. */
export function routeFrame(frame: unknown, chunks: ChunkAssembler): RoutedFrame {
  const f = frame as NativeOutgoing | null;
  switch (f?.type) {
    case "response":
      return typeof f.id === "string" && typeof f.status === "number"
        ? { kind: "response", response: f }
        : { kind: "error", message: "Antwort ohne id/status" };
    case "chunk": {
      const r = chunks.push(f);
      if (r.kind === "complete") return { kind: "response", response: r.response };
      if (r.kind === "error") return { kind: "error", id: r.id, message: r.message };
      return { kind: "pending" };
    }
    case "event":
      return f.event && typeof f.event.type === "string"
        ? { kind: "event", event: f.event }
        : { kind: "error", message: "Ereignis ohne Typ" };
    case "hello":
      return { kind: "hello", hello: f };
    default:
      return { kind: "error", message: "Unbekannter Nachrichtentyp" };
  }
}

/** Splits a serialized response like the companion does (used in tests). */
export function splitIntoChunks(response: NativeResponse, maxBytes: number): NativeChunk[] {
  const json = JSON.stringify(response);
  const count = Math.max(1, Math.ceil(json.length / maxBytes));
  return Array.from({ length: count }, (_, index) => ({
    type: "chunk" as const,
    id: response.id,
    index,
    count,
    data: json.slice(index * maxBytes, (index + 1) * maxBytes),
  }));
}
