import { describe, expect, it } from "vitest";
import { matchProjects, urlMatchesRule } from "./urlRules.ts";
import { parseProjectConfig } from "./projectConfig.ts";

const cfg = (projectId: string, rules: unknown[]) =>
  parseProjectConfig({
    schemaVersion: 1,
    projectId,
    name: projectId,
    urlRules: rules,
    target: { provider: "kan", baseUrl: "https://kan.bn", workspacePublicId: "w", boardPublicId: "b", listPublicId: "l" },
    repositoryAliases: ["frontend"],
  });

describe("urlMatchesRule", () => {
  const rule = { scheme: "http" as const, hostname: "localhost", port: 3000, pathPrefix: "/app" };
  it("matches path boundaries", () => {
    expect(urlMatchesRule("http://localhost:3000/app", rule)).toBe(true);
    expect(urlMatchesRule("http://localhost:3000/app/x?y=1", rule)).toBe(true);
    expect(urlMatchesRule("http://localhost:3000/apple", rule)).toBe(false);
  });
  it("checks port and scheme", () => {
    expect(urlMatchesRule("http://localhost:3001/app", rule)).toBe(false);
    expect(urlMatchesRule("https://localhost:3000/app", rule)).toBe(false);
  });
  it("uses default ports when omitted", () => {
    const r = { scheme: "https" as const, hostname: "staging.example.test", pathPrefix: "/" };
    expect(urlMatchesRule("https://staging.example.test/", r)).toBe(true);
    expect(urlMatchesRule("https://staging.example.test:8443/", r)).toBe(false);
    expect(urlMatchesRule("https://STAGING.example.test/a", r)).toBe(true);
  });
  it("rejects garbage", () => {
    expect(urlMatchesRule("not a url", rule)).toBe(false);
  });
});

describe("matchProjects", () => {
  it("returns all matches and nothing for unknown hosts", () => {
    const a = cfg("a", [{ scheme: "http", hostname: "localhost", port: 3000 }]);
    const b = cfg("b", [{ scheme: "http", hostname: "localhost", port: 3000, pathPrefix: "/admin" }]);
    expect(matchProjects([a, b], "http://localhost:3000/admin/x")).toEqual(["a", "b"]);
    expect(matchProjects([a, b], "http://localhost:3000/")).toEqual(["a"]);
    expect(matchProjects([a, b], "https://other.test/")).toEqual([]);
  });
});

describe("ProjectConfigSchema", () => {
  it("rejects nested tokens and local paths", () => {
    const project = cfg("a", [{ scheme: "http", hostname: "x" }]);
    expect(() => parseProjectConfig({ ...project, target: { ...project.target, apiToken: "secret" } })).toThrow();
    expect(() => parseProjectConfig({ ...project, urlRules: [{ ...project.urlRules[0], localPath: "/private" }] })).toThrow();
  });
  it("rejects unknown keys such as local paths or tokens", () => {
    expect(() =>
      parseProjectConfig({ ...cfg("a", [{ scheme: "http", hostname: "x" }]), apiToken: "secret" }),
    ).toThrow();
  });
});
