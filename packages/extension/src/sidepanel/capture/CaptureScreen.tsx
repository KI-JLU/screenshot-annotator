/** Preview, crop and comment form for a fresh capture; saves the comment to the companion. */
import { useEffect, useId, useMemo, useState } from "preact/hooks";
import type { CreateCommentRequest, MarkKind, Rect } from "@website-review/shared";
import { buildScreenshotMeta, cssToImageScale, fullRect, markGeometryFromCss, type Size } from "../../lib/geometry.ts";
import { blobToBase64, renderFinalPng } from "../../lib/render.ts";
import { MARK_KIND_LABELS } from "../../lib/format.ts";
import { useAction, useApp } from "../context.ts";
import type { ActiveTab } from "../useActiveTab.ts";
import { confirmDialog } from "../components/ConfirmDialog.tsx";
import { ErrorText, Field, Notice } from "../components/ui.tsx";
import { CropEditor } from "./CropEditor.tsx";
import { useCapture } from "./useCapture.tsx";

export function CaptureScreen({ tab }: { tab: ActiveTab | null }) {
  const { client, announce, projects } = useApp();
  const cap = useCapture();
  const { capture, draft } = cap;
  const id = useId();
  const action = useAction();
  const [image, setImage] = useState<Size | null>(null);
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    setImage(null);
    setImageError(false);
    if (!capture) return;
    const img = new Image();
    img.onload = () => setImage({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => setImageError(true);
    img.src = capture.dataUrl;
  }, [capture?.id]);

  const geometry = useMemo(() => {
    if (!capture || !image) return null;
    const viewport = { width: capture.context.viewport.width, height: capture.context.viewport.height };
    const scale = cssToImageScale(image, viewport);
    const marks = markGeometryFromCss(capture, image, viewport);
    return { scale, marks };
  }, [capture, image]);

  if (!draft) return null;
  const project = projects?.find((p) => p.config.projectId === draft.projectId);
  const mode: MarkKind | null = capture?.mode ?? null;
  const attach = mode !== "page" || draft.attachScreenshot;
  const crop: Rect | null = image ? (draft.crop ?? fullRect(image)) : null;
  const metaResult =
    image && crop && geometry ? buildScreenshotMeta({ original: image, crop, ...geometry.marks }) : null;
  const markerInside = metaResult?.markerInside ?? true;
  const textMissing = draft.text.trim() === "";
  const canSubmit = !!capture && !textMissing && (!attach || (!!metaResult && markerInside)) && !action.busy;

  const submit = (e: Event) => {
    e.preventDefault();
    if (!capture || !canSubmit) return;
    void action.run(async () => {
      const context = { ...capture.context };
      const extra = draft.extraContext.trim();
      if (extra) context.extraContext = extra;
      const req: CreateCommentRequest = {
        clientRequestId: capture.id,
        text: draft.text.trim(),
        markKind: capture.mode,
        context,
      };
      if (attach && metaResult && geometry) {
        const blob = await renderFinalPng(capture.dataUrl, metaResult.meta, geometry.scale.x);
        req.screenshot = metaResult.meta;
        req.imagePngBase64 = await blobToBase64(blob);
      }
      await client.createComment(draft.reviewId, req);
      await cap.reset();
      announce("Kommentar als Entwurf gespeichert.");
    });
  };

  const discard = async () => {
    if (draft.text.trim()) {
      const ok = await confirmDialog({
        title: "Entwurf verwerfen?",
        message: "Screenshot und eingegebener Text werden verworfen.",
        confirmLabel: "Verwerfen",
        danger: true,
      });
      if (!ok) return;
    }
    await cap.reset();
    announce("Entwurf verworfen.");
  };

  const recapture = (m: MarkKind) => {
    if (!tab) return;
    void cap.start(m, tab, { reviewId: draft.reviewId, projectId: draft.projectId });
  };

  const submitHintId = `${id}-submit-hint`;
  const submitHint = !capture
    ? "Der Screenshot ist nicht mehr vorhanden. Bitte neu aufnehmen; der Text bleibt erhalten."
    : textMissing
      ? "Bitte einen Kommentar eingeben."
      : attach && !markerInside
        ? "Die Markierung liegt außerhalb des Ausschnitts."
        : "";

  return (
    <section class="stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Neuer Kommentar{mode ? ` – ${MARK_KIND_LABELS[mode]}` : ""}</h2>
      {capture && (
        <p class="muted small ellipsis" title={capture.context.url}>
          {project ? `${project.config.name} · ` : ""}
          {capture.context.pageTitle || capture.context.url} · {capture.context.viewport.width}×
          {capture.context.viewport.height} (DPR {capture.context.viewport.devicePixelRatio})
        </p>
      )}
      {capture?.context.elementDescription && (
        <p class="small">
          Element: <code>{capture.context.elementDescription}</code>
        </p>
      )}
      {!capture && (
        <Notice tone="warn">
          Der Screenshot dieses Entwurfs ist nicht mehr verfügbar (z. B. zu groß für den Sitzungsspeicher). Der Text ist
          erhalten – bitte neu aufnehmen.
        </Notice>
      )}
      {imageError && <p class="alert">Der Screenshot konnte nicht geladen werden.</p>}

      <form class="stack" onSubmit={submit}>
        {mode === "page" && (
          <label class="check">
            <input
              type="checkbox"
              checked={draft.attachScreenshot}
              onChange={(e) => cap.updateDraft({ attachScreenshot: e.currentTarget.checked })}
            />
            Screenshot mitsenden
          </label>
        )}
        {capture && image && crop && geometry && attach && (
          <CropEditor
            src={capture.dataUrl}
            image={image}
            marks={geometry.marks}
            imagePxPerCssPx={geometry.scale.x}
            crop={crop}
            markerInside={markerInside}
            onCrop={(c) => cap.updateDraft({ crop: c })}
          />
        )}
        <Field label="Kommentar (erforderlich)" id={`${id}-text`}>
          <textarea
            id={`${id}-text`}
            class="input"
            rows={4}
            required
            value={draft.text}
            onInput={(e) => cap.updateDraft({ text: e.currentTarget.value })}
            placeholder="Was soll sich ändern?"
          />
        </Field>
        <Field
          label="Zusätzlicher Kontext (optional)"
          id={`${id}-extra`}
          hint="Weiterer Seitentext, den du gezielt mitgeben möchtest, z. B. aus einem größeren Bereich."
        >
          <textarea
            id={`${id}-extra`}
            class="input"
            rows={2}
            aria-describedby={`${id}-extra-hint`}
            value={draft.extraContext}
            onInput={(e) => cap.updateDraft({ extraContext: e.currentTarget.value })}
          />
        </Field>
        {capture?.context.elementText && (
          <details>
            <summary>Erfasster Elementtext</summary>
            <p class="small prewrap">{capture.context.elementText}</p>
          </details>
        )}
        <ErrorText error={action.error} />
        {submitHint && (
          <p class="hint" id={submitHintId}>
            {submitHint}
          </p>
        )}
        <div class="row wrap">
          <button
            type="submit"
            class="btn primary"
            disabled={!canSubmit}
            aria-describedby={submitHint ? submitHintId : undefined}
          >
            {action.busy ? "Speichere …" : "Übernehmen"}
          </button>
          <button type="button" class="btn" onClick={() => void discard()} disabled={action.busy}>
            Verwerfen
          </button>
        </div>
        <div class="row wrap" role="group" aria-label="Neu aufnehmen">
          <span class="muted small">Neu aufnehmen:</span>
          {(["element", "point", "page"] as const).map((m) => (
            <button key={m} type="button" class="btn small" disabled={!tab || action.busy} onClick={() => recapture(m)}>
              {MARK_KIND_LABELS[m]}
            </button>
          ))}
        </div>
      </form>
    </section>
  );
}
