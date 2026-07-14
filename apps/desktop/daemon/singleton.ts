import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, writeFile, type FileHandle } from "node:fs/promises";
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

  /** Durable P1a generation to inject into every retained work fence. */
  get currentGeneration(): number {
    if (!this.lockHeld || this.generation < 1) throw new DaemonFenceLostError("Supervisor generation is unavailable before the daemon owns its fence.");
    return this.generation;
  }

  async acquire(): Promise<number> {
    assertMacOS(this.platform);
    await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.lockPath), 0o700);
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
    await this.writeGeneration(this.generation);
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
    // Keep the lock inode persistent. Unlinking after releasing flock permits
    // another daemon to lock the old inode while a third creates a new one.
  }

  private async readGeneration(): Promise<number> {
    try {
      const raw = await readFile(this.generationPath, "utf8");
      const value = Number.parseInt(raw.trim(), 10);
      if (!Number.isSafeInteger(value) || value < 0 || raw.trim() !== String(value)) {
        throw new Error("Supervisor generation state is malformed; refusing to roll back fencing.");
      }
      return value;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  private async writeGeneration(generation: number): Promise<void> {
    const temporary = `${this.generationPath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${generation}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.generationPath);
    const directory = await open(dirname(this.generationPath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

export function defaultDaemonPaths(home = process.env.HOME ?? ""): { lockPath: string; socketPath: string; manifestPath: string; auditPath: string } {
  const root = join(home, ".letagents");
  return { lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "daemon-manifest.json"), auditPath: join(root, "daemon-audit.jsonl") };
}
