import type { IncomingMessage } from "node:http";
import { matchesHash } from "../ids.ts";
import { Store } from "../store/store.ts";
import { HttpError } from "./errors.ts";

export function isExtensionOrigin(origin?: string): origin is string {
  return !!origin && /^chrome-extension:\/\/[a-zA-Z0-9_-]+$/.test(origin);
}
function bearer(req: IncomingMessage): string {
  const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? "");
  if (!match) throw new HttpError(401, "unauthorized", "Kopplung mit dem Begleitdienst erforderlich");
  return match[1]!;
}
export function authenticateExtension(req: IncomingMessage, store: Store): void {
  const token = bearer(req); const pairing = store.getPairing();
  if (!pairing || !matchesHash(token, pairing.tokenHash)) {
    throw new HttpError(401, "unauthorized", "Kopplung mit dem Begleitdienst erforderlich");
  }
  if (req.headers.origin !== undefined && req.headers.origin !== pairing.extensionOrigin) throw new HttpError(403, "forbidden_origin", "Extension ist nicht gekoppelt");
}
export function authenticateInternal(req: IncomingMessage, internalTokenHash: string): void {
  if (!matchesHash(bearer(req), internalTokenHash)) throw new HttpError(401, "unauthorized", "Interner Zugang ungültig");
}
