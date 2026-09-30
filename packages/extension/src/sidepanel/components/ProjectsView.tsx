import { useEffect, useId, useState } from "preact/hooks";
import type { ProjectView } from "@website-review/shared";
import { useApp } from "../context.ts";
import { ImportProject } from "./ImportProject.tsx";
import { ProjectCard } from "./ProjectCard.tsx";
import { ProjectForm } from "./ProjectForm.tsx";

type Mode = { kind: "list" } | { kind: "create"; fromUrl?: string } | { kind: "edit"; project: ProjectView } | { kind: "import" };

export function ProjectsView({ createFromUrl }: { createFromUrl?: string }) {
  const { projects, reloadProjects } = useApp();
  const id = useId();
  const [mode, setMode] = useState<Mode>(createFromUrl ? { kind: "create", fromUrl: createFromUrl } : { kind: "list" });

  useEffect(() => {
    if (createFromUrl) setMode({ kind: "create", fromUrl: createFromUrl });
  }, [createFromUrl]);

  const back = () => {
    setMode({ kind: "list" });
    void reloadProjects();
  };

  if (mode.kind === "create") return <ProjectForm fromUrl={mode.fromUrl} onDone={back} onCancel={() => setMode({ kind: "list" })} />;
  if (mode.kind === "edit") return <ProjectForm existing={mode.project} onDone={back} onCancel={() => setMode({ kind: "list" })} />;
  if (mode.kind === "import") return <ImportProject onDone={back} onCancel={() => setMode({ kind: "list" })} />;

  return (
    <section class="stack" aria-labelledby={`${id}-h`}>
      <div class="row between wrap">
        <h2 id={`${id}-h`}>Projekte</h2>
        <div class="row">
          <button type="button" class="btn primary small" onClick={() => setMode({ kind: "create" })}>
            Neues Projekt
          </button>
          <button type="button" class="btn small" onClick={() => setMode({ kind: "import" })}>
            Config importieren
          </button>
        </div>
      </div>
      {projects === null && <p class="muted">Lade …</p>}
      {projects?.length === 0 && <p class="muted">Noch keine Projekte. Lege ein Projekt an oder importiere eine Projektconfig.</p>}
      <ul class="plain-list stack">
        {projects?.map((p) => (
          <li key={p.config.projectId}>
            <ProjectCard project={p} onEdit={() => setMode({ kind: "edit", project: p })} />
          </li>
        ))}
      </ul>
    </section>
  );
}
