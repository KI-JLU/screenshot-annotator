import assert from "node:assert/strict";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.159.2 (fixture)\n");
  process.exit(0);
}
const mode = process.env.FAKE_MODE ?? "normal";
let initialized = false;
let handshaken = false;
let turnCounter = 0;
const transcript = [];
const approvalResponses = [];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const approvalMethods = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "applyPatchApproval", "execCommandApproval", "mcpServer/elicitation/request", "unknown/request"];
const output = {
  outcome: "ready", ticket: { title: "Mehr Abstand", desiredChange: "Abstand vergrößern.", openPoints: [], implementationIdeas: [] },
  findings: [{ repository: "frontend", path: "src/page.ts", lineStart: null, lineEnd: null, note: "Filterbereich" }],
  questions: [], duplicates: [], mergeWith: [],
};

function threadSettings(params) {
  assert.equal(params.sandbox, "read-only");
  assert.equal(params.approvalPolicy, "never");
  assert.equal(params.cwd, "/tmp/frontend");
  assert.ok(params.developerInstructions.includes("kan_get_card"));
  assert.deepEqual(params.config.mcp_servers.review, { command: "gateway", args: ["mcp"], env: { INTERNAL_TOKEN: "secret" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  transcript.push(message);
  const { id, method, params } = message;
  const respond = (result) => send({ id, result });
  try {
    if (!method) { approvalResponses.push(message); return; }
    if (method === "initialize") {
      assert.equal(params.clientInfo.name, "website-review-companion");
      initialized = true;
      if (mode === "hang-init") return;
      respond({ userAgent: "fixture" }); return;
    }
    if (method === "initialized") { assert.ok(initialized); handshaken = true; return; }
    assert.ok(handshaken, "initialized notification must precede calls");
    switch (method) {
      case "ping": respond({ pong: true, inherited: Boolean(process.env.PATH), env: process.env.TEST_ENV }); break;
      case "inspect": respond({ transcript, approvalResponses }); break;
      case "silence": break;
      case "crash": process.exit(7); break;
      case "malformed": process.stdout.write("{bad json\n"); break;
      case "chunked": {
        const wire = JSON.stringify({ id, result: "Größe ✓" }) + "\n";
        const bytes = Buffer.from(wire);
        const split = bytes.indexOf(Buffer.from("ö")) + 1;
        process.stdout.write(bytes.subarray(0, split));
        setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
        break;
      }
      case "approvals":
        for (const [index, approval] of approvalMethods.entries()) send({ id: `approval-${index}`, method: approval, params: {} });
        respond({}); break;
      case "thread/resume":
        threadSettings(params);
        if (params.threadId === "missing") send({ id, error: { code: -32000, message: "missing" } });
        else respond({ thread: { id: params.threadId } });
        break;
      case "thread/start": threadSettings(params); respond({ thread: { id: "thread-1" } }); break;
      case "turn/interrupt": respond({}); break;
      case "turn/start": {
        assert.equal(params.outputSchema.additionalProperties, false);
        assert.deepEqual(params.outputSchema.required, ["outcome", "ticket", "findings", "questions", "duplicates", "mergeWith"]);
        assert.deepEqual(params.outputSchema.properties.findings.items.properties.lineStart.type, ["number", "null"]);
        assert.equal(params.input[0].type, "text");
        assert.deepEqual(params.input[0].text_elements, []);
        assert.ok(params.input[0].text.includes("/tmp/frontend"));
        assert.ok(!params.input[0].text.includes("secret"));
        assert.deepEqual(params.input[1], { type: "localImage", path: "/tmp/approved.png" });
        const turnId = `turn-${++turnCounter}`;
        const threadId = params.threadId;
        notify("fixture/turnReceived", { turnId });
        if (mode === "crash-turn") { process.exit(8); break; }
        if (mode === "late-start") { setTimeout(() => respond({ turn: { id: turnId } }), 60); break; }
        if (mode === "hang-turn") { respond({ turn: { id: turnId } }); break; }
        const text = mode === "bad-json" ? "kein JSON" : JSON.stringify(mode === "invalid-output" ? { ...output, outcome: "question" } : output);
        const item = { type: "agentMessage", id: "message-1", text, phase: mode === "legacy" ? null : "final_answer" };
        // Deliberately arrive before turn/start's response and mix unrelated turns/threads.
        notify("item/completed", { threadId: "other", turnId, item: { ...item, text: "foreign" }, completedAtMs: Date.now() });
        notify("item/completed", { threadId, turnId: "other", item: { ...item, text: "foreign" }, completedAtMs: Date.now() });
        if (mode !== "completion-items") notify("item/completed", { threadId, turnId, item, completedAtMs: Date.now() });
        notify("item/completed", { threadId, turnId, item: { ...item, text: "Zwischenstand", phase: "commentary" }, completedAtMs: Date.now() });
        notify("turn/completed", { threadId: "other", turn: { id: turnId, status: "failed", items: [] } });
        notify("turn/completed", { threadId, turn: { id: turnId, status: mode === "failed-turn" ? "failed" : "completed", items: mode === "completion-items" ? [item] : [], error: null } });
        respond({ turn: { id: turnId } });
        break;
      }
      default: send({ id, error: { code: -32601, message: "unknown" } });
    }
  } catch (error) {
    process.stderr.write(String(error.stack));
    send({ id, error: { code: -32000, message: error.message } });
  }
});
