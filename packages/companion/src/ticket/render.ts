import type { CaptureContext, CommentAnalysis, MarkKind, TicketDraft } from "@website-review/shared";

export interface RenderCardInput {
  comments: { text: string; markKind: MarkKind; context: CaptureContext }[];
  analysis: Pick<CommentAnalysis, "ticket" | "findings" | "checkouts">;
  reference: string;
}

// Slice by UTF-16 length (Kan's cap), without leaving half a surrogate pair.
function clip(text: string, length: number): string {
  const result = text.slice(0, Math.max(0, length));
  return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result;
}

export function renderCardTitle(draft: TicketDraft): string {
  return clip(draft.title.replace(/\s+/g, " ").trim(), 200);
}

function stagingNote(input: RenderCardInput): string {
  const stands = input.analysis.checkouts.map((checkout) =>
    `${checkout.alias} @ ${checkout.headCommit.slice(0, 7)}${checkout.branch ? ` (${checkout.branch})` : ""}${checkout.hasUncommittedChanges ? ", mit uncommitteten Änderungen" : ""}`,
  );
  return stands.length
    ? `_Lokal untersuchter Stand: ${stands.join("; ")}. Übereinstimmung mit dem deployten Stand ist nicht geprüft._`
    : "_Lokaler Code wurde untersucht. Übereinstimmung mit dem deployten Stand ist nicht geprüft._";
}

function render(input: RenderCardInput, prefix: string): string {
  const { ticket, findings } = input.analysis;
  const parts: string[] = [];
  if (prefix) parts.push(prefix);
  if (ticket.desiredChange.trim()) parts.push(ticket.desiredChange);
  for (const comment of input.comments) {
    parts.push(`**Originalkommentar:** „${comment.text}“`);
    const { context } = comment;
    const mark = comment.markKind === "element" ? `Element${context.elementText ? ` „${context.elementText}“` : ""}`
      : comment.markKind === "point" ? "freie Position" : "allgemeiner Seitenkommentar";
    const lines = [
      ...(context.url ? [`- Seite: ${context.url}`] : []),
      `- Fenstergröße: ${context.viewport.width}×${context.viewport.height} (DPR ${context.viewport.devicePixelRatio})`,
      `- Markierung: ${mark}`,
      ...(context.extraContext?.trim() ? [`- Zusätzlicher Kontext: ${context.extraContext}`] : []),
    ];
    parts.push(`### Kontext\n${lines.join("\n")}`);
  }
  if (findings.length) {
    const lines = findings.map((finding) => {
      const location = finding.lineStart == null ? finding.path
        : `${finding.path}:${finding.lineStart}${finding.lineEnd == null || finding.lineEnd === finding.lineStart ? "" : `-${finding.lineEnd}`}`;
      return `- \`${finding.repository}\`: \`${location}\` – ${finding.note}`;
    });
    parts.push(`### Code-Fundstellen (lokal untersucht)\n${lines.join("\n")}`);
  }
  const note = stagingNote(input);
  parts.push(note);
  for (const [heading, entries] of [
    ["Umsetzungsideen (Vermutung)", ticket.implementationIdeas], ["Offene Angaben", ticket.openPoints],
  ] as const) {
    const nonempty = entries.filter((entry) => entry.trim());
    if (nonempty.length) parts.push(`### ${heading}\n${nonempty.map((entry) => `- ${entry}`).join("\n")}`);
  }
  if (!input.reference || /[\r\n]/.test(input.reference)) throw new Error("Review-Referenz muss eine einzelne, nicht leere Zeile sein.");
  const reference = `Review-Referenz: ${input.reference}`;
  const body = parts.join("\n\n");
  if (body.length + reference.length + 2 <= 10_000) return `${body}\n\n${reference}`;
  // Reserve both the deployment caveat and the reconciliation marker before truncating content.
  const suffix = `\n\n_Hinweis: Inhalt wegen der Zeichenbegrenzung gekürzt._\n\n${note}\n\n${reference}`;
  if (suffix.length > 10_000) throw new Error("Standangaben und Review-Referenz überschreiten die Zeichenbegrenzung.");
  return `${clip(body, 10_000 - suffix.length).trimEnd()}${suffix}`;
}

export function renderCardDescription(input: RenderCardInput): string {
  return render(input, "");
}

export function renderAppendComment(input: RenderCardInput): string {
  return render(input, "Ergänzendes Feedback aus Website-Review:");
}
