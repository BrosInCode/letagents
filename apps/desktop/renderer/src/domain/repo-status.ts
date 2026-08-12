import type { RepoStatus } from "../../../electron/ipc-types";

export function repoChangedFileCount(repoStatus: Pick<RepoStatus, "changes">): number {
  const changes = repoStatus.changes;
  return changes
    ? changes.staged + changes.unstaged + changes.untracked + changes.conflicted
    : 0;
}

export function repoBranchLabel(repoStatus: Pick<RepoStatus, "isGitRepo" | "detached" | "branch">): string {
  if (!repoStatus.isGitRepo) return "Not a Git repository";
  if (repoStatus.detached) return "Detached HEAD";
  return repoStatus.branch || "No active branch";
}

export function repoWorkspaceSummary(
  repoStatus: Pick<RepoStatus, "isGitRepo" | "changes" | "upstream" | "ahead" | "behind">,
  options: { plainFolderLabel?: string; includeCleanState?: boolean } = {},
): string {
  if (!repoStatus.isGitRepo) return options.plainFolderLabel || "Plain local folder";
  const parts: string[] = [];
  const changedCount = repoChangedFileCount(repoStatus);
  if (options.includeCleanState !== false) {
    parts.push(changedCount > 0 ? `${changedCount} ${changedCount === 1 ? "file" : "files"} changed` : "clean");
  }
  if ((repoStatus.ahead || 0) > 0) parts.push(`${repoStatus.ahead} ahead`);
  if ((repoStatus.behind || 0) > 0) parts.push(`${repoStatus.behind} behind`);
  if (repoStatus.upstream && (repoStatus.ahead || 0) === 0 && (repoStatus.behind || 0) === 0) {
    parts.push(`tracking ${repoStatus.upstream}`);
  }
  return parts.join(" · ") || "Git workspace";
}
