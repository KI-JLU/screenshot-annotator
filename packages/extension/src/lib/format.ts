/** German labels and readiness texts shared by several views. */
import type { CommentState, MarkKind, PreflightProblem, ProjectView } from "@website-review/shared";

export const MARK_KIND_LABELS: Record<MarkKind, string> = {
  element: "Element",
  point: "Freie Stelle",
  page: "Seitenkommentar",
};

export const PREFLIGHT_KIND_LABELS: Record<PreflightProblem["kind"], string> = {
  checkout: "Checkout",
  codex: "Codex",
  kan_token: "Kan-Zugang",
  kan_target: "Kan-Ziel",
};

/** Visual tone of a state badge; the state is always also written out as text. */
export function stateTone(state: CommentState): "neutral" | "busy" | "attention" | "ok" | "error" {
  switch (state) {
    case "draft":
      return "neutral";
    case "processing":
    case "ready":
    case "publishing":
      return "busy";
    case "question_open":
    case "decision_open":
      return "attention";
    case "ticket_created":
    case "published":
      return "ok";
    case "failed":
    case "outcome_unclear":
      return "error";
  }
}

/** Problems preventing processing, as readable sentences. */
export function readinessProblems(view: ProjectView): string[] {
  const out: string[] = [];
  for (const c of view.checkouts) {
    if (!c.path) out.push(`Checkout „${c.alias}“: kein lokaler Ordner zugeordnet.`);
    else if (!c.ok) out.push(`Checkout „${c.alias}“: ${c.problem ?? "nicht gültig"}.`);
  }
  const k = view.kan;
  if (!k.tokenConfigured) out.push(`Kan-Zugang für ${k.baseUrl} fehlt.`);
  else if (k.tokenValid === false) out.push("Kan-Zugang ungültig.");
  if (k.targetValid === false) out.push("Kan-Ziel (Board oder Spalte) nicht gefunden.");
  if (k.problem && !out.some((p) => p.includes(k.problem as string))) out.push(`Kan: ${k.problem}`);
  if (!view.readyForProcessing && out.length === 0) out.push("Noch nicht geprüft – bitte „Prüfen“ ausführen.");
  return view.readyForProcessing ? [] : out;
}

export function shortCommit(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}
