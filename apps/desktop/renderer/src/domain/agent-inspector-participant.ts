import type {
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentPermissionRequest,
  DesktopManagedAgentSession,
} from "../../../electron/ipc-types";
import type { AgentInspectorSelection } from "../components/desktop/content/desktop-chat-message/types";
import {
  canStopManagedAgentTurn,
  managedAgentSessionMatchesRoom,
  managedAgentPermissionProfileLabel,
  managedAgentPermissionProfileSummary,
  managedAgentSessionStatusLabel,
} from "./managed-agents";
import {
  agentInspectorRequestResetKey,
  resolveAgentInspectorManagedSession,
} from "./agent-inspector-identity";

/**
 * A participant is not promoted to a desktop-managed agent from a display
 * label. This projection is deliberately built from the already-resolved
 * Inspector selection plus the exact managed-session bridge only.
 */
export type AgentInspectorParticipantProjection =
  | {
      kind: "external";
      title: string;
      eyebrow: "Room participant";
      heading: string;
      detail: string;
    }
  | {
      kind: "unavailable";
      title: string;
      eyebrow: "Local desktop agent";
      heading: string;
      detail: string;
    }
  | {
      kind: "local_managed";
      title: string;
      eyebrow: "Local desktop agent";
      heading: string;
      detail: string;
      session: DesktopManagedAgentSession;
      canStopTurn: boolean;
      canStopWorker: boolean;
      canRetry: boolean;
      permissionRequests: readonly DesktopManagedAgentPermissionRequest[];
    };

export function projectAgentInspectorParticipant(
  selection: AgentInspectorSelection,
  sessions: readonly DesktopManagedAgentSession[],
  roomIdentifier: string,
): AgentInspectorParticipantProjection | null {
  if (selection.kind !== "external") return null;
  const roomSessions = sessions.filter((session) =>
    managedAgentSessionMatchesRoom(session, roomIdentifier)
  );
  const resolution = resolveAgentInspectorManagedSession(roomSessions, selection);
  if (resolution.state === "ambiguous") {
    return {
      kind: "unavailable",
      title: selection.displayName || selection.sender || "Agent",
      eyebrow: "Local desktop agent",
      heading: "Local agent identity unavailable",
      detail: "Conflicting exact local sessions were found. Controls are withheld until the identity is unambiguous.",
    };
  }
  if (resolution.state === "unmatched") {
    return {
      kind: "external",
      title: selection.displayName || selection.sender || "Agent",
      eyebrow: "Room participant",
      heading: "Externally managed agent",
      detail: "This participant is visible in this room, but its runtime and permissions are managed elsewhere.",
    };
  }

  const session = resolution.session;
  const running = session.status === "starting" || session.status === "running";
  return {
    kind: "local_managed",
    title: selection.displayName || session.displayName || selection.sender || "Agent",
    eyebrow: "Local desktop agent",
    heading: managedAgentSessionStatusLabel(session),
    detail: running
      ? session.activeWork?.summary || "This agent is working from this desktop."
      : session.failure?.message || session.lastError || "This agent is managed by this desktop.",
    session,
    canStopTurn: canStopManagedAgentTurn(session),
    canStopWorker: session.canStop,
    canRetry: session.status === "blocked" && Boolean(session.failure?.retryable),
    permissionRequests: session.pendingPermissionRequests,
  };
}

export function agentInspectorManagedSessionIdentity(
  session: Pick<
    DesktopManagedAgentSession,
    "id" | "roomIdentifier" | "supervisorEntryId" | "agentSessionId" | "agentKey"
  >,
): string {
  return JSON.stringify([
    session.id,
    session.roomIdentifier,
    session.supervisorEntryId || null,
    session.agentSessionId || null,
    session.agentKey || null,
  ]);
}

export interface AgentInspectorParticipantSessionUpdate {
  roomIdentifier: string;
  inspectorRequestVersion: number;
  selectionKey: string;
  expectedSessionIdentity: string;
  session: DesktopManagedAgentSession;
}

/**
 * The shell is the final mutation boundary. A component response from another
 * room/request/session can never repopulate the current room's session list.
 */
export function isCurrentAgentInspectorParticipantSessionUpdate(
  update: AgentInspectorParticipantSessionUpdate,
  current: {
    roomIdentifier: string;
    inspectorRequestVersion: number;
    selection: AgentInspectorSelection | null;
    sessions: readonly DesktopManagedAgentSession[];
  },
): boolean {
  if (
    update.roomIdentifier !== current.roomIdentifier
    || update.inspectorRequestVersion !== current.inspectorRequestVersion
    || update.selectionKey !== agentInspectorRequestResetKey(current.selection, current.inspectorRequestVersion)
    || !managedAgentSessionMatchesRoom(update.session, current.roomIdentifier)
    || agentInspectorManagedSessionIdentity(update.session) !== update.expectedSessionIdentity
  ) return false;
  const resolution = resolveAgentInspectorManagedSession(current.sessions, current.selection);
  return resolution.state === "matched"
    && managedAgentSessionMatchesRoom(resolution.session, current.roomIdentifier)
    && agentInspectorManagedSessionIdentity(resolution.session) === update.expectedSessionIdentity;
}

export function agentInspectorParticipantPermissionLabel(
  session: Pick<DesktopManagedAgentSession, "permissionProfile" | "permissionProfileId">,
): { label: string; detail: string } {
  return {
    label: managedAgentPermissionProfileLabel(session),
    detail: managedAgentPermissionProfileSummary(session.permissionProfile),
  };
}

export function agentInspectorTranscriptText(item: Record<string, unknown>): string | null {
  for (const key of ["text", "summary", "content", "message"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function agentInspectorParticipantInspection(
  inspections: Readonly<Record<string, DesktopManagedAgentInspectResult>>,
  sessionId: string,
): DesktopManagedAgentInspectResult | null {
  return inspections[sessionId] ?? null;
}
