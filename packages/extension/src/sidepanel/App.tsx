import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ProjectView } from "@website-review/shared";
import { CompanionClient, errorText } from "../lib/api.ts";
import type { HostStatus } from "../lib/nativeTransport.ts";
import { PanelConnection } from "../lib/panelConnection.ts";
import { AppContext, type AppContextValue, type PanelEvent, type View } from "./context.ts";
import { ConfirmHost } from "./components/ConfirmDialog.tsx";
import { HostStatusBanner, StatusView } from "./components/StatusView.tsx";
import { ProjectsView } from "./components/ProjectsView.tsx";
import { ReviewTab } from "./components/ReviewTab.tsx";
import { CaptureProvider } from "./capture/useCapture.tsx";

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

function onlineOf(s: HostStatus): boolean | null {
  if (s.state === "connected") return true;
  if (s.state === "connecting") return null;
  return false;
}

export function App() {
  const connection = useMemo(() => new PanelConnection(), []);
  const client = useMemo(() => new CompanionClient(connection), [connection]);
  useEffect(
    () => () => {
      client.dispose();
      connection.dispose();
    },
    [client, connection],
  );

  const [view, setViewState] = useState<View>("review");
  const [createFromUrl, setCreateFromUrl] = useState<string | undefined>(undefined);
  const [hostStatus, setHostStatus] = useState<HostStatus>(connection.status);
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [status, setStatus] = useState("");
  const listeners = useRef(new Set<(e: PanelEvent) => void>());
  const online = onlineOf(hostStatus);

  const announce = useCallback((message: string) => {
    // Clear first so repeating the same message is announced again.
    setStatus("");
    requestAnimationFrame(() => setStatus(message));
  }, []);

  const handleError = useCallback((e: unknown) => errorText(e), []);

  const reloadProjects = useCallback(async () => {
    try {
      setProjects(await client.listProjects());
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
    const offEvent = connection.onEvent((e) => {
      if (e.type === "projects.updated") void reloadProjects();
      emit(e);
    });
    let wasConnected = false;
    const onStatus = (s: HostStatus) => {
      setHostStatus(s);
      const connected = s.state === "connected";
      if (connected && !wasConnected) {
        // (Re)connected: everything may have changed while the host was away.
        void reloadProjects();
        emit({ type: "reconnected" });
      }
      wasConnected = connected;
    };
    const offStatus = connection.onStatus(onStatus);
    onStatus(connection.status);
    return () => {
      offEvent();
      offStatus();
    };
  }, [connection, reloadProjects, emit]);

  const reconnect = useCallback(() => connection.reconnect(), [connection]);

  const setView = useCallback((v: View, opts?: { createProjectFromUrl?: string }) => {
    setCreateFromUrl(opts?.createProjectFromUrl);
    setViewState(v);
  }, []);

  const ctx: AppContextValue = useMemo(
    () => ({ client, hostStatus, reconnect, online, projects, reloadProjects, subscribe, announce, handleError, setView }),
    [client, hostStatus, reconnect, online, projects, reloadProjects, subscribe, announce, handleError, setView],
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
          {view !== "connection" && <HostStatusBanner />}
          <p class="statusline" role="status" aria-live="polite">
            {status}
          </p>
          <main class="main">
            {view === "review" && <ReviewTab />}
            {view === "projects" && <ProjectsView createFromUrl={createFromUrl} />}
            {view === "connection" && <StatusView />}
          </main>
          <ConfirmHost />
        </div>
      </CaptureProvider>
    </AppContext.Provider>
  );
}
