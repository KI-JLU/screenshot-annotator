/**
 * Chrome's extension id for a manifest `key`: SHA-256 of the DER public key (base64-decoded `key`),
 * first 32 hex digits, each mapped 0-9a-f → a-p. Web Crypto only, so it runs in Node (tests,
 * scripts/check-dist.mjs) and in the browser.
 */
export async function extensionIdFromKey(keyBase64: string): Promise<string> {
  const der = Uint8Array.from(atob(keyBase64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
}
