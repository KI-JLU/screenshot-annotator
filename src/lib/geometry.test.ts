import { describe, expect, it } from "vitest";
import { MIN_ELEMENT_CROP, cropFor, rectFromPoints, roundRect, wrapText } from "./geometry.ts";

const viewport = { width: 1200, height: 800 };

describe("cropFor", () => {
  it("keeps a drawn area as is, clipped to the viewport", () => {
    expect(cropFor("area", { x: 10, y: 20, width: 300, height: 100 }, viewport)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 100,
    });
    expect(cropFor("area", { x: 1100, y: 700, width: 300, height: 300 }, viewport)).toEqual({
      x: 1100,
      y: 700,
      width: 100,
      height: 100,
    });
  });

  it("pads a large element", () => {
    expect(cropFor("element", { x: 100, y: 100, width: 600, height: 300 }, viewport)).toEqual({
      x: 76,
      y: 76,
      width: 648,
      height: 348,
    });
  });

  it("gives a small element surrounding context, centred on it", () => {
    const crop = cropFor("element", { x: 500, y: 400, width: 80, height: 20 }, viewport);
    expect(crop).toEqual({ x: 340, y: 330, ...MIN_ELEMENT_CROP });
  });

  it("shifts the context inward at the viewport edge instead of shrinking it", () => {
    const crop = cropFor("element", { x: 0, y: 790, width: 50, height: 10 }, viewport);
    expect(crop).toEqual({ x: 0, y: 640, ...MIN_ELEMENT_CROP });
  });

  it("clips an element larger than the viewport to the viewport", () => {
    expect(cropFor("element", { x: -50, y: -500, width: 2000, height: 3000 }, viewport)).toEqual({
      x: 0,
      y: 0,
      ...viewport,
    });
  });

  it("returns null for an element outside the viewport", () => {
    expect(cropFor("element", { x: 0, y: 900, width: 50, height: 50 }, viewport)).toBeNull();
  });
});

describe("rectFromPoints / roundRect", () => {
  it("normalizes drags in any direction", () => {
    expect(rectFromPoints({ x: 50, y: 40 }, { x: 10, y: 60 })).toEqual({ x: 10, y: 40, width: 40, height: 20 });
  });

  it("rounds edges, not sizes", () => {
    expect(roundRect({ x: 0.4, y: 0.6, width: 10.4, height: 10.4 })).toEqual({ x: 0, y: 1, width: 11, height: 10 });
  });
});

describe("wrapText", () => {
  const measure = (s: string) => s.length; // one unit per character

  it("wraps at word boundaries", () => {
    expect(wrapText("the quick brown fox", 10, measure)).toEqual(["the quick", "brown fox"]);
  });

  it("keeps explicit line breaks and empty lines", () => {
    expect(wrapText("a\n\nb", 10, measure)).toEqual(["a", "", "b"]);
  });

  it("breaks words wider than a line", () => {
    expect(wrapText("see https://example.com/abc", 10, measure)).toEqual(["see", "https://ex", "ample.com/", "abc"]);
  });
});
