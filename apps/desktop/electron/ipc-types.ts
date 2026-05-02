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

export type DesktopMcpInstallTargetId = "claude-code" | "antigravity" | "cursor" | "codex";

export interface DesktopMcpInstallTarget {
  id: DesktopMcpInstallTargetId;
  name: string;
  description: string;
  configPath: string;
  status: "not_installed" | "installed" | "needs_attention";
  lastInstalledAt: string | null;
  restartHint: string;
}

export interface DesktopMcpInstallState {
  completed: boolean;
  completedAt: string | null;
  selectedTargetId: DesktopMcpInstallTargetId | null;
  targets: DesktopMcpInstallTarget[];
}

export interface DesktopMcpInstallResult {
  success: boolean;
  target: DesktopMcpInstallTarget;
  installState: DesktopMcpInstallState;
  message: string;
}

export interface DesktopMcpInstallManyResult {
  success: boolean;
  targets: DesktopMcpInstallTarget[];
  installState: DesktopMcpInstallState;
  message: string;
}

export interface DesktopAuthAccount {
  id: string;
  provider: string;
  providerUserId: string;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface DesktopPendingDeviceAuth {
  requestId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
  roomIdentifier: string | null;
  startedAt: string;
}

export interface DesktopAuthStatus {
  authenticated: boolean;
  account: DesktopAuthAccount | null;
  pendingDeviceAuth: DesktopPendingDeviceAuth | null;
  apiUrl: string | null;
  tokenStored: boolean;
  error: string | null;
}

export interface DesktopAuthStartResult {
  pendingDeviceAuth: DesktopPendingDeviceAuth;
  authStatus: DesktopAuthStatus;
}

export interface DesktopAuthPollResult {
  status: "pending" | "slow_down" | "authorized" | "denied" | "expired" | "unknown";
  intervalSeconds: number | null;
  expiresInSeconds: number | null;
  authStatus: DesktopAuthStatus;
  error: string | null;
}

export interface DesktopRoomAccess {
  status: "ready" | "missing_room" | "auth_required" | "forbidden" | "unavailable";
  title: string;
  message: string;
  roomIdentifier: string | null;
  deviceFlowUrl: string | null;
  code: string | null;
  httpStatus: number | null;
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
  access: DesktopRoomAccess;
  room: DesktopRoomInfo | null;
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
  participants: DesktopParticipantSummary[];
  recentActivity: DesktopActivityEntry[];
  messages: DesktopRoomMessage[];
}

export interface DesktopRepoRoomSelection {
  canceled: boolean;
  repoPath: string | null;
  roomIdentifier: string | null;
  source: "configured" | "git_remote" | "local_fallback" | null;
  snapshot: DesktopRoomSnapshot | null;
  error: string | null;
  warning: string | null;
}

export interface DesktopApi {
  app: {
    getInfo: () => Promise<DesktopAppInfo>;
  };
  room: {
    getSnapshot: (roomIdentifier?: string | null) => Promise<DesktopRoomSnapshot>;
  };
  auth: {
    getStatus: () => Promise<DesktopAuthStatus>;
    startDeviceFlow: (roomIdentifier?: string | null) => Promise<DesktopAuthStartResult>;
    pollDeviceFlow: (requestId?: string | null) => Promise<DesktopAuthPollResult>;
    openVerification: (url: string) => Promise<void>;
    signOut: () => Promise<DesktopAuthStatus>;
  };
  setup: {
    getMcpInstallState: () => Promise<DesktopMcpInstallState>;
    installMcpServer: (targetId: DesktopMcpInstallTargetId) => Promise<DesktopMcpInstallResult>;
    installMcpServers: (targetIds: DesktopMcpInstallTargetId[]) => Promise<DesktopMcpInstallManyResult>;
    completeMcpOnboarding: () => Promise<DesktopMcpInstallState>;
  };
  repos: {
    getStatus: () => Promise<RepoStatus>;
    pickRoom: () => Promise<DesktopRepoRoomSelection>;
  };
  workers: {
    list: () => Promise<WorkerSnapshot[]>;
  };
  diagnostics: {
    getSnapshot: () => Promise<DiagnosticsSnapshot>;
  };
}
