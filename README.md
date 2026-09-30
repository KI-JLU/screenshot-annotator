# Website Review

Personal website reviews for an internal team: comment on dev and staging pages in Chrome, let a locally running Codex analyze each comment against your local checkout, and publish the result as cards in [kan.bn](https://kan.bn).

- Product requirements: [`docs/design.md`](docs/design.md) (German)
- Technical decisions: [`docs/architecture.md`](docs/architecture.md)

## Components

| Package | What it does |
| --- | --- |
| `packages/extension` | Chrome MV3 extension. The side panel handles projects, reviews, comments, questions and decisions; an overlay marks an element, a free position or the whole page; screenshot preview with crop. |
| `packages/companion` | Local companion service (`website-review-companion`). Owns the SQLite state, checks checkouts, runs `codex app-server`, provides the read-only `review` MCP gateway to Codex, and publishes to Kan with an operation log and reconciliation. |
| `packages/shared` | Contract between the two: domain types, HTTP API, project config schema, URL rules, states. |

## Requirements

- Linux or macOS, Node.js 24 or newer, Git
- Chrome (or Chromium) with side panel support
- `codex` CLI, logged in (`codex login`). Tested with codex-cli 0.159.2. The companion uses your normal Codex configuration and model.
- A Kan API key (Kan → Settings → API Keys)

## Setup

```bash
npm install
npm run build
node packages/companion/dist/cli.js serve        # listens on 127.0.0.1:47821
```

Load the extension: `chrome://extensions` → enable developer mode → "Load unpacked" → `packages/extension/dist`.

Then connect them:

1. Open the side panel (extension icon). Get a pairing code with `node packages/companion/dist/cli.js pair` and enter it in the panel.
2. Under "Projekte", create a project or import a shared config. Enter the Kan base URL and your API key, then choose workspace, board and list.
3. Map every repository alias to your local checkout and click "Prüfen".
4. Allow the extension access to websites when asked. It needs this for screenshots.

### Run as a systemd user service

```ini
# ~/.config/systemd/user/website-review-companion.service
[Unit]
Description=Website Review companion

[Service]
ExecStart=/usr/bin/env node %h/path/to/ReviewChrome/packages/companion/dist/cli.js serve
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now website-review-companion
```

The unit's PATH must include `codex`. If it doesn't, add `Environment=PATH=…`.

## Usage

1. Open a page that matches a project's URL rules. If several projects match, pick one.
2. Collect comments with "Element markieren", "Freie Stelle markieren" or "Seitenkommentar". Crop the screenshot if needed; the marker must stay inside the crop. Comments from several pages of the same project go into the same review.
3. Click "Review verarbeiten". The companion checks the checkouts, Codex and the Kan target first.
4. Each comment moves through its own states. Clear comments are published automatically; questions, duplicate candidates and merge proposals wait at the comment until you decide.
5. Published comments show the ticket link. Deleting a review removes local data only; Kan cards stay.

## Sharing a project

"Exportieren" writes the shareable config (address rules, Kan target, repository aliases). It never contains tokens, local paths, drafts or screenshots. A teammate imports it, then enters their own Kan key and checkout paths.

## Local data

| What | Where |
| --- | --- |
| Database and screenshots | `$XDG_DATA_HOME/website-review/` (default `~/.local/share/website-review/`) |
| Kan API keys | `$XDG_CONFIG_HOME/website-review/secrets.json` (mode 0600) |

Override both with `WEBSITE_REVIEW_DATA_DIR` and `WEBSITE_REVIEW_CONFIG_DIR`.

## Development

```bash
npm test             # vitest, all packages
npm run typecheck
npm run build
```

Integration checks that use real services:

- `node scripts/smoke-codex.ts <git checkout>` runs one real analysis turn against `codex app-server`.
- `node scripts/e2e-local.mjs <git checkout>` runs the full stack (companion, real Codex, gateway MCP) against the local fake Kan in `scripts/fake-kan.mjs`. It pairs, sets up a project, captures three comments, processes them, answers questions, decides duplicates and prints the resulting Kan state. It needs a prior `npm run build`.
