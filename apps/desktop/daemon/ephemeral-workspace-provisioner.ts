import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, opendir, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { WORKSPACE_MARKER, type WorkspaceMarker } from "./workspace-provisioner.js";

const EPHEMERAL_REMOTE_PREFIX = "letagents-ephemeral:";
const EMPTY_REVISION = "0".repeat(40);
const EPHEMERAL_REPO = "room-only";

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function isEphemeralWorkspaceMarker(
  marker: Pick<WorkspaceMarker, "remote_url" | "resolved_revision" | "bare_path">,
): boolean {
  return marker.remote_url.startsWith(EPHEMERAL_REMOTE_PREFIX)
    && marker.resolved_revision === EMPTY_REVISION;
}

/** Private, intentionally non-Git cwd for a room-only supervised agent. */
export class EphemeralWorkspaceProvisioner {
  constructor(private readonly root: string) {}

  async provision(input: {
    workAttemptId: string;
    taskId: string;
  }): Promise<{ path: string; reused: boolean; identity: WorkspaceMarker }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.workAttemptId)) {
      throw new Error("Work attempt IDs must be supervisor-minted UUIDs.");
    }
    if (!input.taskId.trim()) throw new Error("A task ID is required for an ephemeral workspace.");

    const canonicalRoot = await this.canonicalRoot();
    const parent = resolve(canonicalRoot, "worktrees", EPHEMERAL_REPO);
    if (!inside(canonicalRoot, parent)) throw new Error("Ephemeral workspace escaped the daemon root.");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);

    const path = resolve(parent, input.workAttemptId);
    if (!inside(parent, path)) throw new Error("Ephemeral workspace escaped its private parent.");
    let reused = true;
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Ephemeral workspace path is unsafe.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(path, { mode: 0o700 });
      reused = false;
    }
    await chmod(path, 0o700);

    const canonicalPath = await realpath(path);
    if (!inside(await realpath(parent), canonicalPath)) throw new Error("Ephemeral workspace resolved outside its private parent.");
    const identity: WorkspaceMarker = {
      version: 1,
      repo: EPHEMERAL_REPO,
      work_attempt_id: input.workAttemptId,
      task_id: input.taskId,
      remote_url: `${EPHEMERAL_REMOTE_PREFIX}${createHash("sha256").update(input.taskId).digest("hex")}`,
      resolved_revision: EMPTY_REVISION,
      // Compatibility identity only; no Git common directory exists.
      bare_path: canonicalPath,
    };
    const markerPath = join(canonicalPath, WORKSPACE_MARKER);
    if (reused) {
      const existing = await this.readMarker(markerPath);
      if (JSON.stringify(existing) !== JSON.stringify(identity)) {
        throw new Error("Ephemeral workspace identity does not match its work attempt.");
      }
    } else {
      await this.writeMarker(markerPath, identity);
    }
    return { path: canonicalPath, reused, identity };
  }

  /** Remove crash-orphaned room-only directories that have no durable attempt. */
  async garbageCollectOrphans(retainedAttemptIds: ReadonlySet<string>): Promise<string[]> {
    const canonicalRoot = await this.canonicalRoot();
    const parent = resolve(canonicalRoot, "worktrees", EPHEMERAL_REPO);
    let parentInfo;
    try { parentInfo = await lstat(parent); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new Error("Ephemeral workspace parent is unsafe.");
    }
    const canonicalParent = await realpath(parent);
    if (!inside(canonicalRoot, canonicalParent)) throw new Error("Ephemeral workspace parent escaped the daemon root.");

    const removed: string[] = [];
    const entries = await opendir(canonicalParent);
    for await (const entry of entries) {
      const workAttemptId = entry.name;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workAttemptId)
        || retainedAttemptIds.has(workAttemptId)) continue;
      const candidate = resolve(canonicalParent, workAttemptId);
      if (!inside(canonicalParent, candidate)) continue;
      const candidateInfo = await lstat(candidate);
      if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink()) continue;
      const canonicalCandidate = await realpath(candidate);
      if (!inside(canonicalParent, canonicalCandidate)) continue;

      const childNames: string[] = [];
      const children = await opendir(canonicalCandidate);
      for await (const child of children) childNames.push(child.name);
      const markerPath = join(canonicalCandidate, WORKSPACE_MARKER);
      let safeToDelete = childNames.length === 0;
      if (childNames.includes(WORKSPACE_MARKER)) {
        const markerInfo = await lstat(markerPath);
        if (markerInfo.isFile() && !markerInfo.isSymbolicLink()) {
          try {
            const marker = await this.readMarker(markerPath);
            safeToDelete = marker.version === 1
              && marker.repo === EPHEMERAL_REPO
              && marker.work_attempt_id === workAttemptId
              && isEphemeralWorkspaceMarker(marker)
              && resolve(marker.bare_path) === canonicalCandidate;
          } catch {
            safeToDelete = false;
          }
        }
      } else if (childNames.length > 0) {
        // A crash between writing and renaming the marker leaves only the
        // provisioner's exact temporary regular file; arbitrary contents fail closed.
        safeToDelete = childNames.every((name) =>
          new RegExp(`^${WORKSPACE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[0-9]+\\.[0-9a-f-]{36}\\.tmp$`, "i").test(name)
        );
        if (safeToDelete) {
          for (const name of childNames) {
            const info = await lstat(join(canonicalCandidate, name));
            if (!info.isFile() || info.isSymbolicLink()) { safeToDelete = false; break; }
          }
        }
      }
      if (!safeToDelete) continue;
      await rm(canonicalCandidate, { recursive: true, force: false });
      removed.push(workAttemptId);
    }
    return removed;
  }

  private async canonicalRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Daemon root must be a non-symlink directory.");
    return realpath(this.root);
  }

  private async writeMarker(path: string, marker: WorkspaceMarker): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async readMarker(path: string): Promise<WorkspaceMarker> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error("Ephemeral workspace marker is missing or invalid.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Ephemeral workspace marker is missing or invalid.");
    }
    return parsed as WorkspaceMarker;
  }
}
