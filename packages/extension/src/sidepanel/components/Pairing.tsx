import { useEffect, useId, useState } from "preact/hooks";
import type { HealthResponse } from "@website-review/shared";
import { CompanionClient, errorText, normalizeBaseUrl, type CompanionSettings } from "../../lib/api.ts";
import { saveSettings } from "../../lib/settings.ts";
import { ErrorText, Field, Notice } from "./ui.tsx";

/** First run: pair with the companion using the code printed by `website-review-companion pair`. */
export function Pairing({ settings }: { settings: CompanionSettings }) {
  const id = useId();
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null | "offline">(null);

  const checkHealth = async (url: string) => {
    try {
      setHealth(await new CompanionClient({ baseUrl: url }).health());
    } catch {
      setHealth("offline");
    }
  };

  useEffect(() => {
    void checkHealth(settings.baseUrl);
  }, [settings.baseUrl]);

  const submit = async (e: Event) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError("Bitte den Kopplungscode eingeben.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const url = normalizeBaseUrl(baseUrl);
      const res = await new CompanionClient({ baseUrl: url }).pair(trimmed);
      await saveSettings({ baseUrl: url, token: res.token });
    } catch (err) {
      setError(errorText(err));
      void checkHealth(normalizeBaseUrl(baseUrl));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Mit dem Begleitdienst koppeln</h2>
      {health === "offline" && (
        <div class="banner warn" role="alert">
          <p>
            <strong>Begleitdienst nicht erreichbar</strong> unter {normalizeBaseUrl(baseUrl)}. Starte ihn mit{" "}
            <code>website-review-companion serve</code>.
          </p>
          <button type="button" class="btn small" onClick={() => void checkHealth(normalizeBaseUrl(baseUrl))}>
            Erneut prüfen
          </button>
        </div>
      )}
      {health && health !== "offline" && (
        <Notice>
          Begleitdienst erreichbar (Version {health.version}).
          {health.paired && " Er ist bereits mit einer Extension gekoppelt – eine neue Kopplung ersetzt diese."}
        </Notice>
      )}
      <ol class="steps">
        <li>
          Im Terminal <code>website-review-companion pair</code> ausführen.
        </li>
        <li>Den angezeigten Code (8 Zeichen, 10 Minuten gültig) hier eingeben.</li>
      </ol>
      <form class="stack" onSubmit={submit}>
        <Field label="Kopplungscode" id={`${id}-code`}>
          <input
            id={`${id}-code`}
            class="input mono"
            value={code}
            autoComplete="off"
            spellcheck={false}
            maxLength={32}
            onInput={(e) => setCode(e.currentTarget.value)}
            required
          />
        </Field>
        <details>
          <summary>Adresse des Begleitdienstes</summary>
          <Field label="Adresse" id={`${id}-url`} hint="Standard: http://127.0.0.1:47821">
            <input
              id={`${id}-url`}
              class="input mono"
              value={baseUrl}
              onInput={(e) => setBaseUrl(e.currentTarget.value)}
              onBlur={() => void checkHealth(normalizeBaseUrl(baseUrl))}
            />
          </Field>
        </details>
        <ErrorText error={error} />
        <div class="row">
          <button type="submit" class="btn primary" disabled={busy}>
            {busy ? "Kopple …" : "Koppeln"}
          </button>
        </div>
      </form>
    </section>
  );
}
