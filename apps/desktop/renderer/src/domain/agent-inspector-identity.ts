import type {
  DesktopManagedAgentSession,
  DesktopSupervisorManifestEntry,
} from "../../../electron/ipc-types";
import type {
  AgentInspectorSelection,
  AgentInspectorRequest,
  AgentModalTarget,
} from "../components/desktop/content/desktop-chat-message/types";

export type SupervisorEntriesResource =
  | { state: "loading"; roomIdentifier: string; updatedAt: string | null; data: readonly DesktopSupervisorManifestEntry[]; error: null }
  | { state: "refreshing"; roomIdentifier: string; updatedAt: string | null; data: readonly DesktopSupervisorManifestEntry[]; error: null }
  | { state: "ready"; roomIdentifier: string; updatedAt: string; data: readonly DesktopSupervisorManifestEntry[]; error: null }
  | { state: "error"; roomIdentifier: string; updatedAt: string | null; data: readonly DesktopSupervisorManifestEntry[]; error: string };

export interface AgentInspectorSupervisorEntryUpdate {
  entry: DesktopSupervisorManifestEntry;
  roomIdentifier: string;
  inspectorRequestVersion: number;
}

export interface AgentInspectorOperationContext {
  modalStateVersion: number;
  roomIdentifier: string;
  inspectorRequestVersion: number;
}

export interface AgentInspectorOperationToken {
  operationId: string;
  entryId: string;
  providerActionId: string | null;
  context: AgentInspectorOperationContext;
}

/**
 * Async inspector controls may finish after close/reopen, room navigation, or
 * a different control beginning. Only the exact still-active operation may
 * mutate UI state or release the in-flight lock.
 */
export function isCurrentAgentInspectorOperation(
  expected: AgentInspectorOperationToken,
  current: AgentInspectorOperationToken | null,
  context: AgentInspectorOperationContext,
  active: boolean,
): boolean {
  return active
    && current?.operationId === expected.operationId
    && current.entryId === expected.entryId
    && current.providerActionId === expected.providerActionId
    && context.modalStateVersion === expected.context.modalStateVersion
    && context.roomIdentifier === expected.context.roomIdentifier
    && context.inspectorRequestVersion === expected.context.inspectorRequestVersion;
}

export function isCurrentAgentInspectorSupervisorUpdate(
  update: AgentInspectorSupervisorEntryUpdate,
  currentRoomIdentifier: string,
  currentInspectorRequestVersion: number,
): boolean {
  return update.roomIdentifier === currentRoomIdentifier
    && update.entry.roomId === currentRoomIdentifier
    && update.inspectorRequestVersion === currentInspectorRequestVersion;
}

export interface ExactSupervisorIdentity {
  agentSessionId: string | null;
  agentKey: string | null;
}

export type SupervisorIdentityResolution =
  | { state: "matched"; entryId: string }
  | { state: "unmatched" }
  | { state: "ambiguous" };

