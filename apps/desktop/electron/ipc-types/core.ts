export interface DesktopAppInfo {
  appName: string;
  appVersion?: string;
  platform: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  workspaceRoot: string;
  /** OS user home used as the deterministic cwd for rooms without project context. */
  homePath?: string;
  apiUrl: string | null;
}

export interface DesktopGitHubPullRequestStats {
  url: string;
  number: number;
  title: string | null;
  state: "open" | "closed" | "merged" | "draft" | "unknown";
  baseRefName: string | null;
  headRefName: string | null;
  changedFiles: number;
  additions: number;
  deletions: number;
}

export interface RepoWorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  isCurrent: boolean;
  isMain?: boolean;
}

export interface RepoChangeSummary {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface RepoBranchDelta {
  branch: string | null;
  filesChanged: number;
  additions: number;
  deletions: number;
  baseBranch: string | null;
}

export interface RepoStatus {
  rootPath: string;
  mainRootPath?: string | null;
  isGitRepo?: boolean;
  gitHeadPath?: string | null;
  head?: string | null;
  branch: string | null;
  detached?: boolean;
  defaultBranch?: string | null;
  /** Remote default used for root-vs-branch room routing; distinct from local fallback. */
  routingDefaultBranch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  changes?: RepoChangeSummary;
  branchDelta?: RepoBranchDelta | null;
  branchDeltas?: RepoBranchDelta[];
  dirty?: boolean;
  roomIdentifier?: string | null;
  roomSource?: "configured" | "git_remote" | "local_git" | "local_folder" | null;
  worktrees: RepoWorktreeEntry[];
}

export interface DesktopRepoWorktreeResult {
  worktreePath: string | null;
  branch: string | null;
  error: string | null;
}

export interface WorkerSnapshot {
  id: string;
  runtime: string;
  state: "not_started" | "starting" | "connected" | "away" | "offline" | "failed";
  roomId: string | null;
  actorLabel: string | null;
  agentKey: string | null;
  agentSessionId: string | null;
  detail: string;
}

export interface DiagnosticsSnapshot {
  apiUrl: string | null;
  localMode: "disabled";
  notes: string[];
}
