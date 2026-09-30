/**
 * Screenshot preview with marker and crop selection. Crop by dragging on the image or via numeric
 * inputs (original image px). The overlay uses an SVG in image coordinates, so what is shown is
 * what renderFinalPng draws.
 */
import { useId, useRef, useState } from "preact/hooks";
import type { Point, Rect } from "@website-review/shared";
import {
  displayToImage,
  isFullCrop,
  markerStyle,
  normalizeCrop,
  rectFromPoints,
  type MarkGeometry,
  type Size,
} from "../../lib/geometry.ts";
import { MARK_COLOR } from "../../lib/render.ts";

const MIN_DRAG_PX = 8;

export function CropEditor(props: {
  src: string;
  image: Size;
  marks: MarkGeometry;
  imagePxPerCssPx: number;
  crop: Rect;
  onCrop: (crop: Rect) => void;
  markerInside: boolean;
}) {
  const { image, marks, crop } = props;
  const id = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ start: Point; current: Point; pointerId: number } | null>(null);
  const { radius, lineWidth } = markerStyle(props.imagePxPerCssPx);

  const toImage = (e: PointerEvent): Point => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return displayToImage({ x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height }, image);
  };

  const shown = drag ? rectFromPoints(drag.start, drag.current) : crop;
  const full = isFullCrop(crop, image) && !drag;

  const setField = (key: keyof Rect, raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    props.onCrop(normalizeCrop({ ...crop, [key]: v }, image));
  };

  return (
    <div class="crop">
      <div class="crop-stage">
        <img src={props.src} alt="Aufgenommener Screenshot der Seite" draggable={false} />
        <svg
          ref={svgRef}
          class="crop-svg"
          viewBox={`0 0 ${image.width} ${image.height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Zuschnittbereich: mit der Maus ziehen, um einen Ausschnitt zu wählen"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = toImage(e);
            setDrag({ start: p, current: p, pointerId: e.pointerId });
          }}
          onPointerMove={(e) => {
            if (!drag || drag.pointerId !== e.pointerId) return;
            setDrag({ ...drag, current: toImage(e) });
          }}
          onPointerUp={(e) => {
            if (!drag || drag.pointerId !== e.pointerId) return;
            const r = rectFromPoints(drag.start, toImage(e));
            setDrag(null);
            if (r.width >= MIN_DRAG_PX && r.height >= MIN_DRAG_PX) props.onCrop(normalizeCrop(r, image));
          }}
          onPointerCancel={() => setDrag(null)}
        >
          {!full && (
            <path
              class="crop-dim"
              fill-rule="evenodd"
              d={`M0 0H${image.width}V${image.height}H0Z M${shown.x} ${shown.y}h${shown.width}v${shown.height}h${-shown.width}Z`}
            />
          )}
          {marks.elementBox && (
            <rect
              x={marks.elementBox.x + lineWidth / 2}
              y={marks.elementBox.y + lineWidth / 2}
              width={Math.max(0, marks.elementBox.width - lineWidth)}
              height={Math.max(0, marks.elementBox.height - lineWidth)}
              fill="none"
              stroke={MARK_COLOR}
              stroke-width={lineWidth}
            />
          )}
          {marks.marker && (
            <g>
              <circle
                cx={marks.marker.x}
                cy={marks.marker.y}
                r={radius}
                fill="rgba(225,29,46,0.18)"
                stroke="rgba(255,255,255,0.9)"
                stroke-width={lineWidth + 2 * Math.max(1, Math.round(lineWidth / 3))}
              />
              <circle cx={marks.marker.x} cy={marks.marker.y} r={radius} fill="none" stroke={MARK_COLOR} stroke-width={lineWidth} />
              <circle cx={marks.marker.x} cy={marks.marker.y} r={Math.max(2, lineWidth * 0.8)} fill={MARK_COLOR} />
            </g>
          )}
          {!full && (
            <rect
              class="crop-frame"
              x={shown.x}
              y={shown.y}
              width={shown.width}
              height={shown.height}
              fill="none"
              vector-effect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>
      <fieldset class="crop-fields">
        <legend>Ausschnitt in Bildpixeln (Original {image.width} × {image.height})</legend>
        {(
          [
            ["x", "Links"],
            ["y", "Oben"],
            ["width", "Breite"],
            ["height", "Höhe"],
          ] as const
        ).map(([key, label]) => (
          <div class="crop-field" key={key}>
            <label for={`${id}-${key}`}>{label}</label>
            <input
              id={`${id}-${key}`}
              class="input mono"
              type="number"
              min={key === "width" || key === "height" ? 1 : 0}
              max={key === "x" || key === "width" ? image.width : image.height}
              step={1}
              value={crop[key]}
              onChange={(e) => setField(key, e.currentTarget.value)}
            />
          </div>
        ))}
      </fieldset>
      <div class="row">
        <button type="button" class="btn small" disabled={isFullCrop(crop, image)} onClick={() => props.onCrop({ x: 0, y: 0, ...image })}>
          Zuschnitt zurücksetzen
        </button>
        <span class="muted small">
          {isFullCrop(crop, image) ? "Kein Zuschnitt – ganzes Bild." : `Ausschnitt ${crop.width} × ${crop.height} px.`}
        </span>
      </div>
      {!props.markerInside && (
        <p class="alert" role="alert" id="marker-outside">
          Die Markierung liegt außerhalb des Ausschnitts. Bitte den Ausschnitt so wählen, dass die Markierung enthalten
          ist, oder den Zuschnitt zurücksetzen.
        </p>
      )}
    </div>
  );
}
