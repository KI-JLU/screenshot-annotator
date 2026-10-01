/**
 * Selection overlay, injected on demand with chrome.scripting.executeScript({ files: ["content.js"] }).
 *
 * - Shadow DOM host fixed over the viewport at max z-index (top layer via popover when available),
 *   so the page layout is untouched and page events are swallowed.
 * - Click selects the element under the pointer; dragging selects a free area. Esc cancels.
 * - Then a comment box opens. Enter copies, Shift+Enter adds a line.
 * - Before the screenshot the overlay is removed and two animation frames pass, so the capture
 *   shows the page only. The image is rendered here and written to the clipboard.
 */
import { annotationText, renderAnnotation, type Annotation } from "../lib/annotate.ts";
import { rectFromPoints, type Point, type Rect } from "../lib/geometry.ts";
import type { CaptureResponse, ContentToWorker, WorkerToContent } from "../lib/messages.ts";

declare global {
  interface Window {
    __screenshotAnnotator?: { start(): void };
  }
}

const Z = "2147483647";
/** Pointer travel (CSS px) that turns a click into an area drag, and the smallest usable area. */
const DRAG_THRESHOLD = 4;
const MIN_AREA = 8;
const TOAST_MS = 4000;

type Selection = { kind: "element"; element: Element; description: string } | { kind: "area"; rect: Rect };

function collapse(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function capText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
}

function isFormField(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/** Short hint like `button.primary "Save"` that helps an agent find the element in the code. */
function describeElement(el: Element): string {
  let desc = el.tagName.toLowerCase();
  if (el.id && el.id.length <= 40) desc += `#${CSS.escape(el.id)}`;
  for (const c of [...el.classList].filter((c) => c.length <= 40).slice(0, 2)) desc += `.${CSS.escape(c)}`;
  const attrLabel = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title");
  // Form fields are described by their labels, never by their value (it may be a password).
  const label = collapse(
    isFormField(el)
      ? attrLabel || el.labels?.[0]?.innerText || el.getAttribute("placeholder")
      : attrLabel || (el instanceof HTMLElement ? el.innerText : el.textContent),
  );
  if (label) desc += ` "${capText(label, 60)}"`;
  return desc;
}

function rectOf(sel: Selection): Rect {
  if (sel.kind === "area") return sel.rect;
  const r = sel.element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
}

async function captureViewport(): Promise<string> {
  const msg: ContentToWorker = { type: "capture" };
  const res = (await chrome.runtime.sendMessage(msg)) as CaptureResponse;
  if (!res.ok) throw new Error(`Screenshot failed: ${res.error}`);
  return res.dataUrl;
}

async function copyToClipboard(png: Promise<Blob>, text: string): Promise<void> {
  // Pages served over plain http (other than localhost) have no async clipboard.
  if (!navigator.clipboard?.write) throw new Error("This page is not a secure context, so it has no clipboard access.");
  // Passing the promise lets the write start inside the Enter/click gesture while the image renders.
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": png, "text/plain": new Blob([text], { type: "text/plain" }) }),
  ]);
}

