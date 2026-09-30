/**
 * Side panel end of the worker multiplexer (see background/nativeHost.ts): one chrome.runtime.connect
 * port per panel, request/response correlation by id, companion events and host status.
 */
import type { CompanionEvent, NativeMethod, NativeResponse } from "@website-review/shared";
import { CompanionError } from "./api.ts";
import {
  PANEL_PORT_NAME,
  PendingRequests,
  makeRequest,
  type HostStatus,
  type PanelToWorkerMessage,
  type WorkerToPanelMessage,
} from "./nativeTransport.ts";

/** What CompanionClient needs from a transport. */
export interface Transport {
  request(method: NativeMethod, path: string, body: unknown, timeoutMs: number): Promise<NativeResponse>;
}

interface Waiting {
  resolve: (r: NativeResponse) => void;
  reject: (e: CompanionError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PanelConnection implements Transport {
  private port: chrome.runtime.Port | null = null;
  private readonly pending = new PendingRequests<Waiting>();
  private readonly statusListeners = new Set<(s: HostStatus) => void>();
  private readonly eventListeners = new Set<(e: CompanionEvent) => void>();
  private disposed = false;
  private reopenTimer: ReturnType<typeof setTimeout> | undefined;
  status: HostStatus = { state: "connecting" };

  constructor() {
    this.open();
  }

  private open(): chrome.runtime.Port {
    const port = chrome.runtime.connect({ name: PANEL_PORT_NAME });
    this.port = port;
    port.onMessage.addListener((msg: unknown) => this.onMessage(msg as WorkerToPanelMessage));
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      // The worker restarted or the extension reloaded: fail what is in flight and reattach.
      for (const [, w] of this.pending.drain()) {
        clearTimeout(w.timer);
        w.reject(new CompanionError(0, "unavailable", "Verbindung zum Hintergrunddienst der Extension unterbrochen. Bitte erneut versuchen."));
      }
      if (!this.disposed) this.reopenTimer = setTimeout(() => this.open(), 500);
    });
    return port;
  }

  private onMessage(msg: WorkerToPanelMessage): void {
    switch (msg?.type) {
      case "response": {
        const w = this.pending.take(msg.id);
        if (w) {
          clearTimeout(w.timer);
          w.resolve(msg);
        }
        return;
      }
      case "transport_error": {
        const w = this.pending.take(msg.id);
        if (w) {
          clearTimeout(w.timer);
          w.reject(new CompanionError(0, "unavailable", msg.message));
        }
        return;
      }
      case "event":
        for (const fn of this.eventListeners) fn(msg.event);
        return;
      case "status":
        this.status = msg.status;
        for (const fn of this.statusListeners) fn(msg.status);
    }
  }

  private send(msg: PanelToWorkerMessage): void {
    const port = this.port ?? this.open();
    port.postMessage(msg);
  }

  request(method: NativeMethod, path: string, body: unknown, timeoutMs: number): Promise<NativeResponse> {
    const id = crypto.randomUUID();
    return new Promise<NativeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.take(id)) return;
        try {
          this.send({ type: "abandon", id });
        } catch {
          /* port gone */
        }
        reject(new CompanionError(0, "timeout", "Zeitüberschreitung bei der Anfrage an den Begleitdienst."));
      }, timeoutMs);
      this.pending.add(id, { resolve, reject, timer });
      try {
        this.send(makeRequest(id, method, path, body));
      } catch (e) {
        this.pending.take(id);
        clearTimeout(timer);
        reject(new CompanionError(0, "unavailable", `Anfrage konnte nicht gesendet werden: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  /** Asks the worker to reconnect to the native host now (resets the backoff). */
  reconnect(): void {
    try {
      this.send({ type: "reconnect" });
    } catch {
      /* reopened on next request */
    }
  }

  onStatus(fn: (s: HostStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  onEvent(fn: (e: CompanionEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.reopenTimer);
    this.port?.disconnect();
    this.port = null;
  }
}
