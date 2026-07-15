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
  openAgentDetail?: (target: AgentModalTarget) => void;
}

export function useAgentReasoningLauncher(options: AgentReasoningLauncherOptions) {
  function openAgentModal(target: AgentModalTarget): void {
    const resolvedTarget = agentTargetWithPresenceSession(target, options.presence());
    if (options.openAgentDetail) {
      options.openAgentDetail(resolvedTarget);
      return;
    }

    const session = latestReasoningForAgent(resolvedTarget, options.reasoningSessions());
    if (session) {
      options.openReasoning(session.id);
      return;
    }
    if (hasReasoningStreamSurface(resolvedTarget, options.presence())) {
      options.openFallback(resolvedTarget);
    }
  }

  return { openAgentModal };
}

/**
 * Older room messages may predate embedded agent-session identity. Resolve the
 * clicked actor through current presence, but only when the stable identity
 * join selects one worker. Ambiguous same-key/same-label peers fail closed.
 */
export function agentTargetWithPresenceSession(
  target: AgentModalTarget,
  presenceEntries: readonly DesktopAgentPresence[],
): AgentModalTarget {
  if (target.agentSessionId?.trim()) return target;

  const candidates = presenceEntries.filter((presence) => Boolean(presence.agentSessionId?.trim()));
  const targetAgentKey = normalizeAgentKey(target.agentKey);
  const targetActorKeys = new Set([
    target.actorLabel,
    target.sender,
  ].map(normalizeAgentKey).filter(Boolean));

  let matches = targetAgentKey
    ? candidates.filter((presence) => normalizeAgentKey(presence.agentKey) === targetAgentKey)
    : [];
  if (matches.length > 1 && targetActorKeys.size) {
    matches = matches.filter((presence) => targetActorKeys.has(normalizeAgentKey(presence.actorLabel)));
  } else if (matches.length === 0 && targetActorKeys.size) {
    matches = candidates.filter((presence) => targetActorKeys.has(normalizeAgentKey(presence.actorLabel)));
  }
  if (matches.length !== 1) return target;

  const presence = matches[0]!;
  return {
    ...target,
    actorLabel: target.actorLabel || presence.actorLabel,
    displayName: target.displayName || presence.displayName,
    ideLabel: target.ideLabel || presence.ideLabel,
    agentKey: target.agentKey || presence.agentKey,
    agentSessionId: presence.agentSessionId,
  };
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
      presence.agentSessionId,
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
