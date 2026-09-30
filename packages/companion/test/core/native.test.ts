import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EXTENSION_ID, MAX_NATIVE_FRAME_BYTES, NATIVE_HOST_NAME, type NativeChunk, type NativeOutgoing } from "@website-review/shared";
import { FrameDecoder, encodeFrame, MAX_INCOMING_FRAME_BYTES, outgoingFrames } from "../../src/native/codec.ts";
import { runHostLoop } from "../../src/native/host.ts";
import { acquireLock, lockHeld } from "../../src/native/lock.ts";
import { browserDirectories } from "../../src/native/install.ts";
import { EventBus } from "../../src/events/eventBus.ts";
import { commentInput, config, fixture } from "./helpers.ts";
import { getPaths } from "../../src/paths.ts";

const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), "wr-native-")); dirs.push(dir); return dir; };
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM"); await exited;
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const health = { type: "request", id: "health", method: "GET", path: "/v1/health" };

describe("native framing", () => {
  it("decodes round trips with split headers, UTF-8 payloads and merged frames", () => {
    const values = [health, { text: "Grüße 😀" }, { next: true }];
    const bytes = Buffer.concat(values.map(encodeFrame));
    for (const size of [1, 3, 7, bytes.length]) {
      const received: unknown[] = []; const lengths: number[] = [];
      const decoder = new FrameDecoder((value, length) => { received.push(value); lengths.push(length); });
      for (let offset = 0; offset < bytes.length; offset += size) decoder.push(bytes.subarray(offset, offset + size));
      decoder.end(); expect(received).toEqual(values);
      expect(lengths).toEqual(values.map((value) => Buffer.byteLength(JSON.stringify(value))));
    }
  });
  it("rejects oversized, empty, malformed and truncated input", () => {
    for (const length of [0, MAX_INCOMING_FRAME_BYTES + 1]) {
      const prefix = Buffer.alloc(4); prefix.writeUInt32LE(length);
      expect(() => new FrameDecoder(() => {}).push(prefix)).toThrow("Framegröße");
    }
    const invalid = Buffer.from([1, 0, 0, 0, 123]);
    expect(() => new FrameDecoder(() => {}).push(invalid)).toThrow();
    const decoder = new FrameDecoder(() => {}); decoder.push(encodeFrame(health).subarray(0, 10));
    expect(() => decoder.end()).toThrow("Unvollständiger");
  });
  it("chunks an image response above 1 MiB and reassembles its serialized JSON", async () => {
    const f = await fixture();
    try {
      f.app.store.saveProject(config()); const review = f.app.store.createReview("example");
      const comment = f.app.comments.create(review.id, commentInput(true));
      const png = Buffer.concat([f.app.comments.image(comment.id), Buffer.alloc(1024 * 1024, 42)]);
      writeFileSync(f.app.store.getImagePath(comment.id)!, png);
      const response = await f.app.dispatch({ method: "GET", path: `/v1/comments/${comment.id}/image` });
      const outgoing = { type: "response" as const, id: "image", ...response };
      const chunks: NativeChunk[] = [];
      const decoder = new FrameDecoder((value) => chunks.push(value as NativeChunk));
      for (const bytes of outgoingFrames(outgoing)) {
        expect(bytes.readUInt32LE()).toBeLessThanOrEqual(MAX_NATIVE_FRAME_BYTES); decoder.push(bytes);
      }
      decoder.end(); expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c, index) => c.type === "chunk" && c.count === chunks.length && c.index === index)).toBe(true);
      const restored = JSON.parse(chunks.map((c) => c.data).join(""));
      expect(restored).toEqual(outgoing); expect(Buffer.from(restored.body.pngBase64, "base64")).toEqual(png);
    } finally { await f.close(); }
  });
  it("keeps escaped and non-ASCII chunks below the frame cap", () => {
    const message = { type: "response" as const, id: '"é', status: 200, body: '\u0000"😀'.repeat(200_000) };
    const chunks: NativeChunk[] = []; const decoder = new FrameDecoder((value) => chunks.push(value as NativeChunk));
    for (const frame of outgoingFrames(message)) { expect(frame.readUInt32LE()).toBeLessThanOrEqual(MAX_NATIVE_FRAME_BYTES); decoder.push(frame); }
    expect(JSON.parse(chunks.map((chunk) => chunk.data).join(""))).toEqual(message);
  });
});

