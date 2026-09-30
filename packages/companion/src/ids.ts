import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Time-sortable IDs with 128 random bits; safe as image filenames. */
export function newId(): string {
  return Date.now().toString(36).padStart(9, "0") + randomBytes(16).toString("hex");
}

export function randomToken(): string { return randomBytes(32).toString("hex"); }
export function hashSecret(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function matchesHash(value: string, hash: string): boolean {
  const a = Buffer.from(hashSecret(value), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...randomBytes(8)].map((byte) => alphabet[byte % alphabet.length]).join("");
}
