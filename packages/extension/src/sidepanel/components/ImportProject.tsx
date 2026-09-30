/** Import a shared project config from a file or pasted JSON. */
import { useId, useState } from "preact/hooks";
import { ProjectConfigSchema } from "@website-review/shared";
import { isCompanionError } from "../../lib/api.ts";
import { useAction, useApp } from "../context.ts";
import { confirmDialog } from "./ConfirmDialog.tsx";
import { issuePath } from "./ProjectForm.tsx";
import { ErrorText, Field } from "./ui.tsx";

export function ImportProject({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { client, announce } = useApp();
  const id = useId();
  const [text, setText] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const action = useAction();

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
    setIssues([]);
  };

  const submit = (e: Event) => {
    e.preventDefault();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      setIssues(["Der Inhalt ist kein gültiges JSON."]);
      return;
    }
    const parsed = ProjectConfigSchema.safeParse(json);
    if (!parsed.success) {
      setIssues(
        parsed.error.issues.map((i) =>
          i.code === "unrecognized_keys"
            ? `${issuePath(i.path)}: unbekannte Felder (${i.keys.join(", ")}) – Projektconfigs enthalten keine Tokens oder lokalen Pfade.`
            : `${issuePath(i.path)}: ${i.message}`,
        ),
      );
      return;
    }
    setIssues([]);
    void action.run(async () => {
      let view;
      try {
        view = await client.importProject({ config: json });
      } catch (err) {
        if (!(isCompanionError(err) && err.code === "conflict")) throw err;
        const ok = await confirmDialog({
          title: `Projekt „${parsed.data.projectId}“ existiert bereits`,
          message:
            "Adressregeln, Name, Aliasse und Kan-Ziel durch die importierte Config ersetzen? Deine lokale Checkout-Zuordnung und deine Reviews bleiben erhalten.",
          confirmLabel: "Ersetzen",
        });
        if (!ok) return;
        view = await client.importProject({ config: json, replaceExisting: true });
      }
      announce(
        `Projekt „${view.config.name}“ importiert. Bitte jetzt lokale Checkouts zuordnen und den Kan-Zugang hinterlegen.`,
      );
      onDone();
    });
  };

  return (
    <form class="stack" onSubmit={submit} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Projektconfig importieren</h2>
      <p class="small">
        Die Config enthält Adressregeln, Repository-Aliasse und das Kan-Ziel – keine Tokens und keine lokalen Pfade.
      </p>
      <Field label="Datei wählen" id={`${id}-file`}>
        <input
          id={`${id}-file`}
          type="file"
          accept=".json,application/json"
          class="input"
          onChange={(e) => void readFile(e.currentTarget.files?.[0])}
        />
      </Field>
      <Field label="… oder JSON einfügen" id={`${id}-json`}>
        <textarea
          id={`${id}-json`}
          class="input mono"
          rows={10}
          spellcheck={false}
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </Field>
      {issues.length > 0 && (
        <div class="alert" role="alert">
          <p>Die Config ist ungültig:</p>
          <ul>
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      )}
      <ErrorText error={action.error} />
      <div class="row">
        <button type="submit" class="btn primary" disabled={!text.trim() || action.busy}>
          Importieren
        </button>
        <button type="button" class="btn" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}
