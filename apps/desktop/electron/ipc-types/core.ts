export interface DesktopAppInfo {
  appName: string;
  platform: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  workspaceRoot: string;
  workspaceRoomIdentifier: string | null;
  apiUrl: string | null;
}

export interface RepoWorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  isCurrent: boolean;
}

export interface RepoStatus {
  rootPath: string;
  branch: string | null;
  worktrees: RepoWorktreeEntry[];
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
