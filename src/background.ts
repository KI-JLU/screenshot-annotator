/**
 * Service worker. The toolbar icon (or Alt+Shift+S) injects the overlay into the active tab; that
 * click grants activeTab, which is what allows captureVisibleTab without host permissions.
 */
import type { CaptureResponse, ContentToWorker, WorkerToContent } from "./lib/messages.ts";

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function flagError(tabId: number, message: string): Promise<void> {
  console.warn(message);
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#e11d2e" });
  await chrome.action.setBadgeText({ tabId, text: "!" });
  await chrome.action.setTitle({ tabId, title: message });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const msg: WorkerToContent = { type: "overlay/start" };
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // chrome://, the Web Store and similar pages refuse script injection.
    await flagError(tab.id, `Cannot mark on this page: ${messageOf(e)}`);
  }
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse: (r: CaptureResponse) => void) => {
  const msg = raw as ContentToWorker;
  if (msg?.type !== "capture" || sender.tab?.windowId === undefined) return false;
  chrome.tabs
    .captureVisibleTab(sender.tab.windowId, { format: "png" })
    .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
    .catch((e: unknown) => sendResponse({ ok: false, error: messageOf(e) }));
  return true;
});
