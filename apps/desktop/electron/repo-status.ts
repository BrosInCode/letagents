import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { DesktopRepoRoomSelection, RepoStatus, RepoWorktreeEntry } from "./ipc-types.js";

const execFileAsync = promisify(execFile);

async function runGit(workspaceRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: workspaceRoot });
  return stdout;
}

async function runGitInPath(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function getCurrentBranch(workspaceRoot: string): Promise<string | null> {
  try {
    const stdout = await runGit(workspaceRoot, ["branch", "--show-current"]);
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

async function getWorktrees(workspaceRoot: string): Promise<RepoWorktreeEntry[]> {
  try {
    const stdout = await runGit(workspaceRoot, ["worktree", "list", "--porcelain"]);
    const lines = stdout.split(/\r?\n/);
    const entries: RepoWorktreeEntry[] = [];
    let current: Partial<RepoWorktreeEntry> | null = null;

    for (const line of lines) {
      if (!line.trim()) {
        if (current?.path && current.head) {
          entries.push({
            path: current.path,
            branch: current.branch ?? null,
            head: current.head,
            isCurrent: current.path === workspaceRoot,
          });
        }
        current = null;
        continue;
      }

      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ").trim();
      if (key === "worktree") {
        current = { path: value };
      } else if (current && key === "HEAD") {
        current.head = value;
      } else if (current && key === "branch") {
        current.branch = value.replace(/^refs\/heads\//, "");
      }
    }

    if (current?.path && current.head) {
      entries.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head,
        isCurrent: current.path === workspaceRoot,
      });
    }

    return entries;
  } catch {
    return [];
  }
}

export async function buildRepoStatus(workspaceRoot: string): Promise<RepoStatus> {
  return {
    rootPath: workspaceRoot,
    branch: await getCurrentBranch(workspaceRoot),
    worktrees: await getWorktrees(workspaceRoot),
  };
}
export function normalizeGitRemoteToRoomIdentifier(remote: string): string | null {
  const value = remote.trim();
  if (!value) return null;

  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(value);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`.replace(/\.git$/, "");
  }

  try {
    const url = new URL(value);
    if (!url.hostname) return null;
    return `${url.hostname}${url.pathname}`.replace(/\.git$/, "").replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function readConfiguredRoomIdentifier(workspaceRoot: string): string | null {
  return readConfiguredRoomIdentifierAt(workspaceRoot);
}

function readConfiguredRoomIdentifierAt(repoRoot: string): string | null {
  try {
    const configPath = join(repoRoot, ".letagents.json");
    if (!existsSync(configPath)) return null;
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { room?: string };
    return parsed.room?.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveRoomIdentifier(workspaceRoot: string): Promise<string | null> {
  const configured = readConfiguredRoomIdentifier(workspaceRoot);
  if (configured) return configured;

  try {
    const stdout = await runGit(workspaceRoot, ["remote", "get-url", "origin"]);
    return normalizeGitRemoteToRoomIdentifier(stdout);
  } catch {
    return null;
  }
}

function slugifyLocalProjectName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "project";
}

function createLocalRoomIdentifier(projectPath: string): string {
  const normalizedPath = resolve(projectPath);
  const folderName = slugifyLocalProjectName(basename(normalizedPath));
  const pathHash = createHash("sha256").update(normalizedPath).digest("hex").slice(0, 10);
  return `local-${folderName}-${pathHash}`;
}

export async function resolveRoomIdentifierFromPath(folderPath: string): Promise<{
  repoRoot: string | null;
  roomIdentifier: string;
  source: DesktopRepoRoomSelection["source"];
  warning: string | null;
}> {
  let repoRoot: string | null = null;
  try {
    const stdout = await runGitInPath(folderPath, ["rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim() || null;
  } catch {
    return {
      repoRoot: null,
      roomIdentifier: createLocalRoomIdentifier(folderPath),
      source: "local_fallback",
      warning: "This folder is not a Git repository yet. LetAgents opened a local room that you can attach to GitHub later.",
    };
  }

  if (!repoRoot) {
    return {
      repoRoot: null,
      roomIdentifier: createLocalRoomIdentifier(folderPath),
      source: "local_fallback",
      warning: "This folder is not a Git repository yet. LetAgents opened a local room that you can attach to GitHub later.",
    };
  }

  const configured = readConfiguredRoomIdentifierAt(repoRoot);
  if (configured) return { repoRoot, roomIdentifier: configured, source: "configured", warning: null };

  try {
    const stdout = await runGitInPath(repoRoot, ["remote", "get-url", "origin"]);
    const roomIdentifier = normalizeGitRemoteToRoomIdentifier(stdout);
    if (roomIdentifier) return { repoRoot, roomIdentifier, source: "git_remote", warning: null };
  } catch {
    // Fall through to the local room fallback below.
  }

  return {
    repoRoot,
    roomIdentifier: createLocalRoomIdentifier(repoRoot),
    source: "local_fallback",
    warning: "This repo is only on your Mac. LetAgents opened a local room; attach it to GitHub after you add a remote.",
  };
}
