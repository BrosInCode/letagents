import type {
  DesktopAgentPresence,
  DesktopReasoningSession,
} from "../../../../../../electron/ipc-types";
import type { AgentModalTarget } from "../DesktopChatMessage.vue";

interface AgentReasoningLauncherOptions {
  presence: () => DesktopAgentPresence[];
  reasoningSessions: () => DesktopReasoningSession[];
  openReasoning: (sessionId: string) => void;
  openFallback: (target: AgentModalTarget) => void;
}

export function useAgentReasoningLauncher(options: AgentReasoningLauncherOptions) {
  function openAgentModal(target: AgentModalTarget): void {
    const session = latestReasoningForAgent(target, options.reasoningSessions());
    if (session) {
      options.openReasoning(session.id);
      return;
    }
    if (hasReasoningStreamSurface(target, options.presence())) {
      options.openFallback(target);
    }
  }

  return { openAgentModal };
}

export function latestReasoningForAgent(
  target: AgentModalTarget,
  sessions: readonly DesktopReasoningSession[],
): DesktopReasoningSession | null {
  const keys = agentIdentityKeys(target);
  if (!keys.length) return null;

  return sessions
    .filter((session) => reasoningSessionKeys(session).some((key) => keys.includes(key)))
    .sort((left, right) =>
      reasoningTime(right) - reasoningTime(left)
      || String(right.id).localeCompare(String(left.id))
    )[0] || null;
}

export function hasReasoningStreamSurface(
  target: AgentModalTarget,
  presenceEntries: readonly DesktopAgentPresence[],
): boolean {
  const keys = agentIdentityKeys(target);
  const markerText = [
    target.ideLabel,
    target.sender,
    target.actorLabel,
  ].join(" ").toLowerCase();
  if (markerText.includes("codex")) return true;

  return presenceEntries.some((presence) => {
    const presenceKeys = [
      presence.actorLabel,
      presence.displayName,
      presence.agentKey,
    ].map(normalizeAgentIdentity).filter(Boolean);
    if (!presenceKeys.some((key) => keys.includes(key))) return false;

    const capability = String(presence.livenessObservation?.livenessCapability || "").toLowerCase();
    const bridgeId = String(presence.livenessObservation?.toolBridgeId || "").toLowerCase();
    const runtime = String(presence.runtime || "").toLowerCase();
    const ideLabel = String(presence.ideLabel || "").toLowerCase();
    return capability.includes("stream") ||
      capability.includes("codex") ||
      bridgeId.includes(":codex:") ||
      runtime === "codex" ||
      ideLabel === "codex";
  });
}

function agentIdentityKeys(target: AgentModalTarget): string[] {
  return [
    target.actorLabel,
    target.sender,
    target.displayName,
    displayNameFromActorLabel(target.actorLabel),
  ].map(normalizeAgentIdentity).filter(Boolean);
}

function reasoningSessionKeys(session: DesktopReasoningSession): string[] {
  return [
    session.actorLabel,
    displayNameFromActorLabel(session.actorLabel),
    session.agentKey,
  ].map(normalizeAgentIdentity).filter(Boolean);
}

function normalizeAgentIdentity(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function displayNameFromActorLabel(value: string | null | undefined): string {
  return String(value || "").split("|")[0]?.trim() || "";
}

function reasoningTime(session: DesktopReasoningSession): number {
  const parsed = Date.parse(String(session.updatedAt || session.createdAt || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
