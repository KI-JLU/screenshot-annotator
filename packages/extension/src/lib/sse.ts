/** Minimal text/event-stream parser (WHATWG EventSource field rules) for fetch-based streaming. */
import type { CompanionEvent } from "@website-review/shared";

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private id: string | undefined;

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const idx = this.buffer.search(/\r\n|\r|\n/);
      if (idx < 0) break;
      // A trailing "\r" may be the first half of "\r\n" split across chunks.
      if (this.buffer[idx] === "\r" && idx === this.buffer.length - 1) break;
      const len = this.buffer.startsWith("\r\n", idx) ? 2 : 1;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + len);
      this.line(line, out);
    }
    return out;
  }

  private line(line: string, out: SseMessage[]): void {
    if (line === "") {
      if (this.data.length > 0) {
        const msg: SseMessage = { event: this.event || "message", data: this.data.join("\n") };
        if (this.id !== undefined) msg.id = this.id;
        out.push(msg);
      }
      this.data = [];
      this.event = "";
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id") this.id = value;
  }
}

/** Accepts `data: {"type": …}` as well as `event: <type>` + `data: {…}`. */
export function toCompanionEvent(msg: SseMessage): CompanionEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(msg.data);
  } catch {
    parsed = undefined;
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  if (obj && typeof obj.type === "string") return obj as unknown as CompanionEvent;
  if (msg.event && msg.event !== "message") return { ...(obj ?? {}), type: msg.event } as unknown as CompanionEvent;
  return null;
}
