/**
 * Background service worker: opens the side panel on action click, injects the capture overlay on
 * demand and takes the screenshot once the overlay has removed itself.
 *
 * The worker may be suspended while the user is choosing an element, so no capture state is kept in
 * memory: the overlay's selection message carries everything needed.
 */
import {
  SESSION_CAPTURE_KEY,
  isPermissionError,
  type CaptureResult,
  type ContentToWorker,
  type OverlaySelection,
  type PanelToWorker,
  type StartCaptureResponse,
  type WorkerBroadcast,
  type WorkerToContent,
} from "../lib/messages.ts";

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e: unknown) => {
  console.error("setPanelBehavior failed", e);
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

function broadcast(msg: WorkerBroadcast): void {
  // No receiver when the side panel is closed; the result is also kept in storage.session.
  chrome.runtime.sendMessage(msg).catch(() => undefined);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function startCapture(tabId: number, mode: OverlaySelection["mode"]): Promise<StartCaptureResponse> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (e) {
    const message = messageOf(e);
    return {
      ok: false,
      permissionProblem: isPermissionError(message),
      error: `Die Markierung kann auf dieser Seite nicht gestartet werden: ${message}`,
    };
  }
  try {
    const msg: WorkerToContent = { type: "overlay/start", mode };
    await chrome.tabs.sendMessage(tabId, msg);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Markiermodus konnte nicht gestartet werden: ${messageOf(e)}` };
  }
}

async function cancelCapture(tabId: number): Promise<void> {
  const msg: WorkerToContent = { type: "overlay/cancel" };
  await chrome.tabs.sendMessage(tabId, msg).catch(() => undefined);
}

async function takeScreenshot(selection: OverlaySelection, tab: chrome.tabs.Tab | undefined): Promise<void> {
  if (!tab?.id || tab.windowId === undefined) {
    broadcast({ type: "capture/error", message: "Tab der Markierung nicht gefunden.", permissionProblem: false });
    return;
  }
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (e) {
    const message = messageOf(e);
    const permissionProblem = isPermissionError(message);
    broadcast({
      type: "capture/error",
      // Chrome allows captureVisibleTab only with <all_urls> or activeTab (granted by clicking the
      // toolbar icon on that tab); a per-site host permission is not enough.
      message: permissionProblem
        ? "Screenshot nicht erlaubt: Chrome erlaubt Screenshots nur mit Zugriff auf alle Websites oder direkt nach einem Klick auf das Symbol der Extension in diesem Tab. Bitte Zugriff erlauben und erneut markieren."
        : `Screenshot fehlgeschlagen: ${message}`,
      permissionProblem,
    });
    return;
  }
  const result: CaptureResult = {
    ...selection,
    id: crypto.randomUUID(),
    tabId: tab.id,
    windowId: tab.windowId,
    dataUrl,
    capturedAt: new Date().toISOString(),
  };
  try {
    await chrome.storage.session.set({ [SESSION_CAPTURE_KEY]: result });
  } catch (e) {
    // Quota exceeded for very large screenshots: the open side panel still gets the message.
    console.warn("Capture could not be stored in session storage", e);
  }
  broadcast({ type: "capture/result", result });
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg = raw as PanelToWorker | ContentToWorker;
  switch (msg?.type) {
    case "capture/start":
      void startCapture(msg.tabId, msg.mode).then(sendResponse);
      return true;
    case "capture/cancel":
      void cancelCapture(msg.tabId).then(() => sendResponse({ ok: true }));
      return true;
    case "overlay/selected":
      void takeScreenshot(msg.selection, sender.tab);
      return false;
    case "overlay/cancelled":
      broadcast({ type: "capture/cancelled" });
      return false;
    default:
      return false;
  }
});
