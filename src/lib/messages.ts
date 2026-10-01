/** Messages between the service worker and the injected overlay. */

export type WorkerToContent = { type: "overlay/start" };

export type ContentToWorker = { type: "capture" };

export type CaptureResponse = { ok: true; dataUrl: string } | { ok: false; error: string };
