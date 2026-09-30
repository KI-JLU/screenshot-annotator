import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { newId } from "../ids.ts";
import { ensurePrivateDir } from "../paths.ts";
import { HttpError } from "../http/errors.ts";

export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new HttpError(400, "validation", "Ungültige Kan-Adresse"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new HttpError(400, "validation", "Ungültige Kan-Adresse");
  }
  return url.toString().replace(/\/+$/, "");
}

/** Tokens stay in this file. Callers expose only configured/valid flags. */
export class Secrets {
  readonly filename: string;
  constructor(readonly configDir: string) {
    ensurePrivateDir(configDir);
    this.filename = join(configDir, "secrets.json");
    if (!existsSync(this.filename)) this.write({});
    chmodSync(this.filename, 0o600);
  }
  private read(): Record<string, string> {
    return z.record(z.string()).parse(JSON.parse(readFileSync(this.filename, "utf8")));
  }
  private write(secrets: Record<string, string>): void {
    const temporary = join(this.configDir, `.secrets-${newId()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.filename);
    } finally { rmSync(temporary, { force: true }); }
  }
  get(baseUrl: string): string | undefined { return this.read()[normalizeBaseUrl(baseUrl)]; }
  set(baseUrl: string, token: string): void {
    const secrets = this.read();
    secrets[normalizeBaseUrl(baseUrl)] = token;
    this.write(secrets);
  }
  listBaseUrls(): string[] { return Object.keys(this.read()).sort(); }
}
