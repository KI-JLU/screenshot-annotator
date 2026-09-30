import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { ProjectConfig, CreateCommentRequest } from "@website-review/shared";
import { createApp, type ProcessingService } from "../../src/app.ts";
import type { KanClient } from "../../src/kan/types.ts";

export const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
export const OTHER_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

export function config(id = "example"): ProjectConfig {
  return { schemaVersion: 1, projectId: id, name: id,
    urlRules: [{ scheme: "http", hostname: "localhost", port: 3000, pathPrefix: "/app" }],
    target: { provider: "kan", baseUrl: "https://kan.example", workspacePublicId: "workspace", boardPublicId: "board", listPublicId: "list" },
    repositoryAliases: ["frontend"] };
}
export function commentInput(withImage = false): CreateCommentRequest {
  return { text: "Hier mehr Luft", markKind: "page", context: {
    url: "http://localhost:3000/app", pageTitle: "Test", viewport: { width: 800, height: 600, devicePixelRatio: 1 },
    scroll: { x: 0, y: 0 }, extraContext: "Filterbereich",
  }, ...(withImage ? { imagePngBase64: PNG.toString("base64"), screenshot: {
    width: 1, height: 1, originalWidth: 1, originalHeight: 1, crop: { x: 0, y: 0, width: 1, height: 1 },
  } } : {}) };
}
export function fakeKan(): KanClient {
  return {
    baseUrl: "https://kan.example", cardUrl: (id) => `https://kan.example/cards/${id}`,
    listWorkspaces: vi.fn(async () => [{ publicId: "workspace", name: "Workspace" }]),
    listBoards: vi.fn(async () => [{ publicId: "board", name: "Board" }]),
    getBoard: vi.fn(async () => ({ publicId: "board", name: "Board", lists: [{ publicId: "list", name: "To do", cards: [] }] })),
    searchCards: vi.fn(async () => []), getCard: vi.fn(async (publicId: string) => ({ publicId, title: "Ticket", description: "", attachments: [], comments: [] })),
    createCard: vi.fn(async () => ({ publicId: "card" })), addComment: vi.fn(async () => ({ publicId: "comment" })),
    uploadAttachment: vi.fn(async () => ({ publicId: "attachment" })),
  };
}
export async function fixture(processing?: ProcessingService) {
  const dir = await mkdtemp(join(tmpdir(), "review-core-"));
  const kan = fakeKan();
  const factory = vi.fn(() => kan);
  const app = createApp({ dataDir: join(dir, "data"), configDir: join(dir, "config"), port: 0, kanClientFactory: factory, processing });
  const { url, port } = await app.start();
  let token = "";
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(url + path, {
    method, headers: { Origin: ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const pair = async () => {
    const response = await request("POST", "/v1/pair", { code: app.store.createPairingCode() });
    if (response.status !== 200) throw new Error(`Pair failed: ${response.status}`);
    token = (await response.json() as { token: string }).token;
    return token;
  };
  const close = async () => { await app.stop(); await rm(dir, { recursive: true, force: true }); };
  return { dir, app, kan, factory, url, port, request, pair, close, get token() { return token; } };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
