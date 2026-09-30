# Website Review

Personal website reviews for an internal team: comment on dev and staging pages in Chrome, let a locally running Codex analyze each comment against your local checkout, and publish the result as cards in [kan.bn](https://kan.bn).

- Product requirements: [`docs/design.md`](docs/design.md) (German)
- Technical decisions: [`docs/architecture.md`](docs/architecture.md)

## Components

| Package | What it does |
| --- | --- |
| `packages/extension` | Chrome MV3 extension. The side panel handles projects, reviews, comments, questions and decisions; an overlay marks an element, a free position or the whole page; screenshot preview with crop. |
| `packages/companion` | Local companion (`website-review-companion`), started by Chrome via Native Messaging. Owns the SQLite state, checks checkouts, runs `codex app-server`, provides the read-only `review` MCP gateway to Codex, and publishes to Kan with an operation log and reconciliation. |
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
node packages/companion/dist/cli.js install-native-host   # registers the companion with Chrome/Chromium
```

Load the extension: `chrome://extensions` → enable developer mode → "Load unpacked" → `packages/extension/dist`. The extension id is fixed (`ncgffplfgbdklhlkklkfefbennjdbnko`) and must match the one the host manifest allows.

There is no service to start and nothing to pair. Opening the side panel makes Chrome start the companion; it runs while Chrome is open.

1. Open the side panel (extension icon). It should show "Begleitdienst verbunden".
2. Under "Projekte", create a project or import a shared config. Enter the Kan base URL and your API key, then choose workspace, board and list.
3. Map every repository alias to your local checkout and click "Prüfen".
4. Allow the extension access to websites when asked. It needs this for screenshots.

### Chrome or Chromium as Flatpak

A Flatpak browser only reads host manifests under `~/.var/app/<app-id>/config/…` and cannot see your repository or the host's `node`. `install-native-host` detects `com.google.Chrome` and `org.chromium.Chromium` and installs a small wrapper inside the sandbox directory that starts the real launcher with `flatpak-spawn --host`. For that, the browser needs D-Bus access to `org.freedesktop.Flatpak`:

```bash
flatpak override --user --talk-name=org.freedesktop.Flatpak com.google.Chrome   # or: install-native-host --allow-flatpak-host
flatpak kill com.google.Chrome                                                  # then start Chrome again
```

This lets code running in the browser start commands outside the sandbox, so the Flatpak sandbox no longer protects against a compromised browser. Undo it with `flatpak override --user --no-talk-name=org.freedesktop.Flatpak com.google.Chrome`. The alternative is a non-Flatpak Chrome (RPM/DEB), which needs neither the wrapper nor the permission.

`install-native-host` records the absolute paths of `node` and `codex` at install time. Run it again after moving the repository or changing your Node or Codex installation. `uninstall-native-host` removes the registration, and `status` shows what is installed.

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
- `node scripts/e2e-local.mjs <git checkout>` runs the full stack (native host, real Codex, gateway MCP) against the local fake Kan in `scripts/fake-kan.mjs`. It speaks the native-messaging framing directly, sets up a project, captures three comments, processes them, answers questions, decides duplicates and prints the resulting Kan state. It needs a prior `npm run build`.
