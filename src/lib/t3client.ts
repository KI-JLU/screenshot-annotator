/** T3 Code HTTP calls and the stored connection. Used by the service worker and the options page. */
import { SCOPES, type ShellSnapshot } from "./t3.ts";

export interface T3Connection {
  serverUrl: string;
  token: string;
  expiresAt: string;
}

const CONNECTION_KEY = "t3.connection";
const LAST_PROJECT_KEY = "t3.lastProject";

/** `reconnect` means the token is missing, expired or revoked: pair again in the options page. */
export class T3Error extends Error {
  constructor(
    message: string,
    readonly reconnect = false,
  ) {
    super(message);
  }
}

export async function loadConnection(): Promise<T3Connection | null> {
  const { [CONNECTION_KEY]: c } = await chrome.storage.local.get(CONNECTION_KEY);
  return (c as T3Connection | undefined) ?? null;
}

export async function clearConnection(): Promise<void> {
  await chrome.storage.local.remove(CONNECTION_KEY);
}

/** Host permission for the server; the pattern ignores the port. Must run inside a user gesture. */
export function serverOrigins(serverUrl: string): string[] {
  const url = new URL(serverUrl);
  return [`${url.protocol}//${url.hostname}/*`];
}

async function request(serverUrl: string, path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl}${path}`, init);
  } catch {
    throw new T3Error(`T3 Code is not reachable at ${serverUrl}. Is it running?`);
  }
  if (res.ok) return res;
  const body = (await res.json().catch(() => ({}))) as { _tag?: string; reason?: string; traceId?: string };
  if (res.status === 401) throw new T3Error("T3 Code rejected the pairing. Connect again in the extension options.", true);
  const detail = [body.reason ?? body._tag, body.traceId && `trace ${body.traceId}`].filter(Boolean).join(", ");
  throw new T3Error(`T3 Code answered ${res.status}${detail ? ` (${detail})` : ""}.`);
}

/** Exchanges a one-time pairing code for a bearer token and stores the connection. */
export async function connect(serverUrl: string, credential: string): Promise<T3Connection> {
  const res = await request(serverUrl, "/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: SCOPES,
      client_label: "Screenshot Annotator",
      client_device_type: "desktop",
    }),
  }).catch((e: unknown) => {
    // A used or expired pairing code is a 401 here, not a stale token.
    if (e instanceof T3Error && e.reconnect) throw new T3Error("The pairing code is invalid, expired or already used. Create a new one.");
    throw e;
  });
  const token = (await res.json()) as { access_token: string; expires_in: number };
  const connection: T3Connection = {
    serverUrl,
    token: token.access_token,
    expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
  };
  await chrome.storage.local.set({ [CONNECTION_KEY]: connection });
  return connection;
}

function authorized(c: T3Connection): HeadersInit {
  return { authorization: `Bearer ${c.token}` };
}

async function failOnUnauthorized<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof T3Error && e.reconnect) await clearConnection();
    throw e;
  }
}

export function fetchShell(c: T3Connection): Promise<ShellSnapshot> {
  return failOnUnauthorized(
    request(c.serverUrl, "/api/orchestration/shell", { headers: authorized(c) }).then((r) => r.json() as Promise<ShellSnapshot>),
  );
}

export async function dispatch(c: T3Connection, command: object): Promise<void> {
  await failOnUnauthorized(
    request(c.serverUrl, "/api/orchestration/dispatch", {
      method: "POST",
      headers: { ...authorized(c), "content-type": "application/json" },
      body: JSON.stringify(command),
    }),
  );
}

/** Last project used per page host, and overall, to preselect next time. */
export async function lastProject(host: string): Promise<string | undefined> {
  const { [LAST_PROJECT_KEY]: last } = await chrome.storage.local.get(LAST_PROJECT_KEY);
  const l = last as { byHost?: Record<string, string>; any?: string } | undefined;
  return l?.byHost?.[host] ?? l?.any;
}

export async function rememberProject(host: string, projectId: string): Promise<void> {
  const { [LAST_PROJECT_KEY]: last } = await chrome.storage.local.get(LAST_PROJECT_KEY);
  const byHost = { ...(last as { byHost?: Record<string, string> } | undefined)?.byHost, [host]: projectId };
  await chrome.storage.local.set({ [LAST_PROJECT_KEY]: { byHost, any: projectId } });
}
