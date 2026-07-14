import { constants } from "node:fs";
import { mkdir, open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import { assertMacOS } from "./platform.js";

export class DaemonFenceLostError extends Error {}
export class DaemonAlreadyRunningError extends Error {}

/**
 * A daemon-owned lock and durable generation fence. The exclusive create is
 * the portable Node representation of the macOS lock-file flock contract:
 * only one process can acquire it, and every operation must verify the durable
 * generation so an older supervisor exits instead of continuing after a handoff.
 */
export class DaemonSingleton {
  readonly generationPath: string;
  private lockHeld = false;
  private generation = 0;
  private flockHandle: FileHandle | null = null;

  constructor(readonly lockPath: string, private readonly platform = process.platform) {
    this.generationPath = `${lockPath}.generation`;
  }

  async acquire(): Promise<number> {
    assertMacOS(this.platform);
    await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    try {
      // Darwin's O_EXLOCK is the kernel flock primitive. O_NONBLOCK makes a
      // competing daemon fail immediately instead of waiting behind a stale
      // supervisor. Node does not expose O_EXLOCK, so this is the documented
      // Darwin flag value; test hosts use the atomic-create equivalent.
      const usesDarwinFlock = this.platform === "darwin" && process.platform === "darwin";
      const flags = usesDarwinFlock
        ? constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | 0x20 /* O_EXLOCK */
        : "wx";
      const handle = await open(this.lockPath, flags, 0o600);
      if (usesDarwinFlock) this.flockHandle = handle;
      else await handle.close();
    } catch (error: unknown) {
      if (["EEXIST", "EAGAIN", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new DaemonAlreadyRunningError("A supervisor daemon already owns this host lock.");
      throw error;
    }
    const prior = await this.readGeneration();
    this.generation = prior + 1;
    await writeFile(this.generationPath, `${this.generation}\n`, { mode: 0o600 });
    this.lockHeld = true;
    return this.generation;
  }

  async assertCurrent(): Promise<void> {
    if (!this.lockHeld || await this.readGeneration() !== this.generation) {
      throw new DaemonFenceLostError("Supervisor generation fence was lost; exiting stale daemon.");
    }
  }

  async release(): Promise<void> {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    await this.flockHandle?.close();
    this.flockHandle = null;
    await unlink(this.lockPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  private async readGeneration(): Promise<number> {
    try {
      const raw = await readFile(this.generationPath, "utf8");
      const value = Number.parseInt(raw.trim(), 10);
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }
}

export function defaultDaemonPaths(home = process.env.HOME ?? ""): { lockPath: string; socketPath: string; manifestPath: string; auditPath: string } {
  const root = join(home, ".letagents");
  return { lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "daemon-manifest.json"), auditPath: join(root, "daemon-audit.jsonl") };
}
