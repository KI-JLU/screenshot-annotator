import { createContext } from "preact";
import { useCallback, useContext, useState } from "preact/hooks";
import type { CompanionEvent, ProjectView } from "@website-review/shared";
import type { CompanionClient, CompanionSettings } from "../lib/api.ts";

export type View = "review" | "projects" | "connection";

/** Companion events plus a local signal after the event stream (re)connected: refetch everything. */
export type PanelEvent = CompanionEvent | { type: "reconnected" };

export interface AppContextValue {
  client: CompanionClient;
  settings: CompanionSettings;
  /** null = not known yet */
  online: boolean | null;
  projects: ProjectView[] | null;
  reloadProjects(): Promise<void>;
  subscribe(fn: (e: PanelEvent) => void): () => void;
  /** Screen reader + visible status line. */
  announce(message: string): void;
  /** Records connection/auth problems and returns a German message for display. */
  handleError(e: unknown): string;
  setView(view: View, opts?: { createProjectFromUrl?: string }): void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("AppContext missing");
  return ctx;
}

/** Runs an async action with busy flag and a displayable error. */
export function useAction() {
  const { handleError } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn();
      } catch (e) {
        setError(handleError(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [handleError],
  );
  return { busy, error, setError, run };
}
