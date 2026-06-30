import type {
  DesktopAgentPresence,
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderSetupAction,
  DesktopManagedAgentSession,
  DesktopParticipantSummary,
  RepoStatus,
} from "../../../electron/ipc-types";
import { normalizeAgentKey } from "./agents";

export interface AgentSetupConfirmation {
  providerId: DesktopAgentProviderId;
  action: DesktopAgentProviderSetupAction;
}

export function hasDesktopManagedRuntime(
  provider: Pick<DesktopAgentProvider, "capabilities"> | null | undefined,
): boolean {
  return Boolean(provider?.capabilities.includes("desktop_managed_runtime"));
}

export function preferredManagedAgentRepoRootPath(
  repoStatus: Pick<RepoStatus, "rootPath" | "mainRootPath"> | null | undefined,
): string | null {
  const mainRootPath = String(repoStatus?.mainRootPath ?? "").trim();
  if (mainRootPath) {
    return mainRootPath;
  }
  const rootPath = String(repoStatus?.rootPath ?? "").trim();
  return rootPath || null;
}

export function isVisibleManagedAgentSession(
  session: DesktopManagedAgentSession,
): boolean {
  if (session.status === "failed" || session.status === "interrupted" || session.status === "unknown") {
    return false;
  }
  return session.canStop;
}

export function isDeliverableManagedAgentSession(
  session: DesktopManagedAgentSession,
): boolean {
  return isVisibleManagedAgentSession(session) &&
    Boolean(session.agentSessionId) &&
    (
      session.status === "running" ||
      (session.deliveryMode === "desktop_events" && session.status === "completed")
    );
}

export function canStopManagedAgentTurn(
  session: Pick<DesktopManagedAgentSession, "canStop" | "status"> | null | undefined,
): boolean {
  return Boolean(
    session?.canStop &&
    (session.status === "starting" || session.status === "running")
  );
}

