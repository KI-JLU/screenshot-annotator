import { MAX_NATIVE_FRAME_BYTES, type NativeOutgoing, type NativeResponse } from "@website-review/shared";

export const MAX_INCOMING_FRAME_BYTES = 64 * 1024 * 1024;
export function encodeFrame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4); header.writeUInt32LE(json.length);
  return Buffer.concat([header, json]);
}

/** Allocate once per frame, including when stdin delivers single-byte chunks. */
export class FrameDecoder {
  private header = Buffer.alloc(4);
  private headerRead = 0;
  private payload?: Buffer;
  private payloadRead = 0;
  constructor(private readonly receive: (message: unknown, frameLength: number) => void, private readonly limit = MAX_INCOMING_FRAME_BYTES) {}
  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const count = Math.min(4 - this.headerRead, chunk.length - offset);
        chunk.copy(this.header, this.headerRead, offset, offset + count);
        offset += count; this.headerRead += count;
        if (this.headerRead < 4) continue;
        const length = this.header.readUInt32LE();
        if (!length || length > this.limit) throw new Error("Ungültige Native-Messaging-Framegröße");
        this.payload = Buffer.allocUnsafe(length); this.payloadRead = 0;
      }
      const count = Math.min(this.payload.length - this.payloadRead, chunk.length - offset);
      chunk.copy(this.payload, this.payloadRead, offset, offset + count);
      offset += count; this.payloadRead += count;
      if (this.payloadRead === this.payload.length) {
        const payload = this.payload;
        this.payload = undefined; this.headerRead = 0;
        const json = new TextDecoder("utf-8", { fatal: true }).decode(payload);
        this.receive(JSON.parse(json), payload.length);
      }
    }
  }
  end(): void {
    if (this.headerRead || this.payload) throw new Error("Unvollständiger Native-Messaging-Frame");
  }
}

export function* outgoingFrames(message: NativeOutgoing): Generator<Buffer> {
  const frame = encodeFrame(message);
  if (message.type !== "response" || frame.length - 4 <= MAX_NATIVE_FRAME_BYTES) { yield frame; return; }
  const response: NativeResponse = message;
  const json = JSON.stringify(response);
  // A UTF-16 code unit needs at most six bytes after JSON escaping. Reserve envelope space.
  const overhead = Buffer.byteLength(JSON.stringify({ type: "chunk", id: response.id, index: Number.MAX_SAFE_INTEGER, count: Number.MAX_SAFE_INTEGER, data: "" }));
  const size = Math.floor((MAX_NATIVE_FRAME_BYTES - overhead) / 6);
  if (size < 1) throw new Error("Native-Messaging-ID ist zu groß");
  const count = Math.ceil(json.length / size);
  for (let index = 0; index < count; index++) {
    yield encodeFrame({ type: "chunk", id: response.id, index, count, data: json.slice(index * size, (index + 1) * size) });
  }
}
