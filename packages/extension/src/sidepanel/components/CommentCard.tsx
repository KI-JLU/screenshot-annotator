/** One comment with state label, details and the actions its state allows. */
import { useEffect, useId, useState } from "preact/hooks";
import type { Comment, DuplicateCandidate, MergeProposal, OpenQuestion, ReviewDetail } from "@website-review/shared";
import { HAS_EXTERNAL_WRITE_STATES, isEditable } from "@website-review/shared";
import { isCompanionError } from "../../lib/api.ts";
import { MARK_KIND_LABELS, formatDate } from "../../lib/format.ts";
import { useAction, useApp } from "../context.ts";
import { confirmDialog } from "./ConfirmDialog.tsx";
import { ErrorText, Field, StateBadge } from "./ui.tsx";

interface Props {
  comment: Comment;
  index: number;
  review: ReviewDetail;
  allComments: Comment[];
  /** Called after a successful action; `updated` when the API returned the new comment. */
  onChanged: (updated?: Comment) => void;
}

export function CommentCard({ comment: c, index, review, allComments, onChanged }: Props) {
  const { client, announce } = useApp();
  const id = useId();
  const action = useAction();
  const [editing, setEditing] = useState(false);

  const act = (label: string, fn: () => Promise<Comment | void>) =>
    action.run(async () => {
      const res = await fn();
      announce(label);
      onChanged(res ?? undefined);
    });

  const remove = async () => {
    const external = HAS_EXTERNAL_WRITE_STATES.includes(c.state) || !!c.ticket;
    const ok = await confirmDialog({
      title: `Kommentar ${index} löschen?`,
      message: external
        ? "Der Kommentar und sein Screenshot werden lokal gelöscht. Das Ticket bzw. die Ergänzung in Kan bleibt bestehen."
        : "Der Kommentar und sein Screenshot werden gelöscht.",
      confirmLabel: "Löschen",
      danger: true,
    });
    if (ok) await act(`Kommentar ${index} gelöscht.`, () => client.deleteComment(c.id));
  };

  const pending = c.pendingDecision;
  const proposal = pending?.kind === "merge" ? review.mergeProposals.find((p) => p.id === pending.proposalId) : undefined;

  return (
    <article class={`card comment state-${c.state}`} aria-labelledby={`${id}-h`}>
      <header class="row between wrap">
        <h4 id={`${id}-h`} class="comment-title">
          #{index} · {MARK_KIND_LABELS[c.markKind]}
        </h4>
        <StateBadge state={c.state} />
      </header>
      {c.stateDetail && <p class="state-detail">{c.stateDetail}</p>}

      <div class="comment-body">
        {c.screenshot && <Thumb commentId={c.id} revision={c.revision} index={index} />}
        <div class="grow stack-xs">
          {!editing && <p class="prewrap">{c.text}</p>}
          <p class="muted small ellipsis" title={c.context.url}>
            {pathOf(c.context.url)} · {formatDate(c.createdAt)}
            {c.revision > 1 ? ` · Revision ${c.revision}` : ""}
          </p>
          {c.context.elementDescription && (
            <p class="small ellipsis">
              <code>{c.context.elementDescription}</code>
            </p>
          )}
          {c.context.extraContext && !editing && (
            <p class="small prewrap">
              <span class="muted">Zusätzlicher Kontext:</span> {c.context.extraContext}
            </p>
          )}
        </div>
      </div>

      {c.ticket && (
        <p class="ticket">
          {c.ticket.mode === "created" ? "Ticket: " : "Ergänzt in: "}
          <a href={c.ticket.url} target="_blank" rel="noreferrer">
            {c.ticket.title || c.ticket.cardPublicId}
          </a>
          {!c.ticket.attachmentUploaded && <span class="muted"> · Screenshot-Upload ausstehend</span>}
        </p>
      )}
      {c.mergeGroupId && <p class="small muted">Wird mit anderen Kommentaren als gemeinsames Ticket verarbeitet.</p>}

      {c.analysis && <AnalysisDetails comment={c} />}

      {editing ? (
        <EditForm
          comment={c}
          onCancel={() => setEditing(false)}
          onSaved={(updated) => {
            setEditing(false);
            announce(`Kommentar ${index} gespeichert (Revision ${updated.revision}).`);
            onChanged(updated);
          }}
          onConflict={() => onChanged()}
        />
      ) : null}

      {c.questions.length > 0 && (
        <Questions comment={c} onAnswered={(updated) => onChanged(updated)} />
      )}

      {pending?.kind === "duplicate" && (
        <DuplicateDecision
          candidates={pending.candidates}
          busy={action.busy}
          onAppend={(card) =>
            act("Entscheidung gespeichert: Vorhandenes Ticket wird ergänzt.", () =>
              client.decide(c.id, { kind: "duplicate", action: "append", cardPublicId: card }),
            )
          }
          onCreateNew={() =>
            act("Entscheidung gespeichert: Neues Ticket wird erstellt.", () =>
              client.decide(c.id, { kind: "duplicate", action: "create_new" }),
            )
          }
        />
      )}

      {pending?.kind === "merge" && (
        <MergeDecision
          proposal={proposal}
          self={c}
          allComments={allComments}
          busy={action.busy}
          onDecide={(accept) =>
            act(accept ? "Zusammenfassung angenommen." : "Zusammenfassung abgelehnt – Kommentare laufen einzeln weiter.", () =>
              client.decide(c.id, { kind: "merge", proposalId: pending.proposalId, action: accept ? "accept" : "reject" }),
            )
          }
        />
      )}

      {c.state === "outcome_unclear" && (
        <Reconcile
          busy={action.busy}
          onRecheck={() => act("Abgleich ausgeführt.", () => client.reconcile(c.id, { action: "recheck" }))}
          onExists={(card) =>
            act("Karte verknüpft.", () => client.reconcile(c.id, { action: "confirm_exists", cardPublicId: card }))
          }
          onAbsent={() => act("Neuer Erstellversuch freigegeben.", () => client.reconcile(c.id, { action: "confirm_absent" }))}
        />
      )}

      <ErrorText error={action.error} />

      {!editing && (
        <div class="row wrap actions">
          {isEditable(c.state) && (
            <button type="button" class="btn small" onClick={() => setEditing(true)}>
              Bearbeiten
            </button>
          )}
          {c.state === "failed" && (
            <button
              type="button"
              class="btn small primary"
              disabled={action.busy}
              onClick={() => void act("Erneuter Versuch gestartet.", () => client.retry(c.id))}
            >
              Erneut versuchen
            </button>
          )}
          <button
            type="button"
            class="btn small danger"
            disabled={action.busy}
            onClick={() => void remove()}
            aria-label={`Kommentar ${index} löschen`}
          >
            Löschen
          </button>
        </div>
      )}
    </article>
  );
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function Thumb({ commentId, revision, index }: { commentId: string; revision: number; index: number }) {
  const { client } = useApp();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [large, setLarge] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    client.commentImageUrl(commentId, revision).then(
      (u) => alive && setSrc(u),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [client, commentId, revision]);

  if (failed) return <span class="thumb placeholder small muted">Bild nicht verfügbar</span>;
  if (!src) return <span class="thumb placeholder small muted">Bild …</span>;
  return (
    <button
      type="button"
      class={large ? "thumb large" : "thumb"}
      onClick={() => setLarge(!large)}
      aria-expanded={large}
      aria-label={large ? `Screenshot zu Kommentar ${index} verkleinern` : `Screenshot zu Kommentar ${index} vergrößern`}
    >
      <img src={src} alt={`Screenshot zu Kommentar ${index}`} />
    </button>
  );
}

function AnalysisDetails({ comment: c }: { comment: Comment }) {
  const a = c.analysis;
  if (!a) return null;
  return (
    <details class="analysis">
      <summary>Aufbereitetes Ticket{a.revision !== c.revision ? ` (zu Revision ${a.revision})` : ""}</summary>
      <div class="stack-xs">
        <p>
          <strong>{a.ticket.title}</strong>
        </p>
        <p class="prewrap">{a.ticket.desiredChange}</p>
        {a.findings.length > 0 && (
          <>
            <p class="muted small">Code-Fundstellen (lokal untersucht):</p>
            <ul class="small">
              {a.findings.map((f, i) => (
                <li key={i}>
                  <code>
                    {f.repository}: {f.path}
                    {f.lineStart ? `:${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ""}` : ""}
                  </code>{" "}
                  – {f.note}
                </li>
              ))}
            </ul>
          </>
        )}
        {a.ticket.implementationIdeas.length > 0 && (
          <>
            <p class="muted small">Umsetzungsideen (Vermutung):</p>
            <ul class="small">
              {a.ticket.implementationIdeas.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </>
        )}
        {a.ticket.openPoints.length > 0 && (
          <>
            <p class="muted small">Offene Angaben:</p>
            <ul class="small">
              {a.ticket.openPoints.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}

function EditForm(props: {
  comment: Comment;
  onCancel: () => void;
  onSaved: (c: Comment) => void;
  onConflict: () => void;
}) {
  const { client } = useApp();
  const c = props.comment;
  const id = useId();
  const [text, setText] = useState(c.text);
  const [extra, setExtra] = useState(c.context.extraContext ?? "");
  const [conflict, setConflict] = useState<string | null>(null);
  const action = useAction();

  const save = (e: Event) => {
    e.preventDefault();
    if (!text.trim()) return;
    setConflict(null);
    void action.run(async () => {
      try {
        const updated = await client.updateComment(c.id, {
          baseRevision: c.revision,
          text: text.trim(),
          context: { extraContext: extra.trim() },
        });
        props.onSaved(updated);
      } catch (err) {
        if (isCompanionError(err) && err.code === "conflict") {
          setConflict(
            `Der Kommentar wurde zwischenzeitlich geändert oder ist nicht mehr bearbeitbar (${err.message}). Der aktuelle Stand wird geladen; deine Eingabe bleibt hier erhalten – bitte prüfen und erneut speichern.`,
          );
          props.onConflict();
          return;
        }
        throw err;
      }
    });
  };

  return (
    <form class="stack-sm edit" onSubmit={save}>
      <Field label="Kommentar" id={`${id}-t`}>
        <textarea id={`${id}-t`} class="input" rows={4} required value={text} onInput={(e) => setText(e.currentTarget.value)} />
      </Field>
      <Field label="Zusätzlicher Kontext" id={`${id}-x`}>
        <textarea id={`${id}-x`} class="input" rows={2} value={extra} onInput={(e) => setExtra(e.currentTarget.value)} />
      </Field>
      {conflict && (
        <p class="alert" role="alert">
          {conflict}
        </p>
      )}
      <ErrorText error={action.error} />
      <p class="hint">Speichern erzeugt eine neue Revision (aktuell {c.revision}).</p>
      <div class="row">
        <button type="submit" class="btn small primary" disabled={action.busy || !text.trim() || !isEditable(c.state)}>
          Speichern
        </button>
        <button type="button" class="btn small" onClick={props.onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}

function Questions({ comment: c, onAnswered }: { comment: Comment; onAnswered: (c: Comment) => void }) {
  return (
    <div class="questions stack-sm">
      <p class="section-label">Rückfragen</p>
      {c.questions.map((q) => (
        <QuestionItem key={q.id} comment={c} question={q} onAnswered={onAnswered} />
      ))}
    </div>
  );
}

function QuestionItem(props: { comment: Comment; question: OpenQuestion; onAnswered: (c: Comment) => void }) {
  const { client, announce } = useApp();
  const { question: q, comment: c } = props;
  const id = useId();
  const [answer, setAnswer] = useState("");
  const action = useAction();
  const open = !q.answer && c.state === "question_open";

  const submit = (e: Event) => {
    e.preventDefault();
    if (!answer.trim()) return;
    void action.run(async () => {
      const updated = await client.answer(c.id, { questionId: q.id, answer: answer.trim() });
      setAnswer("");
      announce("Antwort gesendet.");
      props.onAnswered(updated);
    });
  };

  return (
    <div class="question">
      <p class="prewrap">
        <strong>Frage:</strong> {q.text}
      </p>
      {q.answer ? (
        <p class="prewrap">
          <strong>Antwort:</strong> {q.answer}
        </p>
      ) : open ? (
        <form class="stack-xs" onSubmit={submit}>
          <label for={`${id}-a`} class="sr-only">
            Antwort auf: {q.text}
          </label>
          <textarea
            id={`${id}-a`}
            class="input"
            rows={2}
            value={answer}
            onInput={(e) => setAnswer(e.currentTarget.value)}
            placeholder="Antwort"
          />
          <ErrorText error={action.error} />
          <div class="row">
            <button type="submit" class="btn small primary" disabled={action.busy || !answer.trim()}>
              Antwort senden
            </button>
          </div>
        </form>
      ) : (
        <p class="muted small">Noch nicht beantwortet.</p>
      )}
    </div>
  );
}

function DuplicateDecision(props: {
  candidates: DuplicateCandidate[];
  busy: boolean;
  onAppend: (cardPublicId: string) => void;
  onCreateNew: () => void;
}) {
  return (
    <div class="decision stack-sm">
      <p class="section-label">Mögliches Duplikat – bitte entscheiden</p>
      <ul class="plain-list stack-sm">
        {props.candidates.map((d) => (
          <li key={d.cardPublicId} class="candidate stack-xs">
            <a href={d.url} target="_blank" rel="noreferrer">
              {d.title || d.cardPublicId}
            </a>
            <p class="small prewrap">
              <span class="muted">Begründung:</span> {d.reason}
            </p>
            <div class="row">
              <button
                type="button"
                class="btn small"
                disabled={props.busy}
                onClick={() => props.onAppend(d.cardPublicId)}
                aria-label={`Vorhandenes ergänzen: ${d.title || d.cardPublicId}`}
              >
                Vorhandenes ergänzen
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div class="row">
        <button type="button" class="btn small primary" disabled={props.busy} onClick={props.onCreateNew}>
          Neu erstellen
        </button>
      </div>
    </div>
  );
}

function MergeDecision(props: {
  proposal: MergeProposal | undefined;
  self: Comment;
  allComments: Comment[];
  busy: boolean;
  onDecide: (accept: boolean) => void;
}) {
  const { proposal } = props;
  if (!proposal) return <p class="muted small">Zusammenfassungsvorschlag wird geladen …</p>;
  const others = proposal.commentIds
    .filter((cid) => cid !== props.self.id)
    .map((cid) => {
      const i = props.allComments.findIndex((x) => x.id === cid);
      const other = props.allComments[i];
      return { cid, label: other ? `#${i + 1}: ${snippet(other.text)}` : cid };
    });
  return (
    <div class="decision stack-sm">
      <p class="section-label">Vorschlag: zu einem gemeinsamen Ticket zusammenfassen</p>
      <p class="small prewrap">
        <span class="muted">Begründung:</span> {proposal.reason}
      </p>
      <p class="small">Zusammen mit:</p>
      <ul class="small">
        {others.map((o) => (
          <li key={o.cid}>{o.label}</li>
        ))}
      </ul>
      {proposal.status === "open" ? (
        <div class="row wrap">
          <button type="button" class="btn small primary" disabled={props.busy} onClick={() => props.onDecide(true)}>
            Zusammenfassen
          </button>
          <button type="button" class="btn small" disabled={props.busy} onClick={() => props.onDecide(false)}>
            Ablehnen – einzeln verarbeiten
          </button>
        </div>
      ) : (
        <p class="small muted">{proposal.status === "accepted" ? "Angenommen." : "Abgelehnt."}</p>
      )}
    </div>
  );
}

function snippet(t: string): string {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

/** Accepts a Kan card id or a card link (…/cards/<id>). */
export function cardIdFromInput(input: string): string {
  const s = input.trim();
  const m = /\/cards\/([^/?#]+)/.exec(s);
  return m?.[1] ? decodeURIComponent(m[1]) : s;
}

function Reconcile(props: {
  busy: boolean;
  onRecheck: () => void;
  onExists: (cardPublicId: string) => void;
  onAbsent: () => void;
}) {
  const id = useId();
  const [card, setCard] = useState("");
  const confirmAbsent = async () => {
    const ok = await confirmDialog({
      title: "Wirklich keine Karte vorhanden?",
      message:
        "Bitte in Kan prüfen, dass zu diesem Kommentar keine Karte angelegt wurde. Danach wird ein neuer Erstellversuch freigegeben – existiert die Karte doch, entsteht ein Duplikat.",
      confirmLabel: "Keine Karte vorhanden – neu erstellen",
      danger: true,
    });
    if (ok) props.onAbsent();
  };
  return (
    <div class="decision stack-sm">
      <p class="section-label">Ergebnis unklar – Abgleich nötig</p>
      <p class="small">
        Eine Schreibaktion wurde gesendet, aber nicht bestätigt. Es wird keine weitere Karte angelegt, bis geklärt ist, ob
        sie existiert.
      </p>
      <div class="row">
        <button type="button" class="btn small primary" disabled={props.busy} onClick={props.onRecheck}>
          Erneut abgleichen
        </button>
      </div>
      <form
        class="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          const v = cardIdFromInput(card);
          if (v) props.onExists(v);
        }}
      >
        <label for={`${id}-card`} class="small">
          Karten-ID oder Link
        </label>
        <input
          id={`${id}-card`}
          class="input mono grow"
          value={card}
          onInput={(e) => setCard(e.currentTarget.value)}
          placeholder="z. B. abc123 oder https://kan.bn/cards/abc123"
        />
        <button type="submit" class="btn small" disabled={props.busy || !card.trim()}>
          Karte existiert
        </button>
      </form>
      <div class="row">
        <button type="button" class="btn small danger" disabled={props.busy} onClick={() => void confirmAbsent()}>
          Keine Karte vorhanden – neu erstellen
        </button>
      </div>
    </div>
  );
}
