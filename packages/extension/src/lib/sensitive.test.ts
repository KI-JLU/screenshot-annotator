import { describe, expect, it } from "vitest";
import { isSensitiveField } from "./sensitive.ts";

describe("isSensitiveField", () => {
  it("redacts password and hidden inputs", () => {
    expect(isSensitiveField({ tagName: "INPUT", type: "password" })).toBe(true);
    expect(isSensitiveField({ tagName: "input", type: "Hidden" })).toBe(true);
  });
  it("redacts credential, one-time-code and payment autocomplete hints", () => {
    expect(isSensitiveField({ tagName: "input", type: "text", autocomplete: "current-password" })).toBe(true);
    expect(isSensitiveField({ tagName: "input", type: "text", autocomplete: "section-login new-password" })).toBe(true);
    expect(isSensitiveField({ tagName: "input", type: "text", autocomplete: "one-time-code" })).toBe(true);
    expect(isSensitiveField({ tagName: "input", type: "tel", autocomplete: "billing cc-number" })).toBe(true);
    expect(isSensitiveField({ tagName: "select", autocomplete: "cc-exp-month" })).toBe(true);
    expect(isSensitiveField({ tagName: "textarea", autocomplete: "cc-csc" })).toBe(true);
  });
  it("keeps ordinary fields and non-fields", () => {
    expect(isSensitiveField({ tagName: "input", type: "text", autocomplete: "name" })).toBe(false);
    expect(isSensitiveField({ tagName: "input" })).toBe(false);
    expect(isSensitiveField({ tagName: "textarea" })).toBe(false);
    expect(isSensitiveField({ tagName: "div", autocomplete: "cc-number" })).toBe(false);
  });
});