const STYLE = `
:host { all: initial; }
.layer { position: fixed; inset: 0; cursor: crosshair; font: 13px/1.4 system-ui, sans-serif; }
.layer.commenting { cursor: default; }
.box {
  position: fixed; pointer-events: none; display: none; box-sizing: border-box;
  border: 2px solid #e11d2e; background: rgba(225,29,46,0.08); border-radius: 2px;
}
.tag {
  position: fixed; pointer-events: none; display: none; max-width: 60vw; overflow: hidden;
  white-space: nowrap; text-overflow: ellipsis; padding: 2px 6px; border-radius: 3px;
  font-size: 12px; color: #fff; background: #e11d2e;
}
.hint {
  position: fixed; left: 50%; top: 12px; transform: translateX(-50%); pointer-events: none;
  padding: 6px 12px; border-radius: 6px; color: #fff; background: rgba(17,24,39,0.92);
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
.hint.bottom { top: auto; bottom: 12px; }
.panel {
  position: fixed; display: none; width: 320px; box-sizing: border-box; padding: 8px;
  border-radius: 8px; background: #fff; color: #111827; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
}
textarea {
  display: block; width: 100%; box-sizing: border-box; min-height: 72px; resize: vertical;
  padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 4px;
  font: 14px/1.4 system-ui, sans-serif; color: #111827; background: #fff;
}
textarea:focus { outline: 2px solid #e11d2e; outline-offset: -1px; }
.actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
button {
  padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 4px; cursor: pointer;
  font: 13px/1.4 system-ui, sans-serif; color: #111827; background: #fff;
}
button.primary { border-color: #e11d2e; color: #fff; background: #e11d2e; }
.toast {
  display: flex; flex-direction: column; gap: 6px; max-width: 360px; padding: 10px 12px;
  border-radius: 8px; font: 13px/1.4 system-ui, sans-serif; color: #fff;
  background: rgba(17,24,39,0.95); box-shadow: 0 4px 16px rgba(0,0,0,0.3);
}
.toast img { max-width: 100%; max-height: 160px; object-fit: contain; align-self: flex-start; background: #fff; }
.toast button { align-self: flex-end; }
`;

/** Host element in the top layer with a closed shadow root holding STYLE. */
function mountHost(extraCss: string[]): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement("div");
  host.setAttribute("data-screenshot-annotator", "");
  host.style.cssText = [
    "all: initial",
    "position: fixed",
    "margin: 0",
    "padding: 0",
    "border: 0",
    "background: transparent",
    "overflow: visible",
    "display: block",
    `z-index: ${Z}`,
    ...extraCss,
  ]
    .map((d) => `${d} !important`)
    .join(";");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  root.append(style);
  document.documentElement.append(host);
  // Top layer keeps the overlay above open modal dialogs of the page.
  try {
    host.setAttribute("popover", "manual");
    host.showPopover();
  } catch {
    host.removeAttribute("popover");
  }
  return { host, root };
}

