/**
 * Capture controller for the side panel: starts/cancels marking mode via the background worker,
 * receives the screenshot and keeps the unsaved draft in chrome.storage.session.
 */
import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { MarkKind } from "@website-review/shared";
import type { CaptureResult, PanelToWorker, StartCaptureResponse, WorkerBroadcast } from "../../lib/messages.ts";
import { ALL_URLS, originPatternForUrl, requestOrigins } from "../../lib/permissions.ts";
import { clearCapture, clearDraft, loadCapture, loadDraft, saveDraft, type CommentDraft } from "../../lib/session.ts";
import { useApp } from "../context.ts";
import type { ActiveTab } from "../useActiveTab.ts";

export interface CaptureError {
  message: string;
  permissionProblem: boolean;
}

export interface CaptureController {
  marking: { mode: MarkKind; tabId: number } | null;
  capture: CaptureResult | null;
  draft: CommentDraft | null;
  error: CaptureError | null;
  /** Call directly from a click handler (permission request needs the user gesture). */
  start(mode: MarkKind, tab: ActiveTab, target: { reviewId: string; projectId: string }): Promise<void>;
  cancel(): void;
  updateDraft(patch: Partial<CommentDraft>): void;
  /** Drops capture and draft (after saving or when the user discards). */
  reset(): Promise<void>;
  dismissError(): void;
  requestAllUrls(): Promise<void>;
}

const Ctx = createContext<CaptureController | null>(null);

export function useCapture(): CaptureController {
  const c = useContext(Ctx);
  if (!c) throw new Error("CaptureProvider missing");
  return c;
}

const MODE_LABEL: Record<MarkKind, string> = {
  element: "Element markieren",
  point: "Freie Stelle markieren",
  page: "Seitenkommentar",
};

export function CaptureProvider({ children }: { children: ComponentChildren }) {
  const { announce } = useApp();
  const [marking, setMarking] = useState<CaptureController["marking"]>(null);
  const [capture, setCapture] = useState<CaptureResult | null>(null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [error, setError] = useState<CaptureError | null>(null);
  const draftRef = useRef<CommentDraft | null>(null);
  const markingRef = useRef(marking);
  markingRef.current = marking;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const persistDraft = useCallback((d: CommentDraft | null) => {
    draftRef.current = d;
    setDraft(d);
    clearTimeout(saveTimer.current);
    if (d) saveTimer.current = setTimeout(() => void saveDraft(d), 250);
  }, []);

  // Restore after the panel was closed/reopened.
  useEffect(() => {
    void Promise.all([loadDraft(), loadCapture()]).then(([d, c]) => {
      if (d) {
        draftRef.current = d;
        setDraft(d);
        if (c) setCapture(c);
      } else if (c) {
        void clearCapture();
      }
    });
  }, []);

  const receive = useCallback(
    (result: CaptureResult) => {
      setMarking(null);
      setCapture((prev) => (prev?.id === result.id ? prev : result));
      const d = draftRef.current;
      if (d && d.captureId !== result.id) {
        const next: CommentDraft = { ...d, captureId: result.id };
        delete next.crop;
        persistDraft(next);
      }
      announce("Screenshot aufgenommen. Vorschau und Kommentarfeld sind geöffnet.");
    },
    [announce, persistDraft],
  );

  useEffect(() => {
    const onMessage = (raw: unknown) => {
      const msg = raw as WorkerBroadcast;
      if (msg?.type === "capture/result") receive(msg.result);
      else if (msg?.type === "capture/cancelled") {
        setMarking(null);
        announce("Markiermodus beendet.");
      } else if (msg?.type === "capture/error") {
        setMarking(null);
        setError({ message: msg.message, permissionProblem: msg.permissionProblem });
        announce(msg.message);
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [receive, announce]);

  const cancel = useCallback(() => {
    const m = markingRef.current;
    if (!m) return;
    setMarking(null);
    const msg: PanelToWorker = { type: "capture/cancel", tabId: m.tabId };
    void chrome.runtime.sendMessage(msg).catch(() => undefined);
    announce("Markiermodus beendet.");
  }, [announce]);

  // Escape in the side panel leaves marking mode, too.
  useEffect(() => {
    if (!marking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [marking, cancel]);

  const start = useCallback<CaptureController["start"]>(
    async (mode, tab, target) => {
      setError(null);
      const pattern = originPatternForUrl(tab.url);
      if (!pattern) {
        setError({ message: "Diese Seite kann nicht markiert werden (nur http- und https-Seiten).", permissionProblem: false });
        return;
      }
      // First await in the click handler: keeps the user gesture for the permission prompt.
      let granted = false;
      try {
        granted = await requestOrigins([pattern]);
      } catch (e) {
        setError({ message: `Berechtigung konnte nicht angefragt werden: ${String(e)}`, permissionProblem: true });
        return;
      }
      if (!granted) {
        setError({
          message: `Ohne Zugriff auf ${new URL(tab.url).origin} kann die Seite nicht markiert und fotografiert werden.`,
          permissionProblem: true,
        });
        return;
      }
      if (markingRef.current) cancel();
      const prev = draftRef.current;
      const next: CommentDraft =
        prev && prev.reviewId === target.reviewId
          ? { ...prev }
          : { ...target, text: "", extraContext: "", attachScreenshot: true };
      persistDraft(next);
      await saveDraft(next);
      setMarking({ mode, tabId: tab.id });
      if (mode !== "page") announce(`${MODE_LABEL[mode]}: Markiermodus aktiv. Escape bricht ab.`);
      const msg: PanelToWorker = { type: "capture/start", tabId: tab.id, mode };
      let res: StartCaptureResponse;
      try {
        res = (await chrome.runtime.sendMessage(msg)) as StartCaptureResponse;
      } catch (e) {
        res = { ok: false, error: String(e) };
      }
      if (!res?.ok) {
        setMarking(null);
        setError({ message: res?.error ?? "Markierung fehlgeschlagen.", permissionProblem: !!res?.permissionProblem });
      }
    },
    [announce, cancel, persistDraft],
  );

  const updateDraft = useCallback(
    (patch: Partial<CommentDraft>) => {
      const d = draftRef.current;
      if (!d) return;
      persistDraft({ ...d, ...patch });
    },
    [persistDraft],
  );

  const reset = useCallback(async () => {
    clearTimeout(saveTimer.current);
    draftRef.current = null;
    setDraft(null);
    setCapture(null);
    await clearDraft();
  }, []);

  const requestAllUrls = useCallback(async () => {
    const ok = await requestOrigins(ALL_URLS);
    if (ok) {
      setError(null);
      announce("Zugriff auf alle Websites erlaubt. Bitte die Markierung erneut starten.");
    }
  }, [announce]);

  const value = useMemo<CaptureController>(
    () => ({
      marking,
      capture,
      draft,
      error,
      start,
      cancel,
      updateDraft,
      reset,
      dismissError: () => setError(null),
      requestAllUrls,
    }),
    [marking, capture, draft, error, start, cancel, updateDraft, reset, requestAllUrls],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
