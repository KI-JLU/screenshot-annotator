/**
 * T3 Code integration: pure helpers for pairing and for the commands that start a thread.
 *
 * Talks to the HTTP API of a running T3 Code server (default http://127.0.0.1:3773):
 * - POST /oauth/token exchanges a one-time pairing code for a bearer token (30 days).
 * - GET /api/orchestration/shell lists projects and threads.
 * - POST /api/orchestration/dispatch runs `thread.create`, then `thread.turn.start`. The HTTP
 *   endpoint ignores `bootstrap.createThread`, so the thread has to exist before the turn.
 * This is T3 Code's internal API (checked against 0.0.45-nightly) and may change.
 */

export const DEFAULT_SERVER_URL = "http://127.0.0.1:3773";
/** The extension only needs to see projects and start threads. */
export const SCOPES = "orchestration:read orchestration:operate";
/** T3 Code rejects larger images (PROVIDER_SEND_TURN_MAX_IMAGE_BYTES). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ModelSelection {
  instanceId?: unknown;
  model: unknown;
  options?: unknown;
}

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

/** The parts of GET /api/orchestration/shell this extension reads. */
export interface ShellSnapshot {
  projects: { id: string; title: string; defaultModelSelection: ModelSelection | null }[];
  threads: { projectId: string; modelSelection: ModelSelection; runtimeMode: RuntimeMode; updatedAt: string }[];
}

export interface Project {
  id: string;
  title: string;
}

/**
 * Accepts what T3 Code's "Create pairing link" offers: the link (`<server>/pair#token=…`, or a
 * hosted-app link with `?host=<server>`) or the bare code. A link also tells us the server.
 */
export function parsePairingInput(input: string): { credential: string; serverUrl?: string } | null {
  const text = input.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return /\s/.test(text) ? null : { credential: text };
  }
  const credential = new URLSearchParams(url.hash.slice(1)).get("token");
  if (!credential) return null;
  const host = url.searchParams.get("host");
  return { credential, serverUrl: normalizeServerUrl(host ?? url.origin) ?? url.origin };
}

/** `http://127.0.0.1:3773/` → `http://127.0.0.1:3773`; null when not an http(s) URL. */
export function normalizeServerUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Projects with the most recently active first. */
export function projectsByRecency(shell: ShellSnapshot): Project[] {
  const lastActive = new Map<string, string>();
  for (const t of shell.threads) {
    if ((lastActive.get(t.projectId) ?? "") < t.updatedAt) lastActive.set(t.projectId, t.updatedAt);
  }
  return shell.projects
    .map((p) => ({ id: p.id, title: p.title }))
    .sort((a, b) => (lastActive.get(b.id) ?? "").localeCompare(lastActive.get(a.id) ?? "") || a.title.localeCompare(b.title));
}

/**
 * Model and run mode for a new thread. The HTTP API cannot read T3 Code's global default model,
 * so this follows the project's default model, else the newest thread in the project, else the
 * newest thread anywhere: the same setup the user picked last time.
 */
export function threadDefaults(
  shell: ShellSnapshot,
  projectId: string,
): { modelSelection: ModelSelection; runtimeMode: RuntimeMode } | null {
  const newest = (threads: ShellSnapshot["threads"]) =>
    threads.reduce<ShellSnapshot["threads"][number] | undefined>((a, t) => (!a || t.updatedAt > a.updatedAt ? t : a), undefined);
  const inProject = newest(shell.threads.filter((t) => t.projectId === projectId));
  const anywhere = inProject ?? newest(shell.threads);
  const projectModel = shell.projects.find((p) => p.id === projectId)?.defaultModelSelection;
  const modelSelection = projectModel ?? anywhere?.modelSelection;
  if (!modelSelection) return null;
  return { modelSelection, runtimeMode: anywhere?.runtimeMode ?? "approval-required" };
}

/** First line of the comment, or the page, as thread title. */
export function threadTitle(comment: string, pageUrl: string): string {
  const firstLine = comment.split("\n")[0]?.trim() ?? "";
  let title = firstLine;
  if (!title) {
    try {
      const url = new URL(pageUrl);
      title = `Annotation: ${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      title = "Annotation";
    }
  }
  return title.length <= 80 ? title : title.slice(0, 79).trimEnd() + "…";
}

export interface NewThread {
  projectId: string;
  title: string;
  text: string;
  imageDataUrl: string;
  imageBytes: number;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
}

/** The two dispatch commands that create the thread and send the annotation as its first message. */
export function threadCommands(t: NewThread, ids: { thread: string; create: string; turn: string; message: string }, now: string) {
  const setup = {
    modelSelection: t.modelSelection,
    runtimeMode: t.runtimeMode,
    interactionMode: "default" as const,
  };
  return [
    {
      type: "thread.create",
      commandId: ids.create,
      threadId: ids.thread,
      projectId: t.projectId,
      title: t.title,
      ...setup,
      branch: null,
      worktreePath: null,
      createdAt: now,
    },
    {
      type: "thread.turn.start",
      commandId: ids.turn,
      threadId: ids.thread,
      message: {
        messageId: ids.message,
        role: "user",
        text: t.text,
        attachments: [
          { type: "image", name: "annotation.png", mimeType: "image/png", sizeBytes: t.imageBytes, dataUrl: t.imageDataUrl },
        ],
      },
      ...setup,
      createdAt: now,
    },
  ] as const;
}
