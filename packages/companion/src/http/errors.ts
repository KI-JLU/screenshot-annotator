import type { ApiError, ApiErrorCode } from "@website-review/shared";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = "HttpError";
  }
  toJSON(): ApiError {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }
}

export function notFound(what: string): never { throw new HttpError(404, "not_found", `${what} nicht gefunden`); }
export function conflict(message: string): never { throw new HttpError(409, "conflict", message); }
