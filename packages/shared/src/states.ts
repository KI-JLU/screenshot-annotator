/** Per-comment processing state (design doc, "Verarbeitung und Zustände"). */
export const COMMENT_STATES = [
  "draft",
  "processing",
  "question_open",
  "decision_open",
  "ready",
  "publishing",
  "ticket_created",
  "published",
  "failed",
  "outcome_unclear",
] as const;
export type CommentState = (typeof COMMENT_STATES)[number];

export const COMMENT_STATE_LABELS: Record<CommentState, string> = {
  draft: "Entwurf",
  processing: "In Verarbeitung",
  question_open: "Rückfrage offen",
  decision_open: "Entscheidung offen",
  ready: "Bereit",
  publishing: "In Veröffentlichung",
  ticket_created: "Ticket erstellt",
  published: "Veröffentlicht",
  failed: "Fehlgeschlagen",
  outcome_unclear: "Ergebnis unklar",
};

/** The user may edit text/context (creating a new revision) only in these states. */
export const EDITABLE_STATES: readonly CommentState[] = ["draft", "question_open", "decision_open", "failed"];

/** Comments in these states are picked up by "Review verarbeiten". */
export const PROCESSABLE_STATES: readonly CommentState[] = ["draft", "failed"];

/** An external write may exist; deleting such a comment only deletes local data. */
export const HAS_EXTERNAL_WRITE_STATES: readonly CommentState[] = [
  "publishing",
  "ticket_created",
  "published",
  "outcome_unclear",
];

export function isEditable(s: CommentState): boolean {
  return EDITABLE_STATES.includes(s);
}
