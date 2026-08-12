import type {
  DesktopManagedAgentChangedFile,
  DesktopManagedAgentChangeFileStatus,
  DesktopManagedAgentChangeSummary,
  DesktopManagedAgentSession,
} from "../../ipc-types.js";
import { runGit } from "../git-exec.js";

// Kept generous so the shared artifact / expandable file panel carries the full
// change set rather than a truncated head; the server clamps at the same ceiling.
const DEFAULT_FILE_LIMIT = 200;
const GIT_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

interface BuildChangeSummaryOptions {
  fileLimit?: number;
}

interface ParsedNumstatFile {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

interface ParsedStatusFile {
  path: string;
  previousPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  status: DesktopManagedAgentChangeFileStatus;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

type MutableChangedFile = DesktopManagedAgentChangedFile;

export async function buildDesktopManagedAgentChangeSummary(
  session: DesktopManagedAgentSession,
  options: BuildChangeSummaryOptions = {},
): Promise<DesktopManagedAgentChangeSummary> {
  const repoRootPath = session.repoRootPath.trim();
  const fileLimit = Math.max(0, Math.floor(options.fileLimit ?? DEFAULT_FILE_LIMIT));
  const base = (): DesktopManagedAgentChangeSummary => ({
    sessionId: session.id,
    providerId: session.providerId,
    repoRootPath,
    repoBranch: session.repoBranch,
    changedFileCount: 0,
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    additions: 0,
    deletions: 0,
    files: [],
    hiddenFileCount: 0,
    isGitRepo: true,
    updatedAt: new Date().toISOString(),
    error: null,
  });

  if (!repoRootPath) {
    return {
      ...base(),
      isGitRepo: false,
      error: "This agent session does not have a repository path.",
    };
  }

  let isGitRepo = false;
  try {
    isGitRepo = (await git(repoRootPath, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch (error) {
    return {
      ...base(),
      isGitRepo: false,
      error: error instanceof Error ? error.message : "Could not inspect this agent's Git changes.",
    };
  }

  if (!isGitRepo) {
    return {
      ...base(),
      isGitRepo: false,
      error: "This agent session is not attached to a Git working tree.",
    };
  }

  try {
    const [statusOutput, unstagedNumstatOutput, stagedNumstatOutput] = await Promise.all([
      git(repoRootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
      git(repoRootPath, ["diff", "--numstat", "-z", "--"]),
      git(repoRootPath, ["diff", "--cached", "--numstat", "-z", "--"]),
    ]);

    const filesByPath = new Map<string, MutableChangedFile>();
    for (const statusFile of parseStatusOutput(statusOutput)) {
      const entry = ensureChangedFile(filesByPath, statusFile.path);
      entry.previousPath = statusFile.previousPath;
      entry.status = statusFile.status;
      entry.staged ||= statusFile.staged;
      entry.unstaged ||= statusFile.unstaged;
      entry.untracked ||= statusFile.untracked;
    }

    for (const file of parseNumstatOutput(unstagedNumstatOutput)) {
      const entry = ensureChangedFile(filesByPath, file.path);
      entry.additions += file.additions;
      entry.deletions += file.deletions;
      entry.binary ||= file.binary;
      entry.unstaged = true;
      if (entry.status === "unknown") entry.status = "modified";
    }

    for (const file of parseNumstatOutput(stagedNumstatOutput)) {
      const entry = ensureChangedFile(filesByPath, file.path);
      entry.additions += file.additions;
      entry.deletions += file.deletions;
      entry.binary ||= file.binary;
      entry.staged = true;
      if (entry.status === "unknown") entry.status = "modified";
    }

    const allFiles = [...filesByPath.values()].sort(compareChangedFiles);
    const additions = allFiles.reduce((total, file) => total + file.additions, 0);
    const deletions = allFiles.reduce((total, file) => total + file.deletions, 0);
    const summary = base();
    return {
      ...summary,
      changedFileCount: allFiles.length,
      stagedFileCount: allFiles.filter((file) => file.staged).length,
      unstagedFileCount: allFiles.filter((file) => file.unstaged).length,
      untrackedFileCount: allFiles.filter((file) => file.untracked).length,
      additions,
      deletions,
      files: allFiles.slice(0, fileLimit),
      hiddenFileCount: Math.max(0, allFiles.length - fileLimit),
    };
  } catch (error) {
    return {
      ...base(),
      isGitRepo: true,
      error: error instanceof Error ? error.message : "Could not inspect this agent's Git changes.",
    };
  }
}

function ensureChangedFile(filesByPath: Map<string, MutableChangedFile>, path: string): MutableChangedFile {
  const existing = filesByPath.get(path);
  if (existing) return existing;
  const next: MutableChangedFile = {
    path,
    previousPath: null,
    status: "unknown",
    additions: 0,
    deletions: 0,
    binary: false,
    staged: false,
    unstaged: false,
    untracked: false,
  };
  filesByPath.set(path, next);
  return next;
}

function compareChangedFiles(a: DesktopManagedAgentChangedFile, b: DesktopManagedAgentChangedFile): number {
  const aSize = a.additions + a.deletions;
  const bSize = b.additions + b.deletions;
  if (aSize !== bSize) return bSize - aSize;
  if (a.untracked !== b.untracked) return a.untracked ? 1 : -1;
  return a.path.localeCompare(b.path);
}

function parseNumstatOutput(output: string): ParsedNumstatFile[] {
  const records = output.split("\0");
  const files: ParsedNumstatFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab >= 0 ? record.indexOf("\t", firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsText = record.slice(0, firstTab);
    const deletionsText = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (!path) {
      const nextPath = records[index + 2] ?? "";
      path = nextPath;
      index += nextPath ? 2 : 0;
    }
    if (!path) continue;
    const binary = additionsText === "-" || deletionsText === "-";
    files.push({
      path,
      additions: binary ? 0 : safeNumber(additionsText),
      deletions: binary ? 0 : safeNumber(deletionsText),
      binary,
    });
  }
  return files;
}

function parseStatusOutput(output: string): ParsedStatusFile[] {
  const records = output.split("\0").filter(Boolean);
  const files: ParsedStatusFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    const path = record.slice(3);
    if (!path) continue;

    let previousPath: string | null = null;
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      previousPath = records[index + 1] ?? null;
      index += previousPath ? 1 : 0;
    }

    const untracked = indexStatus === "?" && worktreeStatus === "?";
    files.push({
      path,
      previousPath,
      indexStatus,
      worktreeStatus,
      status: statusLabel(indexStatus, worktreeStatus),
      staged: !untracked && indexStatus !== " " && indexStatus !== "?",
      unstaged: !untracked && worktreeStatus !== " " && worktreeStatus !== "?",
      untracked,
    });
  }
  return files;
}

function statusLabel(indexStatus: string, worktreeStatus: string): DesktopManagedAgentChangeFileStatus {
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
  const status = indexStatus !== " " ? indexStatus : worktreeStatus;
  if (status === "A") return "added";
  if (status === "M") return "modified";
  if (status === "D") return "deleted";
  if (status === "R") return "renamed";
  if (status === "C") return "copied";
  if (status === "T") return "typechange";
  return "unknown";
}

function safeNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
    windowsHide: true,
  });
  if (result.code !== 0) {
    throw new Error(gitErrorMessage({
      stderr: result.stderr,
      message: result.stderr || `git ${args.join(" ")} failed`,
    }));
  }
  return result.stdout;
}

function gitErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "Could not inspect this agent's Git changes.";
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
  const message = error instanceof Error ? error.message : "";
  const detail = stderr || message;
  return detail ? `Could not inspect this agent's Git changes: ${detail}` : "Could not inspect this agent's Git changes.";
}
