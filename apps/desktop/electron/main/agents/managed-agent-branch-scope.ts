import { Buffer } from "node:buffer";

import type {
  DesktopAgentProviderPreflight,
  DesktopGitRoomInfo,
  RepoStatus,
} from "../../ipc-types.js";

export function branchScopedGitRoomName(
  gitRoom: DesktopGitRoomInfo | null | undefined,
  repoStatus?: Pick<RepoStatus, "defaultBranch"> | null,
): string | null {
  if (gitRoom?.ref.type !== "branch") return null;
  const branchName = gitRoom.ref.name?.trim() || null;
  if (!branchName) return null;
  if (gitRoom.isDefault) return null;
  const defaultBranch = gitRoom.ref.defaultBranch?.trim() || repoStatus?.defaultBranch?.trim() || null;
  return defaultBranch && branchName === defaultBranch ? null : branchName;
}

export function gitRoomFromBranchRoomIdentifier(
  roomIdentifier: string | null | undefined,
): DesktopGitRoomInfo | null {
  const identifier = roomIdentifier?.trim() || "";
  const githubMatch = /^git-room:github\.com:([^/:\s]+\/[^/:\s]+):branch:([A-Za-z0-9_-]+)$/i.exec(identifier);
  if (githubMatch) {
    const [owner, name] = githubMatch[1].split("/");
    const branch = decodeRoomRef(githubMatch[2]);
    if (!owner || !name || !branch) return null;
    const fullName = `${owner}/${name}`;
    return gitRoomInfo({
      provider: "github",
      host: "github.com",
      repository: { id: null, fullName, owner, name },
      branch,
      source: "git_remote",
      visibility: "unknown",
    });
  }

  const localMatch = /^git-room:local:([^:\s]+):branch:([A-Za-z0-9_-]+)$/i.exec(identifier);
  if (!localMatch) return null;
  const branch = decodeRoomRef(localMatch[2]);
  if (!branch) return null;
  return gitRoomInfo({
    provider: "git",
    host: "local",
    repository: {
      id: `local:${localMatch[1]}`,
      fullName: "Local repository",
      owner: "local",
      name: "Local repository",
    },
    branch,
    source: "local_git",
    visibility: "local",
  });
}

export function applyManagedAgentBranchScopePreflight(input: {
  providerName: string;
  preflight: DesktopAgentProviderPreflight;
  gitRoom: DesktopGitRoomInfo | null | undefined;
  repoStatus: Pick<RepoStatus, "branch" | "defaultBranch" | "detached" | "isGitRepo"> | null;
}): DesktopAgentProviderPreflight {
  const expectedBranch = branchScopedGitRoomName(input.gitRoom, input.repoStatus);
  if (!expectedBranch || !input.preflight.canStart) {
    return input.preflight;
  }

  const currentBranch = input.repoStatus?.branch?.trim() || null;
  if (input.repoStatus?.isGitRepo && currentBranch === expectedBranch && !input.repoStatus.detached) {
    return input.preflight;
  }

  const branchState = branchScopeStateLabel(input.repoStatus);
  return {
    ...input.preflight,
    status: "branch_mismatch",
    canStart: false,
    message: `Choose a worktree on ${expectedBranch} before starting ${input.providerName}.`,
    detail: `This Git Room is scoped to ${expectedBranch}, but the selected project is ${branchState}. Choose a matching worktree or switch branches before starting an agent.`,
    nextAction: "choose_worktree",
    branchMismatch: {
      expectedBranch,
      currentBranch,
      detached: Boolean(input.repoStatus?.detached),
    },
  };
}

function branchScopeStateLabel(
  repoStatus: Pick<RepoStatus, "branch" | "detached" | "isGitRepo"> | null,
): string {
  if (!repoStatus?.isGitRepo) return "not a Git worktree";
  if (repoStatus.detached) return "on a detached HEAD";
  return repoStatus.branch?.trim() ? `on ${repoStatus.branch.trim()}` : "not on a named branch";
}

function decodeRoomRef(encodedRef: string): string | null {
  try {
    const decoded = Buffer.from(encodedRef, "base64url").toString("utf8").trim();
    if (!decoded) return null;
    return Buffer.from(decoded, "utf8").toString("base64url") === encodedRef
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function gitRoomInfo(input: {
  provider: string;
  host: string;
  repository: DesktopGitRoomInfo["repository"];
  branch: string;
  source: string;
  visibility: DesktopGitRoomInfo["visibility"];
}): DesktopGitRoomInfo {
  return {
    provider: input.provider,
    host: input.host,
    repository: input.repository,
    ref: {
      type: "branch",
      name: input.branch,
      defaultBranch: null,
      baseRef: null,
      headRef: input.branch,
      headRepository: null,
    },
    visibility: input.visibility,
    accessMode: input.visibility,
    isDefault: false,
    source: input.source,
  };
}
