import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// Keep app imports dynamic: logging must be redirected before any app module runs.
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === "native-host") {
    for (const method of ["log", "info", "warn", "debug"] as const) console[method] = console.error.bind(console);
    const { startNativeHost } = await import("./native/host.ts");
    await startNativeHost(args[1]); return;
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: "boolean" }, browser: { type: "string" }, "extension-id": { type: "string" }, "allow-flatpak-host": { type: "boolean" },
  } });
  const help = "Befehle: native-host, install-native-host [--browser chrome|chromium|chrome-flatpak|chromium-flatpak|all] [--extension-id ID] [--allow-flatpak-host], uninstall-native-host, status, mcp, --help";
  if (values.help || !positionals.length) { console.log(help); return; }
  const command = positionals[0];
  if (command === "mcp") { const { startGateway } = await import("./mcp/gateway.ts"); await startGateway(); return; }
  const { installNativeHost, uninstallNativeHost, browserTargets, flatpakHostAccess, BROWSER_NAMES } = await import("./native/install.ts");
  if (command === "install-native-host") {
    installNativeHost({ browser: values.browser, extensionId: values["extension-id"], allowFlatpakHost: values["allow-flatpak-host"] });
    return;
  }
  if (command === "uninstall-native-host") { uninstallNativeHost(); return; }
  if (command === "status") {
    const { existsSync } = await import("node:fs");
    const { lockHeld } = await import("./native/lock.ts");
    const { getPaths } = await import("./paths.ts");
    const targets = browserTargets();
    for (const name of BROWSER_NAMES) {
      const target = targets[name];
      const installed = existsSync(target.manifest);
      let line = `${name}: Native-Host-Manifest ${installed ? "installiert" : "nicht installiert"} (${target.manifest})`;
      if (installed && target.flatpak) {
        const access = flatpakHostAccess(target.flatpak.app);
        line += access === false ? " – Flatpak-Freigabe für flatpak-spawn fehlt" : access ? " – Flatpak-Freigabe vorhanden" : "";
      }
      console.log(line);
    }
    console.log(`Begleitdienst: Instanzsperre ${lockHeld(getPaths().runtimeDir) ? "belegt" : "frei"}`); return;
  }
  throw new Error(help);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`Begleitdienst konnte nicht gestartet werden: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
