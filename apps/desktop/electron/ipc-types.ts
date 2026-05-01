export interface DesktopAppInfo {
  appName: string;
  platform: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  workspaceRoot: string;
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
  detail: string;
}

export interface DiagnosticsSnapshot {
  apiUrl: string | null;
  localMode: "disabled";
  notes: string[];
}

export interface DesktopRoomInfo {
  identifier: string;
  code: string;
  name: string;
  displayName: string;
  role: string;
  authenticated: boolean;
  kind: "main" | "focus";
  parentRoomId: string | null;
  focusKey: string | null;
  sourceTaskId: string | null;
  focusStatus: "active" | "concluded" | null;
}

export interface DesktopFocusRoomInfo {
  roomId: string;
  identifier: string;
  displayName: string;
  code: string | null;
  sourceTaskId: string | null;
  focusStatus: "active" | "concluded" | null;
  createdAt: string;
}

export interface DesktopTaskSummary {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  updatedAt: string;
}

export interface DesktopParticipantSummary {
  participantKey: string;
  kind: "human" | "agent";
  displayName: string;
  actorLabel: string | null;
  activityState: "active" | "away" | "offline" | null;
  lastSeenAt: string;
}

export interface DesktopActivityEntry {
  id: string;
  participantDisplayName: string;
  participantKind: "human" | "agent";
  activityState: "active" | "away" | "offline" | null;
  lastRoomActivityAt: string;
  currentTasks: Array<{
    id: string;
    title: string;
    status: string;
  }>;
  completedTasks: Array<{
    id: string;
    title: string;
    status: string;
  }>;
}

export interface DesktopRoomMessageReply {
  id: string;
  sender: string;
  text: string;
  timestamp: string;
}

export interface DesktopRoomMessage {
  id: string;
  sender: string;
  text: string;
  source: string | null;
  timestamp: string;
  actorLabel: string | null;
  replyTo: DesktopRoomMessageReply | null;
}

export interface DesktopRoomSnapshot {
  roomIdentifier: string | null;
  room: DesktopRoomInfo | null;
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
  participants: DesktopParticipantSummary[];
  recentActivity: DesktopActivityEntry[];
  messages: DesktopRoomMessage[];
}

export interface DesktopApi {
  app: {
    getInfo: () => Promise<DesktopAppInfo>;
  };
  room: {
    getSnapshot: (roomIdentifier?: string | null) => Promise<DesktopRoomSnapshot>;
  };
  repos: {
    getStatus: () => Promise<RepoStatus>;
  };
  workers: {
    list: () => Promise<WorkerSnapshot[]>;
  };
  diagnostics: {
    getSnapshot: () => Promise<DiagnosticsSnapshot>;
  };
}
