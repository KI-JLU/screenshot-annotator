/**
 * Pure geometry and text layout for the annotated screenshot. No DOM access; tested in geometry.test.ts.
 * Rects are viewport-relative CSS px unless a name says otherwise.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

/** Space around a selected element, and the smallest crop worth pasting, in CSS px. */
export const ELEMENT_PADDING = 24;
export const MIN_ELEMENT_CROP: Size = { width: 400, height: 160 };

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
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
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** Rounds rect edges (not width/height) to whole pixels so adjacent edges stay consistent. */
export function roundRect(r: Rect): Rect {
  const x1 = Math.round(r.x);
  const y1 = Math.round(r.y);
  return { x: x1, y: y1, width: Math.round(r.x + r.width) - x1, height: Math.round(r.y + r.height) - y1 };
}

export function scaleRect(r: Rect, s: number): Rect {
  return { x: r.x * s, y: r.y * s, width: r.width * s, height: r.height * s };
}

/** Grows `length` around [start, start + size) to at least `min`, shifted to stay inside [0, limit). */
function growSpan(start: number, size: number, min: number, limit: number): [number, number] {
  const length = Math.min(Math.max(size, min), limit);
  const centred = start + size / 2 - length / 2;
  return [clamp(centred, 0, limit - length), length];
}

/**
 * The part of the viewport to keep. An area is kept as drawn; an element gets padding and, when
 * small, surrounding context up to MIN_ELEMENT_CROP. Null when nothing of it is visible.
 */
export function cropFor(kind: "element" | "area", rect: Rect, viewport: Size): Rect | null {
  const view: Rect = { x: 0, y: 0, ...viewport };
  if (kind === "area") return intersectRects(rect, view);
  const visible = intersectRects(rect, view);
  if (!visible) return null;
  const [x, width] = growSpan(
    visible.x - ELEMENT_PADDING,
    visible.width + 2 * ELEMENT_PADDING,
    MIN_ELEMENT_CROP.width,
    viewport.width,
  );
  const [y, height] = growSpan(
    visible.y - ELEMENT_PADDING,
    visible.height + 2 * ELEMENT_PADDING,
    MIN_ELEMENT_CROP.height,
    viewport.height,
  );
  return intersectRects({ x, y, width, height }, view);
}

/**
 * Greedy word wrap. Keeps explicit line breaks and breaks words that are wider than a line
 * (long URLs) at character boundaries. `measure` returns the rendered width of a string.
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/ +/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      let rest = word;
      while (measure(rest) > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && measure(rest.slice(0, cut)) > maxWidth) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}
