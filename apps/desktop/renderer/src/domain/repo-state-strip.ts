import type { DesktopRoomInfo, RepoStatus } from "../../../electron/ipc-types";
import { repoBranchLabel, repoChangedFileCount } from "./repo-status";

export interface RepoStateStripItem {
  key: string;
  label: string;
  value: string;
  tone: "neutral" | "attention" | "danger";
}

export function shouldShowRepoStateForRoom(
  room: Pick<DesktopRoomInfo, "gitRoom">,
  repoStatus: RepoStatus,
  gitRoomMatchesActiveRepo: boolean,
): boolean {
  return Boolean(room.gitRoom && repoStatus.isGitRepo && gitRoomMatchesActiveRepo);
}

export function repoStateBranchLabel(repoStatus: RepoStatus): string {
  return repoBranchLabel(repoStatus);
}

export function repoStateShortHead(repoStatus: RepoStatus): string | null {
  const head = repoStatus.head?.trim();
  return head ? head.slice(0, 7) : null;
}

export function repoStateChangeLabel(repoStatus: RepoStatus): string {
  const changes = repoStatus.changes;
  const changedCount = repoChangedFileCount(repoStatus);
  if (!changes || changedCount === 0) return "Clean";
  const parts = [
    changes.staged ? `${changes.staged} staged` : null,
    changes.unstaged ? `${changes.unstaged} modified` : null,
    changes.untracked ? `${changes.untracked} untracked` : null,
    changes.conflicted ? `${changes.conflicted} conflicted` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function repoStateSyncLabel(repoStatus: RepoStatus): string {
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

export function repoStateStripItems(repoStatus: RepoStatus): RepoStateStripItem[] {
  const changes = repoStatus.changes;
  const changedCount = repoChangedFileCount(repoStatus);
  const head = repoStateShortHead(repoStatus);
  return [
    {
      key: "changes",
      label: "Changes",
      value: repoStateChangeLabel(repoStatus),
      tone: changes?.conflicted ? "danger" : changedCount > 0 ? "attention" : "neutral",
    },
    {
      key: "sync",
      label: "Upstream",
      value: repoStateSyncLabel(repoStatus),
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
