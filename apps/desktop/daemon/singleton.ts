import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import { assertMacOS } from "./platform.js";

export class DaemonFenceLostError extends Error {}
export class DaemonAlreadyRunningError extends Error {}

// Linux CI cannot exercise Darwin's O_EXLOCK directly. Model the ownership
// part of flock in-process while still keeping the lock inode persistent, so
// restart tests have the same acquire -> release -> reacquire semantics as
// production macOS without reintroducing unlink races.
const simulatedFlockOwners = new Set<string>();

/**
 * A daemon-owned lock and durable generation fence. Production macOS uses a
 * kernel flock; injected non-Darwin test hosts model the same ownership over a
 * persistent inode. Every operation verifies the durable generation so an
 * older supervisor exits instead of continuing after a handoff.
 */
export class DaemonSingleton {
  readonly generationPath: string;
  private lockHeld = false;
  private generation = 0;
  private flockHandle: FileHandle | null = null;
  private simulatedFlockHeld = false;

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
      // Darwin flag value; test hosts use the simulated flock owner above.
      const usesDarwinFlock = this.platform === "darwin" && process.platform === "darwin";
      if (usesDarwinFlock) {
        this.flockHandle = await open(
          this.lockPath,
          constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | 0x20 /* O_EXLOCK */,
          0o600,
        );
      } else {
        if (simulatedFlockOwners.has(this.lockPath)) {
          throw new DaemonAlreadyRunningError("A supervisor daemon already owns this host lock.");
        }
        simulatedFlockOwners.add(this.lockPath);
        this.simulatedFlockHeld = true;
        const handle = await open(this.lockPath, "a+", 0o600);
        await handle.close();
      }
      const prior = await this.readGeneration();
      this.generation = prior + 1;
      await this.writeGeneration(this.generation);
      this.lockHeld = true;
      return this.generation;
    } catch (error: unknown) {
      await this.releaseFlockClaim();
      if (error instanceof DaemonAlreadyRunningError) throw error;
      if (["EEXIST", "EAGAIN", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new DaemonAlreadyRunningError("A supervisor daemon already owns this host lock.");
      throw error;
    }
  }

  async assertCurrent(): Promise<void> {
    if (!this.lockHeld || await this.readGeneration() !== this.generation) {
      throw new DaemonFenceLostError("Supervisor generation fence was lost; exiting stale daemon.");
    }
  }

  async release(): Promise<void> {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    await this.releaseFlockClaim();
    // Keep the lock inode persistent. Unlinking after releasing flock permits
    // another daemon to lock the old inode while a third creates a new one.
  }

  private async releaseFlockClaim(): Promise<void> {
    await this.flockHandle?.close();
    this.flockHandle = null;
    if (this.simulatedFlockHeld) simulatedFlockOwners.delete(this.lockPath);
    this.simulatedFlockHeld = false;
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

export function defaultDaemonPaths(home = process.env.HOME ?? ""): { lockPath: string; socketPath: string; manifestPath: string; legacyManifestPath: string; auditPath: string; lifecycleLogPath: string; attemptsPath: string; attemptsRoot: string; workspaceRoot: string; workerBindingsPath: string } {
  const root = join(home, ".letagents");
  return {
    lockPath: join(root, "daemon.lock"),
    socketPath: join(root, "daemon.sock"),
    manifestPath: join(root, "daemon-state.sqlite"),
    legacyManifestPath: join(root, "daemon-manifest.json"),
    auditPath: join(root, "daemon-audit.jsonl"),
    lifecycleLogPath: join(root, "daemon-lifecycle.jsonl"),
    attemptsPath: join(root, "attempts.json"),
    attemptsRoot: join(root, "attempt-data"),
    workspaceRoot: root,
    workerBindingsPath: join(root, "daemon-worker-bindings.json"),
  };
}
