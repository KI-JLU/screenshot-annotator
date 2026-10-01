/** Messages between the service worker and the injected overlay. */
import type { Project } from "./t3.ts";

export type WorkerToContent = { type: "overlay/start" };

export type ContentToWorker =
  | { type: "capture" }
  | { type: "t3/projects"; host: string }
  | { type: "t3/send"; host: string; projectId: string; title: string; text: string; imageDataUrl: string; imageBytes: number }
  | { type: "t3/setup" };

export type CaptureResponse = { ok: true; dataUrl: string } | { ok: false; error: string };

export type T3ProjectsResponse =
  | { state: "disconnected" }
  | { state: "error"; error: string }
  | { state: "ok"; projects: Project[]; selectedId?: string };

export type T3SendResponse = { ok: true } | { ok: false; error: string };
