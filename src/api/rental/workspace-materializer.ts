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
 *
 * Security notes (review feedback):
 * - All git commands use execFileSync with argument arrays (no shell injection)
 * - Scope filtering uses file copy, not deletion (no tracked git deletions)
 * - Always-blocked secret paths (.env, .git-credentials, etc.) are excluded
 *   even in Trusted Open mode
 * - Commit SHA and branch names are validated before use
 */

import { eq } from "drizzle-orm";
import { execFileSync } from "child_process";
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
  let regexStr = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
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
// Always-blocked secret paths (spec §10.3 / §12.2)
// ---------------------------------------------------------------------------

/**
 * Paths that are ALWAYS excluded, even in Trusted Open mode.
 * These are known secret file paths that must never be exposed
 * to a provider agent.
 */
const ALWAYS_BLOCKED_PATHS = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.staging",
  ".env.*",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".docker/config.json",
  "**/.ssh/**",
  "**/.aws/**",
  "**/.gnupg/**",
  "**/.config/gcloud/**",
  "**/id_rsa",
  "**/id_ed25519",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/secrets.yaml",
  "**/secrets.yml",
  "**/secrets.json",
  "**/.vault-token",
  "**/credentials.json",
  "**/service-account*.json",
];

function isAlwaysBlocked(relPath: string): boolean {
  return ALWAYS_BLOCKED_PATHS.some((pattern) =>
    simpleGlobMatch(pattern, relPath),
  );
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const COMMIT_SHA_REGEX = /^[0-9a-f]{7,40}$/i;
const SAFE_BRANCH_CHARS = /^[a-zA-Z0-9\/_.-]+$/;

function validateCommitSha(sha: string): void {
  if (!COMMIT_SHA_REGEX.test(sha)) {
    throw new Error(
      `Invalid commit SHA: ${sha}. Must be 7-40 hex characters.`,
    );
  }
}

function validateRepoUrl(repoUrl: string): string {
  const trimmed = repoUrl.trim();
  if (!trimmed) {
    throw new Error("repoUrl is required");
  }
  if (/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(trimmed)) {
    return trimmed;
  }
  if (
    path.isAbsolute(trimmed) &&
    (
      trimmed.startsWith(`${os.tmpdir()}${path.sep}`) ||
      process.env.LETAGENTS_ALLOW_LOCAL_RENTAL_REPOS === "1"
    )
  ) {
    return trimmed;
  }
  throw new Error("repoUrl must be a GitHub HTTPS repository URL");
}

function validateBranchName(name: string): void {
  if (!SAFE_BRANCH_CHARS.test(name)) {
    throw new Error(
      `Invalid branch name: ${name}. Contains unsafe characters.`,
    );
  }
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
   * Empty array = full repo (Trusted Open Mode) — still applies
   * the always-blocked denylist.
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
 * Architecture (review-hardened):
 * 1. Creates a bare clone (or reuses cached) of the repo
 * 2. Verifies the base commit exists
 * 3. Copies matching files to a flat directory (no .git, no tracked deletions)
 * 4. Applies always-blocked denylist even in Trusted Open mode
 * 5. Records the manifest row
 */
export async function materializeWorkspace(
  deps: WorkspaceMaterializerDeps,
  input: MaterializeWorkspaceInput,
): Promise<MaterializeWorkspaceResult> {
  const log = deps.log ?? (() => {});
  const workspaceRoot = input.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const ttlHours = input.ttlHours ?? 24;

  // Validate inputs
  validateCommitSha(input.baseCommitSha);
  const repoUrl = validateRepoUrl(input.repoUrl);

  // Ensure workspace root exists
  fs.mkdirSync(workspaceRoot, { recursive: true });

  // 1. Bare clone (or reuse cached) — using execFileSync for safety
  const repoHash = hashString(repoUrl);
  const barePath = path.join(workspaceRoot, ".bare-cache", repoHash);
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: "https:file",
  };

  if (!fs.existsSync(barePath)) {
    log(`Cloning bare repo: ${repoUrl}`);
    fs.mkdirSync(path.dirname(barePath), { recursive: true });
    execFileSync("git", ["clone", "--bare", repoUrl, barePath], {
      timeout: 120_000,
      stdio: "pipe",
      env: gitEnv,
    });
  } else {
    log(`Reusing cached bare clone: ${barePath}`);
    try {
      execFileSync("git", ["fetch", "--all", "--prune"], {
        cwd: barePath,
        timeout: 60_000,
        stdio: "pipe",
        env: gitEnv,
      });
    } catch {
      log("Warning: fetch failed on cached bare, continuing with stale clone");
    }
  }

  // 2. Verify base commit exists
  try {
    execFileSync("git", ["cat-file", "-t", input.baseCommitSha], {
      cwd: barePath,
      timeout: 10_000,
      stdio: "pipe",
      env: gitEnv,
    });
  } catch {
    throw new Error(
      `Base commit ${input.baseCommitSha} not found in repo ${repoUrl}`,
    );
  }

  // 3. Create workspace via file copy (not git worktree — avoids tracked deletions)
  const manifestId = deps.generateId();
  const workspacePath = path.join(workspaceRoot, manifestId);
  const workBranch = `rental/${input.sessionId}`;

  validateBranchName(workBranch);

  // Create disposable branch in bare repo for tracking
  try {
    execFileSync(
      "git",
      ["branch", workBranch, input.baseCommitSha],
      { cwd: barePath, timeout: 10_000, stdio: "pipe", env: gitEnv },
    );
  } catch {
    log(`Work branch ${workBranch} may already exist, continuing`);
  }

  // Use git archive to extract files (no .git dir, no tracked deletions)
  fs.mkdirSync(workspacePath, { recursive: true });
  execFileSync(
    "git",
    ["archive", "--format=tar", input.baseCommitSha],
    {
      cwd: barePath,
      timeout: 60_000,
      stdio: ["pipe", fs.openSync(path.join(workspacePath, ".archive.tar"), "w"), "pipe"],
      env: gitEnv,
    },
  );

  // Extract the tar
  execFileSync(
    "tar",
    ["xf", ".archive.tar"],
    { cwd: workspacePath, timeout: 60_000, stdio: "pipe" },
  );

  // Remove the temp tar
  fs.unlinkSync(path.join(workspacePath, ".archive.tar"));

  log(`Extracted files to ${workspacePath}`);

  // 4. Apply scope filter + always-blocked denylist
  const { fileCount, byteCount } = applyScopeAndDenylist(
    workspacePath,
    input.scopeGlobs,
    log,
  );

  // 5. Record manifest
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
// Scope + denylist filter
// ---------------------------------------------------------------------------

/**
 * Remove files that don't match scope globs AND apply the always-blocked
 * denylist. Unlike the previous implementation, this works on a plain
 * directory (no .git) so removals don't create tracked deletions.
 *
 * If scopeGlobs is empty (Trusted Open), all files pass scope — but
 * always-blocked paths are STILL removed per spec §10.3.
 */
function applyScopeAndDenylist(
  workspacePath: string,
  scopeGlobs: string[],
  log: (msg: string) => void,
): { fileCount: number; byteCount: number } {
  const allFiles = walkDir(workspacePath);
  let removedScope = 0;
  let removedDenylist = 0;

  for (const absPath of allFiles) {
    const relPath = path.relative(workspacePath, absPath);

    // Always-blocked denylist — even in Trusted Open
    if (isAlwaysBlocked(relPath)) {
      fs.unlinkSync(absPath);
      removedDenylist++;
      continue;
    }

    // Scope check — empty globs = all pass
    if (scopeGlobs.length > 0) {
      const matches = scopeGlobs.some((glob) => simpleGlobMatch(glob, relPath));
      if (!matches) {
        fs.unlinkSync(absPath);
        removedScope++;
      }
    }
  }

  // Clean up empty directories
  cleanEmptyDirs(workspacePath);

  log(
    `Filter: removed ${removedScope} out-of-scope, ${removedDenylist} blocked`,
  );
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
    if (entry.isDirectory()) {
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
