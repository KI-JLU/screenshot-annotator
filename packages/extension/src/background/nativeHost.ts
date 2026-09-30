/**
 * Owns the single chrome.runtime.connectNative port to the companion and multiplexes it for all
 * side panels (chrome.runtime.connect, name PANEL_PORT_NAME).
 *
 * - Connects lazily when a panel connects or sends a request; stays connected while Chrome runs
 *   (an open native port keeps the MV3 worker alive).
 * - Requests are forwarded unchanged; responses (reassembled from chunks) go back to the panel that
 *   sent the request; events and host status go to every panel.
 * - On disconnect: pending requests fail with a German message, panels get the status, and the worker
 *   reconnects with backoff while panels are open, or immediately on "reconnect" / the next request.
 */
import { NATIVE_HOST_NAME, type NativeRequest } from "@website-review/shared";
import {
  ChunkAssembler,
  PANEL_PORT_NAME,
  PendingRequests,
  backoffMs,
  routeFrame,
  statusFromDisconnect,
  statusFromHello,
  transportFailureMessage,
  type HostStatus,
  type PanelToWorkerMessage,
  type WorkerToPanelMessage,
} from "../lib/nativeTransport.ts";

type Port = chrome.runtime.Port;

class NativeHostBridge {
  private native: Port | null = null;
  private readonly panels = new Set<Port>();
  private readonly pending = new PendingRequests<Port>();
  private readonly chunks = new ChunkAssembler();
  private status: HostStatus = { state: "connecting" };
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  attachPanel(port: Port): void {
    this.panels.add(port);
    port.onMessage.addListener((msg: unknown) => this.onPanelMessage(port, msg as PanelToWorkerMessage));
    port.onDisconnect.addListener(() => {
      this.panels.delete(port);
      this.pending.removeWhere((p) => p === port);
    });
    this.post(port, { type: "status", status: this.status });
    this.ensureConnected();
  }

  private post(port: Port, msg: WorkerToPanelMessage): void {
    try {
      port.postMessage(msg);
    } catch {
      // Panel closed in the meantime.
      this.panels.delete(port);
    }
  }

  private setStatus(status: HostStatus): void {
    this.status = status;
    for (const p of this.panels) this.post(p, { type: "status", status });
  }

  private ensureConnected(): void {
    if (this.native) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.connect();
  }

  private connect(): void {
    this.setStatus({ state: "connecting" });
    let port: Port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      this.onDisconnected(e instanceof Error ? e.message : String(e));
      return;
    }
    this.native = port;
    port.onMessage.addListener((frame: unknown) => this.onFrame(frame));
    port.onDisconnect.addListener(() => {
      // Must be read inside the listener, otherwise Chrome logs "Unchecked runtime.lastError".
      const detail = chrome.runtime.lastError?.message;
      if (this.native !== port) return;
      this.native = null;
      this.onDisconnected(detail);
    });
  }

  private onFrame(frame: unknown): void {
    const routed = routeFrame(frame, this.chunks);
    switch (routed.kind) {
      case "response": {
        const panel = this.pending.take(routed.response.id);
        if (panel) this.post(panel, routed.response);
        return;
      }
      case "hello":
        this.attempt = 0;
        this.setStatus(statusFromHello(routed.hello));
        return;
      case "event":
        for (const p of this.panels) this.post(p, { type: "event", event: routed.event });
        return;
      case "pending":
        return;
      case "error": {
        console.warn("Ungültige Nachricht vom Begleitdienst:", routed.message);
        const panel = routed.id ? this.pending.take(routed.id) : undefined;
        if (panel && routed.id) {
          this.post(panel, { type: "transport_error", id: routed.id, message: `Ungültige Antwort des Begleitdienstes: ${routed.message}` });
        }
      }
    }
  }

  private onDisconnected(detail: string | undefined): void {
    this.chunks.clear();
    const status = statusFromDisconnect(detail);
    const message = transportFailureMessage(status);
    for (const [id, panel] of this.pending.drain()) this.post(panel, { type: "transport_error", id, message });
    if (this.panels.size === 0) {
      this.setStatus(status);
      return;
    }
    const delay = backoffMs(this.attempt++);
    this.setStatus(status.state === "disconnected" ? { ...status, retryInMs: delay } : status);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.panels.size > 0) this.ensureConnected();
    }, delay);
  }

  private onPanelMessage(panel: Port, msg: PanelToWorkerMessage): void {
    switch (msg?.type) {
      case "request":
        this.forward(panel, msg);
        return;
      case "abandon":
        this.pending.take(msg.id);
        return;
      case "reconnect":
        this.attempt = 0;
        if (this.native && this.status.state === "problem") {
          // The other profile may be gone now: restart the host process.
          const old = this.native;
          this.native = null;
          old.disconnect();
          this.connect();
        } else if (this.native) {
          this.post(panel, { type: "status", status: this.status });
        } else {
          this.ensureConnected();
        }
    }
  }

  private forward(panel: Port, req: NativeRequest): void {
    this.ensureConnected();
    const native = this.native;
    if (!native) {
      this.post(panel, { type: "transport_error", id: req.id, message: transportFailureMessage(this.status) });
      return;
    }
    try {
      this.pending.add(req.id, panel);
    } catch (e) {
      this.post(panel, { type: "transport_error", id: req.id, message: String(e) });
      return;
    }
    try {
      native.postMessage(req);
    } catch (e) {
      this.pending.take(req.id);
      this.post(panel, {
        type: "transport_error",
        id: req.id,
        message: `Anfrage konnte nicht an den Begleitdienst gesendet werden: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}

export function installNativeHostBridge(): void {
  const bridge = new NativeHostBridge();
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === PANEL_PORT_NAME) bridge.attachPanel(port);
  });
}
