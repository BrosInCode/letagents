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

/**
 * The shell request version is authoritative. Two requests may intentionally
 * have identical presentation/session fields, so those fields alone cannot
 * decide whether modal-local operations should survive.
 */
export function agentInspectorRequestResetKey(
  selection: AgentInspectorSelection | null,
  inspectorRequestVersion: number,
): string {
  return JSON.stringify([
    inspectorRequestVersion,
    selection?.kind ?? null,
    selection?.kind === "supervised" ? selection.supervisorEntryId : null,
    selection?.kind === "unavailable" ? selection.unavailableReason : null,
    selection?.messageId ?? null,
    selection?.clientMessageId ?? null,
    selection?.messageSource ?? null,
    selection?.agentSessionId ?? null,
    selection?.agentKey ?? null,
    selection?.actorLabel ?? null,
    selection?.displayName ?? null,
    selection?.sender ?? null,
  ]);
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

/**
 * A daemon-owned final-answer publication is the strongest Chat identity
 * available: it binds one canonical room message directly to one durable
 * supervisor entry without consulting mutable labels or provider metadata.
 */
export function resolveSupervisorEntryIdForPublishedMessage(
  entries: readonly Pick<DesktopSupervisorManifestEntry, "id" | "deliveryReceipts">[],
  identity: Pick<AgentModalTarget, "messageId" | "clientMessageId">,
): SupervisorIdentityResolution {
  const canonicalMessageId = exactIdentity(identity.messageId);
  const clientMessageId = exactIdentity(identity.clientMessageId);
  if (!canonicalMessageId && !clientMessageId) return { state: "unmatched" };
  const matches = entries.filter((entry) =>
    entry.deliveryReceipts?.some((receipt) =>
      (canonicalMessageId && exactIdentity(receipt.canonicalMessageId) === canonicalMessageId)
      || (clientMessageId && exactIdentity(receipt.replyClientMessageId) === clientMessageId)));
  if (matches.length > 1) return { state: "ambiguous" };
  return matches.length === 1
    ? { state: "matched", entryId: matches[0]!.id }
    : { state: "unmatched" };
}

export function supervisedAgentInspectorSelection(
  entry: Pick<DesktopSupervisorManifestEntry, "id" | "displayName" | "agentKey" | "agentSessionId" | "provider">,
  presentation: Partial<AgentModalTarget> = {},
): Extract<AgentInspectorSelection, { kind: "supervised" }> {
  const displayName = presentation.displayName?.trim() || entry.displayName;
  return {
    kind: "supervised",
    supervisorEntryId: entry.id,
    messageId: presentation.messageId ?? null,
    clientMessageId: presentation.clientMessageId ?? null,
    messageSource: presentation.messageSource ?? null,
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

export function resolvingAgentInspectorRequest(target: AgentModalTarget): AgentInspectorRequest {
  return { kind: "resolving", target };
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
  const resolution = resolveAgentInspectorManagedSession(sessions, selection);
  return resolution.state === "matched" ? [resolution.session] : [];
}

export type AgentInspectorManagedSessionResolution =
  | { state: "matched"; session: DesktopManagedAgentSession }
  | { state: "unmatched" }
  | { state: "ambiguous" };

/**
 * Resolve one control-bearing local session without collapsing ambiguity into
 * "external". Display labels and provider labels are deliberately excluded.
 */
export function resolveAgentInspectorManagedSession(
  sessions: readonly DesktopManagedAgentSession[],
  selection: AgentInspectorSelection | null,
): AgentInspectorManagedSessionResolution {
  if (!selection) return { state: "unmatched" };
  if (selection.kind === "supervised") {
    const matches = sessions.filter((session) => session.supervisorEntryId === selection.supervisorEntryId);
    if (matches.length > 1) return { state: "ambiguous" };
    return matches.length === 1 ? { state: "matched", session: matches[0]! } : { state: "unmatched" };
  }
  if (selection.kind !== "external") return { state: "unmatched" };

  const sessionId = exactIdentity(selection.agentSessionId);
  const agentKey = exactIdentity(selection.agentKey);
  const specificAgentKey = agentKey && /[/:]/.test(agentKey) ? agentKey : null;
  if (!sessionId && !specificAgentKey) return { state: "unmatched" };

  const sessionMatches = sessionId
    ? sessions.filter((session) => exactIdentity(session.agentSessionId) === sessionId)
    : [];
  const keyMatches = specificAgentKey
    ? sessions.filter((session) => exactIdentity(session.agentKey) === specificAgentKey)
    : [];
  if (sessionMatches.length > 1 || keyMatches.length > 1) return { state: "ambiguous" };
  if (sessionId && specificAgentKey) {
    if (sessionMatches.length === 0 && keyMatches.length === 0) return { state: "unmatched" };
    if (sessionMatches.length !== 1 || keyMatches.length !== 1) return { state: "ambiguous" };
    return sessionMatches[0]!.id === keyMatches[0]!.id
      ? { state: "matched", session: sessionMatches[0]! }
      : { state: "ambiguous" };
  }
  if (sessionId) {
    return sessionMatches.length === 1
      ? { state: "matched", session: sessionMatches[0]! }
      : { state: "unmatched" };
  }
  return keyMatches.length === 1
    ? { state: "matched", session: keyMatches[0]! }
    : { state: "unmatched" };
}

export function resolveAgentInspectorSelection(
  resource: SupervisorEntriesResource,
  request: AgentInspectorRequest,
  roomId: string,
): AgentInspectorSelection {
  const target = request.target;
  if (resource.roomIdentifier !== roomId) return { ...target, kind: "resolving" };
  if (request.kind === "resolving") return { ...target, kind: "resolving" };
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

  const publicationResolution = resolveSupervisorEntryIdForPublishedMessage(
    roomEntries,
    target,
  );
  const stableIdentityResolution = resolveSupervisorEntryId(roomEntries, {
    agentSessionId: target.agentSessionId,
    agentKey: target.agentKey,
  });
  const resolutions = [
    publicationResolution,
    stableIdentityResolution,
  ];
  if (resolutions.some((resolution) => resolution.state === "ambiguous")) {
    return { ...target, kind: "unavailable", unavailableReason: "ambiguous" };
  }
  const resolvedEntryIds = new Set(
    resolutions
      .filter((resolution): resolution is Extract<SupervisorIdentityResolution, { state: "matched" }> =>
        resolution.state === "matched")
      .map((resolution) => resolution.entryId),
  );
  if (resolvedEntryIds.size > 1) {
    return { ...target, kind: "unavailable", unavailableReason: "ambiguous" };
  }
  const resolvedEntryId = [...resolvedEntryIds][0];
  if (resolvedEntryId) {
    return { ...target, kind: "supervised", supervisorEntryId: resolvedEntryId };
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
