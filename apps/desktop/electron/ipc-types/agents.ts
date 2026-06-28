import type { DesktopMcpInstallTargetId } from "./setup.js";

export type DesktopAgentProviderId =
  | "claude-code"
  | "antigravity"
  | "cursor"
  | "codex"
  | (string & {});

export type DesktopAgentProviderCapability =
  | "external_mcp"
  | "desktop_managed_runtime"
  | "installable_runtime"
  | "auth_preflight"
  | "turn_control"
  | "reasoning_stream";

export type DesktopAgentProviderStatus =
  | "missing_runtime"
  | "runtime_installed"
  | "auth_required"
  | "bridge_required"
  | "repo_required"
  | "ready"
  | "running"
  | "error";

export type DesktopAgentProviderSetupAction =
  | "install_runtime"
  | "install_mcp_bridge";

export interface DesktopAgentProvider {
  id: DesktopAgentProviderId;
  name: string;
  description: string;
  capabilities: DesktopAgentProviderCapability[];
  runtimeCommand: string | null;
  mcpTargetId: DesktopMcpInstallTargetId;
}

export interface DesktopAgentProviderPreflightInput {
  roomIdentifier?: string | null;
  repoRootPath?: string | null;
}

export interface DesktopAgentProviderPreflight {
  providerId: DesktopAgentProviderId;
  status: DesktopAgentProviderStatus;
  canStart: boolean;
  message: string;
  detail: string | null;
  nextAction: DesktopAgentProviderSetupAction | "authenticate" | "choose_repo" | null;
  version: string | null;
  mcpStatus: "not_installed" | "installed" | "needs_attention" | null;
}

export interface DesktopAgentProviderSetupInput {
  action: DesktopAgentProviderSetupAction;
  confirmed?: boolean;
  roomIdentifier?: string | null;
  repoRootPath?: string | null;
}

export interface DesktopAgentProviderSetupResult {
  providerId: DesktopAgentProviderId;
  action: DesktopAgentProviderSetupAction;
  success: boolean;
  message: string;
  detail: string | null;
}

export type DesktopManagedAgentSessionStatus =
  | "starting"
  | "running"
  | "completed"
  | "interrupted"
  | "failed"
  | "unknown";

export type DesktopManagedAgentDeliveryMode =
  | "mcp_polling"
  | "desktop_events";

export interface DesktopManagedAgentActiveWork {
  kind: "message" | "task_update";
  eventId: string | null;
  startedAt: string;
  summary: string | null;
}

export interface DesktopManagedAgentSession {
  id: string;
  providerId: DesktopAgentProviderId;
  runtime: string;
  roomIdentifier: string;
  roomDisplayName: string | null;
  repoRootPath: string;
  repoBranch: string | null;
  status: DesktopManagedAgentSessionStatus;
  deliveryMode: DesktopManagedAgentDeliveryMode;
  canStop: boolean;
  agentSessionId: string | null;
  actorLabel: string | null;
  agentKey: string | null;
  displayName: string | null;
  ownerLabel: string | null;
  ideLabel: string | null;
  reasoningSessionId: string | null;
  activeWork: DesktopManagedAgentActiveWork | null;
  startedAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface DesktopManagedAgentStartInput {
  providerId: DesktopAgentProviderId;
  roomIdentifier: string;
  roomDisplayName?: string | null;
  repoRootPath: string;
  deliveryMode?: DesktopManagedAgentDeliveryMode;
  stopPhrase?: string | null;
  maxMinutes?: number | null;
}

export interface DesktopManagedAgentStartResult {
  session: DesktopManagedAgentSession;
  reused: boolean;
  message: string;
}

export interface DesktopManagedAgentStopInput {
  sessionId?: string | null;
  roomIdentifier?: string | null;
  stopMode?: "turn" | "worker";
  shutdownServer?: boolean;
}

export interface DesktopManagedAgentInspectResult {
  session: DesktopManagedAgentSession;
  serverReachable: boolean;
  recentItems: Array<Record<string, unknown>>;
}
