import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 3 * 60_000;

/**
 * Cross-process lock using an atomic mkdir. Every agent spawns its own server process, and those processes share
 * checkouts and install directories, so writes to them must be serialised.
 */
export async function withLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  await mkdir(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = await stat(lockDir).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockDir}`);
      await sleep(150 + Math.random() * 150);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}
