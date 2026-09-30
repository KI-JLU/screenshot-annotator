import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { EXTENSION_ID, NATIVE_HOST_NAME } from "@website-review/shared";
import { ensurePrivateDir, getPaths } from "../paths.ts";

export type BrowserName = "chrome" | "chromium" | "chrome-flatpak" | "chromium-flatpak";
export const BROWSER_NAMES: readonly BrowserName[] = ["chrome", "chromium", "chrome-flatpak", "chromium-flatpak"];
/** Flatpak app ids of the browsers we support; their config lives under ~/.var/app/<id>/config. */
export const FLATPAK_APPS = { "chrome-flatpak": "com.google.Chrome", "chromium-flatpak": "org.chromium.Chromium" } as const;

export interface BrowserTarget {
  name: BrowserName;
  /** Browser profile root; its existence means the browser is installed for this user. */
  configDir: string;
  manifest: string;
  /** Set for Flatpak browsers: the host must be started through flatpak-spawn from inside the sandbox. */
  flatpak?: { app: string; appDir: string; wrapper: string };
}

export function browserTargets(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<BrowserName, BrowserTarget> {
  const home = env.HOME || homedir();
  const manifestIn = (configDir: string) => join(configDir, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
  const plain = (name: BrowserName, configDir: string): BrowserTarget => ({ name, configDir, manifest: manifestIn(configDir) });
  const flatpak = (name: keyof typeof FLATPAK_APPS, profile: string): BrowserTarget => {
    const app = FLATPAK_APPS[name];
    const appDir = join(home, ".var/app", app);
    // ~/.var/app/<id> is mounted at the same path inside the sandbox, so the wrapper is reachable from there.
    return { name, configDir: join(appDir, "config", profile), manifest: manifestIn(join(appDir, "config", profile)),
      flatpak: { app, appDir, wrapper: join(appDir, "data", "website-review", "native-host-flatpak.sh") } };
  };
  if (platform === "darwin") {
    return {
      chrome: plain("chrome", join(home, "Library/Application Support/Google/Chrome")),
      chromium: plain("chromium", join(home, "Library/Application Support/Chromium")),
      "chrome-flatpak": flatpak("chrome-flatpak", "google-chrome"),
      "chromium-flatpak": flatpak("chromium-flatpak", "chromium"),
    };
  }
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return {
    chrome: plain("chrome", join(config, "google-chrome")),
    chromium: plain("chromium", join(config, "chromium")),
    "chrome-flatpak": flatpak("chrome-flatpak", "google-chrome"),
    "chromium-flatpak": flatpak("chromium-flatpak", "chromium"),
  };
}
export function browserDirectories(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<"chrome" | "chromium", string> {
  const targets = browserTargets(env, platform);
  return { chrome: targets.chrome.configDir, chromium: targets.chromium.configDir };
}
export function manifestPaths(): Record<BrowserName, string> {
  const targets = browserTargets();
  return Object.fromEntries(BROWSER_NAMES.map((name) => [name, targets[name].manifest])) as Record<BrowserName, string>;
}

/**
 * Flatpak browsers may only start processes outside their sandbox via flatpak-spawn --host, which needs
 * D-Bus access to org.freedesktop.Flatpak. Returns undefined when `flatpak` itself is unavailable.
 */
export function flatpakHostAccess(app: string): boolean | undefined {
  try {
    const out = execFileSync("flatpak", ["info", "--show-permissions", app], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    return /^org\.freedesktop\.Flatpak=talk$/m.test(out);
  } catch {
    return undefined;
  }
}
const FLATPAK_GRANT = (app: string) => `flatpak override --user --talk-name=org.freedesktop.Flatpak ${app}`;

function findExecutable(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(dir, name);
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; } catch { /* try next PATH entry */ }
  }
  return undefined;
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export interface InstallOptions {
  browser?: string;
  extensionId?: string;
  cliPath?: string;
  /** Grant Flatpak browsers the D-Bus access flatpak-spawn --host needs (flatpak override --user). */
  allowFlatpakHost?: boolean;
}

export function installNativeHost(options: InstallOptions = {}): void {
  const { browser, extensionId = EXTENSION_ID, cliPath = process.argv[1]!, allowFlatpakHost = false } = options;
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error("Ungültige Extension-ID");
  if (browser !== undefined && browser !== "all" && !BROWSER_NAMES.includes(browser as BrowserName)) {
    throw new Error(`Browser muss ${BROWSER_NAMES.join(", ")} oder all sein`);
  }
  const targets = browserTargets();
  const detected = BROWSER_NAMES.filter((name) => existsSync(targets[name].flatpak?.appDir ?? targets[name].configDir));
  const browsers: BrowserName[] = browser === "all" ? [...BROWSER_NAMES] : browser ? [browser as BrowserName] : detected.length ? detected : ["chrome"];
  const { dataDir } = getPaths(); ensurePrivateDir(dataDir);
  const launcher = join(dataDir, "native-host.sh");
  const codex = findExecutable("codex");
  if (!codex) console.warn("Warnung: codex wurde nicht auf PATH gefunden.");
  const path = [...new Set([dirname(process.execPath), ...(codex ? [dirname(codex)] : [])])].join(delimiter);
  // Chrome starts the host with the desktop session's environment, so pin what was in effect at install time:
  // the allowed extension id, Codex's config home and any overridden data/config/runtime dirs.
  const pinned: Record<string, string> = { WEBSITE_REVIEW_EXTENSION_ID: extensionId };
  for (const name of ["CODEX_HOME", "WEBSITE_REVIEW_DATA_DIR", "WEBSITE_REVIEW_CONFIG_DIR"]) {
    const value = process.env[name];
    if (value) pinned[name] = resolve(value);
  }
  const exports = Object.entries(pinned).map(([name, value]) => `export ${name}=${quote(value)}\n`).join("");
  writeFileSync(launcher, `#!/bin/sh\nexport PATH=${quote(path)}:"$PATH"\n${exports}exec ${quote(process.execPath)} ${quote(resolve(cliPath))} native-host "$@"\n`, { mode: 0o755 });
  chmodSync(launcher, 0o755); console.log(`Geschrieben: ${launcher}`);
  for (const name of browsers) {
    const target = targets[name];
    let hostPath = launcher;
    if (target.flatpak) {
      // Runs inside the sandbox, which cannot see the repository or the host's node; start the launcher outside it.
      // --watch-bus ends the host process when the browser side of the connection goes away.
      mkdirSync(dirname(target.flatpak.wrapper), { recursive: true });
      writeFileSync(target.flatpak.wrapper, `#!/bin/sh\nexec /usr/bin/flatpak-spawn --host --watch-bus ${quote(launcher)} "$@"\n`, { mode: 0o755 });
      chmodSync(target.flatpak.wrapper, 0o755); console.log(`Geschrieben: ${target.flatpak.wrapper}`);
      hostPath = target.flatpak.wrapper;
    }
    mkdirSync(dirname(target.manifest), { recursive: true });
    writeFileSync(target.manifest, JSON.stringify({ name: NATIVE_HOST_NAME, description: "Website-Review Begleitdienst", path: hostPath, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2) + "\n");
    console.log(`Geschrieben: ${target.manifest}`);
    if (target.flatpak) ensureFlatpakHostAccess(target.flatpak.app, allowFlatpakHost);
  }
}

function ensureFlatpakHostAccess(app: string, allow: boolean): void {
  const access = flatpakHostAccess(app);
  if (access === true) { console.log(`Flatpak ${app}: Zugriff auf flatpak-spawn --host ist erlaubt.`); return; }
  if (access === undefined) { console.warn(`Warnung: Berechtigungen von ${app} konnten nicht geprüft werden (flatpak nicht verfügbar?).`); return; }
  if (allow) {
    execFileSync("flatpak", ["override", "--user", "--talk-name=org.freedesktop.Flatpak", app], { stdio: "inherit" });
    console.log(`Flatpak ${app}: Zugriff auf org.freedesktop.Flatpak erteilt. Browser neu starten.`);
    return;
  }
  console.warn([
    `Achtung: ${app} läuft in einer Flatpak-Sandbox und darf den Begleitdienst noch nicht starten.`,
    "Dafür braucht der Browser Zugriff auf org.freedesktop.Flatpak. Damit kann Code aus dem Browser Befehle außerhalb",
    "der Sandbox ausführen; die Sandbox schützt dann nicht mehr vor einem kompromittierten Browser.",
    `Freigeben:   ${FLATPAK_GRANT(app)}   (oder install-native-host --allow-flatpak-host)`,
    `Rücknehmen:  flatpak override --user --no-talk-name=org.freedesktop.Flatpak ${app}`,
    "Danach den Browser vollständig beenden und neu starten.",
  ].join("\n"));
}
export function uninstallNativeHost(): void {
  const targets = browserTargets();
  const paths = [...BROWSER_NAMES.flatMap((name) => [targets[name].manifest, ...(targets[name].flatpak ? [targets[name].flatpak!.wrapper] : [])]),
    join(getPaths().dataDir, "native-host.sh")];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    rmSync(path, { force: true }); console.log(`Entfernt: ${path}`);
  }
}
