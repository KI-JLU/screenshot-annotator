import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../paths.ts";

export function lockHeld(runtimeDir: string): boolean {
  try {
    const pid = Number(readFileSync(join(runtimeDir, "companion.lock"), "utf8").trim());
    // An empty lock can belong to a process between O_EXCL and writing its PID.
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export function acquireLock(runtimeDir: string): (() => void) | undefined {
  ensurePrivateDir(runtimeDir);
  const path = join(runtimeDir, "companion.lock");
  for (;;) {
    let fd: number;
    try { fd = openSync(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const before = statSync(path, { throwIfNoEntry: false });
      if (!before) continue;
      if (lockHeld(runtimeDir)) return undefined;
      const after = statSync(path, { throwIfNoEntry: false });
      if (after?.ino === before.ino) { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      continue;
    }
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
    const inode = statSync(path).ino;
    let released = false;
    return () => {
      if (released) return; released = true;
      if (statSync(path, { throwIfNoEntry: false })?.ino === inode) unlinkSync(path);
    };
  }
}