function unmountHost(host: HTMLElement): void {
  try {
    if (host.matches(":popover-open")) host.hidePopover();
  } catch {
    /* popover unsupported */
  }
  host.remove();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function createOverlay(): { start(): void } {
  let phase: "select" | "comment" | null = null;
  let host: HTMLElement | null = null;
  let parts: {
    layer: HTMLElement;
    box: HTMLElement;
    tag: HTMLElement;
    hint: HTMLElement;
    panel: HTMLElement;
    textarea: HTMLTextAreaElement;
  } | null = null;
  let toastHost: HTMLElement | null = null;
  let toastTimer: number | undefined;
  let toastImageUrl: string | undefined;
  let pointer: Point | null = null;
  let dragStart: Point | null = null;
  let dragging = false;
  let selection: Selection | null = null;

  const underPointer = (p: Point): Element | null =>
    document.elementsFromPoint(p.x, p.y).find((e) => e !== host && !host?.contains(e)) ?? null;

  const showBox = (r: Rect) => {
    if (!parts) return;
    Object.assign(parts.box.style, {
      display: "block",
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  };

  const updateHover = () => {
    if (!parts || !pointer || phase !== "select") return;
    parts.hint.classList.toggle("bottom", pointer.y < 80);
    if (dragging && dragStart) {
      showBox(rectFromPoints(dragStart, pointer));
      parts.tag.style.display = "none";
      return;
    }
    const target = underPointer(pointer);
    if (!target) {
      parts.box.style.display = "none";
      parts.tag.style.display = "none";
      return;
    }
    const r = target.getBoundingClientRect();
    showBox({ x: r.left, y: r.top, width: r.width, height: r.height });
    parts.tag.textContent = describeElement(target);
    const tagTop = r.top >= 24 ? r.top - 22 : Math.min(r.bottom + 4, window.innerHeight - 22);
    Object.assign(parts.tag.style, { display: "block", left: `${Math.max(0, r.left)}px`, top: `${tagTop}px` });
  };

  /**
   * The shadow root is closed, so window listeners see our events retargeted to the host. Focus
   * only ever sits in the comment box; pointer events count when they land on it.
   */
  const inPanel = (e: Event) => {
    if (phase !== "comment" || !parts || e.target !== host) return false;
    if (e instanceof KeyboardEvent) return true;
    if (!(e instanceof MouseEvent)) return false;
    const r = parts.panel.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };

  /** Swallows page events, except those aimed at the comment box. */
  const block = (e: Event) => {
    if (!phase || inPanel(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onPointerDown = (e: PointerEvent) => {
    block(e);
    if (phase !== "select" || e.button !== 0) return;
    dragStart = { x: e.clientX, y: e.clientY };
    dragging = false;
  };

  const onPointerMove = (e: PointerEvent) => {
    block(e);
    pointer = { x: e.clientX, y: e.clientY };
    if (dragStart && !dragging) {
      dragging = Math.hypot(pointer.x - dragStart.x, pointer.y - dragStart.y) > DRAG_THRESHOLD;
    }
    updateHover();
  };

  const onPointerUp = (e: PointerEvent) => {
    block(e);
    if (phase !== "select" || !dragStart) return;
    const end = { x: e.clientX, y: e.clientY };
    const start = dragStart;
    const wasDrag = dragging;
    dragStart = null;
    dragging = false;
    if (wasDrag) {
      const rect = rectFromPoints(start, end);
      if (rect.width >= MIN_AREA && rect.height >= MIN_AREA) openComment({ kind: "area", rect });
      else updateHover();
      return;
    }
    const target = underPointer(end);
    if (target) openComment({ kind: "element", element: target, description: describeElement(target) });
  };

  const onKey = (e: KeyboardEvent) => {
    if (!phase) return;
    if (e.key === "Escape") {
      block(e);
      teardown();
      return;
    }
    if (inPanel(e)) {
      if (e.type === "keydown" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
      // Keep typing away from page shortcuts; the default action (text input) still happens.
      e.stopImmediatePropagation();
      return;
    }
    block(e);
  };

  const onScroll = () => {
    if (phase === "comment" && selection) {
      showBox(rectOf(selection));
      placePanel();
    } else updateHover();
  };

  const placePanel = () => {
    if (!parts || !selection) return;
    const r = rectOf(selection);
    const w = 320;
    const h = parts.panel.offsetHeight || 130;
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = r.y + r.height + gap;
    if (top + h > vh) top = r.y - h - gap >= 0 ? r.y - h - gap : Math.max(gap, vh - h - gap);
    const left = Math.min(Math.max(gap, r.x), Math.max(gap, vw - w - gap));
    Object.assign(parts.panel.style, { display: "block", left: `${left}px`, top: `${top}px` });
  };

  const openComment = (sel: Selection) => {
    if (!parts) return;
    selection = sel;
    phase = "comment";
    parts.layer.classList.add("commenting");
    parts.tag.style.display = "none";
    parts.hint.classList.remove("bottom");
    parts.hint.textContent = "Add a comment · Enter copies · Shift+Enter new line · Esc cancels";
    showBox(rectOf(sel));
    placePanel();
    parts.textarea.focus();
  };

  const BLOCKED = ["mousedown", "mouseup", "mousemove", "click", "dblclick", "contextmenu", "auxclick", "touchstart", "touchmove", "touchend", "wheel"];
  const KEYS = ["keydown", "keypress", "keyup"];

  const listen = (on: boolean) => {
    const method = on ? "addEventListener" : "removeEventListener";
    const opts = { capture: true, passive: false };
    window[method]("pointerdown", onPointerDown as EventListener, opts);
    window[method]("pointermove", onPointerMove as EventListener, opts);
    window[method]("pointerup", onPointerUp as EventListener, opts);
    window[method]("scroll", onScroll, opts);
    for (const t of BLOCKED) window[method](t, block, opts);
    for (const t of KEYS) window[method](t, onKey as EventListener, opts);
  };

  const teardown = () => {
    phase = null;
    selection = null;
    dragStart = null;
    dragging = false;
    listen(false);
    if (host) unmountHost(host);
    host = null;
    parts = null;
  };

  const hideToast = () => {
    window.clearTimeout(toastTimer);
    if (toastHost) unmountHost(toastHost);
    if (toastImageUrl) URL.revokeObjectURL(toastImageUrl);
    toastHost = null;
    toastImageUrl = undefined;
  };

  const showToast = (message: string, image?: Blob, sticky = false) => {
    hideToast();
    const { host: th, root } = mountHost(["right: 16px", "bottom: 16px", "left: auto", "top: auto"]);
    toastHost = th;
    const toast = el("div", "toast");
    toast.setAttribute("role", "status");
    toast.append(el("div", "", message));
    if (image) {
      const img = el("img");
      img.alt = "Annotated screenshot";
      img.src = toastImageUrl = URL.createObjectURL(image);
      toast.append(img);
    }
    const close = el("button", "", "Close");
    close.addEventListener("click", hideToast);
    toast.append(close);
    root.append(toast);
    if (!sticky) toastTimer = window.setTimeout(hideToast, TOAST_MS);
  };

  const submit = () => {
    if (!parts || !selection) return;
    const annotation: Annotation = {
      kind: selection.kind,
      rect: rectOf(selection),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      comment: parts.textarea.value.trim(),
      url: location.href,
      ...(selection.kind === "element" ? { element: selection.description } : {}),
    };
    teardown();
    const png = (async () => {
      // Let the page repaint without the overlay before the worker takes the screenshot.
      await nextFrames(2);
      return renderAnnotation(await captureViewport(), annotation);
    })();
    copyToClipboard(png, annotationText(annotation)).then(
      async () => showToast("Copied. Paste it into Claude Code or Codex.", await png),
      async (e: unknown) => {
        const image = await png.catch(() => undefined);
        const reason = e instanceof Error ? e.message : String(e);
        if (image) showToast(`Could not write to the clipboard (${reason}). Right-click the image → Copy image.`, image, true);
        else showToast(reason, undefined, true);
      },
    );
  };

  return {
    start() {
      if (phase) teardown();
      hideToast();
      const mounted = mountHost([
        "inset: 0",
        "width: 100vw",
        "height: 100vh",
        "max-width: none",
        "max-height: none",
        "pointer-events: auto",
        "cursor: crosshair",
      ]);
      host = mounted.host;
      const layer = el("div", "layer");
      const hint = el("div", "hint", "Click an element or drag an area · Esc cancels");
      hint.setAttribute("role", "status");
      const panel = el("div", "panel");
      const textarea = el("textarea");
      textarea.placeholder = "What should change here?";
      textarea.setAttribute("aria-label", "Comment");
      const cancel = el("button", "", "Cancel");
      const copy = el("button", "primary", "Copy");
      cancel.addEventListener("click", teardown);
      copy.addEventListener("click", submit);
      const actions = el("div", "actions");
      actions.append(cancel, copy);
      panel.append(textarea, actions);
      const box = el("div", "box");
      const tag = el("div", "tag");
      layer.append(box, tag, hint, panel);
      mounted.root.append(layer);
      parts = { layer, box, tag, hint, panel, textarea };
      phase = "select";
      listen(true);
    },
  };
}

if (!window.__screenshotAnnotator) {
  const overlay = createOverlay();
  window.__screenshotAnnotator = overlay;
  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    if ((raw as WorkerToContent)?.type !== "overlay/start") return false;
    overlay.start();
    sendResponse({ ok: true });
    return false;
  });
}
