import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export class WorkspaceFenceError extends Error {}
export type WorkspaceFenceMode = "shared" | "exclusive";
/**
 * Scope of a fence's authority within a repository worktree namespace:
 *  - "target": authority over ONE workspace path (provisioning a single worktree).
 *  - "repo":   authority over the whole namespace (a live supervisor generation's
 *              retained shared fence, and repository-wide GC's exclusive fence).
 */
export type WorkspaceFenceScope = "target" | "repo";

export type WorkspaceFenceHandle = {
  readonly workspacePath: string;
  readonly owner: string;
  readonly generation: number;
  readonly mode: WorkspaceFenceMode;
  readonly scope: WorkspaceFenceScope;
  release: () => Promise<void>;
};

type FenceRecord = { owner: string; generation: number; pid: number; workspace_path: string; mode: WorkspaceFenceMode; scope: WorkspaceFenceScope; created_at: string };

// A repository worktree root is the smallest namespace in which a worktree
// can be substituted for another valid managed worktree.  Scoping here keeps
// an active agent in repo B from starving safe collection in unrelated repo A.
function rootFor(workspacePath: string): string { return dirname(resolve(workspacePath)); }
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
    if (!(typeof value.owner === "string" && Number.isInteger(value.generation) && typeof value.pid === "number"
      && typeof value.workspace_path === "string" && (value.mode === "shared" || value.mode === "exclusive") && typeof value.created_at === "string")) {
      return null;
    }
    // Records written before scope existed were namespace-wide by construction, so
    // a missing scope reads as "repo" for a safe live upgrade.
    return { ...value, scope: value.scope === "target" ? "target" : "repo" } as FenceRecord;
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
 * Does acquiring `incoming` conflict with an already-live `existing` record?
 *  - A repo-exclusive fence (GC) conflicts with every live record, and nothing may
 *    be acquired while one is held — repository-wide authority/quiescence.
 *  - A target-exclusive fence (provisioning one workspace) conflicts ONLY with
 *    another live record on the same workspace path; sibling workspaces and a live
 *    generation's repo-shared fence do not block it.
 *  - A repo-shared fence (a live supervisor generation) conflicts only with a
 *    repo-exclusive fence, so independent workspaces provision concurrently.
 */
function fenceConflicts(incoming: FenceRecord, existing: FenceRecord): boolean {
  if (incoming.scope === "repo" && incoming.mode === "exclusive") return true;
  if (existing.scope === "repo" && existing.mode === "exclusive") return true;
  if (incoming.mode === "exclusive" && incoming.scope === "target") {
    return resolve(existing.workspace_path) === resolve(incoming.workspace_path);
  }
  return false;
}

/**
 * The daemon uses a retained repo-shared fence for each live supervisor
 * generation, so independent workspaces execute concurrently.  Provisioning a
 * single workspace takes a target-exclusive fence (path-local).  GC takes a
 * repo-exclusive fence, which cannot be granted while any live generation for
 * that repository retains authority.  The tiny mutation lock makes the
 * transition atomic; PID-stamped records make crash recovery explicit and safe.
 */
export async function acquireWorkspaceFence(workspacePath: string, owner: string, generation: number, mode: WorkspaceFenceMode = "shared", scope: WorkspaceFenceScope = "repo"): Promise<WorkspaceFenceHandle> {
  if (!owner.trim() || !Number.isInteger(generation) || generation < 0) throw new WorkspaceFenceError("Fence owner and generation are required.");
  const directory = fenceDirectory(workspacePath);
  const record: FenceRecord = { owner, generation, pid: process.pid, workspace_path: resolve(workspacePath), mode, scope, created_at: new Date().toISOString() };
  const token = randomUUID();
  // Filename prefix stays mode-based (scope lives in the record body) so existing
  // shared/exclusive fence-file counts remain valid.
  const path = join(directory, `${mode}-${token}.json`);
  await withMutationLock(directory, async () => {
    await removeStale(directory);
    const records = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".json")).map(async (name) => readRecord(join(directory, name))));
    const live = records.filter((value): value is FenceRecord => value !== null);
    if (live.some((value) => fenceConflicts(record, value))) {
      throw new WorkspaceFenceError(`Workspace mutation is fenced by a live supervisor generation: ${workspacePath}`);
    }
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  });
  let released = false;
  return {
    workspacePath: record.workspace_path, owner, generation, mode, scope,
    release: async () => {
      if (released) return;
      await withMutationLock(directory, async () => {
        const held = await readRecord(path);
        if (!held || held.owner !== owner || held.generation !== generation || held.pid !== process.pid || held.mode !== mode || held.scope !== scope) throw new WorkspaceFenceError("Workspace fence ownership was lost.");
        await rm(path, { force: false });
        released = true;
      });
    },
  };
}

/** Compatibility helper for a short, target-local exclusive provisioning section. */
export async function withWorkspaceFence<T>(workspacePath: string, operation: () => Promise<T>): Promise<T> {
  const handle = await acquireWorkspaceFence(workspacePath, `transient-${randomUUID()}`, 0, "exclusive", "target");
  try { return await operation(); }
  finally { await handle.release(); }
}
