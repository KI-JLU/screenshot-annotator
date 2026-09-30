import { describe, expect, it } from "vitest";
import { EXTENSION_ID } from "@website-review/shared";
import sourceManifest from "../../public/manifest.json";
import { extensionIdFromKey } from "./extensionId.ts";

// Non-literal specifier: the built manifest may not exist before the first build.
const DIST_MANIFEST = "../../dist/manifest.json";

async function loadDistManifest(): Promise<{ key?: string } | null> {
  try {
    const mod = (await import(/* @vite-ignore */ DIST_MANIFEST)) as { default: { key?: string } };
    return mod.default;
  } catch {
    return null;
  }
}

describe("extension id", () => {
  it("public/manifest.json key yields EXTENSION_ID", async () => {
    expect(await extensionIdFromKey(sourceManifest.key)).toBe(EXTENSION_ID);
  });

  it("dist/manifest.json key yields EXTENSION_ID (when built)", async (ctx) => {
    const dist = await loadDistManifest();
    if (!dist) ctx.skip();
    expect(dist?.key).toBeTruthy();
    expect(await extensionIdFromKey(dist?.key ?? "")).toBe(EXTENSION_ID);
  });

  it("maps hex digits to a-p", async () => {
    const id = await extensionIdFromKey(btoa("any key bytes"));
    expect(id).toMatch(/^[a-p]{32}$/);
  });
});
