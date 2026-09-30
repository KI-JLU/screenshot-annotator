import { describe, expect, it } from "vitest";
import {
  buildScreenshotMeta,
  cssPointToImage,
  cssRectToImage,
  cssToImageScale,
  displayToImage,
  elementMarker,
  intersectRects,
  markGeometryFromCss,
  normalizeCrop,
  pointInRect,
  pointToCrop,
  rectFromPoints,
  rectToCrop,
} from "./geometry.ts";

describe("CSS px → image px", () => {
  it("uses the actual image size, not only the device pixel ratio", () => {
    // DPR 2 would suggest 2560, but the capture came back 2500 wide (e.g. page zoom).
    const s = cssToImageScale({ width: 2500, height: 1600 }, { width: 1280, height: 800 });
    expect(s.x).toBeCloseTo(1.953125);
    expect(s.y).toBe(2);
    expect(cssPointToImage({ x: 640, y: 400 }, s)).toEqual({ x: 1250, y: 800 });
  });

  it("maps rects at DPR 1 and 2", () => {
    expect(cssRectToImage({ x: 10, y: 20, width: 30, height: 40 }, { x: 1, y: 1 })).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
    expect(cssRectToImage({ x: 10, y: 20, width: 30, height: 40 }, { x: 2, y: 2 })).toEqual({
      x: 20,
      y: 40,
      width: 60,
      height: 80,
    });
  });

  it("rejects an empty viewport", () => {
    expect(() => cssToImageScale({ width: 100, height: 100 }, { width: 0, height: 100 })).toThrow();
  });
});

describe("markGeometryFromCss", () => {
  const image = { width: 2000, height: 1000 };
  const viewport = { width: 1000, height: 500 };

  it("uses the centre of the visible element part as marker", () => {
    // Element extends beyond the right viewport edge.
    const g = markGeometryFromCss({ elementRect: { x: 900, y: 100, width: 200, height: 50 } }, image, viewport);
    expect(g.elementBox).toEqual({ x: 1800, y: 200, width: 400, height: 100 });
    expect(g.marker).toEqual({ x: 1900, y: 250 });
  });

  it("maps point marks and clamps them to the image", () => {
    expect(markGeometryFromCss({ point: { x: 250, y: 125 } }, image, viewport).marker).toEqual({ x: 500, y: 250 });
    expect(markGeometryFromCss({ point: { x: 1200, y: -5 } }, image, viewport).marker).toEqual({ x: 2000, y: 0 });
  });

  it("has no marker for page comments", () => {
    expect(markGeometryFromCss({}, image, viewport)).toEqual({});
  });

  it("has no marker for an element outside the image", () => {
    expect(elementMarker({ x: -100, y: 0, width: 50, height: 50 }, image)).toBeNull();
  });
});

