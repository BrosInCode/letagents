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
  description: string | null;
  status: string;
  assignee: string | null;
  assigneeAgentKey: string | null;
  createdBy: string | null;
  prUrl: string | null;
  workflowArtifacts: Array<{
    provider: string;
    kind: string;
    id: string | null;
    number: number | null;
    title: string | null;
    url: string | null;
    ref: string | null;
    state: string | null;
  }>;
  workflowRefs: Array<{
    provider: string;
    kind: string;
    label: string;
    url: string;
  }>;
  activeLeases: Array<{
    id: string;
    kind: "work" | "review" | string;
    holderLabel: string | null;
    agentKey: string | null;
    agentSessionId: string | null;
    status: string;
    updatedAt: string | null;
  }>;
  activeLocks: Array<{
    id: string;
    scope: "room" | "task" | string;
    reason: string | null;
    message: string | null;
    createdBy: string | null;
  }>;
  stalePromptState: {
    isStale: boolean;
    reason: string | null;
    staleForMs: number | null;
    muted: boolean;
    mutedBy: string | null;
    mutedAt: string | null;
  } | null;
  createdAt: string | null;
  updatedAt: string;
}

export interface DesktopTaskMutationResult {
  task: DesktopTaskSummary;
}

export interface DesktopTaskLeaseActionInput {
  action: "release" | "handoff";
  lease_id?: string | null;
  target_actor_key?: string | null;
  target_actor_instance_id?: string | null;
  target_agent_session_id?: string | null;
  reason?: string | null;
}

export interface DesktopTaskReviewLeaseActionInput {
  action: "assign" | "claim" | "release";
  lease_id?: string | null;
  target_actor_key?: string | null;
  target_actor_instance_id?: string | null;
  target_agent_session_id?: string | null;
  reason?: string | null;
}

export interface DesktopTaskWorkerActionInput {
  action: "claim" | "start" | "block" | "resume" | "submit_review";
  reason?: string | null;
}

export interface DesktopTaskReviewWorkerActionInput {
  action: "claim" | "release";
  lease_id?: string | null;
  reason?: string | null;
}

export interface DesktopParticipantSummary {
  participantKey: string;
  kind: "human" | "agent";
  displayName: string;
  actorLabel: string | null;
  agentKey: string | null;
  githubLogin: string | null;
  ownerLabel: string | null;
  ideLabel: string | null;
  hiddenAt: string | null;
  activityState: "active" | "away" | "offline" | null;
  lastSeenAt: string;
  lastRoomActivityAt: string | null;
  lastLiveHeartbeatAt: string | null;
  sourceFlags: Array<"delivery" | "presence" | "messages" | "tasks">;
}

