/**
 * Capture overlay, injected on demand with chrome.scripting.executeScript({ files: ["content.js"] }).
 * Built as a classic IIFE script (no imports at runtime).
 *
 * - Shadow DOM host fixed over the viewport at max z-index (top layer via popover when available),
 *   so the page layout is untouched.
 * - Element mode: hover outline; click selects the element; Alt/Shift+click selects a free point.
 * - Point mode: crosshair; click selects the point.
 * - Page mode: no overlay, only context.
 * - Escape cancels. Pointer/click events are swallowed so the page does not react.
 * - Before reporting the selection the overlay is removed completely and two animation frames pass,
 *   so the screenshot shows the page without the overlay.
 */
import type { CaptureContext, MarkKind, Point, Rect } from "@website-review/shared";
import type { ContentToWorker, OverlaySelection, WorkerToContent } from "../lib/messages.ts";
import { isSensitiveField } from "../lib/sensitive.ts";

interface OverlayApi {
  start(mode: MarkKind): void;
  cancel(): void;
}

declare global {
  interface Window {
    __websiteReviewOverlay?: OverlayApi;
  }
}

const MAX_TEXT = 500;
const Z = "2147483647";

function collapse(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

type FormField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function isFormField(el: Element): el is FormField {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/** Password, hidden, credential/one-time-code and payment fields: their values never leave the page. */
function isSensitive(el: FormField): boolean {
  return isSensitiveField({
    tagName: el.tagName,
    type: el instanceof HTMLInputElement ? el.type : undefined,
    autocomplete: el.getAttribute("autocomplete"),
  });
}

/** Describes a field without its value: aria-label, placeholder or the associated <label> text. */
function fieldLabel(el: FormField): string {
  const labelText = el.labels?.[0] ? collapse(el.labels[0].innerText || el.labels[0].textContent) : "";
  return collapse(
    el.getAttribute("aria-label") ||
      (el instanceof HTMLSelectElement ? "" : el.placeholder) ||
      labelText ||
      el.getAttribute("title"),
  );
}

function visibleText(el: Element): string {
  if (isFormField(el)) {
    if (isSensitive(el)) return fieldLabel(el);
    if (el instanceof HTMLSelectElement) return collapse(el.selectedOptions[0]?.textContent) || fieldLabel(el);
    return collapse(el.value) || fieldLabel(el);
  }
  if (el instanceof HTMLImageElement) return collapse(el.alt || el.title);
  const text = el instanceof HTMLElement ? el.innerText : el.textContent;
  return collapse(text) || collapse(el.getAttribute("aria-label") || el.getAttribute("title"));
}

function cssIdent(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s;
}

/** Short hint like `button.primary „Speichern“`; context only, not a selector for re-finding. */
function describeElement(el: Element): string {
  let desc = el.tagName.toLowerCase();
  if (el.id && el.id.length <= 40) desc += `#${cssIdent(el.id)}`;
  const classes = [...el.classList].filter((c) => c.length <= 40).slice(0, 2);
  for (const c of classes) desc += `.${cssIdent(c)}`;
  // Form fields are labelled by their label texts only, never by their value (see isSensitive).
  const label = isFormField(el)
    ? fieldLabel(el)
    : collapse(el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || visibleText(el));
  if (label) desc += ` „${capText(label, 60)}“`;
  return desc;
}

function baseContext(): CaptureContext {
  return {
    url: location.href,
    pageTitle: document.title,
    // innerWidth/innerHeight describe the full captured viewport (incl. scrollbars).
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    scroll: { x: window.scrollX, y: window.scrollY },
  };
}

function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
}

function send(msg: ContentToWorker): void {
  chrome.runtime.sendMessage(msg).catch(() => undefined);
}

const STYLE = `
:host { all: initial; }
.layer { position: fixed; inset: 0; cursor: crosshair; }
.box {
  position: fixed; pointer-events: none; display: none; box-sizing: border-box;
  border: 2px solid #e11d2e; background: rgba(225,29,46,0.08); border-radius: 2px;
}
.tag {
  position: fixed; pointer-events: none; display: none; max-width: 60vw; overflow: hidden;
  white-space: nowrap; text-overflow: ellipsis; padding: 2px 6px; border-radius: 3px;
  font: 12px/1.4 system-ui, sans-serif; color: #fff; background: #e11d2e;
}
.hline, .vline { position: fixed; pointer-events: none; display: none; background: rgba(225,29,46,0.7); }
.hline { left: 0; right: 0; height: 1px; }
.vline { top: 0; bottom: 0; width: 1px; }
.hint {
  position: fixed; left: 50%; top: 12px; transform: translateX(-50%); pointer-events: none;
  padding: 6px 12px; border-radius: 6px; font: 13px/1.4 system-ui, sans-serif;
  color: #fff; background: rgba(17,24,39,0.92); box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
.hint.bottom { top: auto; bottom: 12px; }
`;

function createOverlay(): OverlayApi {
  let active: MarkKind | null = null;
  let host: HTMLElement | null = null;
  let parts: { box: HTMLElement; tag: HTMLElement; hline: HTMLElement; vline: HTMLElement; hint: HTMLElement } | null = null;
  let hovered: Element | null = null;
  let lastPointer: Point | null = null;

  const underPointer = (x: number, y: number): Element | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === host || (host && host.contains(el))) continue;
      return el;
    }
    return null;
  };

  const updateHover = () => {
    if (!parts || !lastPointer) return;
    const { x, y } = lastPointer;
    // Keep the hint away from the pointer.
    parts.hint.classList.toggle("bottom", y < 80);
    if (active === "point") {
      parts.hline.style.display = "block";
      parts.vline.style.display = "block";
      parts.hline.style.top = `${y}px`;
      parts.vline.style.left = `${x}px`;
      return;
    }
    hovered = underPointer(x, y);
    if (!hovered) {
      parts.box.style.display = "none";
      parts.tag.style.display = "none";
      return;
    }
    const r = hovered.getBoundingClientRect();
    Object.assign(parts.box.style, {
      display: "block",
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    parts.tag.textContent = describeElement(hovered);
    const tagTop = r.top >= 24 ? r.top - 22 : Math.min(r.bottom + 4, window.innerHeight - 22);
    Object.assign(parts.tag.style, { display: "block", left: `${Math.max(0, r.left)}px`, top: `${tagTop}px` });
  };

  const block = (e: Event) => {
    if (!active) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onMove = (e: PointerEvent | MouseEvent) => {
    block(e);
    lastPointer = { x: e.clientX, y: e.clientY };
    updateHover();
  };

  const onScroll = () => updateHover();

  const onKey = (e: KeyboardEvent) => {
    if (!active) return;
    if (e.key === "Escape") {
      block(e);
      teardown();
      send({ type: "overlay/cancelled" });
    }
  };

  const onClick = (e: MouseEvent) => {
    block(e);
    if (!active || e.button !== 0) return;
    const point = { x: e.clientX, y: e.clientY };
    const asPoint = active === "point" || e.altKey || e.shiftKey;
    if (asPoint) {
      void finish({ mode: "point", context: baseContext(), point });
      return;
    }
    const el = underPointer(point.x, point.y);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const rect: Rect = { x: r.left, y: r.top, width: r.width, height: r.height };
    const context = baseContext();
    const text = capText(visibleText(el), MAX_TEXT);
    if (text) context.elementText = text;
    context.elementDescription = describeElement(el);
    void finish({ mode: "element", context, elementRect: rect, point });
  };

  const BLOCKED = ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu", "auxclick", "touchstart", "touchend"];

  const teardown = () => {
    active = null;
    hovered = null;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    for (const t of BLOCKED) window.removeEventListener(t, block, true);
    if (host) {
      try {
        if (host.matches(":popover-open")) host.hidePopover();
      } catch {
        /* popover unsupported */
      }
      host.remove();
    }
    host = null;
    parts = null;
  };

  const finish = async (selection: OverlaySelection) => {
    teardown();
    // Let the page repaint without the overlay before the worker takes the screenshot.
    await nextFrames(2);
    send({ type: "overlay/selected", selection });
  };

  const mount = (mode: MarkKind) => {
    host = document.createElement("div");
    host.setAttribute("data-website-review-overlay", "");
    host.style.cssText = [
      "all: initial",
      "position: fixed",
      "inset: 0",
      "width: 100vw",
      "height: 100vh",
      "max-width: none",
      "max-height: none",
      "margin: 0",
      "padding: 0",
      "border: 0",
      "background: transparent",
      "overflow: visible",
      "display: block",
      "pointer-events: auto",
      `z-index: ${Z}`,
      "cursor: crosshair",
    ]
      .map((d) => `${d} !important`)
      .join(";");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const layer = document.createElement("div");
    layer.className = "layer";
    const box = document.createElement("div");
    box.className = "box";
    const tag = document.createElement("div");
    tag.className = "tag";
    const hline = document.createElement("div");
    hline.className = "hline";
    const vline = document.createElement("div");
    vline.className = "vline";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.setAttribute("role", "status");
    hint.textContent =
      mode === "point"
        ? "Freie Stelle markieren: Stelle anklicken · Esc bricht ab"
        : "Element markieren: Element anklicken · Alt/Umschalt+Klick markiert freie Stelle · Esc bricht ab";
    layer.append(box, tag, hline, vline, hint);
    shadow.append(style, layer);
    parts = { box, tag, hline, vline, hint };
    document.documentElement.append(host);
    // Top layer keeps the overlay above open modal dialogs of the page.
    try {
      host.setAttribute("popover", "manual");
      host.showPopover();
    } catch {
      host.removeAttribute("popover");
    }
  };

  return {
    start(mode) {
      if (active) teardown();
      if (mode === "page") {
        void finish({ mode: "page", context: baseContext() });
        return;
      }
      active = mode;
      mount(mode);
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("click", onClick, true);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("scroll", onScroll, true);
      for (const t of BLOCKED) window.addEventListener(t, block, true);
    },
    cancel() {
      if (!active) return;
      teardown();
    },
  };
}

if (!window.__websiteReviewOverlay) {
  const overlay = createOverlay();
  window.__websiteReviewOverlay = overlay;
  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const msg = raw as WorkerToContent;
    if (msg?.type === "overlay/start") {
      overlay.start(msg.mode);
      sendResponse({ ok: true });
    } else if (msg?.type === "overlay/cancel") {
      overlay.cancel();
      sendResponse({ ok: true });
    }
    return false;
  });
}
