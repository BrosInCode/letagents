import type {
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentPermissionRequest,
  DesktopManagedAgentSession,
} from "../../../electron/ipc-types";
import type { AgentInspectorSelection } from "../components/desktop/content/desktop-chat-message/types";
import {
  canStopManagedAgentTurn,
  managedAgentPermissionProfileLabel,
  managedAgentPermissionProfileSummary,
  managedAgentSessionStatusLabel,
} from "./managed-agents";
import { resolveAgentInspectorManagedSessions } from "./agent-inspector-identity";

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
): AgentInspectorParticipantProjection | null {
  if (selection.kind !== "external") return null;
  const exactSessions = resolveAgentInspectorManagedSessions(sessions, selection);
  if (exactSessions.length !== 1) {
    return {
      kind: "external",
      title: selection.displayName || selection.sender || "Agent",
      eyebrow: "Room participant",
      heading: "Externally managed agent",
      detail: "This participant is visible in the room but is not controlled by this desktop.",
    };
  }

  const session = exactSessions[0]!;
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
