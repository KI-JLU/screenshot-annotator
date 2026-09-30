import { z } from "zod";
import { KanError, type KanClient, type KanClientOptions, type KanErrorKind } from "./types.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const named = z.object({ publicId: z.string(), name: z.string() });
const identified = z.object({ publicId: z.string() });
const card = identified.extend({
  title: z.string(), description: z.string().nullable().default(null),
  listPublicId: z.string().optional(), listName: z.string().optional(),
});
const board = named.extend({ lists: z.array(named.extend({ cards: z.array(card) })) });
const detail = card.extend({
  list: named.nullish(),
  attachments: z.array(identified.extend({
    filename: z.string().nullish(), originalFilename: z.string().nullish(), s3Key: z.string().optional(),
  })).default([]),
  // The API nests the comment object inside an activity. Other activities have null here.
  activities: z.array(z.unknown()).default([]),
});
const activityComment = z.object({ comment: identified.extend({
  comment: z.string(), deletedAt: z.string().nullish(),
}) });

function httpError(status: number): KanError {
  let kind: KanErrorKind;
  if (status === 401 || status === 403) kind = "auth";
  else if (status === 404) kind = "not_found";
  else if (status === 429) kind = "rate_limited";
  else if (status >= 500) kind = "server";
  else kind = "validation";
  const messages = { auth: "Kan-Zugang ungültig", not_found: "Kan-Ziel nicht gefunden", rate_limited: "Kan-Anfragelimit erreicht", server: "Kan-Serverfehler", validation: "Kan-Anfrage ungültig" };
  return new KanError(`${messages[kind]} (HTTP ${status})`, kind, status, kind === "server");
}

export function createKanClient(opts: KanClientOptions): KanClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const fetcher = opts.fetch ?? globalThis.fetch;
  let queue: Promise<unknown> = Promise.resolve();
  let nextRequestAt = 0;

  function request<T>(url: string, init: RequestInit, schema: z.ZodType<T, z.ZodTypeDef, unknown> | null): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        await delay(Math.max(0, nextRequestAt - Date.now()));
        nextRequestAt = Date.now() + 601; // At most 100 requests in any 60-second window.
        const controller = new AbortController();
        let requestSent = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new KanError("Zeitüberschreitung bei Kan", "timeout", undefined, requestSent));
              }, opts.timeoutMs ?? 20_000);
            }),
            (async () => {
              requestSent = true;
              const response = await fetcher(url, { ...init, signal: controller.signal, redirect: "error" });
              if (!response.ok) {
                await response.body?.cancel();
                throw httpError(response.status);
              }
              if (!schema) {
                await response.body?.cancel();
                return undefined as T;
              }
              return schema.parse(await response.json());
            })(),
          ]);
        } catch (error) {
          clearTimeout(timer);
          const mapped = error instanceof KanError ? error : new KanError(
            controller.signal.aborted ? "Zeitüberschreitung bei Kan" : "Kan-Antwort nicht zuverlässig empfangen",
            controller.signal.aborted ? "timeout" : "network", undefined, requestSent,
          );
          if (init.method !== "GET" || attempt >= 2 || !["rate_limited", "server"].includes(mapped.kind)) throw mapped;
          await delay(250 * 2 ** attempt);
        } finally {
          clearTimeout(timer);
        }
      }
    };
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  }
  function api<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, body?: unknown): Promise<T> {
    return request(`${baseUrl}/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${opts.apiToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, schema);
  }
  const cardPath = (id: string) => `/cards/${encodeURIComponent(id)}`;
  return {
    baseUrl,
    cardUrl: (id) => `${baseUrl}/cards/${encodeURIComponent(id)}`,
    async listWorkspaces() {
      const memberships = await api("/workspaces", z.array(z.object({ workspace: named })));
      return memberships.map(({ workspace }) => workspace);
    },
    listBoards: (id) => api(`/workspaces/${encodeURIComponent(id)}/boards`, z.array(named)),
    async getBoard(id) {
      const result = await api(`/boards/${encodeURIComponent(id)}`, board);
      return { ...result, lists: result.lists.map((list) => ({ ...list,
        cards: list.cards.map((item) => ({ ...item, listPublicId: list.publicId, listName: list.name })),
      })) };
    },
    async searchCards(id, query, limit = 20) {
      const results = await api(`/workspaces/${encodeURIComponent(id)}/search?${new URLSearchParams({ query, limit: String(limit) })}`,
        z.array(card.extend({ type: z.enum(["board", "card"]) })));
      return results.filter((item) => item.type === "card").map((item) => card.parse(item));
    },
    async getCard(id) {
      const result = await api(cardPath(id), detail);
      const comments = new Map<string, { publicId: string; comment: string }>();
      for (const activity of result.activities) {
        const parsed = activityComment.safeParse(activity);
        if (parsed.success && !parsed.data.comment.deletedAt) {
          const { publicId, comment } = parsed.data.comment;
          comments.set(publicId, { publicId, comment });
        }
      }
      return {
        ...card.parse(result), listName: result.list?.name ?? result.listName,
        attachments: result.attachments.map((attachment) => ({
          publicId: attachment.publicId,
          filename: attachment.filename ?? attachment.originalFilename ?? attachment.s3Key?.split("/").at(-1) ?? "",
          originalFilename: attachment.originalFilename ?? undefined,
        })), comments: [...comments.values()],
      };
    },
    createCard: (input) => api("/cards", identified, { ...input, labelPublicIds: [], memberPublicIds: [], position: "end" }),
    addComment: (id, comment) => api(`${cardPath(id)}/comments`, identified, { comment }),
    async uploadAttachment(id, input) {
      const metadata = { filename: input.filename, contentType: input.contentType, size: input.bytes.byteLength };
      const upload = await api(`${cardPath(id)}/attachments/upload-url`, z.object({ url: z.string(), key: z.string() }), metadata);
      await request(upload.url, { method: "PUT", headers: { "Content-Type": input.contentType }, body: Buffer.from(input.bytes) }, null);
      return api(`${cardPath(id)}/attachments/confirm`, identified, {
        ...metadata, s3Key: upload.key, originalFilename: input.filename,
      });
    },
  };
}
