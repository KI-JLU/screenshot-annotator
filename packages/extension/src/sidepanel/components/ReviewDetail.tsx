/** An open review: capture buttons, "Review verarbeiten", preflight problems and the comment list. */
import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";
import type { Comment, MarkKind, PreflightProblem, ProjectView, ReviewDetail } from "@website-review/shared";
import { COMMENT_STATE_LABELS, PROCESSABLE_STATES } from "@website-review/shared";
import { errorText, isCompanionError, preflightProblems } from "../../lib/api.ts";
import { MARK_KIND_LABELS, PREFLIGHT_KIND_LABELS, readinessProblems } from "../../lib/format.ts";
import { useAction, useApp } from "../context.ts";
import { useCapture } from "../capture/useCapture.tsx";
import type { ActiveTab } from "../useActiveTab.ts";
import { CommentCard } from "./CommentCard.tsx";
import { countsText } from "./ReviewList.tsx";
import { ErrorText, Notice } from "./ui.tsx";

const MARK_BUTTONS: { mode: MarkKind; label: string }[] = [
  { mode: "element", label: "Element markieren" },
  { mode: "point", label: "Freie Stelle markieren" },
  { mode: "page", label: "Seitenkommentar" },
];

export function ReviewDetailView(props: {
  reviewId: string;
  project: ProjectView;
  tab: ActiveTab;
  onShowList: () => void;
  onGone: () => void;
}) {
  const { reviewId, project, tab } = props;
  const { client, subscribe, announce, handleError, online, setView } = useApp();
  const cap = useCapture();
  const id = useId();
  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightProblem[] | null>(null);
  const process = useAction();
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prevStates = useRef(new Map<string, string>());

  const reload = useCallback(async () => {
    try {
      const r = await client.getReview(reviewId);
      // Announce state changes that happened in the background (processing, publishing).
      const changes: string[] = [];
      sortComments(r.comments).forEach((c, i) => {
        const before = prevStates.current.get(c.id);
        if (before && before !== c.state) changes.push(`Kommentar ${i + 1}: ${COMMENT_STATE_LABELS[c.state]}`);
      });
      prevStates.current = new Map(r.comments.map((c) => [c.id, c.state]));
      setReview(r);
      setLoadError(null);
      if (changes.length) {
        const more = changes.length > 3 ? ` und ${changes.length - 3} weitere` : "";
        announce(`Status geändert – ${changes.slice(0, 3).join("; ")}${more}.`);
      }
    } catch (e) {
      if (isCompanionError(e) && e.code === "not_found") {
        props.onGone();
        return;
      }
      setLoadError(handleError(e));
    }
  }, [client, reviewId, announce, handleError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () =>
      subscribe((e) => {
        const relevant =
          e.type === "reconnected" ||
          ((e.type === "review.updated" || e.type === "comment.updated") && e.reviewId === reviewId);
        if (!relevant) return;
        clearTimeout(reloadTimer.current);
        reloadTimer.current = setTimeout(() => void reload(), 150);
      }),
    [subscribe, reviewId, reload],
  );

  const replaceComment = (c: Comment) =>
    setReview((r) => (r ? { ...r, comments: r.comments.map((x) => (x.id === c.id ? c : x)) } : r));

  const runProcess = () =>
    process.run(async () => {
      setPreflight(null);
      try {
        const res = await client.processReview(reviewId);
        announce(
          res.started.length
            ? `Verarbeitung gestartet für ${res.started.length} Kommentar${res.started.length === 1 ? "" : "e"}.`
            : "Keine Kommentare zu verarbeiten.",
        );
      } catch (e) {
        const problems = preflightProblems(e);
        if (!problems) throw e;
        setPreflight(problems.length ? problems : [{ kind: "checkout", message: errorText(e) }]);
        announce("Verarbeitung nicht gestartet: Voraussetzungen fehlen.");
      }
      await reload();
    });

  if (loadError && !review) {
    return (
      <div class="stack">
        <ErrorText error={loadError} />
        <div class="row">
          <button type="button" class="btn" onClick={() => void reload()}>
            Erneut laden
          </button>
          <button type="button" class="btn" onClick={props.onShowList}>
            Andere Reviews
          </button>
        </div>
      </div>
    );
  }
  if (!review) return <p class="muted">Lade Review …</p>;

  const comments = sortComments(review.comments);
  const processable = comments.filter((c) => PROCESSABLE_STATES.includes(c.state)).length;
  const problems = readinessProblems(project);
  const capturing = !!cap.marking;
  const canCapture = online !== false && !capturing;

  return (
    <div class="stack">
      <section class="card stack-sm" aria-labelledby={`${id}-h`}>
        <div class="row between wrap">
          <h2 id={`${id}-h`} class="grow">
            {review.title}
          </h2>
          <button type="button" class="btn small" onClick={props.onShowList}>
            Alle Reviews
          </button>
        </div>
        <p class="muted small">{countsText(countByState(comments))}</p>

        <div class="row wrap" role="group" aria-label="Kommentar erfassen">
          {MARK_BUTTONS.map((b) => (
            <button
              key={b.mode}
              type="button"
              class={b.mode === "element" ? "btn primary" : "btn"}
              disabled={!canCapture}
              onClick={() => void cap.start(b.mode, tab, { reviewId, projectId: project.config.projectId })}
            >
              {b.label}
            </button>
          ))}
        </div>
        {cap.marking && (
          <div class="notice info row between wrap">
            <span>
              <strong>{MARK_KIND_LABELS[cap.marking.mode]}:</strong> Markiermodus aktiv – auf der Seite klicken. Escape
              beendet den Modus.
            </span>
            <button type="button" class="btn small" onClick={cap.cancel}>
              Abbrechen
            </button>
          </div>
        )}
        {cap.error && (
          <div class="alert stack-sm" role="alert">
            <p>{cap.error.message}</p>
            <div class="row wrap">
              {cap.error.permissionProblem && (
                <button type="button" class="btn small" onClick={() => void cap.requestAllUrls()}>
                  Zugriff auf alle Websites erlauben
                </button>
              )}
              <button type="button" class="btn small" onClick={cap.dismissError}>
                Schließen
              </button>
            </div>
          </div>
        )}
      </section>

      <section class="card stack-sm" aria-labelledby={`${id}-proc`}>
        <h3 id={`${id}-proc`}>Verarbeitung</h3>
        {problems.length > 0 && (
          <Notice tone="warn">
            <p>Projekt noch nicht bereit:</p>
            <ul>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <button type="button" class="btn small" onClick={() => setView("projects")}>
              Projekt einrichten
            </button>
          </Notice>
        )}
        {review.processing && <p>Verarbeitung läuft …</p>}
        <div class="row wrap">
          <button
            type="button"
            class="btn primary"
            onClick={() => void runProcess()}
            disabled={process.busy || processable === 0 || online === false}
            aria-describedby={`${id}-proc-hint`}
          >
            {process.busy ? "Starte …" : "Review verarbeiten"}
          </button>
          <span class="muted small" id={`${id}-proc-hint`}>
            {processable === 0
              ? "Keine Entwürfe oder fehlgeschlagenen Kommentare."
              : `${processable} Kommentar${processable === 1 ? "" : "e"} bereit zur Verarbeitung.`}
          </span>
        </div>
        <ErrorText error={process.error} />
        {preflight && (
          <div class="alert" role="alert">
            <p>
              <strong>Verarbeitung nicht gestartet.</strong> Bitte zuerst beheben:
            </p>
            <ul>
              {preflight.map((p, i) => (
                <li key={i}>
                  <strong>{PREFLIGHT_KIND_LABELS[p.kind] ?? p.kind}:</strong> {p.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section class="stack-sm" aria-labelledby={`${id}-comments`}>
        <h3 id={`${id}-comments`}>Kommentare ({comments.length})</h3>
        {loadError && <ErrorText error={loadError} />}
        {comments.length === 0 && (
          <p class="muted">Noch keine Kommentare. Markiere ein Element, eine freie Stelle oder schreibe einen Seitenkommentar.</p>
        )}
        <ol class="plain-list stack-sm">
          {comments.map((c, i) => (
            <li key={c.id}>
              <CommentCard
                comment={c}
                index={i + 1}
                review={review}
                allComments={comments}
                onChanged={(updated) => {
                  if (updated) replaceComment(updated);
                  void reload();
                }}
              />
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function sortComments(list: Comment[]): Comment[] {
  return [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function countByState(comments: Comment[]) {
  const counts: Partial<Record<Comment["state"], number>> = {};
  for (const c of comments) counts[c.state] = (counts[c.state] ?? 0) + 1;
  return counts;
}