describe("rect helpers", () => {
  it("intersects and detects non-overlap", () => {
    expect(intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({
      x: 5,
      y: 5,
      width: 5,
      height: 5,
    });
    expect(intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBeNull();
  });

  it("normalizes drags in any direction", () => {
    expect(rectFromPoints({ x: 50, y: 60 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 40, height: 40 });
  });

  it("maps display coordinates to image px", () => {
    expect(displayToImage({ x: 180, y: 50 }, { width: 360, height: 200 }, { width: 2000, height: 1111 })).toEqual({
      x: 1000,
      y: 277.75,
    });
    expect(displayToImage({ x: 400, y: -3 }, { width: 360, height: 200 }, { width: 2000, height: 1000 })).toEqual({
      x: 2000,
      y: 0,
    });
  });
});

describe("normalizeCrop", () => {
  const image = { width: 1000, height: 800 };
  it("rounds and clamps to the image", () => {
    expect(normalizeCrop({ x: -10.4, y: 100.6, width: 300.2, height: 900 }, image)).toEqual({
      x: 0,
      y: 101,
      width: 290,
      height: 699,
    });
  });
  it("accepts negative width/height from numeric input", () => {
    expect(normalizeCrop({ x: 500, y: 500, width: -100, height: -50 }, image)).toEqual({
      x: 400,
      y: 450,
      width: 100,
      height: 50,
    });
  });
  it("falls back to the full image when the crop is empty or too small", () => {
    expect(normalizeCrop({ x: 2000, y: 0, width: 10, height: 10 }, image)).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
    expect(normalizeCrop({ x: 0, y: 0, width: 5, height: 5 }, image, 10)).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });
});

describe("crop translation", () => {
  const crop = { x: 100, y: 50, width: 400, height: 300 };

  it("checks containment half-open", () => {
    expect(pointInRect({ x: 100, y: 50 }, crop)).toBe(true);
    expect(pointInRect({ x: 499.9, y: 349.9 }, crop)).toBe(true);
    expect(pointInRect({ x: 500, y: 200 }, crop)).toBe(false);
    expect(pointInRect({ x: 99, y: 200 }, crop)).toBe(false);
  });

  it("translates points and clips rects", () => {
    expect(pointToCrop({ x: 150, y: 80 }, crop)).toEqual({ x: 50, y: 30 });
    expect(rectToCrop({ x: 50, y: 100, width: 200, height: 400 }, crop)).toEqual({ x: 0, y: 50, width: 150, height: 250 });
    expect(rectToCrop({ x: 0, y: 0, width: 50, height: 50 }, crop)).toBeNull();
  });
});

describe("buildScreenshotMeta", () => {
  const original = { width: 2000, height: 1200 };

  it("describes an uncropped capture", () => {
    const { meta, markerInside } = buildScreenshotMeta({
      original,
      crop: { x: 0, y: 0, width: 2000, height: 1200 },
      marker: { x: 300.4, y: 200.6 },
      elementBox: { x: 200, y: 150, width: 200.4, height: 100 },
    });
    expect(markerInside).toBe(true);
    expect(meta).toEqual({
      width: 2000,
      height: 1200,
      originalWidth: 2000,
      originalHeight: 1200,
      crop: { x: 0, y: 0, width: 2000, height: 1200 },
      marker: { x: 300, y: 201 },
      elementBox: { x: 200, y: 150, width: 200, height: 100 },
    });
  });

  it("translates marker and clips the element box into the crop", () => {
    const { meta, markerInside } = buildScreenshotMeta({
      original,
      crop: { x: 250, y: 100, width: 500, height: 400 },
      marker: { x: 300, y: 200 },
      elementBox: { x: 200, y: 150, width: 200, height: 100 },
    });
    expect(markerInside).toBe(true);
    expect(meta.width).toBe(500);
    expect(meta.height).toBe(400);
    expect(meta.crop).toEqual({ x: 250, y: 100, width: 500, height: 400 });
    expect(meta.marker).toEqual({ x: 50, y: 100 });
    expect(meta.elementBox).toEqual({ x: 0, y: 50, width: 150, height: 100 });
  });

  it("flags a marker outside the crop", () => {
    const { meta, markerInside } = buildScreenshotMeta({
      original,
      crop: { x: 1000, y: 0, width: 500, height: 500 },
      marker: { x: 300, y: 200 },
      elementBox: { x: 200, y: 150, width: 200, height: 100 },
    });
    expect(markerInside).toBe(false);
    expect(meta.marker).toBeUndefined();
    expect(meta.elementBox).toBeUndefined();
  });

  it("keeps a rounded marker inside a tiny crop (rounding edge)", () => {
    // 9.75 is inside [0, 10) but would round to 10 == width, which the companion rejects.
    const { meta, markerInside } = buildScreenshotMeta({
      original,
      crop: { x: 100, y: 200, width: 10, height: 10 },
      marker: { x: 109.75, y: 209.6 },
      elementBox: { x: 95.4, y: 195.4, width: 15.2, height: 15.2 },
    });
    expect(markerInside).toBe(true);
    expect(meta.marker).toEqual({ x: 9, y: 9 });
    const box = meta.elementBox;
    expect(box).toBeDefined();
    if (!box) return;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(meta.width);
    expect(box.y + box.height).toBeLessThanOrEqual(meta.height);
  });

  it("still rejects a marker exactly on the right/bottom crop edge", () => {
    const { meta, markerInside } = buildScreenshotMeta({
      original,
      crop: { x: 100, y: 200, width: 10, height: 10 },
      marker: { x: 110, y: 205 },
    });
    expect(markerInside).toBe(false);
    expect(meta.marker).toBeUndefined();
  });

  it("allows any crop for page comments", () => {
    const { meta, markerInside } = buildScreenshotMeta({ original, crop: { x: 10, y: 10, width: 100, height: 100 } });
    expect(markerInside).toBe(true);
    expect(meta.marker).toBeUndefined();
    expect(meta.crop).toEqual({ x: 10, y: 10, width: 100, height: 100 });
  });
});
