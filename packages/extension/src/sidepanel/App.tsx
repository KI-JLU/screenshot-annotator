import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ProjectView } from "@website-review/shared";
import { CompanionClient, errorText, isCompanionError, type CompanionSettings } from "../lib/api.ts";
import { loadSettings, onSettingsChanged, saveSettings } from "../lib/settings.ts";
import { AppContext, type AppContextValue, type PanelEvent, type View } from "./context.ts";
import { ConfirmHost } from "./components/ConfirmDialog.tsx";
import { Pairing } from "./components/Pairing.tsx";
import { ConnectionView } from "./components/ConnectionView.tsx";
import { ProjectsView } from "./components/ProjectsView.tsx";
import { ReviewTab } from "./components/ReviewTab.tsx";
import { CaptureProvider } from "./capture/useCapture.tsx";

export function App() {
  const [settings, setSettings] = useState<CompanionSettings | null>(null);
  useEffect(() => {
    void loadSettings().then(setSettings);
    return onSettingsChanged(setSettings);
  }, []);

  if (!settings) return <p class="pad muted">Lade …</p>;
  if (!settings.token) {
    return (
      <div class="app">
        <Header />
        <main class="main">
          <Pairing settings={settings} />
        </main>
      </div>
    );
  }
  return <Main settings={settings} key={`${settings.baseUrl}|${settings.token}`} />;
}

function Header({ children }: { children?: ComponentChildren }) {
  return (
    <header class="topbar">
      <h1 class="brand">Website Review</h1>
      {children}
    </header>
  );
}

const VIEWS: { id: View; label: string }[] = [
  { id: "review", label: "Review" },
  { id: "projects", label: "Projekte" },
  { id: "connection", label: "Verbindung" },
];

function Main({ settings }: { settings: CompanionSettings }) {
  const client = useMemo(() => new CompanionClient(settings), [settings]);
  useEffect(() => () => client.dispose(), [client]);

  const [view, setViewState] = useState<View>("review");
  const [createFromUrl, setCreateFromUrl] = useState<string | undefined>(undefined);
  const [online, setOnline] = useState<boolean | null>(null);
  const [authProblem, setAuthProblem] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [status, setStatus] = useState("");
  const listeners = useRef(new Set<(e: PanelEvent) => void>());

  const announce = useCallback((message: string) => {
    // Clear first so repeating the same message is announced again.
    setStatus("");
    requestAnimationFrame(() => setStatus(message));
  }, []);

  const handleError = useCallback((e: unknown) => {
    if (isCompanionError(e)) {
      if (e.unreachable) setOnline(false);
      if (e.authProblem) setAuthProblem(errorText(e));
    }
    return errorText(e);
  }, []);

  const reloadProjects = useCallback(async () => {
    try {
      setProjects(await client.listProjects());
      setOnline(true);
    } catch (e) {
      handleError(e);
    }
  }, [client, handleError]);

  const emit = useCallback((e: PanelEvent) => {
    for (const fn of listeners.current) fn(e);
  }, []);

  const subscribe = useCallback((fn: (e: PanelEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  useEffect(() => {
    void reloadProjects();
    return client.subscribeEvents({
      onOpen: () => {
        setOnline(true);
        setAuthProblem(null);
        void reloadProjects();
        emit({ type: "reconnected" });
      },
      onEvent: (e) => {
        if (e.type === "projects.updated") void reloadProjects();
        emit(e);
      },
      onError: (e) => {
        handleError(e);
      },
    });
  }, [client, reloadProjects, emit, handleError]);

  // While offline, poll the unauthenticated health endpoint to detect the companion coming back.
  useEffect(() => {
    if (online !== false) return;
    const t = setInterval(() => {
      client.health().then(
        () => {
          setOnline(true);
          void reloadProjects();
          emit({ type: "reconnected" });
        },
        () => undefined,
      );
    }, 5_000);
    return () => clearInterval(t);
  }, [online, client, reloadProjects, emit]);

  const setView = useCallback((v: View, opts?: { createProjectFromUrl?: string }) => {
    setCreateFromUrl(opts?.createProjectFromUrl);
    setViewState(v);
  }, []);

  const ctx: AppContextValue = useMemo(
    () => ({ client, settings, online, projects, reloadProjects, subscribe, announce, handleError, setView }),
    [client, settings, online, projects, reloadProjects, subscribe, announce, handleError, setView],
  );

  return (
    <AppContext.Provider value={ctx}>
      <CaptureProvider>
        <div class="app">
          <Header>
            <nav class="tabs" aria-label="Bereiche">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  class="tab"
                  aria-current={view === v.id ? "page" : undefined}
                  onClick={() => setView(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </nav>
          </Header>
          {online === false && (
            <div class="banner warn" role="alert">
              <p>
                <strong>Begleitdienst nicht erreichbar</strong> ({settings.baseUrl}). Starte ihn mit{" "}
                <code>website-review-companion serve</code>. Gespeicherte Entwürfe bleiben erhalten; die Verbindung wird
                automatisch erneut versucht.
              </p>
              <button type="button" class="btn small" onClick={() => void reloadProjects()}>
                Jetzt erneut versuchen
              </button>
            </div>
          )}
          {authProblem && (
            <div class="banner error" role="alert">
              <p>
                <strong>Kopplung ungültig.</strong> Der Begleitdienst akzeptiert diese Extension nicht mehr (z. B. nach
                erneutem Koppeln einer anderen Extension).
              </p>
              <button
                type="button"
                class="btn small"
                onClick={() => void saveSettings({ baseUrl: settings.baseUrl })}
              >
                Neu koppeln
              </button>
            </div>
          )}
          <p class="statusline" role="status" aria-live="polite">
            {status}
          </p>
          <main class="main">
            {view === "review" && <ReviewTab />}
            {view === "projects" && <ProjectsView createFromUrl={createFromUrl} />}
            {view === "connection" && <ConnectionView />}
          </main>
          <ConfirmHost />
        </div>
      </CaptureProvider>
    </AppContext.Provider>
  );
}
