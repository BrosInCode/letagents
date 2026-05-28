import type {
  DesktopAgentPresence,
  DesktopReasoningSession,
} from "../../../../../../electron/ipc-types";
import { normalizeAgentKey } from "../../../../domain/agents";
import {
  latestReasoningSessionForTarget,
  reasoningAgentTargetKeys,
} from "../../../../domain/reasoning";
import type { AgentModalTarget } from "../desktop-chat-message/types";

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
  return latestReasoningSessionForTarget(target, sessions);
}

export function hasReasoningStreamSurface(
  target: AgentModalTarget,
  presenceEntries: readonly DesktopAgentPresence[],
): boolean {
  const keys = reasoningAgentTargetKeys(target);
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
    ].map(normalizeAgentKey).filter(Boolean);
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
