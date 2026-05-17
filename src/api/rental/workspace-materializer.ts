/**
 * Scoped Workspace Materializer — p4.0
 *
 * Creates disposable, scope-filtered workspaces for rental sessions.
 * Per spec §10.6, materializes a git worktree from a base commit,
 * applies scope glob filters, and records a manifest row.
 *
 * The materializer is invoked when a rental session transitions to
 * "accepted" — the provider's agent gets a filtered checkout of the
 * renter's repo limited to the agreed scope globs.
 */

import { eq } from "drizzle-orm";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { rental_workspace_manifests } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Simple glob matching (avoids external dependency)
// ---------------------------------------------------------------------------

/**
 * Simple glob pattern matcher supporting:
 * - `*` matches any characters except `/`
 * - `**` matches any characters including `/`
 * - `?` matches a single non-`/` character
 */
function simpleGlobMatch(pattern: string, filepath: string): boolean {
  // Convert glob pattern to regex
  let regexStr = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches everything including /
        if (pattern[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        // * matches everything except /
        regexStr += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
      i++;
    } else if (ch === ".") {
      regexStr += "\\.";
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }
  regexStr += "$";

  return new RegExp(regexStr).test(filepath);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaterializeWorkspaceInput {
  /** rental_sessions.id */
  sessionId: string;
  /** URL or local path to the renter's git repo. */
  repoUrl: string;
  /** SHA to check out as the base for the rental workspace. */
  baseCommitSha: string;
  /**
   * Minimatch glob patterns that define which files are exposed.
   * Empty array = full repo (Trusted Open Mode).
   */
  scopeGlobs: string[];
  /** Optional override for the workspace root directory. */
  workspaceRoot?: string;
  /** TTL in hours before the workspace expires. Default: 24. */
  ttlHours?: number;
}

export interface MaterializeWorkspaceResult {
  manifestId: string;
  workspacePath: string;
  workBranch: string;
  filesMaterialized: number;
  bytesMaterialized: number;
}

export interface WorkspaceMaterializerDeps {
  db: {
    insert: (table: typeof rental_workspace_manifests) => {
      values: (v: unknown) => { returning: () => Promise<unknown[]> };
    };
    update: (table: typeof rental_workspace_manifests) => {
      set: (v: unknown) => { where: (c: unknown) => Promise<unknown> };
    };
    select: () => {
      from: (table: typeof rental_workspace_manifests) => {
        where: (c: unknown) => Promise<unknown[]>;
      };
    };
  };
  generateId: () => string;
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Default workspace root
// ---------------------------------------------------------------------------

const DEFAULT_WORKSPACE_ROOT = path.join(
  os.tmpdir(),
  "letagents-rental-workspaces",
);

// ---------------------------------------------------------------------------
// Materializer
// ---------------------------------------------------------------------------

/**
 * Materialize a scoped workspace for a rental session.
 *
 * 1. Creates a bare clone (or reuses cached) of the repo
 * 2. Creates a disposable work branch from the base commit
 * 3. Creates a git worktree checkout at a fresh temp path
 * 4. Applies scope-glob filter (deletes out-of-scope files)
 * 5. Records the manifest row
 */
export async function materializeWorkspace(
  deps: WorkspaceMaterializerDeps,
  input: MaterializeWorkspaceInput,
): Promise<MaterializeWorkspaceResult> {
  const log = deps.log ?? (() => {});
  const workspaceRoot = input.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const ttlHours = input.ttlHours ?? 24;

  // Ensure workspace root exists
  fs.mkdirSync(workspaceRoot, { recursive: true });

  // 1. Bare clone (or reuse cached)
  const repoHash = hashString(input.repoUrl);
  const barePath = path.join(workspaceRoot, ".bare-cache", repoHash);

  if (!fs.existsSync(barePath)) {
    log(`Cloning bare repo: ${input.repoUrl}`);
    fs.mkdirSync(path.dirname(barePath), { recursive: true });
    execSync(`git clone --bare "${input.repoUrl}" "${barePath}"`, {
      timeout: 120_000,
      stdio: "pipe",
    });
  } else {
    log(`Reusing cached bare clone: ${barePath}`);
    try {
      execSync("git fetch --all --prune", {
        cwd: barePath,
        timeout: 60_000,
        stdio: "pipe",
      });
    } catch {
      log("Warning: fetch failed on cached bare, continuing with stale clone");
    }
  }

  // 2. Verify base commit exists
  try {
    execSync(`git cat-file -t ${input.baseCommitSha}`, {
      cwd: barePath,
      timeout: 10_000,
      stdio: "pipe",
    });
  } catch {
    throw new Error(
      `Base commit ${input.baseCommitSha} not found in repo ${input.repoUrl}`,
    );
  }

  // 3. Create disposable work branch
  const workBranch = `rental/${input.sessionId}`;
  try {
    execSync(`git branch "${workBranch}" ${input.baseCommitSha}`, {
      cwd: barePath,
      timeout: 10_000,
      stdio: "pipe",
    });
  } catch {
    // Branch may already exist from a re-materialization
    log(`Work branch ${workBranch} may already exist, continuing`);
  }

  // 4. Create worktree checkout
  const manifestId = deps.generateId();
  const workspacePath = path.join(workspaceRoot, manifestId);

  execSync(`git worktree add "${workspacePath}" "${workBranch}"`, {
    cwd: barePath,
    timeout: 60_000,
    stdio: "pipe",
  });
  log(`Created worktree at ${workspacePath}`);

  // 5. Apply scope-glob filter
  const { fileCount, byteCount } = applyScopeFilter(
    workspacePath,
    input.scopeGlobs,
    log,
  );

  // 6. Record manifest
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

  await deps.db.insert(rental_workspace_manifests).values({
    id: manifestId,
    session_id: input.sessionId,
    base_commit_sha: input.baseCommitSha,
    work_branch: workBranch,
    scope_globs: input.scopeGlobs,
    workspace_path: workspacePath,
    files_materialized: fileCount,
    bytes_materialized: byteCount,
    retention_status: "active",
    materialized_at: now,
    expires_at: expiresAt,
    created_at: now,
    updated_at: now,
  });

  log(`Manifest ${manifestId} recorded: ${fileCount} files, ${byteCount} bytes`);

  return {
    manifestId,
    workspacePath,
    workBranch,
    filesMaterialized: fileCount,
    bytesMaterialized: byteCount,
  };
}

/**
 * Get the active workspace manifest for a session.
 */
export async function getActiveManifest(
  deps: WorkspaceMaterializerDeps,
  sessionId: string,
): Promise<unknown | null> {
  const rows = await deps.db
    .select()
    .from(rental_workspace_manifests)
    .where(eq(rental_workspace_manifests.session_id, sessionId));

  const active = (rows as Array<{ retention_status: string }>).find(
    (r) => r.retention_status === "active",
  );
  return active ?? null;
}

// ---------------------------------------------------------------------------
// Scope filter
// ---------------------------------------------------------------------------

/**
 * Delete files that don't match any scope glob. If scopeGlobs is
 * empty, all files are kept (Trusted Open Mode).
 */
function applyScopeFilter(
  workspacePath: string,
  scopeGlobs: string[],
  log: (msg: string) => void,
): { fileCount: number; byteCount: number } {
  // Empty globs = full repo, no filtering
  if (scopeGlobs.length === 0) {
    return countFiles(workspacePath);
  }

  const allFiles = walkDir(workspacePath);
  let removedCount = 0;

  for (const absPath of allFiles) {
    const relPath = path.relative(workspacePath, absPath);
    // Skip .git directory
    if (relPath.startsWith(".git")) continue;

    const matches = scopeGlobs.some((glob) => simpleGlobMatch(glob, relPath));
    if (!matches) {
      fs.unlinkSync(absPath);
      removedCount++;
    }
  }

  // Clean up empty directories
  cleanEmptyDirs(workspacePath);

  log(`Scope filter: removed ${removedCount} out-of-scope files`);
  return countFiles(workspacePath);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return Math.abs(hash).toString(36);
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git") continue; // Skip .git
      results.push(...walkDir(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function cleanEmptyDirs(dir: string): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== ".git") {
      const fullPath = path.join(dir, entry.name);
      cleanEmptyDirs(fullPath);
      try {
        const remaining = fs.readdirSync(fullPath);
        if (remaining.length === 0) {
          fs.rmdirSync(fullPath);
        }
      } catch {
        // Directory may have been removed by parent cleanup
      }
    }
  }
}

function countFiles(dir: string): { fileCount: number; byteCount: number } {
  const files = walkDir(dir);
  let byteCount = 0;
  for (const f of files) {
    try {
      byteCount += fs.statSync(f).size;
    } catch {
      // File may have been removed during filtering
    }
  }
  return { fileCount: files.length, byteCount };
}
