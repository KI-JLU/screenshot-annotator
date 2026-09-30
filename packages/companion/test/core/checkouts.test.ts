import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateCheckout } from "../../src/checkouts/validate.ts";
import { config, fixture, type Fixture } from "./helpers.ts";
import type { ProjectView } from "@website-review/shared";

const exec = promisify(execFile);
describe("checkout validation", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "review-git-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function repo(): Promise<string> {
    const path = join(dir, "repo"); await mkdir(path);
    await exec("git", ["-C", path, "init", "-b", "main"]);
    await writeFile(join(path, "file.txt"), "tracked\n");
    await exec("git", ["-C", path, "add", "file.txt"]);
    await exec("git", ["-C", path, "-c", "user.name=Core Test", "-c", "user.email=core@example.org", "-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
    return path;
  }

  it("rejects missing, relative, non-directory and non-git paths", async () => {
    expect(await validateCheckout("repo")).toMatchObject({ path: null, ok: false });
    expect(await validateCheckout("repo", "relative")).toMatchObject({ ok: false, problem: "Absoluter Ordnerpfad erforderlich" });
    expect(await validateCheckout("repo", join(dir, "missing"))).toMatchObject({ ok: false, problem: "Ordner fehlt" });
    const file = join(dir, "file"); await writeFile(file, "");
    expect(await validateCheckout("repo", file)).toMatchObject({ ok: false, problem: "Kein Ordner" });
    expect(await validateCheckout("repo", dir)).toMatchObject({ ok: false, problem: "Kein Git-Checkout" });
  });

  it("records HEAD, branch and dirty state from a real repository", async () => {
    const path = await repo();
    const clean = await validateCheckout("frontend", path);
    expect(clean).toMatchObject({ alias: "frontend", path, ok: true, branch: "main", hasUncommittedChanges: false });
    expect(clean.headCommit).toMatch(/^[0-9a-f]{40,64}$/);
    await writeFile(join(path, "untracked.txt"), "dirty");
    expect(await validateCheckout("frontend", path)).toMatchObject({ ok: true, hasUncommittedChanges: true });
  });

  it("refuses a git repository without a HEAD commit", async () => {
    await exec("git", ["-C", dir, "init"]);
    expect((await validateCheckout("repo", dir)).ok).toBe(false);
  });

  it("becomes ready only when all aliases and Kan are valid", async () => {
    const path = await repo();
    const f: Fixture = await fixture();
    try {

      await f.call("POST", "/v1/projects", config());
      await f.call("PUT", "/v1/kan/credentials", { baseUrl: "https://kan.example", apiToken: "token" });
      const response = await f.call("PUT", "/v1/projects/example/checkouts", { checkouts: { frontend: path } });
      expect((await response.json() as ProjectView).readyForProcessing).toBe(true);
      const invalid = await f.call("PUT", "/v1/projects/example/checkouts", { checkouts: { frontend: "relative" } });
      expect(invalid.status).toBe(400);
      expect(f.app.store.getCheckouts("example")).toEqual({ frontend: path });
    } finally { await f.close(); }
  });
});
