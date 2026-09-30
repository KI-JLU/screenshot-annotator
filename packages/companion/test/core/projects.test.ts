import { stat, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, fixture, type Fixture } from "./helpers.ts";
import type { ProjectView } from "@website-review/shared";
import { KanError } from "../../src/kan/types.ts";

describe("projects, sharing and Kan targets", () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.close(); });

  it("exports exactly the shared config without local paths or credentials", async () => {
    expect((await f.call("POST", "/v1/projects", config())).status).toBe(200);
    await f.call("PUT", "/v1/projects/example/checkouts", { checkouts: { frontend: "/private/code" } });
    await f.call("PUT", "/v1/kan/credentials", { baseUrl: "https://kan.example", apiToken: "private-token" });
    const response = await f.call("GET", "/v1/projects/example/export");
    const exported = await response.json();
    expect(exported).toEqual(config());
    expect(JSON.stringify(exported)).not.toContain("/private/code");
    expect(JSON.stringify(exported)).not.toContain("private-token");
    const credentials = await f.call("GET", "/v1/kan/credentials");
    expect(await credentials.json()).toEqual([{ baseUrl: "https://kan.example", configured: true, valid: true }]);
    expect((await stat(f.app.secrets.filename)).mode & 0o777).toBe(0o600);
    expect((await stat(f.app.store.dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(f.app.secrets.configDir)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(f.app.secrets.filename, "utf8"))).toEqual({ "https://kan.example": "private-token" });
  });

  it("rejects unknown config fields and malformed schemas", async () => {
    for (const input of [
      { ...config(), token: "secret" }, { ...config(), checkouts: { frontend: "/local" } },
      { ...config(), schemaVersion: 2 }, { ...config(), repositoryAliases: [] },
    ]) {
      const response = await f.call("POST", "/v1/projects/import", { config: input });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
    }
    expect(f.app.store.listProjects()).toEqual([]);
  });

  it("replacing imported shareable config retains the local mapping", async () => {
    await f.call("POST", "/v1/projects/import", { config: config() });
    await f.call("PUT", "/v1/projects/example/checkouts", { checkouts: { frontend: "/local/repo" } });
    const duplicate = await f.call("POST", "/v1/projects/import", { config: config() });
    expect(duplicate.status).toBe(409);
    const replacement = { ...config(), name: "Neuer Name" };
    const response = await f.call("POST", "/v1/projects/import", { config: replacement, replaceExisting: true });
    expect(response.status).toBe(200);
    expect((await response.json() as ProjectView).checkouts[0]?.path).toBe("/local/repo");
    expect(await (await f.call("GET", "/v1/projects/example/export")).json()).toEqual(replacement);
  });

  it("returns both matches and respects port and path segment boundaries", async () => {
    await f.call("POST", "/v1/projects", config("one"));
    await f.call("POST", "/v1/projects", config("two"));
    expect(await (await f.call("POST", "/v1/match", { url: "http://localhost:3000/app/page" })).json()).toEqual({ projectIds: ["one", "two"] });
    for (const url of ["http://localhost:3000/apple", "http://localhost:3001/app", "https://localhost:3000/app"]) {
      expect(await (await f.call("POST", "/v1/match", { url })).json()).toEqual({ projectIds: [] });
    }
  });

  it("does not mistake inherited object properties for mapped repository aliases", async () => {
    const response = await f.call("POST", "/v1/projects", { ...config(), repositoryAliases: ["constructor", "toString"] });
    expect(response.status).toBe(200);
    expect((await response.json() as ProjectView).checkouts).toEqual([
      { alias: "constructor", path: null, ok: false, problem: "Checkout fehlt" },
      { alias: "toString", path: null, ok: false, problem: "Checkout fehlt" },
    ]);
  });

  it("validates credentials before storing and strips cards from list selection responses", async () => {
    vi.mocked(f.kan.listWorkspaces).mockRejectedValueOnce(new KanError("secret-token", "auth", 401, false));
    const failed = await f.call("PUT", "/v1/kan/credentials", { baseUrl: "https://kan.example", apiToken: "secret-token" });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: { code: "kan_error", message: "Kan-Zugang ungültig" } });
    expect(f.app.secrets.get("https://kan.example")).toBeUndefined();
    await f.call("PUT", "/v1/kan/credentials", { baseUrl: "https://kan.example/", apiToken: "valid-token" });
    expect(await (await f.call("GET", "/v1/kan/workspaces?baseUrl=https://kan.example")).json()).toEqual([{ publicId: "workspace", name: "Workspace" }]);
    expect(await (await f.call("GET", "/v1/kan/workspaces/workspace/boards?baseUrl=https://kan.example")).json()).toEqual([{ publicId: "board", name: "Board" }]);
    expect(await (await f.call("GET", "/v1/kan/boards/board/lists?baseUrl=https://kan.example")).json()).toEqual([{ publicId: "list", name: "To do" }]);
  });

  it("caches the last check and detects a missing target list on explicit check", async () => {
    await f.call("PUT", "/v1/kan/credentials", { baseUrl: "https://kan.example", apiToken: "token" });
    const created = await f.call("POST", "/v1/projects", config());
    expect((await created.json() as ProjectView).kan).toMatchObject({ tokenValid: true, targetValid: true });
    expect(f.kan.getBoard).toHaveBeenCalledTimes(1);
    await f.call("GET", "/v1/projects"); await f.call("GET", "/v1/projects");
    expect(f.kan.getBoard).toHaveBeenCalledTimes(1);
    vi.mocked(f.kan.getBoard).mockResolvedValue({ publicId: "board", name: "Board", lists: [] });
    const checked = await f.call("POST", "/v1/projects/example/check");
    expect((await checked.json() as ProjectView).kan).toMatchObject({ tokenValid: true, targetValid: false, problem: "Zielspalte fehlt" });
    expect(f.kan.getBoard).toHaveBeenCalledTimes(2);
  });
});
