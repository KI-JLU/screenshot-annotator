/** Renders the approved PNG: crop applied, marker (red circle) and element outline drawn in. */
import type { ScreenshotMeta } from "@website-review/shared";
import { markerStyle } from "./geometry.ts";

export const MARK_COLOR = "#e11d2e";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawMarks(ctx: Ctx, meta: ScreenshotMeta, imagePxPerCssPx: number): void {
  const { radius, lineWidth } = markerStyle(imagePxPerCssPx);
  if (meta.elementBox) {
    const b = meta.elementBox;
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = MARK_COLOR;
    ctx.strokeRect(b.x + lineWidth / 2, b.y + lineWidth / 2, Math.max(0, b.width - lineWidth), Math.max(0, b.height - lineWidth));
  }
  if (meta.marker) {
    const { x, y } = meta.marker;
    // White halo keeps the marker visible on red or dark backgrounds.
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.lineWidth = lineWidth + 2 * Math.max(1, Math.round(lineWidth / 3));
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.stroke();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = MARK_COLOR;
    ctx.fillStyle = "rgba(225,29,46,0.18)";
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, lineWidth * 0.8), 0, Math.PI * 2);
    ctx.fillStyle = MARK_COLOR;
    ctx.fill();
  }
}

export async function loadBitmap(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

export async function renderFinalPng(dataUrl: string, meta: ScreenshotMeta, imagePxPerCssPx: number): Promise<Blob> {
  const bitmap = await loadBitmap(dataUrl);
  try {
    const { crop } = meta;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(meta.width, meta.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas nicht verfügbar");
      ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, meta.width, meta.height);
      drawMarks(ctx, meta, imagePxPerCssPx);
      return await canvas.convertToBlob({ type: "image/png" });
    }
    const canvas = document.createElement("canvas");
    canvas.width = meta.width;
    canvas.height = meta.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas nicht verfügbar");
    ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, meta.width, meta.height);
    drawMarks(ctx, meta, imagePxPerCssPx);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG-Erzeugung fehlgeschlagen"))), "image/png"),
    );
  } finally {
    bitmap.close();
  }
}

/** Base64 without data: prefix, as required by CreateCommentRequest.imagePngBase64. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