describe("host loop", () => {
  it("sends hello and all events, dispatches concurrently, and stops on EOF", async () => {
    const input = new PassThrough(), output = new PassThrough();
    const frames: NativeOutgoing[] = []; const decoder = new FrameDecoder((value) => frames.push(value as NativeOutgoing));
    output.on("data", (chunk: Buffer) => decoder.push(chunk));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const app = { events: new EventBus(), start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
      dispatch: vi.fn(async ({ path }: { path: string }) => { if (path === "/slow") await blocked; return { status: 200, body: path }; }) };
    const done = runHostLoop(input, output, app);
    input.write(Buffer.concat([encodeFrame({ ...health, id: "slow", path: "/slow" }), encodeFrame(health)]));
    app.events.emit({ type: "projects.updated" }); app.events.emit({ type: "ping" });
    await vi.waitFor(() => expect(frames).toContainEqual({ type: "response", id: "health", status: 200, body: "/v1/health" }));
    expect(frames[0]).toMatchObject({ type: "hello" });
    expect(frames.filter((frame) => frame.type === "event")).toEqual([{ type: "event", event: { type: "projects.updated" } }, { type: "event", event: { type: "ping" } }]);
    expect(frames.some((frame) => frame.type === "response" && frame.id === "slow")).toBe(false);
    release(); input.end(); await done; decoder.end();
    expect(app.stop).toHaveBeenCalledOnce();
    expect(frames).toContainEqual({ type: "response", id: "slow", status: 200, body: "/slow" });
  });
  it("closes the app after a stdin error", async () => {
    const input = new PassThrough(), output = new PassThrough(); output.resume();
    const app = { events: new EventBus(), start: vi.fn(async () => {}), stop: vi.fn(async () => {}), dispatch: vi.fn(async () => ({ status: 204 })) };
    const done = runHostLoop(input, output, app); input.destroy(new Error("broken pipe")); await done;
    expect(app.stop).toHaveBeenCalledOnce();
  });
  it("recovers stale locks and leaves live locks intact", () => {
    const dir = temporary(); const path = join(dir, "companion.lock");
    // A completed child supplies a real, dead PID instead of assuming a PID is unused.
    const pid = Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }));
    writeFileSync(path, String(pid)); expect(lockHeld(dir)).toBe(false);
    const release = acquireLock(dir)!; expect(release).toBeTypeOf("function");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid)); expect(acquireLock(dir)).toBeUndefined();
    release(); release(); expect(existsSync(path)).toBe(false);
  });
});