export interface DesktopAgentPresence {
  roomId: string;
  actorLabel: string;
  agentKey: string | null;
  agentInstanceId: string | null;
  agentSessionId: string | null;
  sessionKind: "controller" | "worker";
  runtime: string;
  displayName: string;
  ownerLabel: string | null;
  ideLabel: string | null;
  status: "idle" | "working" | "reviewing" | "blocked";
  statusText: string | null;
  lastHeartbeatAt: string;
  freshness: "active" | "stale";
  activityState: "active" | "away" | "offline";
  sourceFlags: Array<"delivery" | "presence" | "messages" | "tasks">;
  livenessObservation: {
    roomId: string;
    agentSessionId: string;
    source: string;
    hostId: string | null;
    hostKind: string | null;
    hostLabel: string | null;
    livenessCapability: string;
    toolBridgeId: string | null;
    lastObservedAt: string;
    lastToolCallAt: string | null;
    detail: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
}

export interface DesktopReasoningSnapshot {
  summary: string;
  goal?: string | null;
  checking?: string | null;
  hypothesis?: string | null;
  blocker?: string | null;
  next_action?: string | null;
  milestone?: string | null;
  status?: string | null;
  confidence?: number | null;
}

export interface DesktopReasoningSession {
  id: string;
  roomId: string | null;
  actorLabel: string | null;
  agentKey: string | null;
  taskId: string | null;
  title: string | null;
  status: string | null;
  summary: string | null;
  latestPayload: DesktopReasoningSnapshot | null;
  goal: string | null;
  checking: string | null;
  hypothesis: string | null;
  blocker: string | null;
  nextAction: string | null;
  milestone: string | null;
  confidence: number | null;
  closedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DesktopReasoningUpdate {
  id: string;
  roomId: string | null;
  sessionId: string | null;
  actorLabel: string | null;
  status: string | null;
  summary: string | null;
  milestone: string | null;
  payload: DesktopReasoningSnapshot | null;
  createdAt: string | null;
}

export interface DesktopReasoningSessionDetail {
  session: DesktopReasoningSession;
  updates: DesktopReasoningUpdate[];
}

export interface DesktopActivityEntry {
  id: string;
  room: {
    id: string;
    displayName: string;
    kind: "main" | "focus";
    focusStatus: "active" | "concluded" | null;
    sourceTaskId: string | null;
  } | null;
  participantDisplayName: string;
  participantKind: "human" | "agent";
  participantActorLabel: string | null;
  participantOwnerLabel: string | null;
  participantIdeLabel: string | null;
  activityState: "active" | "away" | "offline" | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastRoomActivityAt: string;
  messageCount: number;
  reasoningSessionCount: number;
  currentTasks: Array<{
    id: string;
    title: string;
    status: string;
    updatedAt: string | null;
    workflowRefs: Array<{
      provider: string;
      kind: string;
      label: string;
      url: string;
    }>;
  }>;
  completedTasks: Array<{
    id: string;
    title: string;
    status: string;
    updatedAt: string | null;
    workflowRefs: Array<{
      provider: string;
      kind: string;
      label: string;
      url: string;
    }>;
  }>;
  createdTasks: Array<{
    id: string;
    title: string;
    status: string;
    updatedAt: string | null;
    workflowRefs: Array<{
      provider: string;
      kind: string;
      label: string;
      url: string;
    }>;
  }>;
}

export interface DesktopRoomMessageReply {
  id: string;
  sender: string;
  text: string;
  source: string | null;
  timestamp: string;
}

export interface DesktopRoomMessageAttachment {
  id: string | null;
  name: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  url: string | null;
  downloadUrl: string | null;
  dataUrl: string | null;
  contentBase64: string | null;
}

export interface DesktopRoomMessage {
  id: string;
  sender: string;
  text: string;
  attachments: DesktopRoomMessageAttachment[];
  agentPromptKind: string | null;
  source: string | null;
  timestamp: string;
  actorLabel: string | null;
  agentIdentity: {
    name: string | null;
    displayName: string | null;
    ownerLabel: string | null;
    ownerAttribution: string | null;
    ideLabel: string | null;
    actorLabel: string | null;
  } | null;
  replyTo: DesktopRoomMessageReply | null;
}

export interface DesktopGitHubIntegrationStatus {
  roomId: string;
  accessRoomId: string | null;
  configured: boolean;
  setupManifestAvailable: boolean;
  connected: boolean;
  installUrlAvailable: boolean;
  repository: { fullName: string } | null;
}

export interface DesktopGitHubIntegrationActionResult {
  opened: boolean;
  message: string;
}

export interface DesktopRoomSnapshot {
  roomIdentifier: string | null;
  access: DesktopRoomAccess;
  room: DesktopRoomInfo | null;
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
  participants: DesktopParticipantSummary[];
  participantHiddenCount: number;
  presence: DesktopAgentPresence[];
  reasoningSessions: DesktopReasoningSession[];
  recentActivity: DesktopActivityEntry[];
  messages: DesktopRoomMessage[];
}

export interface DesktopSendRoomMessageResult {
  message: DesktopRoomMessage;
}

export interface DesktopRoomMessagesPage {
  messages: DesktopRoomMessage[];
  hasOlder: boolean;
}

export type DesktopRoomStreamEvent =
  | {
      type: "open";
      roomIdentifier: string;
    }
  | {
      type: "message";
      roomIdentifier: string;
      message: DesktopRoomMessage;
    }
  | {
      type: "task_update";
      roomIdentifier: string;
      task: DesktopTaskSummary;
    }
  | {
      type: "reasoning_update";
      roomIdentifier: string;
      session: DesktopReasoningSession;
    }
  | {
      type: "reasoning_remove";
      roomIdentifier: string;
      sessionId: string;
    }
  | {
      type: "session_disconnect" | "error";
      roomIdentifier: string;
      message: string | null;
    };

export interface DesktopStagedAttachment {
  uploadId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  previewDataUrl: string | null;
}

export interface DesktopDroppedAttachmentContent {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentBase64: string;
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
    getMessagesBefore: (roomIdentifier: string, beforeMessageId: string, limit?: number) => Promise<DesktopRoomMessagesPage>;
    getReasoningSession: (roomIdentifier: string, sessionId: string) => Promise<DesktopReasoningSessionDetail>;
    pickAttachments: (roomIdentifier: string) => Promise<DesktopStagedAttachment[]>;
    stageDroppedAttachmentContents?: (
      roomIdentifier: string,
      files: DesktopDroppedAttachmentContent[]
    ) => Promise<DesktopStagedAttachment[]>;
    discardAttachment: (roomIdentifier: string, uploadId: string) => Promise<void>;
    startStream: (roomIdentifier: string, afterMessageId?: string | null) => Promise<void>;
    stopStream: (roomIdentifier?: string | null) => Promise<void>;
    onStreamEvent: (callback: (event: DesktopRoomStreamEvent) => void) => () => void;
    sendMessage: (
      roomIdentifier: string,
      text: string,
      replyTo?: string | null,
      attachments?: Array<{ upload_id: string }>
    ) => Promise<DesktopSendRoomMessageResult>;
    addTask: (roomIdentifier: string, title: string) => Promise<DesktopTaskMutationResult>;
    updateTask: (
      roomIdentifier: string,
      taskId: string,
      updates: { status?: string; assignee?: string | null; pr_url?: string | null }
    ) => Promise<DesktopTaskMutationResult>;
    updateTaskLease: (
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskLeaseActionInput
    ) => Promise<DesktopTaskMutationResult>;
    updateTaskReviewLease: (
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskReviewLeaseActionInput
    ) => Promise<DesktopTaskMutationResult>;
    runTaskWorkerAction: (
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskWorkerActionInput
    ) => Promise<DesktopTaskMutationResult>;
    runTaskReviewWorkerAction: (
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskReviewWorkerActionInput
    ) => Promise<DesktopTaskMutationResult>;
    rename: (roomIdentifier: string, displayName: string) => Promise<DesktopRoomInfo>;
    getGitHubIntegrationStatus: (roomIdentifier: string) => Promise<DesktopGitHubIntegrationStatus>;
    openGitHubInstall: (roomIdentifier: string) => Promise<DesktopGitHubIntegrationActionResult>;
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
