import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { CheckoutStatus } from "@website-review/shared";

const execute = promisify(execFile);
async function git(path: string, args: string[], timeout: number): Promise<string> {
  const result = await execute("git", ["-C", path, ...args], { timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
  return result.stdout.trim();
}

export async function validateCheckout(alias: string, path?: string | null, timeoutMs = 5000): Promise<CheckoutStatus> {
  const status: CheckoutStatus = { alias, path: path ?? null, ok: false };
  if (!path) return { ...status, problem: "Checkout fehlt" };
  if (!isAbsolute(path)) return { ...status, problem: "Absoluter Ordnerpfad erforderlich" };
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return { ...status, problem: "Kein Ordner" };
    await access(path, constants.R_OK | constants.X_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ...status, problem: code === "ENOENT" ? "Ordner fehlt" : "Nicht lesbar" };
  }
  try { await git(path, ["rev-parse", "--show-toplevel"], timeoutMs); }
  catch { return { ...status, problem: "Kein Git-Checkout" }; }
  try {
    const [headCommit, branch, dirty] = await Promise.all([
      git(path, ["rev-parse", "--verify", "HEAD^{commit}"], timeoutMs),
      git(path, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs),
      git(path, ["status", "--porcelain"], timeoutMs),
    ]);
    return { ...status, ok: true, headCommit, branch, hasUncommittedChanges: dirty.length > 0 };
  } catch { return { ...status, problem: "Git-Checkout kann nicht gelesen werden (HEAD fehlt oder Prüfung fehlgeschlagen)" }; }
}
