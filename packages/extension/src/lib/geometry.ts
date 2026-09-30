/**
 * Pure geometry for capture, preview and crop. No DOM access; unit-tested in geometry.test.ts.
 *
 * Coordinate spaces:
 * - CSS px: what the content script measures (getBoundingClientRect, click position), viewport-relative.
 * - original image px: pixels of the captureVisibleTab PNG.
 * - final image px: pixels of the cropped PNG (origin = crop top-left).
 */
import type { Point, Rect, ScreenshotMeta } from "@website-review/shared";

export interface Size {
  width: number;
  height: number;
}

export interface Scale {
  x: number;
  y: number;
}

/**
 * Image px per CSS px, derived from the actual image size. devicePixelRatio alone is not reliable
 * (page zoom, fractional scaling, scrollbar handling), so the captured image is the reference.
 */
export function cssToImageScale(image: Size, viewport: Size): Scale {
  if (!(viewport.width > 0) || !(viewport.height > 0)) {
    throw new Error("Viewport size must be positive");
  }
  return { x: image.width / viewport.width, y: image.height / viewport.height };
}

export function cssPointToImage(p: Point, scale: Scale): Point {
  return { x: p.x * scale.x, y: p.y * scale.y };
}

export function cssRectToImage(r: Rect, scale: Scale): Rect {
  return { x: r.x * scale.x, y: r.y * scale.y, width: r.width * scale.x, height: r.height * scale.y };
}

export function fullRect(size: Size): Rect {
  return { x: 0, y: 0, width: size.width, height: size.height };
}

/** Intersection of two rects, or null when they do not overlap with a positive area. */
export function intersectRects(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Normalized rect spanned by two drag points (any direction). */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Rounds rect edges (not width/height) to whole pixels so adjacent edges stay consistent. */
export function roundRect(r: Rect): Rect {
  const x1 = Math.round(r.x);
  const y1 = Math.round(r.y);
  const x2 = Math.round(r.x + r.width);
  const y2 = Math.round(r.y + r.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Turns any user-provided crop (drag result or numeric input) into a valid integer crop inside the
 * image with at least `minSize` px per side. Falls back to the full image when nothing is left.
 */
export function normalizeCrop(r: Rect, image: Size, minSize = 1): Rect {
  const width = Math.abs(r.width);
  const height = Math.abs(r.height);
  const src: Rect = {
    x: r.width < 0 ? r.x + r.width : r.x,
    y: r.height < 0 ? r.y + r.height : r.y,
    width,
    height,
  };
  const inside = intersectRects(roundRect(src), fullRect(image));
  if (!inside || inside.width < minSize || inside.height < minSize) return fullRect(image);
  return inside;
}

export function isFullCrop(crop: Rect, image: Size): boolean {
  return crop.x === 0 && crop.y === 0 && crop.width === image.width && crop.height === image.height;
}

/** Half-open containment: [x, x + width) × [y, y + height). A point on the right/bottom edge is outside. */
export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

export function pointToCrop(p: Point, crop: Rect): Point {
  return { x: p.x - crop.x, y: p.y - crop.y };
}

/** Rect translated into crop coordinates and clipped to the crop; null when fully outside. */
export function rectToCrop(r: Rect, crop: Rect): Rect | null {
  const clipped = intersectRects(r, crop);
  if (!clipped) return null;
  return { x: clipped.x - crop.x, y: clipped.y - crop.y, width: clipped.width, height: clipped.height };
}

/**
 * Marker for an element mark: centre of the visible part of the element box (image px).
 * Null when the element is entirely outside the captured image.
 */
export function elementMarker(elementBox: Rect, image: Size): Point | null {
  const visible = intersectRects(elementBox, fullRect(image));
  if (!visible) return null;
  return { x: visible.x + visible.width / 2, y: visible.y + visible.height / 2 };
}

/** Maps a position within the displayed (scaled) preview to original image px, clamped to the image. */
export function displayToImage(p: Point, display: Size, image: Size): Point {
  if (!(display.width > 0) || !(display.height > 0)) return { x: 0, y: 0 };
  return {
    x: clamp((p.x / display.width) * image.width, 0, image.width),
    y: clamp((p.y / display.height) * image.height, 0, image.height),
  };
}

export interface MarkGeometry {
  /** Marker in original image px (element and point marks). */
  marker?: Point;
  /** Element outline in original image px (element marks), unclipped. */
  elementBox?: Rect;
}

/** Converts what the content script measured (CSS px) into original image px. */
export function markGeometryFromCss(
  input: { elementRect?: Rect; point?: Point },
  image: Size,
  viewport: Size,
): MarkGeometry {
  const scale = cssToImageScale(image, viewport);
  if (input.elementRect) {
    const elementBox = cssRectToImage(input.elementRect, scale);
    const marker = elementMarker(elementBox, image);
    return marker ? { elementBox, marker } : { elementBox };
  }
  if (input.point) {
    const p = cssPointToImage(input.point, scale);
    return { marker: { x: clamp(p.x, 0, image.width), y: clamp(p.y, 0, image.height) } };
  }
  return {};
}

export interface ScreenshotMetaResult {
  meta: ScreenshotMeta;
  /** False when a marker exists but lies outside the crop: the user has to correct the crop. */
  markerInside: boolean;
}

/**
 * Builds ScreenshotMeta for the final (cropped) image: marker and element box in final-image px,
 * element box clipped to the crop, crop in original px.
 */
export function buildScreenshotMeta(input: { original: Size; crop: Rect } & MarkGeometry): ScreenshotMetaResult {
  const crop = normalizeCrop(input.crop, input.original);
  const meta: ScreenshotMeta = {
    width: crop.width,
    height: crop.height,
    originalWidth: input.original.width,
    originalHeight: input.original.height,
    crop,
  };
  let markerInside = true;
  if (input.marker) {
    markerInside = pointInRect(input.marker, crop);
    if (markerInside) {
      const m = pointToCrop(input.marker, crop);
      meta.marker = { x: Math.round(m.x), y: Math.round(m.y) };
    }
  }
  if (input.elementBox && markerInside) {
    const box = rectToCrop(input.elementBox, crop);
    if (box) meta.elementBox = roundRect(box);
  }
  return { meta, markerInside };
}

/** Visual sizes of the drawn marker in image px, proportional to image px per CSS px. */
export function markerStyle(imagePxPerCssPx: number): { radius: number; lineWidth: number } {
  const s = imagePxPerCssPx > 0 ? imagePxPerCssPx : 1;
  return { radius: Math.round(14 * s), lineWidth: Math.max(2, Math.round(3 * s)) };
}
