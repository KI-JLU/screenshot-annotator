/** Native host status: banner for the main views and the "Verbindung" tab. */
import { useEffect, useId, useState } from "preact/hooks";
import type { StatusResponse } from "@website-review/shared";
import type { HostStatus } from "../../lib/nativeTransport.ts";
import { useAction, useApp } from "../context.ts";
import { ErrorText } from "./ui.tsx";

/** The extension cannot know the repository path, so the command is relative to the repo root. */
export const INSTALL_COMMAND = "node packages/companion/dist/cli.js install-native-host";
const INSTALL_COMMAND_CHROMIUM = `${INSTALL_COMMAND} --browser chromium`;

export function hostStatusTitle(s: HostStatus): string {
  switch (s.state) {
    case "connecting":
      return "Verbinde mit dem Begleitdienst …";
    case "connected":
      return `Begleitdienst verbunden (Version ${s.version})`;
    case "not_installed":
      return "Begleitdienst nicht installiert";
    case "problem":
      return s.problemCode === "locked"
        ? "Begleitdienst läuft bereits in einem anderen Browserprofil"
        : "Begleitdienst konnte nicht starten";
    case "disconnected":
      return "Verbindung unterbrochen – neu verbinden…";
  }
}

function CopyCommand({ command }: { command: string }) {
  const { announce } = useApp();
  return (
    <div class="row wrap">
      <code class="command">{command}</code>
      <button
        type="button"
        class="btn small"
        onClick={() =>
          void navigator.clipboard.writeText(command).then(
            () => announce("Befehl kopiert."),
            () => announce("Kopieren nicht möglich – bitte den Befehl markieren und kopieren."),
          )
        }
        aria-label={`Befehl kopieren: ${command}`}
      >
        Kopieren
      </button>
    </div>
  );
}

/** Explanation and actions for a state; `compact` for the banner. */
function HostStatusDetails({ status, compact }: { status: HostStatus; compact?: boolean }) {
  const { reconnect } = useApp();
  const reconnectButton = (
    <button type="button" class="btn small" onClick={reconnect}>
      Erneut verbinden
    </button>
  );
  switch (status.state) {
    case "connecting":
    case "connected":
      return null;
    case "not_installed":
      return (
        <div class="stack-sm">
          <p>
            Chrome findet den lokalen Begleitdienst nicht. Einmalig im Repository ausführen (ein Neustart von Chrome ist
            danach nicht nötig):
          </p>
          <CopyCommand command={INSTALL_COMMAND} />
          {!compact && (
            <>
              <p class="small muted">Für Chromium statt Chrome:</p>
              <CopyCommand command={INSTALL_COMMAND_CHROMIUM} />
            </>
          )}
          <div class="row">{reconnectButton}</div>
        </div>
      );
    case "problem":
      if (status.problemCode !== "locked") {
        return (
          <div class="stack-sm">
            <p>{status.problem}</p>
            <div class="row">{reconnectButton}</div>
          </div>
        );
      }
      return (
        <div class="stack-sm">
          <p>
            Dieser Browser kann den Begleitdienst gerade nicht nutzen, weil er bereits für ein anderes Browserprofil
            läuft. Dort verarbeitete Reviews laufen weiter; hier bitte das andere Profil schließen und erneut
            verbinden.
          </p>
          <p class="small muted">Meldung: {status.problem}</p>
          <div class="row">{reconnectButton}</div>
        </div>
      );
    case "disconnected":
      return (
        <div class="stack-sm">
          <p>
            Der Begleitdienst wurde beendet oder ist abgestürzt. Gespeicherte Entwürfe bleiben erhalten
            {status.retryInMs ? `; neuer Versuch in ${Math.round(status.retryInMs / 1000)} s` : ""}.
          </p>
          <p class="small muted">Meldung: {status.detail}</p>
          <div class="row">{reconnectButton}</div>
        </div>
      );
  }
}

/** Shown above the views whenever the host is not usable. */
export function HostStatusBanner() {
  const { hostStatus } = useApp();
  if (hostStatus.state === "connected" || hostStatus.state === "connecting") return null;
  return (
    <div class={hostStatus.state === "not_installed" ? "banner error" : "banner warn"} role="alert">
      <p>
        <strong>{hostStatusTitle(hostStatus)}</strong>
      </p>
      <HostStatusDetails status={hostStatus} compact />
    </div>
  );
}

export function StatusView() {
  const { client, hostStatus, reconnect } = useApp();
  const id = useId();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const action = useAction();
  const connected = hostStatus.state === "connected";

  const refresh = () =>
    action.run(async () => {
      setStatus(await client.status());
    });

  useEffect(() => {
    setStatus(null);
    if (connected) void refresh();
  }, [client, connected]);

  return (
    <section class="stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Verbindung</h2>
      <div class="card stack-sm" role="status" aria-live="polite">
        <p>
          <strong>{hostStatusTitle(hostStatus)}</strong>
        </p>
        <HostStatusDetails status={hostStatus} />
      </div>
      {connected && (
        <dl class="kv">
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
      )}
      <ErrorText error={action.error} />
      <div class="row wrap">
        {connected && (
          <button type="button" class="btn" onClick={() => void refresh()} disabled={action.busy}>
            Status prüfen
          </button>
        )}
        <button type="button" class="btn" onClick={reconnect}>
          Erneut verbinden
        </button>
      </div>
      <p class="small muted">
        Chrome startet den Begleitdienst automatisch über Native Messaging, solange Chrome läuft. Verarbeitungen
        laufen nur, während Chrome geöffnet ist.
      </p>
    </section>
  );
}