const cli = resolve("packages/companion/dist/cli.js");
function envFor(root: string) {
  return { ...process.env, HOME: root, WEBSITE_REVIEW_DATA_DIR: join(root, "data"), WEBSITE_REVIEW_CONFIG_DIR: join(root, "config"), XDG_CONFIG_HOME: join(root, "browser-config"), XDG_RUNTIME_DIR: join(root, "run") };
}
function host(env: NodeJS.ProcessEnv, origin = `chrome-extension://${EXTENSION_ID}/`) {
  const child = spawn(process.execPath, [cli, "native-host", origin], { env }); children.push(child);
  const frames: NativeOutgoing[] = []; let framingError: unknown; let stderr = "";
  const decoder = new FrameDecoder((frame) => frames.push(frame as NativeOutgoing), 1024 * 1024);
  child.stdout.on("data", (chunk: Buffer) => { try { decoder.push(chunk); } catch (error) { framingError = error; } });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { child, frames, exited, decoder, error: () => framingError, stderr: () => stderr };
}
describe("built CLI", () => {
  beforeAll(() => { execFileSync(process.execPath, ["build.mjs"], { cwd: resolve("packages/companion"), stdio: "pipe" }); });
  it("writes only valid framing to stdout, answers health and releases the lock on EOF", async () => {
    const root = temporary(), env = envFor(root), h = host(env);
    h.child.stdin.write(encodeFrame(health));
    await vi.waitFor(() => expect(h.frames).toContainEqual({ type: "response", id: "health", status: 200, body: { ok: true, version: "0.1.0" } }));
    expect(h.frames[0]).toEqual({ type: "hello", version: "0.1.0" });
    expect(h.error()).toBeUndefined();
    expect(statSync(join(root, "run/website-review/internal.sock")).mode & 0o777).toBe(0o600);
    h.child.stdin.end(); expect(await h.exited).toBe(0); h.decoder.end();
    expect(existsSync(join(root, "run/website-review/companion.lock"))).toBe(false);
    expect(existsSync(join(root, "run/website-review/internal.sock"))).toBe(false);
  });
  it("refuses incorrect caller origins before opening the database", async () => {
    for (const origin of ["https://example.org/", `chrome-extension://${EXTENSION_ID}`, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"]) {
      const root = temporary(); const h = host(envFor(root), origin);
      expect(await h.exited).toBe(1); expect(h.frames).toEqual([]); expect(h.stderr()).toContain("Unzulässiger Aufrufer");
      expect(existsSync(join(root, "data/companion.db"))).toBe(false);
    }
  });
  it("answers every request with 503 and hello.problem when another instance owns the runtime lock", async () => {
    const root = temporary(), env = envFor(root), first = host(env);
    first.child.stdin.write(encodeFrame(health));
    await vi.waitFor(() => expect(first.frames.some((frame) => frame.type === "response")).toBe(true));
    const otherData = join(root, "other-data"); const second = host({ ...env, WEBSITE_REVIEW_DATA_DIR: otherData });
    second.child.stdin.write(Buffer.concat([encodeFrame(health), encodeFrame({ ...health, id: "other", path: "/v1/projects" })]));
    await vi.waitFor(() => expect(second.frames.filter((frame) => frame.type === "response")).toHaveLength(2));
    expect(second.frames[0]).toMatchObject({ type: "hello", problem: expect.stringContaining("anderen Browserprofil") });
    for (const frame of second.frames.filter((frame) => frame.type === "response")) expect(frame).toMatchObject({ status: 503, body: { error: { code: "internal" } } });
    expect(existsSync(otherData)).toBe(false);
    second.child.stdin.end(); expect(await second.exited).toBe(0); expect(lockHeld(getPaths(env).runtimeDir)).toBe(true);
    first.child.stdin.end(); expect(await first.exited).toBe(0);
  });
  it("installs executable launchers and manifests, reports status and uninstalls", () => {
    const root = temporary(), env = envFor(root), id = "abcdefghijklmnopabcdefghijklmnop";
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
    const browserRoot = env.XDG_CONFIG_HOME;
    mkdirSync(join(browserRoot, "google-chrome"), { recursive: true }); mkdirSync(join(browserRoot, "chromium"));
    expect(run("install-native-host", "--extension-id", id)).toContain("Geschrieben:");
    const launcher = join(root, "data/native-host.sh");
    expect(statSync(launcher).mode & 0o777).toBe(0o755);
    expect(readFileSync(launcher, "utf8")).toContain(`exec '${process.execPath}' '${cli}' native-host "$@"`);
    expect(readFileSync(launcher, "utf8")).toContain('export PATH=');
    for (const browser of ["google-chrome", "chromium"]) {
      expect(JSON.parse(readFileSync(join(browserRoot, browser, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`), "utf8"))).toEqual({ name: NATIVE_HOST_NAME, description: "Website-Review Begleitdienst", type: "stdio", path: launcher, allowed_origins: [`chrome-extension://${id}/`] });
    }
    expect(run("status")).toContain("Instanzsperre frei");
    expect(run("status")).toContain("chromium: Native-Host-Manifest installiert");
    run("uninstall-native-host"); expect(existsSync(launcher)).toBe(false);
    expect(run("status")).toContain("chrome: Native-Host-Manifest nicht installiert");
  });
  it("defaults to Chrome when no browser config exists and honors explicit browser selection", () => {
    const root = temporary(), env = envFor(root);
    execFileSync(process.execPath, [cli, "install-native-host"], { env, stdio: "pipe" });
    const manifest = (browser: string) => join(env.XDG_CONFIG_HOME, browser, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
    expect(existsSync(manifest("google-chrome"))).toBe(true); expect(existsSync(manifest("chromium"))).toBe(false);
    execFileSync(process.execPath, [cli, "install-native-host", "--browser", "chromium"], { env, stdio: "pipe" });
    expect(existsSync(manifest("chromium"))).toBe(true);
  });
  it("uses the documented macOS browser paths", () => {
    expect(browserDirectories({ HOME: "/tmp/example" }, "darwin")).toEqual({ chrome: "/tmp/example/Library/Application Support/Google/Chrome", chromium: "/tmp/example/Library/Application Support/Chromium" });
  });
});
