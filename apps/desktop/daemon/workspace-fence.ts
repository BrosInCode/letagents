import { open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export class WorkspaceFenceError extends Error {}

export type WorkspaceFenceHandle = {
  readonly workspacePath: string;
  readonly owner: string;
  readonly generation: number;
  release: () => Promise<void>;
};

type FenceRecord = { owner: string; generation: number; pid: number; workspace_path: string; created_at: string };

// The fence lives at the daemon worktree root, rather than beside an individual
// worktree.  That is deliberate: a pathname is not an authority.  A single
// supervisor fence prevents an old attempt from replacing a sibling pathname
// while another attempt is being recovered, rebound, or collected.
function fencePath(workspacePath: string): string {
  return join(dirname(dirname(resolve(workspacePath))), ".letagents-supervisor-workspace.fence");
}

function stale(record: FenceRecord): boolean {
  try { process.kill(record.pid, 0); return false; }
  catch (error: unknown) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function readFence(path: string): Promise<FenceRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Partial<FenceRecord>;
    return typeof value.owner === "string" && Number.isInteger(value.generation) && typeof value.pid === "number" && typeof value.workspace_path === "string" && typeof value.created_at === "string"
      ? value as FenceRecord : null;
  } catch { return null; }
}

/**
 * Acquire supervisor-owned authority for workspace mutation.  The returned
 * handle is intentionally retained by the caller across terminal/rebind/spawn
 * handoff; only the holder may release it.  A crashed owner is recovered from
 * its PID-stamped record, while a live owner is never silently stolen.
 */
export async function acquireWorkspaceFence(workspacePath: string, owner: string, generation: number): Promise<WorkspaceFenceHandle> {
  if (!owner.trim() || !Number.isInteger(generation) || generation < 0) throw new WorkspaceFenceError("Fence owner and generation are required.");
  const path = fencePath(workspacePath);
  const record: FenceRecord = { owner, generation, pid: process.pid, workspace_path: resolve(workspacePath), created_at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      let released = false;
      return {
        workspacePath: record.workspace_path, owner, generation,
        release: async () => {
          if (released) return;
          const held = await readFence(path);
          if (!held || held.owner !== owner || held.generation !== generation || held.pid !== process.pid) throw new WorkspaceFenceError("Workspace fence ownership was lost.");
          released = true;
          await rm(path, { force: false });
        },
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = await readFence(path);
      if (held && stale(held)) { await rm(path, { force: true }); continue; }
      throw new WorkspaceFenceError(`Workspace mutation is fenced by ${held?.owner ?? "an unknown owner"}: ${workspacePath}`);
    }
  }
  throw new WorkspaceFenceError(`Could not recover stale workspace fence: ${workspacePath}`);
}

/** Compatibility helper for short provisioning-only critical sections. */
export async function withWorkspaceFence<T>(workspacePath: string, operation: () => Promise<T>): Promise<T> {
  const handle = await acquireWorkspaceFence(workspacePath, `transient-${randomUUID()}`, 0);
  try { return await operation(); }
  finally { await handle.release(); }
}