function exactIdentity(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

/**
 * Resolve only server/daemon-owned stable identity. The argument deliberately
 * cannot carry displayName, sender, or actorLabel, keeping presentation labels
 * out of the durable identity join at the type boundary.
 */
export function resolveSupervisorEntryId(
  entries: readonly Pick<DesktopSupervisorManifestEntry, "id" | "agentSessionId" | "agentKey">[],
  identity: ExactSupervisorIdentity,
): SupervisorIdentityResolution {
  const sessionId = exactIdentity(identity.agentSessionId);
  const agentKey = exactIdentity(identity.agentKey);
  const specificAgentKey = agentKey && /[/:]/.test(agentKey) ? agentKey : null;
  const sessionMatches = sessionId
    ? entries.filter((entry) => exactIdentity(entry.agentSessionId) === sessionId)
    : [];
  const keyMatches = specificAgentKey
    ? entries.filter((entry) => exactIdentity(entry.agentKey) === specificAgentKey)
    : [];

  if (sessionMatches.length > 1 || keyMatches.length > 1) return { state: "ambiguous" };
  if (sessionMatches.length === 1 && keyMatches.length === 1 && sessionMatches[0]!.id !== keyMatches[0]!.id) {
    return { state: "ambiguous" };
  }
  if (sessionId) {
    if (sessionMatches.length === 1) return { state: "matched", entryId: sessionMatches[0]!.id };
  }
  if (keyMatches.length === 1) return { state: "matched", entryId: keyMatches[0]!.id };
  return { state: "unmatched" };
}

export function supervisedAgentInspectorSelection(
  entry: Pick<DesktopSupervisorManifestEntry, "id" | "displayName" | "agentKey" | "agentSessionId" | "provider">,
  presentation: Partial<AgentModalTarget> = {},
): Extract<AgentInspectorSelection, { kind: "supervised" }> {
  const displayName = presentation.displayName?.trim() || entry.displayName;
  return {
    kind: "supervised",
    supervisorEntryId: entry.id,
    actorLabel: presentation.actorLabel ?? null,
    displayName,
    ownerAttribution: presentation.ownerAttribution ?? null,
    ideLabel: presentation.ideLabel ?? entry.provider,
    sender: presentation.sender?.trim() || displayName,
    agentKey: entry.agentKey ?? null,
    agentSessionId: entry.agentSessionId,
  };
}

export function supervisedAgentInspectorRequest(
  entry: Pick<DesktopSupervisorManifestEntry, "id" | "displayName" | "agentKey" | "agentSessionId" | "provider">,
  presentation: Partial<AgentModalTarget> = {},
): AgentInspectorRequest {
  const selection = supervisedAgentInspectorSelection(entry, presentation);
  const { kind: _kind, supervisorEntryId, ...target } = selection;
  return { kind: "supervised", supervisorEntryId, target };
}

export function participantAgentInspectorRequest(target: AgentModalTarget): AgentInspectorRequest {
  return { kind: "participant", target };
}

/**
 * Resolve control-bearing local sessions using only exact durable identity.
 * Presentation and reasoning relationships are intentionally excluded: they
 * may help render context, but they must never grant stop/retry/permission
 * controls. Duplicates and disagreeing session/key identities fail closed.
 */
export function resolveAgentInspectorManagedSessions(
  sessions: readonly DesktopManagedAgentSession[],
  selection: AgentInspectorSelection | null,
): DesktopManagedAgentSession[] {
  if (!selection) return [];
  if (selection.kind === "supervised") {
    const matches = sessions.filter((session) => session.supervisorEntryId === selection.supervisorEntryId);
    return matches.length === 1 ? matches : [];
  }
  if (selection.kind !== "external") return [];

  const sessionId = exactIdentity(selection.agentSessionId);
  const agentKey = exactIdentity(selection.agentKey);
  const specificAgentKey = agentKey && /[/:]/.test(agentKey) ? agentKey : null;
  if (!sessionId && !specificAgentKey) return [];

  const sessionMatches = sessionId
    ? sessions.filter((session) => exactIdentity(session.agentSessionId) === sessionId)
    : [];
  const keyMatches = specificAgentKey
    ? sessions.filter((session) => exactIdentity(session.agentKey) === specificAgentKey)
    : [];
  if (sessionMatches.length > 1 || keyMatches.length > 1) return [];
  if (sessionId && specificAgentKey) {
    if (sessionMatches.length !== 1 || keyMatches.length !== 1) return [];
    return sessionMatches[0]!.id === keyMatches[0]!.id ? [sessionMatches[0]!] : [];
  }
  if (sessionId) return sessionMatches.length === 1 ? sessionMatches : [];
  return keyMatches.length === 1 ? keyMatches : [];
}

export function resolveAgentInspectorSelection(
  resource: SupervisorEntriesResource,
  request: AgentInspectorRequest,
  roomId: string,
): AgentInspectorSelection {
  const target = request.target;
  if (resource.roomIdentifier !== roomId) return { ...target, kind: "resolving" };
  const roomEntries = resource.data.filter((entry) => entry.roomId === roomId);
  if (request.kind === "supervised") {
    const entry = roomEntries.find((candidate) => candidate.id === request.supervisorEntryId);
    if (entry) return { ...target, kind: "supervised", supervisorEntryId: entry.id };
    if (resource.state === "ready") {
      return { ...target, kind: "unavailable", unavailableReason: "missing" };
    }
    if (resource.state === "error") {
      return { ...target, kind: "unavailable", unavailableReason: "load_error", unavailableDetail: resource.error };
    }
    return { ...target, kind: "resolving" };
  }

  const resolution = resolveSupervisorEntryId(roomEntries, {
    agentSessionId: target.agentSessionId,
    agentKey: target.agentKey,
  });
  if (resolution.state === "matched") {
    return { ...target, kind: "supervised", supervisorEntryId: resolution.entryId };
  }
  if (resolution.state === "ambiguous") {
    return { ...target, kind: "unavailable", unavailableReason: "ambiguous" };
  }

  // Only a completed list operation can authoritatively classify the target
  // as external. Loading and an initial failure remain visibly unresolved.
  if (resource.state === "ready") {
    return { ...target, kind: "external" };
  }
  if (resource.state === "error") {
    return { ...target, kind: "unavailable", unavailableReason: "load_error", unavailableDetail: resource.error };
  }
  return { ...target, kind: "resolving" };
}