export function normalizeManagedAgentRoomIdentifier(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

export function managedAgentSessionMatchesRoom(
  session: Pick<DesktopManagedAgentSession, "roomIdentifier">,
  roomIdentifier: string | null | undefined,
): boolean {
  const sessionRoom = normalizeManagedAgentRoomIdentifier(session.roomIdentifier);
  const targetRoom = normalizeManagedAgentRoomIdentifier(roomIdentifier);
  return Boolean(sessionRoom && targetRoom && sessionRoom === targetRoom);
}

export interface ManagedAgentTargetKeys {
  agentSessionId?: string | null;
  agentKey?: string | null;
  actorLabel?: string | null;
  displayName?: string | null;
  ideLabel?: string | null;
  ownerAttribution?: string | null;
}

export interface ManagedAgentWorkIndicator {
  id: string;
  displayName: string;
  summary: string;
  startedAt: string;
}

function specificAgentKey(value: string | null | undefined): string {
  const normalized = normalizeAgentKey(value);
  if (!normalized || !/[/:]/.test(normalized)) {
    return "";
  }
  return normalized;
}

export function managedAgentSessionMatchesTarget(
  session: Pick<DesktopManagedAgentSession, "agentSessionId" | "agentKey" | "actorLabel" | "displayName" | "ideLabel" | "ownerLabel">,
  target: ManagedAgentTargetKeys,
): boolean {
  const sessionKeys = [
    normalizeAgentKey(session.agentSessionId),
    specificAgentKey(session.agentKey),
    normalizeAgentKey(session.actorLabel),
  ].filter(Boolean);
  const targetKeys = [
    normalizeAgentKey(target.agentSessionId),
    specificAgentKey(target.agentKey),
    normalizeAgentKey(target.actorLabel),
  ].filter(Boolean);
  if (sessionKeys.some((key) => targetKeys.includes(key))) {
    return true;
  }

  const sessionDisplayName = normalizeAgentKey(session.displayName);
  const targetDisplayName = normalizeAgentKey(target.displayName);
  if (!sessionDisplayName || !targetDisplayName || sessionDisplayName !== targetDisplayName) {
    return false;
  }

  const sessionIdeLabel = normalizeAgentKey(session.ideLabel);
  const targetIdeLabel = normalizeAgentKey(target.ideLabel);
  if (sessionIdeLabel || targetIdeLabel) {
    return Boolean(sessionIdeLabel && targetIdeLabel && sessionIdeLabel === targetIdeLabel);
  }

  const sessionOwnerLabel = normalizeAgentKey(session.ownerLabel);
  const targetOwnerAttribution = normalizeAgentKey(target.ownerAttribution);
  return Boolean(
    sessionOwnerLabel &&
    targetOwnerAttribution &&
    targetOwnerAttribution.includes(sessionOwnerLabel),
  );
}

export function isExternalMcpProviderReady(
  provider: Pick<DesktopAgentProvider, "capabilities"> | null | undefined,
  preflight: Pick<DesktopAgentProviderPreflight, "status" | "mcpStatus"> | null | undefined,
): boolean {
  return Boolean(
    provider &&
    !hasDesktopManagedRuntime(provider) &&
    preflight?.status === "ready" &&
    preflight.mcpStatus === "installed",
  );
}

export function agentProviderNeedsDesktopRepo(
  provider: Pick<DesktopAgentProvider, "capabilities"> | null | undefined,
): boolean {
  return hasDesktopManagedRuntime(provider);
}

export function agentAuthCommand(
  provider: Pick<DesktopAgentProvider, "id" | "runtimeCommand"> | null | undefined,
): string | null {
  if (provider?.id === "claude-code") {
    return `${provider.runtimeCommand?.trim() || "claude"} auth login`;
  }
  if (provider?.id !== "codex") return null;
  return `${provider.runtimeCommand?.trim() || "codex"} login --device-auth`;
}

export function externalMcpProviderInstruction(
  provider: Pick<DesktopAgentProvider, "name"> | null | undefined,
): string {
  const name = provider?.name?.trim() || "this provider";
  return `Open ${name}, then ask it to join this room through the installed LetAgents connection.`;
}

function looksLikeLetAgentsInviteCode(value: string): boolean {
  return /^[a-z0-9]{4}(?:-[a-z0-9]{4})+$/i.test(value.trim());
}

function roomIdentifierForJoinPayload(value: string | null | undefined): string {
  const trimmed = String(value || "").trim();
  return looksLikeLetAgentsInviteCode(trimmed) ? trimmed.toUpperCase() : trimmed;
}

function toolCallPayload(payload: Record<string, string | number>): string {
  return JSON.stringify(payload);
}

function optionalRegisterPayload(input: {
  runtime: string;
  repoRootPath?: string | null;
}): Record<string, string> {
  const payload: Record<string, string> = {
    session_kind: "worker",
    runtime: input.runtime,
    display_name: "<your agent name>",
  };
  const cwd = input.repoRootPath?.trim();
  if (cwd) {
    payload.cwd = cwd;
  }
  return payload;
}

const LETAGENTS_CODENAME_EXAMPLES = "MapleRidge, CedarVista, DawnWinter, GardenFern, SilverHarbor";

export function externalMcpProviderJoinPrompt(
  provider: Pick<DesktopAgentProvider, "id" | "name" | "mcpTargetId"> | null | undefined,
  roomIdentifier: string | null | undefined,
  repoRootPath?: string | null,
): string {
  const name = provider?.name?.trim() || "this agent";
  const runtime = provider?.mcpTargetId?.trim() || provider?.id?.trim() || name.toLowerCase().replace(/\s+/g, "-");
  const room = roomIdentifierForJoinPayload(roomIdentifier);
  const joinInstruction = room
    ? looksLikeLetAgentsInviteCode(room)
      ? `Call join_code with ${toolCallPayload({ code: room, session_mode: "current" })}.`
      : `Call join_room with ${toolCallPayload({ name: room, session_mode: "current" })}.`
    : "Call join_room or join_code for this LetAgents room once you know the room target.";
  return [
    "Use the installed LetAgents connection.",
    joinInstruction,
    `Choose a short distinct LetAgents-style agent name before doing any room work. Examples: ${LETAGENTS_CODENAME_EXAMPLES}.`,
    `Call set_agent_name with ${toolCallPayload({ name: "<your agent name>" })} before posting status or registering.`,
    `Call register_agent_session with ${toolCallPayload(optionalRegisterPayload({ runtime, repoRootPath }))}.`,
    "Do not continue into the room loop until register_agent_session succeeds.",
    `Call post_status with ${toolCallPayload({ agent_session_id: "<returned agent_session_id>", status: "available in the room" })}.`,
    "Call read_messages once, then call get_board once.",
    "If get_board shows accepted unassigned work that is appropriate for you, claim it with claim_task using the returned agent_session_id.",
    `Stay connected by calling wait_for_messages with ${toolCallPayload({ agent_session_id: "<returned agent_session_id>", after_message_id: "<latest seen message id>", timeout: 30000 })} in a loop.`,
    "When messages arrive, update after_message_id to the newest processed message id, use send_message or send_thread_message with the same agent_session_id when useful, and keep waiting; an empty wait result just means continue waiting.",
    `Do not call yourself ${name}, ${name} 1, ${name} 2, or use any numbered provider label.`,
  ].join("\n");
}

export function isAgentSetupConfirmationActive(
  confirmation: AgentSetupConfirmation | null | undefined,
  providerId: DesktopAgentProviderId | null | undefined,
  action: DesktopAgentProviderSetupAction | null | undefined,
): boolean {
  return Boolean(
    confirmation &&
    providerId &&
    action &&
    confirmation.providerId === providerId &&
    confirmation.action === action,
  );
}

export function agentSetupActionButtonLabel(
  action: DesktopAgentProviderSetupAction,
  provider: Pick<DesktopAgentProvider, "name"> | null | undefined,
  armed: boolean,
  busy: boolean,
): string {
  if (busy) return "Installing...";
  if (action === "install_runtime") {
    const name = provider?.name?.trim() || "runtime";
    return armed ? `Confirm install ${name}` : `Install ${name}`;
  }
  return armed ? "Confirm connection install" : "Install LetAgents connection";
}

export function agentSetupConfirmationMessage(
  action: DesktopAgentProviderSetupAction,
  provider: Pick<DesktopAgentProvider, "id" | "name"> | null | undefined,
): string {
  const name = provider?.name?.trim() || "this provider";
  if (action === "install_runtime") {
    return provider?.id === "codex"
      ? "LetAgents will install the official Codex CLI runtime on this machine after confirmation."
      : `LetAgents will install the official ${name} runtime on this machine after confirmation.`;
  }
  return `LetAgents will update ${name}'s agent app configuration to add the LetAgents connection after confirmation.`;
}

export function managedAgentSessionStatusLabel(
  session: Pick<DesktopManagedAgentSession, "deliveryMode" | "status">,
): string {
  if (session.deliveryMode === "desktop_events" && session.status === "completed") {
    return "Waiting for events";
  }
  return session.status.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function managedAgentStopResultMessage(
  session: Pick<DesktopManagedAgentSession, "lastError" | "status">,
): string {
  if (session.lastError?.trim()) {
    return session.lastError.trim();
  }
  if (session.status === "unknown") {
    return "Codex turn state is unknown; refresh the agent to inspect it.";
  }
  if (session.status === "interrupted") {
    return "Codex worker stopped.";
  }
  return "Codex turn stopped.";
}

export function managedAgentStopResultNeedsAttention(
  session: Pick<DesktopManagedAgentSession, "lastError" | "status">,
): boolean {
  return Boolean(session.lastError?.trim() || session.status === "unknown");
}

export function managedAgentSessionDisplayName(
  session: Pick<DesktopManagedAgentSession, "displayName" | "actorLabel" | "runtime">,
): string {
  const chosenName = session.displayName?.trim() || session.actorLabel?.trim();
  if (chosenName) {
    return chosenName;
  }

  const runtime = session.runtime.trim();
  if (runtime && runtime.toLowerCase() !== "codex" && !runtime.toLowerCase().startsWith("codex:")) {
    return runtime;
  }

  return "Local agent";
}

export function activeManagedAgentWorkIndicators(
  sessions: readonly DesktopManagedAgentSession[],
  roomIdentifier: string | null | undefined,
): ManagedAgentWorkIndicator[] {
  return sessions
    .filter((session) =>
      managedAgentSessionMatchesRoom(session, roomIdentifier) &&
      Boolean(session.activeWork) &&
      session.status === "running"
    )
    .map((session) => ({
      id: `${session.id}:${session.activeWork?.eventId || session.activeWork?.startedAt || "work"}`,
      displayName: managedAgentSessionDisplayName(session),
      summary: session.activeWork?.summary?.trim() || "Working in the room.",
      startedAt: session.activeWork?.startedAt || session.updatedAt,
    }))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export function mergeDesktopManagedAgentParticipants(
  participants: readonly DesktopParticipantSummary[],
  sessions: readonly DesktopManagedAgentSession[],
  roomIdentifier: string | null | undefined,
): DesktopParticipantSummary[] {
  const merged = [...participants];
  for (const session of visibleManagedAgentSessionsForRoom(sessions, roomIdentifier)) {
    if (merged.some((participant) => participantMatchesManagedAgentSession(participant, session))) {
      continue;
    }
    merged.push(desktopManagedAgentSessionToParticipant(session));
  }
  return merged;
}

export function mergeDesktopManagedAgentPresence(
  presenceEntries: readonly DesktopAgentPresence[],
  sessions: readonly DesktopManagedAgentSession[],
  roomIdentifier: string | null | undefined,
): DesktopAgentPresence[] {
  const merged = [...presenceEntries];
  for (const session of visibleManagedAgentSessionsForRoom(sessions, roomIdentifier)) {
    const syntheticPresence = desktopManagedAgentSessionToPresence(session);
    const existingIndex = merged.findIndex((presence) =>
      presenceMatchesManagedAgentSession(presence, session)
    );
    if (existingIndex === -1) {
      merged.push(syntheticPresence);
      continue;
    }
    merged[existingIndex] = mergeManagedAgentPresenceEntry(merged[existingIndex], syntheticPresence);
  }
  return merged;
}

function visibleManagedAgentSessionsForRoom(
  sessions: readonly DesktopManagedAgentSession[],
  roomIdentifier: string | null | undefined,
): DesktopManagedAgentSession[] {
  return sessions.filter((session) =>
    managedAgentSessionMatchesRoom(session, roomIdentifier)
    && isDeliverableManagedAgentSession(session)
  );
}

function desktopManagedAgentSessionToParticipant(
  session: DesktopManagedAgentSession,
): DesktopParticipantSummary {
  const displayName = managedAgentSessionDisplayName(session);
  const actorLabel = managedAgentSessionActorLabel(session);
  const timestamp = managedAgentSessionTimestamp(session);
  const activityState = managedAgentSessionActivityState(session);
  return {
    participantKey: `desktop-managed-agent:${managedAgentSessionStableKey(session)}`,
    kind: "agent",
    displayName,
    actorLabel,
    agentKey: session.agentKey || managedAgentSessionAgentKey(session),
    githubLogin: null,
    ownerLabel: session.ownerLabel || "Local desktop",
    ideLabel: session.ideLabel || managedAgentSessionIdeLabel(session),
    hiddenAt: null,
    activityState,
    lastSeenAt: timestamp,
    lastRoomActivityAt: timestamp,
    lastLiveHeartbeatAt: timestamp,
    sourceFlags: ["delivery", "presence"],
  };
}

function desktopManagedAgentSessionToPresence(
  session: DesktopManagedAgentSession,
): DesktopAgentPresence {
  const displayName = managedAgentSessionDisplayName(session);
  const actorLabel = managedAgentSessionActorLabel(session);
  const timestamp = managedAgentSessionTimestamp(session);
  const sessionId = session.agentSessionId || session.id;
  return {
    roomId: session.roomIdentifier,
    actorLabel,
    agentKey: session.agentKey || managedAgentSessionAgentKey(session),
    agentInstanceId: null,
    agentSessionId: session.agentSessionId,
    sessionKind: "worker",
    runtime: session.runtime || session.providerId,
    displayName,
    ownerLabel: session.ownerLabel || "Local desktop",
    ideLabel: session.ideLabel || managedAgentSessionIdeLabel(session),
    repoBranch: session.repoBranch || null,
    status: managedAgentPresenceStatus(session),
    statusText: managedAgentSessionStatusLabel(session),
    lastHeartbeatAt: timestamp,
    freshness: "active",
    activityState: managedAgentSessionActivityState(session),
    sourceFlags: ["delivery", "presence"],
    livenessObservation: {
      roomId: session.roomIdentifier,
      agentSessionId: sessionId,
      source: "desktop_managed_agent",
      hostId: session.id,
      hostKind: "desktop",
      hostLabel: "This desktop",
      livenessCapability: session.deliveryMode === "desktop_events" ? "desktop events" : "mcp loop",
      toolBridgeId: `desktop:${session.providerId}:${session.id}`,
      lastObservedAt: timestamp,
      lastToolCallAt: null,
      detail: managedAgentRepoDetail(session),
      createdAt: session.startedAt || timestamp,
      updatedAt: timestamp,
    },
  };
}

export function managedAgentRepoDetail(
  session: Pick<DesktopManagedAgentSession, "repoBranch" | "repoRootPath">,
): string {
  const branch = session.repoBranch?.trim();
  return branch ? `${branch} - ${session.repoRootPath}` : session.repoRootPath;
}

function mergeManagedAgentPresenceEntry(
  existing: DesktopAgentPresence,
  managed: DesktopAgentPresence,
): DesktopAgentPresence {
  const sourceFlags = Array.from(new Set([...existing.sourceFlags, ...managed.sourceFlags]));
  return {
    ...existing,
    agentKey: existing.agentKey || managed.agentKey,
    agentSessionId: existing.agentSessionId || managed.agentSessionId,
    displayName: existing.displayName || managed.displayName,
    ownerLabel: existing.ownerLabel || managed.ownerLabel,
    ideLabel: existing.ideLabel || managed.ideLabel,
    runtime: existing.runtime || managed.runtime,
    repoBranch: existing.repoBranch || managed.repoBranch,
    status: existing.status === "idle" && managed.status !== "idle" ? managed.status : existing.status,
    statusText: existing.statusText || managed.statusText,
    lastHeartbeatAt: latestTimestampString(existing.lastHeartbeatAt, managed.lastHeartbeatAt),
    freshness: "active",
    activityState: existing.activityState === "offline" ? managed.activityState : existing.activityState,
    sourceFlags,
    livenessObservation: existing.livenessObservation || managed.livenessObservation,
  };
}

function participantMatchesManagedAgentSession(
  participant: DesktopParticipantSummary,
  session: DesktopManagedAgentSession,
): boolean {
  if (participant.kind !== "agent") return false;
  if (sameNormalized(participant.actorLabel, session.actorLabel)) return true;
  if (sameSpecificAgentKey(participant.agentKey, session.agentKey)) return true;
  if (!sameNormalized(participant.displayName, managedAgentSessionDisplayName(session))) return false;
  return Boolean(
    sameNormalized(participant.ideLabel, session.ideLabel)
    || sameNormalized(participant.ideLabel, managedAgentSessionIdeLabel(session))
    || sameNormalized(participant.ownerLabel, session.ownerLabel)
  );
}

function presenceMatchesManagedAgentSession(
  presence: DesktopAgentPresence,
  session: DesktopManagedAgentSession,
): boolean {
  if (presence.agentSessionId && session.agentSessionId && presence.agentSessionId === session.agentSessionId) {
    return true;
  }
  if (sameNormalized(presence.actorLabel, session.actorLabel)) return true;
  if (sameSpecificAgentKey(presence.agentKey, session.agentKey)) return true;
  if (!sameNormalized(presence.displayName, managedAgentSessionDisplayName(session))) return false;
  return Boolean(
    sameNormalized(presence.ideLabel, session.ideLabel)
    || sameNormalized(presence.ideLabel, managedAgentSessionIdeLabel(session))
    || sameNormalized(presence.ownerLabel, session.ownerLabel)
  );
}

function managedAgentSessionActorLabel(session: DesktopManagedAgentSession): string {
  return session.actorLabel?.trim() || session.displayName?.trim() || managedAgentSessionDisplayName(session);
}

function managedAgentSessionAgentKey(session: DesktopManagedAgentSession): string {
  const runtimeKey = normalizeAgentKey(session.runtime || session.providerId) || "agent";
  return `desktop/${runtimeKey}/${managedAgentSessionStableKey(session)}`;
}

function managedAgentSessionIdeLabel(session: Pick<DesktopManagedAgentSession, "providerId" | "runtime">): string {
  if (session.providerId === "codex") return "Codex";
  if (session.providerId === "claude-code") return "Claude Code";
  return session.runtime || session.providerId;
}

function managedAgentPresenceStatus(
  session: Pick<DesktopManagedAgentSession, "deliveryMode" | "status">,
): DesktopAgentPresence["status"] {
  if (session.status === "unknown") return "blocked";
  if (session.status === "completed" && session.deliveryMode === "desktop_events") return "idle";
  if (session.status === "completed") return "idle";
  return "working";
}

function managedAgentSessionActivityState(
  session: Pick<DesktopManagedAgentSession, "deliveryMode" | "status">,
): DesktopAgentPresence["activityState"] {
  return managedAgentPresenceStatus(session) === "idle" ? "away" : "active";
}

function managedAgentSessionTimestamp(
  session: Pick<DesktopManagedAgentSession, "startedAt" | "updatedAt">,
): string {
  return session.updatedAt || session.startedAt || new Date(0).toISOString();
}

function managedAgentSessionStableKey(session: DesktopManagedAgentSession): string {
  return normalizeAgentKey(
    session.agentSessionId
    || session.agentKey
    || session.actorLabel
    || session.displayName
    || session.id,
  ) || session.id;
}

function sameNormalized(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftKey = normalizeAgentKey(left);
  const rightKey = normalizeAgentKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function sameSpecificAgentKey(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftKey = specificAgentKey(left);
  const rightKey = specificAgentKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function latestTimestampString(left: string | null | undefined, right: string | null | undefined): string {
  const leftTime = Date.parse(String(left || ""));
  const rightTime = Date.parse(String(right || ""));
  if (Number.isNaN(leftTime)) return right || left || new Date(0).toISOString();
  if (Number.isNaN(rightTime)) return left || right || new Date(0).toISOString();
  return rightTime > leftTime ? String(right) : String(left);
}
