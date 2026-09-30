import { accessSync, chmodSync, constants, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { EXTENSION_ID, NATIVE_HOST_NAME } from "@website-review/shared";
import { ensurePrivateDir, getPaths } from "../paths.ts";

export function browserDirectories(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<"chrome" | "chromium", string> {
  const home = env.HOME || homedir();
  if (platform === "darwin") return { chrome: join(home, "Library/Application Support/Google/Chrome"), chromium: join(home, "Library/Application Support/Chromium") };
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return { chrome: join(config, "google-chrome"), chromium: join(config, "chromium") };
}
export function manifestPaths(): Record<"chrome" | "chromium", string> {
  const dirs = browserDirectories();
  return { chrome: join(dirs.chrome, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`), chromium: join(dirs.chromium, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`) };
}
function findExecutable(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(dir, name);
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; } catch { /* try next PATH entry */ }
  }
  return undefined;
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function installNativeHost(browser?: string, extensionId = EXTENSION_ID, cliPath = process.argv[1]!): void {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error("Ungültige Extension-ID");
  if (browser !== undefined && !["chrome", "chromium", "all"].includes(browser)) throw new Error("Browser muss chrome, chromium oder all sein");
  const dirs = browserDirectories();
  const selected = browser === "all" ? ["chrome", "chromium"] as const : browser ? [browser as "chrome" | "chromium"]
    : (Object.keys(dirs) as (keyof typeof dirs)[]).filter((name) => existsSync(dirs[name]));
  const browsers = selected.length ? selected : ["chrome"] as const;
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
  const manifests = manifestPaths();
  for (const name of browsers) {
    const target = manifests[name]; mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ name: NATIVE_HOST_NAME, description: "Website-Review Begleitdienst", path: launcher, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2) + "\n");
    console.log(`Geschrieben: ${target}`);
  }
}
export function uninstallNativeHost(): void {
  for (const path of [...Object.values(manifestPaths()), join(getPaths().dataDir, "native-host.sh")]) {
    rmSync(path, { force: true }); console.log(`Entfernt: ${path}`);
  }
}
