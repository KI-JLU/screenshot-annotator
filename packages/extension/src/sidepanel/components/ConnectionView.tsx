import { useEffect, useId, useState } from "preact/hooks";
import type { StatusResponse } from "@website-review/shared";
import { normalizeBaseUrl } from "../../lib/api.ts";
import { saveSettings } from "../../lib/settings.ts";
import { useAction, useApp } from "../context.ts";
import { confirmDialog } from "./ConfirmDialog.tsx";
import { ErrorText, Field } from "./ui.tsx";

export function ConnectionView() {
  const { client, settings, online, announce } = useApp();
  const id = useId();
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const action = useAction();

  const refresh = () =>
    action.run(async () => {
      setStatus(await client.status());
    });

  useEffect(() => {
    void refresh();
  }, [client]);

  const saveUrl = async (e: Event) => {
    e.preventDefault();
    const url = normalizeBaseUrl(baseUrl);
    await saveSettings({ ...settings, baseUrl: url });
    announce("Adresse gespeichert.");
  };

  const unpair = async () => {
    const ok = await confirmDialog({
      title: "Kopplung aufheben?",
      message:
        "Die Extension vergisst den Zugangsschlüssel. Für eine neue Kopplung wird ein Code von „website-review-companion pair“ benötigt. Reviews bleiben im Begleitdienst gespeichert.",
      confirmLabel: "Kopplung aufheben",
      danger: true,
    });
    if (ok) await saveSettings({ baseUrl: settings.baseUrl });
  };

  return (
    <section class="stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Verbindung</h2>
      <dl class="kv">
        <dt>Begleitdienst</dt>
        <dd>{online === false ? "nicht erreichbar" : online ? "verbunden" : "unbekannt"}</dd>
        <dt>Version</dt>
        <dd>{status?.version ?? "–"}</dd>
        <dt>Codex</dt>
        <dd>
          {status
            ? status.codex.available
              ? `verfügbar${status.codex.version ? ` (${status.codex.version})` : ""}`
              : `nicht verfügbar${status.codex.problem ? `: ${status.codex.problem}` : ""}`
            : "–"}
        </dd>
      </dl>
      <ErrorText error={action.error} />
      <div class="row">
        <button type="button" class="btn" onClick={() => void refresh()} disabled={action.busy}>
          Status prüfen
        </button>
      </div>
      <form class="stack" onSubmit={saveUrl}>
        <Field label="Adresse des Begleitdienstes" id={`${id}-url`} hint="Standard: http://127.0.0.1:47821">
          <input
            id={`${id}-url`}
            class="input mono"
            value={baseUrl}
            onInput={(e) => setBaseUrl(e.currentTarget.value)}
          />
        </Field>
        <div class="row">
          <button type="submit" class="btn">
            Adresse speichern
          </button>
          <button type="button" class="btn danger" onClick={() => void unpair()}>
            Kopplung aufheben
          </button>
        </div>
      </form>
    </section>
  );
}
