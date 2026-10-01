# Screenshot Annotator

A Chrome extension that captures a screenshot with your comment on it, for pasting into Claude Code or Codex.

1. Click the toolbar icon or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>.
2. Click an element, or drag to select an area. <kbd>Esc</kbd> cancels.
3. Type a comment and press <kbd>Enter</kbd> (<kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line).
4. Paste into Claude Code or Codex with <kbd>Ctrl</kbd>+<kbd>V</kbd>.

The clipboard gets a PNG and a plain-text version of the same note:

- **Element:** the element with a red outline and some surrounding context. The caption holds your comment, the page URL and a hint like `button#pay.primary "Pay now"`.
- **Area:** exactly the area you dragged. The caption holds your comment and the page URL.

Form fields are described by their label, never by their value.

## Setup

```bash
npm install
npm run build
```

`chrome://extensions` → enable developer mode → "Load unpacked" → `dist/`. Change the shortcut under `chrome://extensions/shortcuts`.

The extension only asks for `activeTab`, `scripting` and `clipboardWrite`. Clicking the icon grants access to the current tab, and that is enough for the screenshot.

## Limits

- Only the visible part of the page is captured. Scroll the element into view first.
- The browser only allows clipboard access on HTTPS and `localhost`. On other plain-HTTP pages the extension shows the image instead: right-click it and choose "Copy image".
- Chrome pages (`chrome://…`, the Web Store) cannot be marked. The icon shows a red `!` in that case.

## Development

```bash
npm test          # vitest: crop geometry and text wrapping
npm run typecheck
npm run build
```
