/**
 * Review tab: follows the active tab, matches its URL to projects (never guesses on ambiguity),
 * and shows the open review of the chosen project.
 */
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ProjectView } from "@website-review/shared";
import { originOf } from "../../lib/format.ts";
import { getOriginMemory, getProjectReview, setOriginMemory, setProjectReview } from "../../lib/session.ts";
import { useApp } from "../context.ts";
import { useActiveTab, type ActiveTab } from "../useActiveTab.ts";
import { CaptureScreen } from "../capture/CaptureScreen.tsx";
import { useCapture } from "../capture/useCapture.tsx";
import { ReviewDetailView } from "./ReviewDetail.tsx";
import { ReviewList } from "./ReviewList.tsx";
import { ErrorText, Notice } from "./ui.tsx";

type MatchState =
  | { status: "idle" }
  | { status: "loading"; url: string }
  | { status: "done"; url: string; projectIds: string[] }
  | { status: "error"; url: string; message: string };

export function ReviewTab() {
  const tab = useActiveTab();
  const cap = useCapture();

  // Switching tabs while marking: stop marking on the old tab.
  useEffect(() => {
    if (cap.marking && tab && cap.marking.tabId !== tab.id) cap.cancel();
  }, [tab?.id]);

  const showPreview = !cap.marking && !!cap.draft && (!!cap.capture || cap.draft.text.trim() !== "");
  if (showPreview) return <CaptureScreen tab={tab} />;
  return <TabReview tab={tab} />;
}

function TabReview({ tab }: { tab: ActiveTab | null }) {
  const { client, online, projects, handleError, subscribe, setView } = useApp();
  const [match, setMatch] = useState<MatchState>({ status: "idle" });
  // Project choice, bound to the URL it was resolved for. id: null = user has to pick.
  const [chosenState, setChosenState] = useState<{ url: string; id: string | null } | undefined>(undefined);
  const origin = originOf(tab?.url);
  const url = tab?.url ?? "";
  // Only the newest match request may update state (tab switches can reorder responses).
  const matchSeq = useRef(0);
  const urlRef = useRef(url);
  urlRef.current = url;

  const runMatch = async (u: string, opts: { refresh?: boolean } = {}) => {
    const seq = ++matchSeq.current;
    // A refresh of the same URL keeps the current view until the new answer arrives.
    if (!opts.refresh) setMatch({ status: "loading", url: u });
    try {
      const res = await client.match(u);
      if (seq !== matchSeq.current || u !== urlRef.current) return;
      setMatch({ status: "done", url: u, projectIds: res.projectIds });
    } catch (e) {
      if (seq !== matchSeq.current || u !== urlRef.current) return;
      setMatch({ status: "error", url: u, message: handleError(e) });
    }
  };

  useEffect(() => {
    if (!origin || online === false) return;
    void runMatch(url);
  }, [url, origin, online, client]);

  // Rules may change (import, edit): rematch.
  useEffect(
    () =>
      subscribe((e) => {
        if ((e.type === "projects.updated" || e.type === "reconnected") && origin) void runMatch(url, { refresh: true });
      }),
    [subscribe, url, origin],
  );

  // Resolve the project: single match, or the user's earlier explicit choice for this origin.
  useEffect(() => {
    if (match.status !== "done") return;
    const forUrl = match.url;
    const matchOrigin = originOf(forUrl);
    const ids = match.projectIds;
    setChosenState((prev) =>
      // Keep an explicit choice across a refresh of the same URL if it still matches.
      prev && prev.url === forUrl && prev.id && ids.includes(prev.id) ? prev : undefined,
    );
    if (ids.length === 1) {
      setChosenState({ url: forUrl, id: ids[0] ?? null });
      return;
    }
    if (ids.length >= 2 && matchOrigin) {
      let alive = true;
      void getOriginMemory(matchOrigin).then((m) => {
        if (!alive) return;
        setChosenState((prev) =>
          prev && prev.url === forUrl && prev.id && ids.includes(prev.id)
            ? prev
            : { url: forUrl, id: m?.projectId && ids.includes(m.projectId) ? m.projectId : null },
        );
      });
      return () => {
        alive = false;
      };
    }
    setChosenState({ url: forUrl, id: null });
  }, [match]);

  // Everything below only uses a match / choice made for exactly the current tab URL.
  const currentMatch: MatchState = match.status !== "idle" && match.url === url ? match : { status: "loading", url };
  const chosen = chosenState && chosenState.url === url ? chosenState.id : undefined;
  const setChosen = (id: string | null) => setChosenState({ url, id });

  if (!tab) return <p class="muted">Kein aktiver Tab.</p>;
  if (!origin) {
    return (
      <Notice>
        Diese Seite kann nicht geprüft werden. Reviews sind nur auf http- und https-Seiten möglich.
      </Notice>
    );
  }
  if (online === false) {
    return <p class="muted">Ohne Verbindung zum Begleitdienst können keine Projekte zugeordnet werden.</p>;
  }
  if (currentMatch.status === "loading") {
    return <p class="muted">Prüfe Projektzuordnung …</p>;
  }
  if (currentMatch.status === "error") {
    return (
      <div class="stack">
        <ErrorText error={currentMatch.message} />
        <div class="row">
          <button type="button" class="btn" onClick={() => void runMatch(url)}>
            Erneut prüfen
          </button>
        </div>
      </div>
    );
  }

  const ids = currentMatch.projectIds;
  if (ids.length === 0) {
    return (
      <section class="stack">
        <h2>Kein Projekt für diese Seite</h2>
        <p class="muted small ellipsis" title={url}>
          {url}
        </p>
        <p>Keine Adressregel eines Projekts passt zu dieser Adresse. Lege ein Projekt an oder importiere eine Projektconfig.</p>
        <div class="row">
          <button type="button" class="btn primary" onClick={() => setView("projects", { createProjectFromUrl: url })}>
            Projekt für diese Seite anlegen
          </button>
          <button type="button" class="btn" onClick={() => setView("projects")}>
            Zu den Projekten
          </button>
        </div>
      </section>
    );
  }

  const byId = (pid: string) => projects?.find((p) => p.config.projectId === pid);

  if (chosen === undefined) return <p class="muted">Prüfe Projektzuordnung …</p>;
  if (chosen === null) {
    return (
      <ProjectPicker
        ids={ids}
        byId={byId}
        onPick={(pid) => {
          setChosen(pid);
          void setOriginMemory(origin, { projectId: pid });
        }}
      />
    );
  }

  const project = byId(chosen);
  if (!project) return <p class="muted">Lade Projekt …</p>;
  return (
    <ProjectReview
      key={`${origin}|${chosen}`}
      project={project}
      origin={origin}
      tab={tab}
      onSwitchProject={ids.length > 1 ? () => setChosen(null) : undefined}
    />
  );
}

