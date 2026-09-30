import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Handler } from "../http/router.ts";
import { HttpError, notFound } from "../http/errors.ts";
import type { ProjectsService } from "../projects/projects.ts";
import type { Store } from "../store/store.ts";

export function registerGatewayHandlers(registerInternal: (method: string, path: string, handler: Handler) => void, store: Store, projects: ProjectsService): void {
  const prefix = "/internal/projects/:projectId/reviews/:reviewId";
  const scoped = (action: (ctx: Parameters<Handler>[0], project: ReturnType<ProjectsService["config"]>) => unknown): Handler => async (ctx) => {
    const review = store.getReview(ctx.params.reviewId!);
    if (!review || review.projectId !== ctx.params.projectId) notFound("Review");
    const project = projects.config(review.projectId);
    try { return await action(ctx, project); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, "kan_error", "Kan-Daten konnten nicht gelesen werden"); }
  };
  registerInternal("GET", `${prefix}/cards/search`, scoped((ctx, project) => {
    const query = ctx.url.searchParams.get("query");
    if (!query?.trim()) throw new HttpError(400, "validation", "Suchbegriff fehlt");
    return projects.client(project.target.baseUrl).searchCards(project.target.workspacePublicId, query);
  }));
  registerInternal("GET", `${prefix}/cards`, scoped(async (_ctx, project) => {
    const board = await projects.client(project.target.baseUrl).getBoard(project.target.boardPublicId);
    return board.lists.flatMap((list) => list.cards.map((card) => ({ ...card, listPublicId: list.publicId, listName: list.name })));
  }));
  registerInternal("GET", `${prefix}/cards/:cardPublicId`, scoped((ctx, project) => projects.client(project.target.baseUrl).getCard(ctx.params.cardPublicId!)));
  registerInternal("GET", `${prefix}/comments`, scoped((ctx) => store.listComments(ctx.params.reviewId!)
    .filter((c) => c.state !== "published" && !c.ticket)
    .map((c) => ({ commentId: c.id, text: c.text, url: c.context.url, state: c.state }))));
}

/** Exported independently of stdio so tests exercise the exact tool handlers. */
export function createGatewayHandlers(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
  async function read(path: string): Promise<unknown> {
    const base = env.WEBSITE_REVIEW_COMPANION_URL;
    const token = env.WEBSITE_REVIEW_INTERNAL_TOKEN;
    const review = env.WEBSITE_REVIEW_REVIEW_ID;
    const project = env.WEBSITE_REVIEW_PROJECT_ID;
    if (!base || !token || !review || !project) throw new Error("MCP-Gateway ist nicht eingerichtet");
    const url = new URL(base);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) throw new Error("Ungültige Begleitdienst-Adresse");
    const response = await fetcher(`${url.origin}/internal/projects/${encodeURIComponent(project)}/reviews/${encodeURIComponent(review)}${path}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok) throw new Error("Begleitdienst konnte die angefragten Daten nicht liefern");
    return response.json();
  }
  return {
    kan_search_cards: ({ query }: { query: string }) => read(`/cards/search?${new URLSearchParams({ query })}`),
    kan_list_board_cards: () => read("/cards"),
    kan_get_card: ({ cardPublicId }: { cardPublicId: string }) => read(`/cards/${encodeURIComponent(cardPublicId)}`),
    review_list_comments: () => read("/comments"),
  };
}
export async function startGateway(env: NodeJS.ProcessEnv = process.env): Promise<McpServer> {
  const server = new McpServer({ name: "website-review", version: "0.1.0" });
  const handlers = createGatewayHandlers(env);
  const invoke = async (action: () => Promise<unknown>) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await action()) }] }; }
    catch { return { isError: true, content: [{ type: "text" as const, text: "Daten konnten nicht gelesen werden. Verbindung zum Begleitdienst prüfen." }] }; }
  };
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  server.registerTool("kan_search_cards", { description: "Karten im Zielworkspace suchen", inputSchema: { query: z.string().min(1) }, annotations }, (args) => invoke(() => handlers.kan_search_cards(args)));
  server.registerTool("kan_list_board_cards", { description: "Alle Karten und Spalten des Zielboards lesen", inputSchema: {}, annotations }, () => invoke(handlers.kan_list_board_cards));
  server.registerTool("kan_get_card", { description: "Karte samt Kommentaren und Anhängen lesen", inputSchema: { cardPublicId: z.string().min(1) }, annotations }, (args) => invoke(() => handlers.kan_get_card(args)));
  server.registerTool("review_list_comments", { description: "Unveröffentlichte Kommentare dieses Reviews lesen", inputSchema: {}, annotations }, () => invoke(handlers.review_list_comments));
  await server.connect(new StdioServerTransport());
  return server;
}
