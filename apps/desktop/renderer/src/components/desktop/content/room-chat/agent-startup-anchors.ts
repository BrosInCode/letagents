import { shallowReactive } from "vue";

/**
 * The person's first message to an agent they are starting, so the start-up
 * row can sit under it. The surface that starts the agent and posts that
 * message notes it here; a row without an anchor sits at the agent's start
 * time instead.
 */
export interface AgentStartupAnchor {
  roomIdentifier: string;
  messageId: string;
  /** The effort the person chose; the manifest entry does not carry it. */
  effort: string | null;
}

const MAX_ANCHORS = 64;
const anchors = shallowReactive(new Map<string, AgentStartupAnchor>());

/** The supervised manifest entry id of a launch request. */
export function supervisedEntryIdForLaunch(creationRequestId: string): string {
  return `supervised_${creationRequestId}`;
}

export function noteAgentStartupAnchor(entryId: string, anchor: { roomIdentifier: string; messageId: string; effort?: string | null }): void {
  anchors.delete(entryId);
  anchors.set(entryId, { roomIdentifier: anchor.roomIdentifier, messageId: anchor.messageId, effort: anchor.effort ?? null });
  while (anchors.size > MAX_ANCHORS) anchors.delete(anchors.keys().next().value!);
}

export function agentStartupAnchors(): ReadonlyMap<string, AgentStartupAnchor> {
  return anchors;
}
