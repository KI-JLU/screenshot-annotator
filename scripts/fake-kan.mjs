// Minimal in-memory Kan API (subset used by the companion) for local end-to-end tests.
// Usage: node scripts/fake-kan.mjs <port>. GET /__state returns the stored data.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const port = Number(process.argv[2] ?? 47900);
const id = () => randomBytes(8).toString("hex");
const TOKEN = "fake-kan-token";
const list = { publicId: "list00000001", name: "Eingang", index: 0 };
const state = {
  workspace: { publicId: "workspace001", name: "Team", slug: "team" },
  board: { publicId: "board0000001", name: "Website", slug: "website" },
  cards: [{ publicId: "card00000old", title: "Abstand im Filterbereich der Suche", description: "Mehr Abstand zwischen Filter und Ergebnissen.", listPublicId: list.publicId, attachments: [], comments: [] }],
  uploads: {},
};
const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); });
const cardView = (c) => ({ publicId: c.publicId, title: c.title, description: c.description, index: 0, cardNumber: 1, dueDate: null });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const body = await readBody(req);
  if (url.pathname === "/__state") return json(res, 200, state);
  if (url.pathname.startsWith("/upload/") && req.method === "PUT") {
    if (req.headers.authorization) return json(res, 400, { message: "auth header leaked to presigned url" });
    state.uploads[url.pathname.slice(8)] = body.length; res.writeHead(200); return res.end();
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { message: "Authorization not provided", code: "UNAUTHORIZED" });
  const p = url.pathname.replace(/^\/api\/v1/, "");
  const data = body.length ? JSON.parse(body.toString()) : undefined;
  let m;
  if (p === "/workspaces") return json(res, 200, [{ role: "admin", workspace: state.workspace }]);
  if ((m = p.match(/^\/workspaces\/([^/]+)\/boards$/))) return json(res, 200, [{ ...state.board, favorite: false }]);
  if ((m = p.match(/^\/workspaces\/([^/]+)\/search$/))) {
    const q = (url.searchParams.get("query") ?? "").toLowerCase();
    return json(res, 200, state.cards.filter((c) => c.title.toLowerCase().includes(q)).map((c) => ({ ...cardView(c), boardPublicId: state.board.publicId, boardName: state.board.name, listName: list.name, type: "card", createdAt: "", updatedAt: null })));
  }
  if ((m = p.match(/^\/boards\/([^/]+)$/))) {
    if (m[1] !== state.board.publicId) return json(res, 404, { message: "not found", code: "NOT_FOUND" });
    return json(res, 200, { ...state.board, lists: [{ ...list, cards: state.cards.map(cardView) }] });
  }
  if (p === "/cards" && req.method === "POST") {
    if (data.listPublicId !== list.publicId) return json(res, 404, { message: "list not found", code: "NOT_FOUND" });
    const card = { publicId: `card${id()}`, title: data.title, description: data.description, listPublicId: list.publicId, attachments: [], comments: [] };
    state.cards.push(card); return json(res, 200, { publicId: card.publicId });
  }
  const card = (m = p.match(/^\/cards\/([^/]+)/)) && state.cards.find((c) => c.publicId === m[1]);
  if (m && !card) return json(res, 404, { message: "card not found", code: "NOT_FOUND" });
  if (card && p.endsWith("/comments") && req.method === "POST") {
    const c = { publicId: `comm${id()}`, comment: data.comment }; card.comments.push(c); return json(res, 200, c);
  }
  if (card && p.endsWith("/attachments/upload-url")) { const key = `att${id()}`; return json(res, 200, { url: `http://127.0.0.1:${port}/upload/${key}`, key }); }
  if (card && p.endsWith("/attachments/confirm")) {
    if (!(data.s3Key in state.uploads)) return json(res, 400, { message: "upload missing", code: "BAD_REQUEST" });
    const a = { publicId: `atta${id()}`, filename: data.filename, originalFilename: data.originalFilename, contentType: data.contentType, size: data.size, s3Key: data.s3Key, createdAt: new Date().toISOString() };
    card.attachments.push(a); return json(res, 200, a);
  }
  if (card && req.method === "GET") {
    return json(res, 200, { ...cardView(card), list: { publicId: list.publicId, name: list.name }, attachments: card.attachments, activities: card.comments.map((c) => ({ type: "card.updated.comment.added", comment: { ...c, deletedAt: null } })) });
  }
  json(res, 404, { message: `no route ${req.method} ${p}`, code: "NOT_FOUND" });
}).listen(port, "127.0.0.1", () => console.log(`fake kan on ${port}`));
