import type { DesktopRoomInfo, RepoBranchDelta, RepoStatus } from "../../../electron/ipc-types";
import { repoBranchLabel, repoChangedFileCount } from "./repo-status";

export interface RepoEnvironmentItem {
  key: string;
  label: string;
  value: string;
  tone: "neutral" | "attention" | "danger";
}

export function shouldShowRepoEnvironmentForRoom(
  room: Pick<DesktopRoomInfo, "gitRoom">,
  repoStatus: RepoStatus,
  gitRoomMatchesActiveRepo: boolean,
): boolean {
  return Boolean(room.gitRoom && repoStatus.isGitRepo && gitRoomMatchesActiveRepo);
}

export function repoEnvironmentBranchLabel(repoStatus: RepoStatus): string {
  return repoBranchLabel(repoStatus);
}

export function repoEnvironmentRoomRefLabel(room: Pick<DesktopRoomInfo, "gitRoom">): string | null {
  const gitRoom = room.gitRoom;
  if (!gitRoom) return null;
  const ref = gitRoom.ref;
  if (ref.type === "branch" || ref.type === "default_branch") {
    return ref.name || ref.defaultBranch || "default branch";
  }
  if (ref.type === "pull_request") {
    return ref.name ? `PR ${ref.name}` : "pull request";
  }
  return ref.name || null;
}

export function repoEnvironmentLinkedRoomLabel(room: Pick<DesktopRoomInfo, "displayName" | "gitRoom">): string {
  const repoName = room.gitRoom?.repository.fullName || room.displayName || "This room";
  const refLabel = repoEnvironmentRoomRefLabel(room);
  return refLabel ? `${repoName} · ${refLabel}` : repoName;
}

export function repoEnvironmentCurrentBranchMatchesRoom(
  room: Pick<DesktopRoomInfo, "gitRoom">,
  repoStatus: Pick<RepoStatus, "isGitRepo" | "detached" | "branch" | "defaultBranch">,
): boolean {
  if (!room.gitRoom || !repoStatus.isGitRepo || repoStatus.detached) return false;
  const roomRef = repoEnvironmentRoomRefLabel(room);
  if (
    !roomRef ||
    (room.gitRoom.ref.type !== "branch" && room.gitRoom.ref.type !== "default_branch")
  ) return false;
  return repoStatus.branch === roomRef;
}

export function repoEnvironmentShortHead(repoStatus: RepoStatus): string | null {
  const head = repoStatus.head?.trim();
  return head ? head.slice(0, 7) : null;
}

export function repoEnvironmentChangeLabel(repoStatus: RepoStatus): string {
  const changes = repoStatus.changes;
  const changedCount = repoChangedFileCount(repoStatus);
  if (!changes || changedCount === 0) return "Clean";
  if (changes.conflicted === 0) {
    return `${changedCount} ${changedCount === 1 ? "file" : "files"} changed`;
  }
  const parts = [
    changes.staged ? `${changes.staged} staged` : null,
    changes.unstaged ? `${changes.unstaged} modified` : null,
    changes.untracked ? `${changes.untracked} untracked` : null,
    changes.conflicted ? `${changes.conflicted} conflicted` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function repoEnvironmentBranchDeltaLabel(delta: RepoBranchDelta | null | undefined): string | null {
  if (!delta) return null;
  const additions = delta.additions.toLocaleString();
  const deletions = delta.deletions.toLocaleString();
  return `+${additions} -${deletions}`;
}

export function repoEnvironmentBranchDeltaForRoom(
  room: Pick<DesktopRoomInfo, "gitRoom">,
  repoStatus: Pick<RepoStatus, "branchDelta" | "branchDeltas">,
): RepoBranchDelta | null {
  const roomRef = repoEnvironmentRoomRefLabel(room);
  if (!roomRef) return null;
  const deltas = repoStatus.branchDeltas || [];
  return deltas.find((delta) => delta.branch === roomRef) ??
    (repoStatus.branchDelta?.branch === roomRef ? repoStatus.branchDelta : null);
}

export function repoEnvironmentSyncLabel(repoStatus: RepoStatus): string {
  const ahead = repoStatus.ahead || 0;
  const behind = repoStatus.behind || 0;
  if (!repoStatus.upstream) return "No upstream";
  if (ahead === 0 && behind === 0) return `Tracking ${repoStatus.upstream}`;
  return [
    ahead > 0 ? `${ahead} ahead` : null,
    behind > 0 ? `${behind} behind` : null,
    repoStatus.upstream,
  ].filter(Boolean).join(" · ");
}

export function repoEnvironmentItems(repoStatus: RepoStatus): RepoEnvironmentItem[] {
  const changes = repoStatus.changes;
  const changedCount = repoChangedFileCount(repoStatus);
  const head = repoEnvironmentShortHead(repoStatus);
  return [
    {
      key: "changes",
      label: "Changes",
      value: repoEnvironmentChangeLabel(repoStatus),
      tone: changes?.conflicted ? "danger" : changedCount > 0 ? "attention" : "neutral",
    },
    {
      key: "sync",
      label: "Upstream",
      value: repoEnvironmentSyncLabel(repoStatus),
      tone: (repoStatus.behind || 0) > 0 ? "attention" : "neutral",
    },
    {
      key: "default",
      label: "Default",
      value: repoStatus.defaultBranch || "Unknown",
      tone: "neutral",
    },
    {
      key: "head",
      label: "Head",
      value: head || "Unknown",
      tone: "neutral",
    },
  ];
}
