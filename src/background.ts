/**
 * Service worker. The toolbar icon (or Alt+Shift+S) injects the overlay into the active tab; that
 * click grants activeTab, which is what allows captureVisibleTab without host permissions.
 * It also makes the T3 Code calls, so the token never reaches a web page.
 */
import type { CaptureResponse, ContentToWorker, T3ProjectsResponse, T3SendResponse, WorkerToContent } from "./lib/messages.ts";
import { MAX_IMAGE_BYTES, projectsByRecency, threadCommands, threadDefaults } from "./lib/t3.ts";
import { dispatch, fetchShell, lastProject, loadConnection, rememberProject } from "./lib/t3client.ts";

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

async function t3Projects(host: string): Promise<T3ProjectsResponse> {
  const connection = await loadConnection();
  if (!connection) return { state: "disconnected" };
  try {
    const projects = projectsByRecency(await fetchShell(connection));
    const last = await lastProject(host);
    return { state: "ok", projects, selectedId: projects.some((p) => p.id === last) ? last : projects[0]?.id };
  } catch (e) {
    return (await loadConnection()) ? { state: "error", error: messageOf(e) } : { state: "disconnected" };
  }
}

async function t3Send(msg: Extract<ContentToWorker, { type: "t3/send" }>): Promise<T3SendResponse> {
  try {
    if (msg.imageBytes > MAX_IMAGE_BYTES) {
      throw new Error("The screenshot is larger than the 10 MiB T3 Code accepts. Select a smaller part.");
    }
    const connection = await loadConnection();
    if (!connection) throw new Error("Not connected to T3 Code. Connect in the extension options.");
    const defaults = threadDefaults(await fetchShell(connection), msg.projectId);
    if (!defaults) throw new Error("No model to use: start one thread in T3 Code first, then try again.");
    const ids = { thread: crypto.randomUUID(), create: crypto.randomUUID(), turn: crypto.randomUUID(), message: crypto.randomUUID() };
    const commands = threadCommands({ ...msg, ...defaults }, ids, new Date().toISOString());
    const [create, turn] = commands;
    await dispatch(connection, create);
    await dispatch(connection, turn).catch(async (e: unknown) => {
      // Don't leave an empty thread behind.
      await dispatch(connection, { type: "thread.delete", commandId: crypto.randomUUID(), threadId: ids.thread }).catch(() => undefined);
      throw e;
    });
    await rememberProject(msg.host, msg.projectId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: messageOf(e) };
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg = raw as ContentToWorker;
  switch (msg?.type) {
    case "capture":
      if (sender.tab?.windowId === undefined) return false;
      chrome.tabs
        .captureVisibleTab(sender.tab.windowId, { format: "png" })
        .then((dataUrl) => sendResponse({ ok: true, dataUrl } satisfies CaptureResponse))
        .catch((e: unknown) => sendResponse({ ok: false, error: messageOf(e) } satisfies CaptureResponse));
      return true;
    case "t3/projects":
      void t3Projects(msg.host).then(sendResponse);
      return true;
    case "t3/send":
      void t3Send(msg).then(sendResponse);
      return true;
    case "t3/setup":
      void chrome.runtime.openOptionsPage();
      return false;
    default:
      return false;
  }
});
