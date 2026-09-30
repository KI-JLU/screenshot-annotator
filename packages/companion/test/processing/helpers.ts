import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { Comment, CreateCommentRequest } from "@website-review/shared";
import { createApp } from "../../src/app.ts";
import type { AnalysisInput, AnalysisOutput, AnalysisResult, AnalysisRunner } from "../../src/codex/types.ts";
import { KanError, type KanCardDetail, type KanClient, type KanCreateCardInput, type KanUploadInput } from "../../src/kan/types.ts";
import { ReviewProcessingService } from "../../src/processing/service.ts";
import { config, commentInput, ORIGIN } from "../core/helpers.ts";

export const ready = (): AnalysisOutput => ({ duplicateCheck: "done", outcome: "ready", ticket: { title: "Mehr Luft", desiredChange: "Mehr Abstand im Filterbereich", implementationIdeas: [], openPoints: [] }, findings: [], questions: [], duplicates: [], mergeWith: [] });
export class MemoryKan implements KanClient {
  readonly baseUrl = "https://kan.example";
  readonly cards = new Map<string, KanCardDetail>();
  createFailure?: { error: KanError; store: boolean };
  uploadFailure?: KanError;
  commentFailure?: { error: KanError; store: boolean };
  cardUrl = (id: string) => `${this.baseUrl}/cards/${id}`;
  listWorkspaces = vi.fn(async () => [{ publicId: "workspace", name: "Workspace" }]);
  listBoards = vi.fn(async () => [{ publicId: "board", name: "Board" }]);
  getBoard = vi.fn(async () => ({ publicId: "board", name: "Board", lists: [{ publicId: "list", name: "To do", cards: [...this.cards.values()] }] }));
  searchCards = vi.fn(async (_workspace: string, query: string) => [...this.cards.values()].filter((c) => c.title.includes(query)));
  getCard = vi.fn(async (id: string) => {
    const card = this.cards.get(id); if (!card) throw new KanError("missing", "not_found", 404, false); return structuredClone(card);
  });
  createCard = vi.fn(async (input: KanCreateCardInput) => {
    const failure = this.createFailure; this.createFailure = undefined;
    const publicId = `card-${this.cards.size + 1}`;
    if (!failure || failure.store) this.cards.set(publicId, { publicId, ...input, comments: [], attachments: [] });
    if (failure) throw failure.error;
    return { publicId };
  });
  addComment = vi.fn(async (id: string, comment: string) => {
    const card = this.cards.get(id)!;
    const publicId = `comment-${card.comments.length + 1}`;
    const failure = this.commentFailure; this.commentFailure = undefined;
    if (!failure || failure.store) card.comments.push({ publicId, comment });
    if (failure) throw failure.error;
    return { publicId };
  });
  uploadAttachment = vi.fn(async (id: string, input: KanUploadInput) => {
    if (this.uploadFailure) { const error = this.uploadFailure; this.uploadFailure = undefined; throw error; }
    const card = this.cards.get(id)!;
    const publicId = `attachment-${card.attachments.length + 1}`;
    card.attachments.push({ publicId, filename: input.filename }); return { publicId };
  });
  seed(id = "existing"): void { this.cards.set(id, { publicId: id, title: "Titel von Kan", description: "Originalbeschreibung", comments: [], attachments: [] }); }
}
export async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "review-processing-"));
  const checkout = join(dir, "repo"); mkdirSync(checkout); writeFileSync(join(checkout, "page.ts"), "export const page = true;\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { stdio: "pipe" });
  git("init", "-b", "main"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.org", "-c", "commit.gpgsign=false", "commit", "-m", "initial");
  const kan = new MemoryKan();
  let analyze: (input: AnalysisInput) => Promise<AnalysisResult> = async () => ({ ok: true, threadId: "thread", output: ready() });
  const runner: AnalysisRunner = { analyze: vi.fn((input: AnalysisInput) => analyze(input)), probe: vi.fn(async () => ({ available: true })), close: vi.fn(async () => {}) };
  const options = { dataDir: join(dir, "data"), configDir: join(dir, "config"), port: 0, kanClientFactory: () => kan, analysisRunner: runner, cliPath: "/test/cli.js" };
  let app = createApp(options);
  app.store.saveProject(config()); app.store.setCheckouts("example", { frontend: checkout }); app.secrets.set(kan.baseUrl, "private-kan-token");
  const review = app.store.createReview("example");
  let url = (await app.start()).url;
  const token = "extension-token"; app.store.pair(app.store.createPairingCode(), ORIGIN, token);
  const request = (path: string, body?: unknown, method = "POST") => fetch(url + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const create = async (input: CreateCommentRequest = commentInput()): Promise<Comment> => {
    const response = await request(`/v1/reviews/${review.id}/comments`, input); if (!response.ok) throw new Error(await response.text()); return await response.json() as Comment;
  };
  return { dir, checkout, kan, runner, review, request, create, get app() { return app; }, get url() { return url; },
    processing: () => app.processing as ReviewProcessingService,
    analyze: (fn: typeof analyze) => { analyze = fn; },
    process: () => request(`/v1/reviews/${review.id}/process`),
    idle: () => (app.processing as ReviewProcessingService).idle(),
    async restart() { await app.stop(); app = createApp(options); url = (await app.start()).url; },
    async close() { await app.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}
export type Fixture = Awaited<ReturnType<typeof setup>>;
