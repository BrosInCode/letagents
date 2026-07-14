import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export class WorkspaceFenceError extends Error {}
export type WorkspaceFenceMode = "shared" | "exclusive";

export type WorkspaceFenceHandle = {
  readonly workspacePath: string;
  readonly owner: string;
  readonly generation: number;
  readonly mode: WorkspaceFenceMode;
  release: () => Promise<void>;
};

type FenceRecord = { owner: string; generation: number; pid: number; workspace_path: string; mode: WorkspaceFenceMode; created_at: string };

function rootFor(workspacePath: string): string { return dirname(dirname(resolve(workspacePath))); }
function fenceDirectory(workspacePath: string): string { return join(rootFor(workspacePath), ".letagents-supervisor-workspace.fences"); }
function stale(record: FenceRecord): boolean {
  try { process.kill(record.pid, 0); return false; }
  catch (error: unknown) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
async function readRecord(path: string): Promise<FenceRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Partial<FenceRecord>;
    return typeof value.owner === "string" && Number.isInteger(value.generation) && typeof value.pid === "number"
      && typeof value.workspace_path === "string" && (value.mode === "shared" || value.mode === "exclusive") && typeof value.created_at === "string"
      ? value as FenceRecord : null;
  } catch { return null; }
}

async function withMutationLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, ".mutation.lock");
  for (let tries = 0; tries < 32; tries += 1) {
    try {
      const handle = await open(lock, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync(); return await operation(); }
      finally { await handle.close(); await rm(lock, { force: true }); }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const value: unknown = JSON.parse(await readFile(lock, "utf8"));
        const pid = value && typeof value === "object" ? (value as { pid?: unknown }).pid : undefined;
        if (typeof pid === "number") { try { process.kill(pid, 0); } catch (inner: unknown) { if ((inner as NodeJS.ErrnoException).code === "ESRCH") { await rm(lock, { force: true }); continue; } } }
      } catch { await rm(lock, { force: true }); continue; }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw new WorkspaceFenceError("Could not acquire workspace-fence mutation lock.");
}

async function removeStale(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (name === ".mutation.lock") continue;
    const path = join(directory, name);
    const record = await readRecord(path);
    if (!record || stale(record)) await rm(path, { force: true });
  }
}

/**
 * The daemon uses a retained shared fence for each live supervisor generation,
 * so independent workspaces execute concurrently.  GC takes an exclusive
 * fence, which cannot be granted while *any* live generation retains shared
 * authority.  The tiny mutation lock makes the shared/exclusive transition
 * atomic; PID-stamped records make crash recovery explicit and safe.
 */
export async function acquireWorkspaceFence(workspacePath: string, owner: string, generation: number, mode: WorkspaceFenceMode = "shared"): Promise<WorkspaceFenceHandle> {
  if (!owner.trim() || !Number.isInteger(generation) || generation < 0) throw new WorkspaceFenceError("Fence owner and generation are required.");
  const directory = fenceDirectory(workspacePath);
  const record: FenceRecord = { owner, generation, pid: process.pid, workspace_path: resolve(workspacePath), mode, created_at: new Date().toISOString() };
  const token = randomUUID();
  const path = join(directory, `${mode}-${token}.json`);
  await withMutationLock(directory, async () => {
    await removeStale(directory);
    const records = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".json")).map(async (name) => readRecord(join(directory, name))));
    const live = records.filter((value): value is FenceRecord => value !== null);
    if (mode === "shared" ? live.some((value) => value.mode === "exclusive") : live.length > 0) {
      throw new WorkspaceFenceError(`Workspace mutation is fenced by a live supervisor generation: ${workspacePath}`);
    }
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  });
  let released = false;
  return {
    workspacePath: record.workspace_path, owner, generation, mode,
    release: async () => {
      if (released) return;
      await withMutationLock(directory, async () => {
        const held = await readRecord(path);
        if (!held || held.owner !== owner || held.generation !== generation || held.pid !== process.pid || held.mode !== mode) throw new WorkspaceFenceError("Workspace fence ownership was lost.");
        await rm(path, { force: false });
        released = true;
      });
    },
  };
}

/** Compatibility helper for short, exclusive provisioning/GC sections. */
export async function withWorkspaceFence<T>(workspacePath: string, operation: () => Promise<T>): Promise<T> {
  const handle = await acquireWorkspaceFence(workspacePath, `transient-${randomUUID()}`, 0, "exclusive");
  try { return await operation(); }
  finally { await handle.release(); }
}
