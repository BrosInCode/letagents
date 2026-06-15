import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderSetupAction,
  DesktopManagedAgentSession,
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

export function isVisibleManagedAgentSession(
  session: DesktopManagedAgentSession,
): boolean {
  if (session.status === "failed" || session.status === "interrupted") {
    return false;
  }
  return session.canStop;
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
  if (provider?.id !== "codex") return null;
  return `${provider.runtimeCommand?.trim() || "codex"} login --device-auth`;
}

export function externalMcpProviderInstruction(
  provider: Pick<DesktopAgentProvider, "name"> | null | undefined,
): string {
  const name = provider?.name?.trim() || "this provider";
  return `Open ${name}, then ask it to join this room through the installed MCP bridge.`;
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

const LETAGENTS_CODENAME_EXAMPLES = "MapleRidge, CedarVista, DawnWinter, GardenFern, SilverHarbor";

export function externalMcpProviderJoinPrompt(
  provider: Pick<DesktopAgentProvider, "id" | "name" | "mcpTargetId"> | null | undefined,
  roomIdentifier: string | null | undefined,
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
    "Use the installed LetAgents MCP bridge.",
    joinInstruction,
    `Choose a short distinct LetAgents-style codename before doing any room work. Examples: ${LETAGENTS_CODENAME_EXAMPLES}.`,
    `Call set_agent_name with ${toolCallPayload({ name: "<your codename>" })} before posting status or registering.`,
    `Call register_agent_session with ${toolCallPayload({ session_kind: "worker", runtime, display_name: "<your codename>" })}.`,
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
  return armed ? "Confirm bridge install" : "Install LetAgents bridge";
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
  return `LetAgents will update ${name}'s MCP configuration to add the LetAgents bridge after confirmation.`;
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
