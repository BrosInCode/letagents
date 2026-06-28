import {
  ensureGitHubRepoRoomBinding,
  getActiveFocusRoomForTask,
  getActiveTaskLeases,
  getGitChildRoom,
  getGitRoomBindingForRoom,
  upsertGitRoomBinding,
  type GitRoomBinding,
  type Project,
  type TaskLease,
} from "../db.js";
import {
  buildGitHubRefFocusKey,
  buildGitHubRefRoomId,
} from "./git-room-routing.js";

export type EnsureTaskGitRoomSkipReason =
  | "not_git_repo_room"
  | "missing_work_lease_branch"
  | "default_branch"
  | "missing_existing_branch_room";

export interface EnsureTaskGitRoomResult {
  room: Project | null;
  binding: GitRoomBinding | null;
  attached_to_focus: boolean;
  skipped?: EnsureTaskGitRoomSkipReason;
}

export interface EnsureTaskGitRoomDeps {
  getGitRoomBindingForRoom(roomId: string): Promise<GitRoomBinding | null>;
  ensureGitHubRepoRoomBinding(roomId: string): Promise<GitRoomBinding | null>;
  getActiveTaskLeases(roomId: string, taskId: string): Promise<TaskLease[]>;
  getActiveFocusRoomForTask(parentRoomId: string, taskId: string): Promise<Project | undefined>;
  getGitChildRoom(input: {
    roomId: string;
    parentRoomId: string;
    focusKey: string;
  }): Promise<Project | undefined>;
  upsertGitRoomBinding(input: Parameters<typeof upsertGitRoomBinding>[0]): Promise<GitRoomBinding>;
}

const defaultDeps: EnsureTaskGitRoomDeps = {
  getGitRoomBindingForRoom,
  ensureGitHubRepoRoomBinding,
  getActiveTaskLeases,
  getActiveFocusRoomForTask,
  getGitChildRoom,
  upsertGitRoomBinding,
};

function normalizeBranchRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^refs\/heads\//, "");
}

function activeWorkLeaseBranch(leases: readonly TaskLease[]): string | null {
  const lease = leases.find((candidate) => candidate.kind === "work");
  return normalizeBranchRef(lease?.branch_ref);
}

async function resolveRepoGitRoomBinding(
  parentRoomId: string,
  deps: EnsureTaskGitRoomDeps
): Promise<GitRoomBinding | null> {
  const binding = await deps.getGitRoomBindingForRoom(parentRoomId);
  if (binding?.provider === "github") {
    return binding;
  }

  const ensured = await deps.ensureGitHubRepoRoomBinding(parentRoomId);
  return ensured?.provider === "github" ? ensured : null;
}

function isDefaultBranchRef(
  branchRef: string,
  repoBinding: GitRoomBinding
): boolean {
  const defaultBranch = normalizeBranchRef(repoBinding.default_branch);
  if (defaultBranch) {
    return branchRef === defaultBranch;
  }

  return repoBinding.is_default && normalizeBranchRef(repoBinding.ref_name) === branchRef;
}

function isSameGitHubRepositoryBinding(
  existing: GitRoomBinding | null,
  repoBinding: GitRoomBinding
): existing is GitRoomBinding {
  return Boolean(
    existing?.provider === "github" &&
    existing.host === (repoBinding.host || "github.com") &&
    existing.repository_full_name.toLowerCase() === repoBinding.repository_full_name.toLowerCase()
  );
}

function isSameBranchBinding(
  existing: GitRoomBinding | null,
  repoBinding: GitRoomBinding,
  branchRef: string
): existing is GitRoomBinding {
  return Boolean(
    isSameGitHubRepositoryBinding(existing, repoBinding) &&
    existing.ref_type === "branch" &&
    normalizeBranchRef(existing.ref_name) === branchRef
  );
}

function selectTaskGitRoomSource(existing: GitRoomBinding | null): GitRoomBinding["source"] {
  return existing && existing.source !== "manual" ? existing.source : "manual";
}

