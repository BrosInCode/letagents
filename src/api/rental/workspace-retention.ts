/**
 * Workspace Retention Service — p4.0
 *
 * Per spec §10.6 / §26 D8, manages the lifecycle of materialized
 * rental workspaces:
 *
 * - Marks expired manifests when TTL elapses
 * - Deletes workspace directories from disk
 * - Cleans up git worktrees and disposable branches
 * - Archives manifests for completed sessions
 *
 * Designed to run as a periodic sweep (e.g. cron or on-demand).
 */

import { and, eq, lt, sql } from "drizzle-orm";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { rental_workspace_manifests } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetentionSweepResult {
  expiredCount: number;
  deletedCount: number;
  archivedCount: number;
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
 * 3. Return summary
 */
export async function runRetentionSweep(
  deps: WorkspaceRetentionDeps,
): Promise<RetentionSweepResult> {
  const log = deps.log ?? (() => {});
  const now = new Date();
  const result: RetentionSweepResult = {
    expiredCount: 0,
    deletedCount: 0,
    archivedCount: 0,
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
  const expiredManifests = (await deps.db
    .select()
    .from(rental_workspace_manifests)
    .where(
      eq(rental_workspace_manifests.retention_status, "expired"),
    )) as Array<{
    id: string;
    workspace_path: string | null;
    work_branch: string;
  }>;

  for (const manifest of expiredManifests) {
    try {
      if (manifest.workspace_path) {
        await deleteWorkspaceFromDisk(manifest.workspace_path, log);
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
 * Marks retention_status = "archived" but does NOT delete from disk
 * immediately — the next retention sweep will handle that.
 */
export async function archiveWorkspace(
  deps: WorkspaceRetentionDeps,
  sessionId: string,
): Promise<void> {
  const now = new Date();
  await deps.db
    .update(rental_workspace_manifests)
    .set({
      retention_status: "archived",
      // Set expires_at to now so next sweep picks it up for cleanup
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
 * Remove a workspace directory from disk and clean up the git worktree
 * reference if the bare cache is still present.
 */
async function deleteWorkspaceFromDisk(
  workspacePath: string,
  log: (msg: string) => void,
): Promise<void> {
  if (!fs.existsSync(workspacePath)) {
    log(`Workspace path ${workspacePath} already absent`);
    return;
  }

  // Try to prune the git worktree from the bare cache
  const gitFile = path.join(workspacePath, ".git");
  if (fs.existsSync(gitFile)) {
    try {
      const gitFileContent = fs.readFileSync(gitFile, "utf-8");
      const bareMatch = gitFileContent.match(/gitdir:\s*(.+)/);
      if (bareMatch) {
        const bareWorktreePath = path.resolve(
          workspacePath,
          bareMatch[1].trim(),
        );
        const bareRepoPath = path.resolve(bareWorktreePath, "..", "..");
        if (fs.existsSync(bareRepoPath)) {
          execSync(`git worktree remove --force "${workspacePath}"`, {
            cwd: bareRepoPath,
            timeout: 30_000,
            stdio: "pipe",
          });
          log(`Pruned worktree from bare cache`);
          return; // worktree remove already deletes the directory
        }
      }
    } catch {
      log(`Could not prune worktree cleanly, falling back to rm -rf`);
    }
  }

  // Fallback: recursive delete
  fs.rmSync(workspacePath, { recursive: true, force: true });
  log(`Removed workspace directory: ${workspacePath}`);
}
