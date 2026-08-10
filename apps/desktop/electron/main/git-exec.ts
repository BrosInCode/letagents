import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitExecResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type RunGitOptions = {
  timeout?: number;
  maxBuffer?: number;
  windowsHide?: boolean;
  signal?: AbortSignal;
};

/**
 * Shared git exec helper for the desktop electron main process.
 * Never throws — failed commands return a non-zero `code`.
 */
export async function runGit(
  cwd: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<GitExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: options.windowsHide ?? true,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    });
    return {
      stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
      stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? (error instanceof Error ? error.message : String(error)),
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}

/**
 * Throwing wrapper for callers that expect stdout-or-throw (repo-status style).
 */
export async function runGitStdout(
  cwd: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<string> {
  const result = await runGit(cwd, args, options);
  if (result.code !== 0) {
    const error = new Error(result.stderr || `git ${args.join(" ")} failed`) as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    error.code = result.code;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}

/**
 * Resolve the main worktree root for a checkout. Preserves the hardened
 * try/catch used by rooms/worktrees.ts (orchestrator mirror).
 */
export async function getMainWorktreeRoot(repoRoot: string): Promise<string> {
  try {
    const { stdout, code } = await runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
    const commonDir = stdout.trim();
    if (code === 0 && commonDir) {
      const absoluteCommonDir = resolve(repoRoot, commonDir);
      if (basename(absoluteCommonDir) === ".git") {
        return dirname(absoluteCommonDir);
      }
    }
  } catch {
    // Fall back to the passed-in root.
  }
  return resolve(repoRoot);
}
