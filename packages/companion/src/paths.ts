import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface CompanionPaths { dataDir: string; configDir: string; runtimeDir: string }

export function getPaths(env: NodeJS.ProcessEnv = process.env): CompanionPaths {
  const xdgData = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), ".local/share");
  const xdgConfig = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  const dataDir = resolve(env.WEBSITE_REVIEW_DATA_DIR || join(xdgData, "website-review"));
  return {
    dataDir,
    runtimeDir: env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR) ? join(env.XDG_RUNTIME_DIR, "website-review") : dataDir,
    configDir: resolve(env.WEBSITE_REVIEW_CONFIG_DIR || join(xdgConfig, "website-review")),
  };
}

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
