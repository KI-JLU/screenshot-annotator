/** Project readiness, checkout mapping, Kan access, site permission, export and delete. */
import { useEffect, useId, useState } from "preact/hooks";
import type { ProjectView } from "@website-review/shared";
import { readinessProblems, shortCommit } from "../../lib/format.ts";
import { hasOrigins, originPatternsForProject, requestOrigins } from "../../lib/permissions.ts";
import { useAction, useApp } from "../context.ts";
import { confirmDialog } from "./ConfirmDialog.tsx";
import { ErrorText } from "./ui.tsx";

export function ProjectCard({ project, onEdit }: { project: ProjectView; onEdit: () => void }) {
  const { client, announce, reloadProjects } = useApp();
  const id = useId();
  const cfg = project.config;
  const problems = readinessProblems(project);
  const action = useAction();
  const [paths, setPaths] = useState<Record<string, string>>(() => pathsOf(project));
  const [permitted, setPermitted] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const patterns = originPatternsForProject(cfg);

  useEffect(() => setPaths(pathsOf(project)), [project]);
  useEffect(() => {
    void hasOrigins(patterns).then(setPermitted);
  }, [patterns.join(" ")]);

  const check = (e: Event) => {
    e.preventDefault();
    void action.run(async () => {
      const current = pathsOf(project);
      const changed = Object.keys(paths).some((k) => (paths[k] ?? "") !== (current[k] ?? ""));
      if (changed) {
        const checkouts: Record<string, string> = {};
        for (const [alias, p] of Object.entries(paths)) if (p.trim()) checkouts[alias] = p.trim();
        await client.setCheckouts(cfg.projectId, checkouts);
      }
      const view = await client.checkProject(cfg.projectId);
      await reloadProjects();
      announce(view.readyForProcessing ? `${cfg.name}: bereit zur Verarbeitung.` : `${cfg.name}: noch nicht bereit.`);
    });
  };

  const saveToken = (e: Event) => {
    e.preventDefault();
    if (!token.trim()) return;
    void action.run(async () => {
      const s = await client.setKanCredential({ baseUrl: cfg.target.baseUrl, apiToken: token.trim() });
      setToken("");
      await client.checkProject(cfg.projectId);
      await reloadProjects();
      announce(s.valid === false ? `Kan-Zugang ungültig${s.problem ? `: ${s.problem}` : ""}.` : "Kan-Zugang gespeichert.");
    });
  };

  const grant = () => {
    // Called directly in the click handler to keep the user gesture.
    void requestOrigins(patterns).then((ok) => {
      setPermitted(ok);
      announce(ok ? "Seitenzugriff erlaubt." : "Seitenzugriff nicht erteilt.");
    });
  };

  const exportConfig = () =>
    action.run(async () => {
      const config = await client.exportProject(cfg.projectId);
      const blob = new Blob([JSON.stringify(config, null, 2) + "\n"], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${cfg.projectId}.website-review.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      announce("Projektconfig exportiert (ohne Tokens und lokale Pfade).");
    });

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Projekt „${cfg.name}“ löschen?`,
      message:
        "Das Projekt, seine lokale Checkout-Zuordnung und alle lokalen Reviews dieses Projekts werden gelöscht. Tickets in Kan bleiben bestehen.",
      confirmLabel: "Projekt löschen",
      danger: true,
    });
    if (!ok) return;
    await action.run(async () => {
      await client.deleteProject(cfg.projectId);
      await reloadProjects();
      announce(`Projekt „${cfg.name}“ gelöscht.`);
    });
  };

  const kan = project.kan;
  // One row per alias of the config, even if the companion has no status for it yet.
  const checkoutRows = cfg.repositoryAliases.map(
    (alias) => project.checkouts.find((c) => c.alias === alias) ?? { alias, path: null, ok: false },
  );
  const needsToken = !kan.tokenConfigured || kan.tokenValid === false;

  return (
    <article class="card stack-sm" aria-labelledby={`${id}-h`}>
      <header class="row between wrap">
        <div>
          <h3 id={`${id}-h`}>{cfg.name}</h3>
          <span class="muted small mono">{cfg.projectId}</span>
        </div>
        <span class={project.readyForProcessing ? "badge tone-ok" : "badge tone-attention"}>
          {project.readyForProcessing ? "Bereit zur Verarbeitung" : "Nicht bereit"}
        </span>
      </header>
      {problems.length > 0 && (
        <ul class="problems small">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <details>
        <summary>Adressregeln und Kan-Ziel</summary>
        <ul class="small mono plain-list">
          {cfg.urlRules.map((r, i) => (
            <li key={i}>
              {r.scheme}://{r.hostname}
              {r.port ? `:${r.port}` : ""}
              {r.pathPrefix ?? "/"}
            </li>
          ))}
        </ul>
        <dl class="kv small">
          <dt>Kan</dt>
          <dd class="mono">{cfg.target.baseUrl}</dd>
          <dt>Workspace</dt>
          <dd class="mono">{cfg.target.workspacePublicId}</dd>
          <dt>Board</dt>
          <dd class="mono">{cfg.target.boardPublicId}</dd>
          <dt>Zielspalte</dt>
          <dd class="mono">{cfg.target.listPublicId}</dd>
        </dl>
      </details>

      <form class="stack-sm" onSubmit={check} aria-label={`Checkouts für ${cfg.name}`}>
        <p class="section-label">Lokale Checkouts</p>
        {checkoutRows.map((c) => (
          <div class="field" key={c.alias}>
            <label for={`${id}-co-${c.alias}`}>
              {c.alias}
              <span class={c.ok ? "status-ok" : "status-bad"}>
                {" "}
                – {c.ok ? "OK" : c.path ? (c.problem ?? "ungültig") : "nicht zugeordnet"}
              </span>
            </label>
            <input
              id={`${id}-co-${c.alias}`}
              class="input mono"
              placeholder="/absoluter/pfad/zum/checkout"
              value={paths[c.alias] ?? ""}
              onInput={(e) => setPaths({ ...paths, [c.alias]: e.currentTarget.value })}
              spellcheck={false}
            />
            {"headCommit" in c && c.ok && c.headCommit && (
              <p class="hint">
                {c.branch ?? "detached"} @ {shortCommit(c.headCommit)}
                {c.hasUncommittedChanges ? " · mit uncommitteten Änderungen" : ""}
              </p>
            )}
          </div>
        ))}
        <div class="row">
          <button type="submit" class="btn small primary" disabled={action.busy}>
            Prüfen
          </button>
          <span class="muted small">Speichert geänderte Pfade und prüft Checkouts und Kan.</span>
        </div>
      </form>

      {needsToken && (
        <form class="stack-sm" onSubmit={saveToken}>
          <p class="section-label">Kan-Zugang für {cfg.target.baseUrl}</p>
          <label for={`${id}-tok`} class="small">
            API-Token (wird nur im Begleitdienst gespeichert)
          </label>
          <div class="row">
            <input
              id={`${id}-tok`}
              type="password"
              class="input mono grow"
              autoComplete="off"
              value={token}
              onInput={(e) => setToken(e.currentTarget.value)}
            />
            <button type="submit" class="btn small" disabled={action.busy || !token.trim()}>
              Speichern
            </button>
          </div>
        </form>
      )}

      <div class="row wrap">
        <span class="small">
          Seitenzugriff: {permitted === null ? "…" : permitted ? "erlaubt" : "nicht erlaubt"}
        </span>
        {permitted === false && (
          <button type="button" class="btn small" onClick={grant}>
            Zugriff auf {patterns.length === 1 ? "diese Seite" : `${patterns.length} Seiten`} erlauben
          </button>
        )}
      </div>

      <ErrorText error={action.error} />
      <div class="row wrap actions">
        <button type="button" class="btn small" onClick={onEdit}>
          Bearbeiten
        </button>
        <button type="button" class="btn small" onClick={() => void exportConfig()} disabled={action.busy}>
          Exportieren
        </button>
        <button type="button" class="btn small danger" onClick={() => void remove()} disabled={action.busy}>
          Löschen
        </button>
      </div>
    </article>
  );
}

function pathsOf(p: ProjectView): Record<string, string> {
  return Object.fromEntries(p.checkouts.map((c) => [c.alias, c.path ?? ""]));
}
