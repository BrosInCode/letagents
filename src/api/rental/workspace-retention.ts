/**
 * Workspace Retention Service — p4.0
 *
 * Per spec §10.6 / §26 D8, manages the lifecycle of materialized
 * rental workspaces:
 *
 * - Marks expired manifests when TTL elapses
 * - Deletes workspace directories from disk
 * - Processes archived manifests (session complete → cleanup)
 *
 * Designed to run as a periodic sweep (e.g. cron or on-demand).
 *
 * Review feedback applied:
 * - archiveWorkspace sets status to "expired" directly (not "archived")
 *   so retention sweep will pick it up and delete from disk
 * - No git worktree pruning needed (materializer uses git archive)
 */

import { and, eq, lt, or } from "drizzle-orm";
import * as fs from "fs";
import { rental_workspace_manifests } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetentionSweepResult {
  expiredCount: number;
  deletedCount: number;
  errors: Array<{ manifestId: string; error: string }>;
}

export interface WorkspaceRetentionDeps {
  db: {
    update: (table: typeof rental_workspace_manifests) => {
      set: (v: unknown) => { where: (c: unknown) => Promise<unknown> };
    };
    select: () => {
      from: (table: typeof rental_workspace_manifests) => {
        where: (c: unknown) => Promise<unknown[]>;
      };
    };
  };
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Retention sweep
// ---------------------------------------------------------------------------

/**
 * Run a full retention sweep:
 *
 * 1. Find all "active" manifests past their expires_at → mark "expired"
 * 2. Find all "expired" manifests → delete workspace from disk → mark "deleted"
 *
 * Note: archiveWorkspace() now sets status directly to "expired" with
 * expires_at = now, so archived sessions are picked up in step 1/2.
 */
export async function runRetentionSweep(
  deps: WorkspaceRetentionDeps,
): Promise<RetentionSweepResult> {
  const log = deps.log ?? (() => {});
  const now = new Date();
  const result: RetentionSweepResult = {
    expiredCount: 0,
    deletedCount: 0,
    errors: [],
  };

  // Step 1: Mark active → expired where TTL has elapsed
  log("Retention sweep: checking for expired workspaces");
  const activeExpired = (await deps.db
    .select()
    .from(rental_workspace_manifests)
    .where(
      and(
        eq(rental_workspace_manifests.retention_status, "active"),
        lt(rental_workspace_manifests.expires_at, now),
      ),
    )) as Array<{ id: string; workspace_path: string | null }>;

  for (const manifest of activeExpired) {
    try {
      await deps.db
        .update(rental_workspace_manifests)
        .set({
          retention_status: "expired",
          updated_at: now,
        })
        .where(eq(rental_workspace_manifests.id, manifest.id));
      result.expiredCount++;
      log(`Marked ${manifest.id} as expired`);
    } catch (err) {
      result.errors.push({
        manifestId: manifest.id,
        error: `Failed to mark expired: ${err}`,
      });
    }
  }

  // Step 2: Delete expired workspaces from disk
  // This catches both TTL-expired and archive-expired manifests
  const expiredManifests = (await deps.db
    .select()
    .from(rental_workspace_manifests)
    .where(
      eq(rental_workspace_manifests.retention_status, "expired"),
    )) as Array<{
    id: string;
    workspace_path: string | null;
  }>;

  for (const manifest of expiredManifests) {
    try {
      if (manifest.workspace_path) {
        deleteWorkspaceFromDisk(manifest.workspace_path, log);
      }

      await deps.db
        .update(rental_workspace_manifests)
        .set({
          retention_status: "deleted",
          deleted_at: now,
          updated_at: now,
        })
        .where(eq(rental_workspace_manifests.id, manifest.id));
      result.deletedCount++;
      log(`Deleted workspace for ${manifest.id}`);
    } catch (err) {
      result.errors.push({
        manifestId: manifest.id,
        error: `Failed to delete: ${err}`,
      });
    }
  }

  return result;
}

/**
 * Archive a workspace manifest (e.g. when a session completes).
 * Sets retention_status = "expired" and expires_at = now so the
 * next retention sweep will delete it from disk.
 *
 * Fixed per review: previously set "archived" status which the sweep
 * never processed, leaving workspaces on disk forever.
 */
export async function archiveWorkspace(
  deps: WorkspaceRetentionDeps,
  sessionId: string,
): Promise<void> {
  const now = new Date();
  await deps.db
    .update(rental_workspace_manifests)
    .set({
      retention_status: "expired",
      expires_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(rental_workspace_manifests.session_id, sessionId),
        eq(rental_workspace_manifests.retention_status, "active"),
      ),
    );
}

// ---------------------------------------------------------------------------
// Disk cleanup
// ---------------------------------------------------------------------------

/**
 * Remove a workspace directory from disk.
 * Since the materializer uses git archive (no .git dir, no worktree),
 * cleanup is a simple recursive delete.
 */
function deleteWorkspaceFromDisk(
  workspacePath: string,
  log: (msg: string) => void,
): void {
  if (!fs.existsSync(workspacePath)) {
    log(`Workspace path ${workspacePath} already absent`);
    return;
  }

  fs.rmSync(workspacePath, { recursive: true, force: true });
  log(`Removed workspace directory: ${workspacePath}`);
}
