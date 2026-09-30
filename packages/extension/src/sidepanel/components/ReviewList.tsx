/** Reviews of a project: reopen older ones, start a new one, delete local review data. */
import { useEffect, useId, useState } from "preact/hooks";
import type { CommentState, ProjectView, ReviewSummary } from "@website-review/shared";
import { COMMENT_STATE_LABELS, COMMENT_STATES } from "@website-review/shared";
import { formatDate } from "../../lib/format.ts";
import { forgetReview } from "../../lib/session.ts";
import { useAction, useApp } from "../context.ts";
import { confirmDialog } from "./ConfirmDialog.tsx";
import { ErrorText, Field } from "./ui.tsx";

/** "Entwurf: 2 · Veröffentlicht: 1" – label first, so the state names need no plural forms. */
export function countsText(counts: Partial<Record<CommentState, number>>): string {
  const parts = COMMENT_STATES.filter((s) => (counts[s] ?? 0) > 0).map((s) => `${COMMENT_STATE_LABELS[s]}: ${counts[s]}`);
  return parts.length ? parts.join(" · ") : "Keine Kommentare";
}

export function ReviewList({ project, onOpen }: { project: ProjectView; onOpen: (reviewId: string) => void }) {
  const { client, subscribe, announce } = useApp();
  const id = useId();
  const projectId = project.config.projectId;
  const [reviews, setReviews] = useState<ReviewSummary[] | null>(null);
  const [title, setTitle] = useState("");
  const load = useAction();
  const create = useAction();

  const reload = () =>
    load.run(async () => {
      const list = await client.listReviews(projectId);
      list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setReviews(list);
    });

  useEffect(() => {
    void reload();
  }, [projectId, client]);

  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "review.updated" || e.type === "reconnected" || e.type === "comment.updated") void reload();
      }),
    [subscribe, projectId],
  );

  const startNew = (e: Event) => {
    e.preventDefault();
    void create.run(async () => {
      const t = title.trim();
      const review = await client.createReview(t ? { projectId, title: t } : { projectId });
      announce(`Review „${review.title}“ gestartet.`);
      onOpen(review.id);
    });
  };

  const remove = async (r: ReviewSummary) => {
    const ok = await confirmDialog({
      title: `Review „${r.title}“ löschen?`,
      message:
        "Die lokalen Kommentare, Screenshots und Verarbeitungsschritte dieses Reviews werden gelöscht. Bereits erstellte oder ergänzte Tickets in Kan bleiben bestehen.",
      confirmLabel: "Review löschen",
      danger: true,
    });
    if (!ok) return;
    await load.run(async () => {
      await client.deleteReview(r.id);
      await forgetReview(r.id);
      announce(`Review „${r.title}“ gelöscht.`);
      await reload();
    });
  };

  return (
    <div class="stack">
      <form class="card stack-sm" onSubmit={startNew} aria-labelledby={`${id}-new`}>
        <h2 id={`${id}-new`}>Neuer Review</h2>
        <Field label="Titel (optional)" id={`${id}-title`}>
          <input id={`${id}-title`} class="input" value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
        </Field>
        <ErrorText error={create.error} />
        <div class="row">
          <button type="submit" class="btn primary" disabled={create.busy}>
            Neuen Review starten
          </button>
        </div>
      </form>

      <section class="stack-sm" aria-labelledby={`${id}-list`}>
        <h2 id={`${id}-list`}>Bisherige Reviews</h2>
        <ErrorText error={load.error} />
        {reviews === null && !load.error && <p class="muted">Lade …</p>}
        {reviews?.length === 0 && <p class="muted">Noch keine Reviews für dieses Projekt.</p>}
        <ul class="plain-list stack-sm">
          {reviews?.map((r) => (
            <li key={r.id} class="card stack-sm">
              <div>
                <strong>{r.title}</strong>
                <div class="muted small">
                  {formatDate(r.updatedAt)} · {countsText(r.counts)}
                </div>
              </div>
              <div class="row">
                <button type="button" class="btn small primary" onClick={() => onOpen(r.id)}>
                  Öffnen
                </button>
                <button
                  type="button"
                  class="btn small danger"
                  onClick={() => void remove(r)}
                  aria-label={`Review „${r.title}“ löschen`}
                >
                  Löschen
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
