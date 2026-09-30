/**
 * Which form field values must never leave the page (elementText/elementDescription go to Codex and Kan).
 * Pure so it can be unit-tested; the overlay passes the relevant element properties.
 */

export interface FieldInfo {
  /** Lower-case tag name, e.g. "input". */
  tagName: string;
  /** input.type (lower-case); undefined for non-inputs. */
  type?: string | undefined;
  /** Raw autocomplete attribute, may contain several tokens ("section-a shipping cc-number"). */
  autocomplete?: string | null | undefined;
}

const SENSITIVE_TYPES = new Set(["password", "hidden"]);
const SENSITIVE_AUTOCOMPLETE = new Set(["current-password", "new-password", "one-time-code"]);

/** True when the field's current value must be redacted. */
export function isSensitiveField(f: FieldInfo): boolean {
  const tag = f.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea" && tag !== "select") return false;
  if (tag === "input" && SENSITIVE_TYPES.has((f.type ?? "text").toLowerCase())) return true;
  const tokens = (f.autocomplete ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.some((t) => SENSITIVE_AUTOCOMPLETE.has(t) || t.startsWith("cc-"));
}
