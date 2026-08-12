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
  repoBranch: string | null;
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
  agentSessionId?: string | null;
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
  agentSessionId?: string | null;
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
  repoBranch: string | null;
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
