/** Message protocol between side panel, background worker and the injected capture overlay. */
import type { CaptureContext, MarkKind, Point, Rect } from "@website-review/shared";

/** What the overlay measured, in CSS px relative to the viewport. */
export interface OverlaySelection {
  mode: MarkKind;
  context: CaptureContext;
  /** Element marks: bounding client rect of the selected element. */
  elementRect?: Rect;
  /** Point marks: click position. */
  point?: Point;
}

/** Selection plus the screenshot taken right after the overlay was removed. */
export interface CaptureResult extends OverlaySelection {
  id: string;
  tabId: number;
  windowId: number;
  /** data:image/png;base64,… from chrome.tabs.captureVisibleTab */
  dataUrl: string;
  capturedAt: string;
}

export type PanelToWorker =
  | { type: "capture/start"; tabId: number; mode: MarkKind }
  | { type: "capture/cancel"; tabId: number };

export interface StartCaptureResponse {
  ok: boolean;
  error?: string;
  /** True when Chrome refused script injection or the screenshot for lack of permissions. */
  permissionProblem?: boolean;
}

export type WorkerToContent = { type: "overlay/start"; mode: MarkKind } | { type: "overlay/cancel" };

export type ContentToWorker =
  | { type: "overlay/selected"; selection: OverlaySelection }
  | { type: "overlay/cancelled" };

export type WorkerBroadcast =
  | { type: "capture/result"; result: CaptureResult }
  | { type: "capture/cancelled" }
  | { type: "capture/error"; message: string; permissionProblem: boolean };

/** chrome.storage.session key holding the last capture until it is saved or discarded. */
export const SESSION_CAPTURE_KEY = "wr:capture";

export function isPermissionError(message: string): boolean {
  return /permission|cannot access|activeTab|<all_urls>|not allowed|Cannot access contents/i.test(message);
}
