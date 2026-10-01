/** Options page: pairs the extension with a T3 Code server. */
import { DEFAULT_SERVER_URL, normalizeServerUrl, parsePairingInput } from "./lib/t3.ts";
import { clearConnection, connect, loadConnection, serverOrigins } from "./lib/t3client.ts";

const form = document.querySelector<HTMLFormElement>("#form")!;
const server = document.querySelector<HTMLInputElement>("#server")!;
const pairing = document.querySelector<HTMLInputElement>("#pairing")!;
const status = document.querySelector<HTMLElement>("#status")!;
const disconnect = document.querySelector<HTMLButtonElement>("#disconnect")!;

function show(text: string, kind: "ok" | "error" | "" = ""): void {
  status.textContent = text;
  status.className = kind;
}

async function render(): Promise<void> {
  const c = await loadConnection();
  server.value = c?.serverUrl ?? (server.value || DEFAULT_SERVER_URL);
  disconnect.hidden = !c;
  if (!c) show("Not connected.");
  else if (new Date(c.expiresAt) < new Date()) show(`Pairing with ${c.serverUrl} expired. Connect again.`, "error");
  else show(`Connected to ${c.serverUrl} until ${new Date(c.expiresAt).toLocaleDateString()}.`, "ok");
}

// Pasting a link fills in the server it points to.
pairing.addEventListener("input", () => {
  const parsed = parsePairingInput(pairing.value);
  if (parsed?.serverUrl) server.value = parsed.serverUrl;
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const parsed = parsePairingInput(pairing.value);
  const serverUrl = normalizeServerUrl(parsed?.serverUrl ?? server.value);
  if (!parsed) return show("Paste the pairing link or code from T3 Code.", "error");
  if (!serverUrl) return show("The server must be an http(s) URL.", "error");
  // permissions.request needs the click's user gesture, so it runs before any other await.
  void chrome.permissions.request({ origins: serverOrigins(serverUrl) }).then(async (granted) => {
    if (!granted) return show(`The extension needs access to ${serverUrl} to talk to T3 Code.`, "error");
    show("Connecting…");
    try {
      await connect(serverUrl, parsed.credential);
      pairing.value = "";
      await render();
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), "error");
    }
  });
});

disconnect.addEventListener("click", () => {
  void clearConnection().then(() => {
    void render();
    show("Disconnected. Revoke the session in T3 Code under Settings → Connections if you no longer need it.");
  });
});

void render();