function ProjectPicker(props: {
  ids: string[];
  byId: (id: string) => ProjectView | undefined;
  onPick: (id: string) => void;
}) {
  const id = useId();
  return (
    <section class="stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Projekt wählen</h2>
      <p>Mehrere Projekte passen zu dieser Seite. Bitte wähle, zu welchem Projekt die Kommentare gehören.</p>
      <ul class="plain-list stack-sm">
        {props.ids.map((pid) => {
          const p = props.byId(pid);
          return (
            <li key={pid}>
              <button type="button" class="btn block" onClick={() => props.onPick(pid)}>
                {p?.config.name ?? pid} <span class="muted">({pid})</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ProjectReview(props: {
  project: ProjectView;
  origin: string;
  tab: ActiveTab;
  onSwitchProject?: () => void;
}) {
  const { project, origin } = props;
  const projectId = project.config.projectId;
  const [reviewId, setReviewId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    void (async () => {
      const m = await getOriginMemory(origin);
      if (m?.projectId === projectId && m.reviewId) {
        setReviewId(m.reviewId);
        return;
      }
      setReviewId((await getProjectReview(projectId)) ?? null);
    })();
  }, [origin, projectId]);

  const open = (rid: string | null) => {
    setReviewId(rid);
    void setOriginMemory(origin, rid ? { projectId, reviewId: rid } : { projectId });
    void setProjectReview(projectId, rid ?? undefined);
  };

  if (reviewId === undefined) return <p class="muted">Lade …</p>;
  return (
    <div class="stack">
      <div class="row between">
        <p class="project-line">
          Projekt: <strong>{project.config.name}</strong>
        </p>
        {props.onSwitchProject && (
          <button type="button" class="btn small" onClick={props.onSwitchProject}>
            Projekt wechseln
          </button>
        )}
      </div>
      {reviewId ? (
        <ReviewDetailView
          key={reviewId}
          reviewId={reviewId}
          project={project}
          tab={props.tab}
          onShowList={() => open(null)}
          onGone={() => open(null)}
        />
      ) : (
        <ReviewList project={project} onOpen={(rid) => open(rid)} />
      )}
    </div>
  );
}
