import { describe, expect, it } from "vitest";
import { parsePairingInput, projectsByRecency, threadCommands, threadDefaults, threadTitle, type ShellSnapshot } from "./t3.ts";

const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
const gpt = { instanceId: "codex", model: "gpt-6.1-sol" };

const shell: ShellSnapshot = {
  projects: [
    { id: "p-a", title: "Alpha", defaultModelSelection: null },
    { id: "p-b", title: "Beta", defaultModelSelection: null },
    { id: "p-c", title: "Gamma", defaultModelSelection: gpt },
  ],
  threads: [
    { projectId: "p-a", modelSelection: gpt, runtimeMode: "approval-required", updatedAt: "2026-09-01T00:00:00Z" },
    { projectId: "p-a", modelSelection: opus, runtimeMode: "full-access", updatedAt: "2026-09-20T00:00:00Z" },
    { projectId: "p-c", modelSelection: opus, runtimeMode: "auto", updatedAt: "2026-09-30T00:00:00Z" },
  ],
};

describe("parsePairingInput", () => {
  it("reads a pairing link", () => {
    expect(parsePairingInput(" http://127.0.0.1:3773/pair#token=abc123 ")).toEqual({
      credential: "abc123",
      serverUrl: "http://127.0.0.1:3773",
    });
  });

  it("takes the server from a hosted-app link", () => {
    expect(parsePairingInput("https://app.t3.codes/pair?host=http%3A%2F%2F192.168.1.5%3A3773%2F#token=xyz")).toEqual({
      credential: "xyz",
      serverUrl: "http://192.168.1.5:3773",
    });
  });

  it("accepts a bare code", () => {
    expect(parsePairingInput("abc-DEF_123")).toEqual({ credential: "abc-DEF_123" });
  });

  it("rejects links without a token and text with spaces", () => {
    expect(parsePairingInput("http://127.0.0.1:3773/pair")).toBeNull();
    expect(parsePairingInput("not a code")).toBeNull();
    expect(parsePairingInput("  ")).toBeNull();
  });
});

describe("projectsByRecency", () => {
  it("puts the most recently active project first, idle ones by title", () => {
    expect(projectsByRecency(shell).map((p) => p.title)).toEqual(["Gamma", "Alpha", "Beta"]);
  });
});

describe("threadDefaults", () => {
  it("follows the newest thread in the project", () => {
    expect(threadDefaults(shell, "p-a")).toEqual({ modelSelection: opus, runtimeMode: "full-access" });
  });

  it("prefers the project's default model", () => {
    expect(threadDefaults(shell, "p-c")).toEqual({ modelSelection: gpt, runtimeMode: "auto" });
  });

  it("falls back to the newest thread anywhere for a project without threads", () => {
    expect(threadDefaults(shell, "p-b")).toEqual({ modelSelection: opus, runtimeMode: "auto" });
  });

  it("returns null without any model to copy", () => {
    expect(threadDefaults({ projects: shell.projects.slice(0, 2), threads: [] }, "p-a")).toBeNull();
  });
});

describe("threadTitle", () => {
  it("uses the first comment line, capped", () => {
    expect(threadTitle("Button too small\nmore", "https://x.test/")).toBe("Button too small");
    expect(threadTitle("x".repeat(100), "https://x.test/")).toHaveLength(80);
  });

  it("falls back to the page", () => {
    expect(threadTitle("", "https://shop.test/checkout?step=2")).toBe("Annotation: shop.test/checkout");
  });
});

describe("threadCommands", () => {
  it("creates the thread, then starts the turn with the image", () => {
    const [create, turn] = threadCommands(
      {
        projectId: "p-a",
        title: "Fix it",
        text: "Fix it\n\nPage: https://x.test/",
        imageDataUrl: "data:image/png;base64,AAAA",
        imageBytes: 3,
        modelSelection: opus,
        runtimeMode: "full-access",
      },
      { thread: "t1", create: "c1", turn: "c2", message: "m1" },
      "2026-10-01T00:00:00.000Z",
    );
    expect(create).toMatchObject({ type: "thread.create", threadId: "t1", projectId: "p-a", branch: null, worktreePath: null });
    expect(turn).toMatchObject({
      type: "thread.turn.start",
      threadId: "t1",
      runtimeMode: "full-access",
      interactionMode: "default",
      message: { role: "user", attachments: [{ type: "image", mimeType: "image/png", sizeBytes: 3 }] },
    });
  });
});
