import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPaths } from "../../src/paths.ts";

describe("XDG paths", () => {
  it("uses XDG directories with companion-specific overrides", () => {
    expect(getPaths({ XDG_DATA_HOME: "/tmp/xdg-data", XDG_CONFIG_HOME: "/tmp/xdg-config" })).toEqual({
      dataDir: "/tmp/xdg-data/website-review", configDir: "/tmp/xdg-config/website-review",
    });
    expect(getPaths({ WEBSITE_REVIEW_DATA_DIR: "/tmp/custom-data", WEBSITE_REVIEW_CONFIG_DIR: "/tmp/custom-config" })).toEqual({
      dataDir: "/tmp/custom-data", configDir: "/tmp/custom-config",
    });
  });
  it("ignores empty and relative XDG values", () => {
    expect(getPaths({ XDG_DATA_HOME: "relative", XDG_CONFIG_HOME: "", WEBSITE_REVIEW_DATA_DIR: "" })).toEqual({
      dataDir: join(homedir(), ".local/share/website-review"), configDir: join(homedir(), ".config/website-review"),
    });
  });
});
