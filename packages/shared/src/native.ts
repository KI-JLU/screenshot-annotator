/**
 * Transport between extension and companion: Chrome Native Messaging.
 * Chrome starts the companion (`website-review-companion native-host`) when the extension's
 * service worker calls chrome.runtime.connectNative(NATIVE_HOST_NAME). Only the extension id listed in
 * the host manifest's allowed_origins can connect, so there is no pairing and no token.
 *
 * Framing (both directions): 4-byte little-endian length + UTF-8 JSON. Chrome limits host→extension
 * messages to 1 MiB, so larger responses are split into NativeChunk frames (see MAX_NATIVE_FRAME_BYTES).
 * The routes and bodies are those documented in api.ts; only the envelope differs from HTTP.
 */
import type { CompanionEvent } from "./api.ts";

export const NATIVE_HOST_NAME = "de.website_review.companion";
/** Stable id of the unpacked extension, derived from the `key` in packages/extension/public/manifest.json. */
export const EXTENSION_ID = "ncgffplfgbdklhlkklkfefbennjdbnko";
/** Serialized NativeResponse larger than this is sent as chunks. Leaves headroom below Chrome's 1 MiB. */
export const MAX_NATIVE_FRAME_BYTES = 768 * 1024;

export type NativeMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Extension → companion. `path` includes the query string, e.g. "/v1/reviews?projectId=demo". */
export interface NativeRequest {
  type: "request";
  id: string;
  method: NativeMethod;
  path: string;
  body?: unknown;
}

/**
 * Companion → extension. `status` uses HTTP semantics; error bodies are ApiError.
 * 204 responses have no body. GET /v1/comments/:id/image answers { pngBase64 }.
 */
export interface NativeResponse {
  type: "response";
  id: string;
  status: number;
  body?: unknown;
}

/** One slice of JSON.stringify(NativeResponse) for responses above MAX_NATIVE_FRAME_BYTES. Reassemble by index, then JSON.parse. */
export interface NativeChunk {
  type: "chunk";
  id: string;
  index: number;
  count: number;
  data: string;
}

/** Companion → extension push (replaces the former SSE stream). */
export interface NativeEvent {
  type: "event";
  event: CompanionEvent;
}

/** Sent once right after the host starts, and whenever its readiness changes. */
export interface NativeHello {
  type: "hello";
  version: string;
  /** Present when this host process cannot serve (e.g. another browser profile already runs the companion). */
  problem?: string;
}

export type NativeIncoming = NativeRequest;
export type NativeOutgoing = NativeResponse | NativeChunk | NativeEvent | NativeHello;

export interface ImageResponse {
  pngBase64: string;
}
