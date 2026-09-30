import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

export interface AppServerClientOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}
export interface AppServerNotification { method: string; params: unknown }
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void }

/** One initialized stdio connection. Notifications emit as { method, params }; exits emit an Error. */
export class AppServerClient extends EventEmitter {
  readonly options: AppServerClientOptions;
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(options: AppServerClientOptions = {}) {
    super();
    this.options = options;
  }

  subscribe(listener: (notification: AppServerNotification) => void): () => void {
    this.on("notification", listener);
    return () => { this.off("notification", listener); };
  }

  async request<T = unknown>(method: string, params: unknown = {}, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (options.signal?.aborted) throw new Error("Codex-Anfrage abgebrochen");
    await this.connect();
    if (options.signal?.aborted) throw new Error("Codex-Anfrage abgebrochen");
    return this.sendRequest(method, params, options) as Promise<T>;
  }

  private connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex-Verbindung ist geschlossen"));
    if (this.ready) return this.ready;
    const child = spawn(this.options.command ?? "codex", this.options.args ?? ["app-server"], {
      env: { ...process.env, ...this.options.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (this.child !== child || !line.trim()) return;
      try { this.receive(JSON.parse(line)); }
      catch { this.fail(child, new Error("Ungültige Codex-Protokollnachricht")); child.kill(); }
    });
    child.stderr.resume(); // Drain diagnostics without copying potentially sensitive content into errors.
    child.stdin.on("error", () => { this.fail(child, new Error("Codex-Eingabekanal geschlossen")); child.kill(); });
    child.on("error", () => this.fail(child, new Error("Codex-App-Server konnte nicht gestartet werden")));
    child.on("exit", (code, signal) => {
      lines.close();
      this.fail(child, new Error(`Codex-App-Server beendet (${signal ?? code ?? "unbekannt"})`));
    });
    const ready = this.sendRequest("initialize", {
      clientInfo: { name: "website-review-companion", title: "Website Review Companion", version: "0.1.0" },
      capabilities: null,
    }).then(() => {
      if (this.child !== child) throw new Error("Codex-Verbindung beendet");
      this.write({ method: "initialized" });
    }).catch((error: unknown) => {
      this.fail(child, error instanceof Error ? error : new Error("Codex-Initialisierung fehlgeschlagen"));
      child.kill();
      throw error;
    });
    this.ready = ready;
    return ready;
  }

  private write(message: unknown): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error("Codex-Verbindung fehlt");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private sendRequest(method: string, params: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const finish = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        reject(error);
      };
      const timer = setTimeout(() => finish(new Error(`Zeitüberschreitung bei Codex (${method})`)),
        options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000);
      const abort = () => finish(new Error("Codex-Anfrage abgebrochen"));
      this.pending.set(id, { resolve, reject, cleanup: () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      } });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      try { this.write({ id, method, params }); }
      catch (error) { finish(error instanceof Error ? error : new Error("Codex-Anfrage fehlgeschlagen")); }
    });
  }

  private receive(message: unknown): void {
    if (typeof message !== "object" || message === null || Array.isArray(message)) throw new Error("Ungültige Nachricht");
    const data = message as Record<string, unknown>;
    if (typeof data.method === "string") {
      if (typeof data.id === "number" || typeof data.id === "string") {
        const result = approvalDenial(data.method);
        this.write(result === undefined
          ? { id: data.id, error: { code: -32601, message: "Methode wird vom Review-Client nicht unterstützt" } }
          : { id: data.id, result });
      } else this.emit("notification", { method: data.method, params: data.params });
      return;
    }
    if (typeof data.id !== "number") return;
    const pending = this.pending.get(data.id);
    if (!pending) return; // Late response to a timed-out request.
    this.pending.delete(data.id);
    pending.cleanup();
    if (data.error !== undefined) pending.reject(new Error("Codex-Anfrage vom Server abgelehnt"));
    else if ("result" in data) pending.resolve(data.result);
    else pending.reject(new Error("Ungültige Codex-Antwort"));
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.ready = undefined;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    this.emit("exit", error);
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    this.fail(child, new Error("Codex-Verbindung geschlossen"));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 500);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  }

  async restart(): Promise<void> {
    await this.close();
    this.closed = false;
    await this.connect();
  }
}

// Values follow the generated 0.159.2 response types, including the legacy denial object.
function approvalDenial(method: string): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": return { decision: "decline" };
    case "execCommandApproval":
    case "applyPatchApproval": return { decision: { denied: { rejection: "Website-Review erlaubt nur lesenden Zugriff." } } };
    case "item/permissions/requestApproval": return { permissions: {}, scope: "turn" };
    case "mcpServer/elicitation/request": return { action: "decline", content: null, _meta: null };
    default: return undefined;
  }
}

export function createAppServerClient(options: AppServerClientOptions = {}): AppServerClient {
  return new AppServerClient(options);
}
