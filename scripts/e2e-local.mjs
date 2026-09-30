// Full-stack local run: real companion + real `codex app-server` + gateway MCP, against scripts/fake-kan.mjs.
// Usage: node scripts/e2e-local.mjs <checkoutDir>
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const checkout = resolve(process.argv[2]);
const KAN = 47900, PORT = 47931, ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const root = mkdtempSync(join(tmpdir(), "wr-e2e-"));
const env = { ...process.env, WEBSITE_REVIEW_DATA_DIR: join(root, "data"), WEBSITE_REVIEW_CONFIG_DIR: join(root, "config") };
const cli = resolve("packages/companion/dist/cli.js");
const procs = [];
const start = (args, e = env) => { const p = spawn(process.execPath, args, { env: e, stdio: ["ignore", "inherit", "inherit"] }); procs.push(p); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => procs.forEach((p) => p.kill()));

start(["scripts/fake-kan.mjs", String(KAN)]);
start([cli, "serve", "--port", String(PORT)]);
await sleep(1500);

let token;
async function api(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return data;
}

function png(w, h) {
  const crc = (buf) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0xee);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const code = execFileSync(process.execPath, [cli, "pair"], { env, encoding: "utf8" }).match(/[A-Z0-9]{8}/)?.[0];
({ token } = await api("POST", "/v1/pair", { code }));
console.log("paired");
await api("PUT", "/v1/kan/credentials", { baseUrl: `http://127.0.0.1:${KAN}`, apiToken: "fake-kan-token" });
const config = {
  schemaVersion: 1, projectId: "demo", name: "Demo",
  urlRules: [{ scheme: "http", hostname: "localhost", port: 3000, pathPrefix: "/" }],
  target: { provider: "kan", baseUrl: `http://127.0.0.1:${KAN}`, workspacePublicId: "workspace001", boardPublicId: "board0000001", listPublicId: "list00000001" },
  repositoryAliases: ["frontend"],
};
await api("POST", "/v1/projects", config);
const view = await api("PUT", "/v1/projects/demo/checkouts", { checkouts: { frontend: checkout } });
console.log("project ready:", view.readyForProcessing, JSON.stringify(view.kan));
const exported = await api("GET", "/v1/projects/demo/export");
console.log("export has path/token:", JSON.stringify(exported).includes(checkout) || JSON.stringify(exported).includes("fake-kan-token"));
const review = await api("POST", "/v1/reviews", { projectId: "demo" });
const ctx = (extra) => ({ url: "http://localhost:3000/search", pageTitle: "Suche", viewport: { width: 1280, height: 800, devicePixelRatio: 1 }, scroll: { x: 0, y: 0 }, ...extra });
const shot = (marker) => ({ width: 200, height: 100, originalWidth: 200, originalHeight: 100, crop: { x: 0, y: 0, width: 200, height: 100 }, ...(marker ? { marker } : {}) });
const comments = [
  { text: "Hier mehr Luft.", markKind: "element", context: ctx({ elementText: "Suche", elementDescription: "section.filters" }), screenshot: shot({ x: 50, y: 20 }), imagePngBase64: png(200, 100) },
  { text: "Der Platzhalter im Suchfeld soll „Produkte durchsuchen“ lauten statt „Suche“.", markKind: "element", context: ctx({ elementText: "", elementDescription: "input[placeholder=Suche]" }), screenshot: shot({ x: 60, y: 22 }), imagePngBase64: png(200, 100) },
  { text: "Das da stimmt nicht.", markKind: "point", context: ctx({}), screenshot: shot({ x: 150, y: 80 }), imagePngBase64: png(200, 100) },
];
for (const c of comments) await api("POST", `/v1/reviews/${review.id}/comments`, { clientRequestId: crypto.randomUUID(), ...c });
console.log("process:", JSON.stringify(await api("POST", `/v1/reviews/${review.id}/process`)));

const settled = ["question_open", "decision_open", "published", "failed", "outcome_unclear"];
const handled = new Set();
for (let i = 0; i < 180; i++) {
  await sleep(5000);
  const detail = await api("GET", `/v1/reviews/${review.id}`);
  const line = detail.comments.map((c) => `${c.text.slice(0, 18)}=${c.state}`).join(" | ");
  console.log(`[${i * 5}s] ${line}`);
  for (const c of detail.comments) {
    if (handled.has(c.id + c.state + c.revision)) continue;
    if (c.state === "question_open") {
      handled.add(c.id + c.state + c.revision);
      console.log("  questions:", c.questions.map((q) => q.text));
      for (const q of c.questions.filter((q) => !q.answer)) await api("POST", `/v1/comments/${c.id}/answer`, { questionId: q.id, answer: "Die Ergebnisliste zeigt keine Treffer an, obwohl es passende Produkte gibt. Die Liste soll Treffer anzeigen." });
    } else if (c.state === "decision_open" && c.pendingDecision?.kind === "duplicate") {
      handled.add(c.id + c.state + c.revision);
      console.log("  duplicate candidates:", JSON.stringify(c.pendingDecision.candidates));
      await api("POST", `/v1/comments/${c.id}/decision`, { kind: "duplicate", action: "append", cardPublicId: c.pendingDecision.candidates[0].cardPublicId });
    } else if (c.state === "decision_open" && c.pendingDecision?.kind === "merge") {
      handled.add(c.id + c.state + c.revision);
      console.log("  merge proposal → reject");
      await api("POST", `/v1/comments/${c.id}/decision`, { kind: "merge", proposalId: c.pendingDecision.proposalId, action: "reject" });
    }
  }
  if (detail.comments.every((c) => ["published", "failed", "outcome_unclear"].includes(c.state))) {
    for (const c of detail.comments) console.log(JSON.stringify({ text: c.text, state: c.state, detail: c.stateDetail, ticket: c.ticket, findings: c.analysis?.findings }, null, 1));
    break;
  }
}
const kan = await (await fetch(`http://127.0.0.1:${KAN}/__state`)).json();
console.log("KAN STATE", JSON.stringify(kan, null, 1));
process.exit(0);