function selectTaskGitRoomVisibility(
  repoBinding: GitRoomBinding,
  existing: GitRoomBinding | null
): GitRoomBinding["visibility"] {
  if (repoBinding.visibility !== "unknown") {
    return repoBinding.visibility;
  }
  return existing && existing.visibility !== "unknown" ? existing.visibility : "unknown";
}

export async function ensureTaskGitRoomForActiveWorkLease(
  input: {
    parentRoomId: string;
    taskId: string;
  },
  deps: EnsureTaskGitRoomDeps = defaultDeps
): Promise<EnsureTaskGitRoomResult> {
  const repoBinding = await resolveRepoGitRoomBinding(input.parentRoomId, deps);
  if (!repoBinding) {
    return {
      room: null,
      binding: null,
      attached_to_focus: false,
      skipped: "not_git_repo_room",
    };
  }

  const branchRef = activeWorkLeaseBranch(
    await deps.getActiveTaskLeases(input.parentRoomId, input.taskId)
  );
  if (!branchRef) {
    return {
      room: null,
      binding: null,
      attached_to_focus: false,
      skipped: "missing_work_lease_branch",
    };
  }

  if (isDefaultBranchRef(branchRef, repoBinding)) {
    return {
      room: null,
      binding: null,
      attached_to_focus: false,
      skipped: "default_branch",
    };
  }

  const taskFocusRoom = await deps.getActiveFocusRoomForTask(
    input.parentRoomId,
    input.taskId
  );
  const branchRoomId = buildGitHubRefRoomId({
    repositoryFullName: repoBinding.repository_full_name,
    refType: "branch",
    refName: branchRef,
  });
  const branchFocusKey = buildGitHubRefFocusKey({
    refType: "branch",
    refName: branchRef,
  });
  const existingBranchRoom = taskFocusRoom
    ? undefined
    : await deps.getGitChildRoom({
        roomId: branchRoomId,
        parentRoomId: input.parentRoomId,
        focusKey: branchFocusKey,
      });
  const target = taskFocusRoom
    ? { room: taskFocusRoom, attached_to_focus: true }
    : existingBranchRoom
      ? { room: existingBranchRoom, attached_to_focus: false }
      : null;

  if (!target) {
    return {
      room: null,
      binding: null,
      attached_to_focus: false,
      skipped: "missing_existing_branch_room",
    };
  }

  const existingTargetBinding = await deps.getGitRoomBindingForRoom(target.room.id);
  const sameRepositoryBinding = isSameGitHubRepositoryBinding(existingTargetBinding, repoBinding)
    ? existingTargetBinding
    : null;
  const sameBranchBinding = isSameBranchBinding(existingTargetBinding, repoBinding, branchRef)
    ? existingTargetBinding
    : null;
  const defaultBranch = repoBinding.default_branch ?? sameRepositoryBinding?.default_branch ?? null;
  const binding = await deps.upsertGitRoomBinding({
    room_id: target.room.id,
    provider: "github",
    host: repoBinding.host || "github.com",
    repository_id: repoBinding.repository_id ?? sameRepositoryBinding?.repository_id ?? null,
    repository_full_name: repoBinding.repository_full_name,
    repository_owner: repoBinding.repository_owner,
    repository_name: repoBinding.repository_name,
    ref_type: "branch",
    ref_name: branchRef,
    default_branch: defaultBranch,
    base_ref: defaultBranch,
    head_ref: branchRef,
    head_repository_id: sameBranchBinding?.head_repository_id ?? null,
    head_repository_full_name: sameBranchBinding?.head_repository_full_name ?? null,
    head_repository_owner: sameBranchBinding?.head_repository_owner ?? null,
    head_repository_name: sameBranchBinding?.head_repository_name ?? null,
    visibility: selectTaskGitRoomVisibility(repoBinding, sameRepositoryBinding),
    is_default: false,
    source: selectTaskGitRoomSource(sameBranchBinding),
  });

  return {
    room: target.room,
    binding,
    attached_to_focus: target.attached_to_focus,
  };
}
