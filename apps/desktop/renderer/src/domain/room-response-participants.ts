import type { DesktopAgentPresence, DesktopRoomMessage, DesktopSupervisorManifestEntry } from "../../../electron/ipc-types";
import { supervisedAgentDisplayLabel } from "./codenames";
import { normalizeManagedAgentRoomIdentifier, workIndicatorSupersededByAgentMessage, type ManagedAgentWorkIndicator } from "./managed-agents";

type Message = Pick<DesktopRoomMessage, "id" | "timestamp" | "accountAgentRouting" | "outgoing" | "liveArrival">;
type Exchange = { finished: Set<string> };

/** UI-only participation, not a claim that a native provider has started.
 * Admit appended live messages, never missing receipts in historical messages.
 * Keep exact outcomes until the source leaves the loaded window: receipts are
 * bounded, so their later absence must not resurrect a completed participant.
 */
export class RoomResponseParticipants {
  private room: string | null = null;
  private initialized = false;
  private arrival = 0;
  private exchanges = new Map<string, Exchange>();

  update(input: {
    roomIdentifier: string;
    loading: boolean;
    messages: readonly Message[];
    entries: readonly DesktopSupervisorManifestEntry[];
    presence: readonly Pick<DesktopAgentPresence, "agentSessionId" | "displayName" | "actorLabel">[];
    fresh: boolean;
  }): ManagedAgentWorkIndicator[] {
    const room = normalizeManagedAgentRoomIdentifier(input.roomIdentifier);
    const messages = input.messages.filter(message => !message.outgoing);
    if (this.room !== room || input.loading) {
      this.room = room;
      this.initialized = false;
      this.exchanges.clear();
    }
    if (input.loading) return [];
    if (this.initialized) {
      for (const message of messages.filter(message => (message.liveArrival ?? 0) > this.arrival)) {
        this.exchanges.set(message.id, { finished: new Set() });
      }
    } else {
      // A replaced history/reconnected snapshot is not evidence of new work.
      this.exchanges.clear();
    }
    this.initialized = true;
    this.arrival = Math.max(this.arrival, ...messages.map(message => message.liveArrival ?? 0));
    const loadedIds = new Set(messages.map(message => message.id));
    for (const id of this.exchanges.keys()) if (!loadedIds.has(id)) this.exchanges.delete(id);

    const indicators = new Map<string, ManagedAgentWorkIndicator>();
    for (const message of messages) {
      const exchange = this.exchanges.get(message.id);
      const routing = message.accountAgentRouting;
      if (!exchange || routing?.authority !== "receipts") continue;
      for (const target of routing.recipientSessions) {
        const session = target.successorAgentSessionId ?? target.agentSessionId;
        // The receipt remains the same logical recipient after an authorized
        // successor takes over its transport session.
        const identity = target.agentKey;
        if (exchange.finished.has(identity)) continue;
        const matches = input.entries.filter(entry =>
          normalizeManagedAgentRoomIdentifier(entry.roomId) === room
          && entry.agentKey === target.agentKey && entry.agentSessionId === session);
        if (matches.length !== 1) continue;
        const entry = matches[0]!;
        const receipt = entry.deliveryReceipts?.find(receipt => receipt.sourceMessageId === message.id);
        if (receipt && (receipt.state.startsWith("acknowledged") || receipt.state.startsWith("cancelled"))) {
          exchange.finished.add(identity);
          continue;
        }
        // Do not cover a blocked delivery, scheduled retry or disconnected
        // runtime with a cheerful Thinking label. Actual work wins at merge.
        const state = entry.roomAgentState;
        if (!input.fresh || entry.agentSessionBindingState !== "active" || entry.desiredState !== "running"
          || entry.condition !== "none" || state?.connection.state !== "connected"
          || state.ingress.state !== "observing" || entry.deliveryAttention
          || state.inbox.state === "blocked" || state.inbox.state === "waiting_for_desktop_credentials"
          || state.inbox.state === "restoring_conversation" || state.turn.state === "failed"
          || receipt?.state === "blocked" || receipt?.state === "retryable"
          || receipt?.state === "queued_behind_blocked" || receipt?.state === "restoring_conversation") continue;
        if (indicators.has(entry.id)) continue;
        const presence = input.presence.find(person => person.agentSessionId === session);
        indicators.set(entry.id, {
          id: entry.id,
          displayName: supervisedAgentDisplayLabel(presence?.displayName || presence?.actorLabel || entry.displayName, entry.id),
          summary: "Thinking",
          startedAt: message.timestamp,
          sourceMessageId: message.id,
          agentSessionId: session,
          agentKey: target.agentKey,
          awaitingRoomTurn: true,
        });
      }
    }
    return [...indicators.values()];
  }
}

/** Native work and retry controls always take precedence over participation. */
export function mergeRoomResponseParticipants(
  actual: readonly ManagedAgentWorkIndicator[],
  participants: readonly ManagedAgentWorkIndicator[],
  messages: readonly Pick<DesktopRoomMessage, "id" | "agentIdentity">[] = [],
): ManagedAgentWorkIndicator[] {
  const current = actual.filter(work => !workIndicatorSupersededByAgentMessage(work, messages));
  return [...current, ...participants.filter(work => !current.some(other => other.id === work.id
    || (Boolean(work.agentSessionId) && other.agentSessionId === work.agentSessionId && other.agentKey === work.agentKey)))];
}
