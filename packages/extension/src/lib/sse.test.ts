import { describe, expect, it } from "vitest";
import { SseParser, toCompanionEvent } from "./sse.ts";

describe("SseParser", () => {
  it("parses events split across chunks and CRLF line endings", () => {
    const p = new SseParser();
    expect(p.push('data: {"type":"projects.updated"}\r')).toEqual([]);
    expect(p.push("\n\r\n: comment\n\nevent: comment.updated\ndata: {\"reviewId\":\"r1\",")).toEqual([
      { event: "message", data: '{"type":"projects.updated"}' },
    ]);
    const out = p.push('\ndata: "commentId":"c1"}\n\n');
    expect(out).toEqual([{ event: "comment.updated", data: '{"reviewId":"r1",\n"commentId":"c1"}' }]);
  });

  it("maps messages to companion events", () => {
    expect(toCompanionEvent({ event: "message", data: '{"type":"review.updated","reviewId":"r"}' })).toEqual({
      type: "review.updated",
      reviewId: "r",
    });
    expect(toCompanionEvent({ event: "ping", data: "" })).toEqual({ type: "ping" });
    expect(toCompanionEvent({ event: "message", data: "hello" })).toBeNull();
  });
});
