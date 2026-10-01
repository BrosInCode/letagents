import type { DesktopBoardIntentSummary, DesktopSupervisorManifestEntry } from "../../../../../../electron/ipc-types";
import type { DesktopAttentionRoom } from "../../../../../../electron/ipc-types/knowledge.js";
import type { DesktopHostApproval } from "../../../../../../shared/host-approvals";
import { agentInspectorOverallState, projectAgentInspector } from "../../../../domain/agent-inspector";
import { isLocalRoomIdentifier } from "../../../../domain/room-urls";
import type { HostApprovalRoomState } from "../room-chat/host-approvals";

/** A board manager answers most intents within its own turn; only a longer wait needs the owner. */
export const BOARD_INTENT_ATTENTION_DELAY_MS = 3 * 60_000;
/** Agents briefly report a blocked step while they recover on their own. */
export const AGENT_ATTENTION_GRACE_MS = 30_000;
/** Longer than one Inbox refresh, so a single clear sample does not restart the grace. */
const AGENT_ATTENTION_CLEAR_MS = 2 * 60_000;

/** Agent work waiting on the owner that is not a written room request. */
export type AgentAttentionItem =
  | { kind: "tool_approval"; key: string; roomIdentifier: string; timestamp: string; approval: DesktopHostApproval }
  | { kind: "agent_attention"; key: string; roomIdentifier: string; timestamp: string; entry: DesktopSupervisorManifestEntry; agentName: string; summary: string }
  | { kind: "board_intent"; key: string; roomIdentifier: string; timestamp: string; intent: DesktopBoardIntentSummary };

export interface AgentAttentionInput {
  /** Supervised agents across rooms. */
  agents?: readonly DesktopSupervisorManifestEntry[];
  /** Since when this desktop has seen each agent needing attention, by entry id. */
  agentFirstSeenAt?: Readonly<Record<string, string>>;
  /** The approvals shared with each room's composer card. */
  approvalRooms?: ReadonlyMap<string, Pick<HostApprovalRoomState, "approvals" | "firstSeenAt" | "stale">>;
  rooms?: ReadonlyArray<Pick<DesktopAttentionRoom, "roomIdentifier" | "boardIntents">>;
  /** The account's rooms. Items elsewhere (another account, a room left) are dropped; local rooms always count. */
  accountRooms?: ReadonlySet<string>;
  nowMs: number;
}

/** The same "Needs attention" state the Activity tab groups agents under. */
export function agentNeedsAttention(entry: DesktopSupervisorManifestEntry): boolean {
  return agentInspectorOverallState(entry) === "needs_attention";
}

/** What the composer shows by default: a live request, or a recorded decision to retry. */
export function isActionableHostApproval(approval: Pick<DesktopHostApproval, "status">): boolean {
  return approval.status === "pending" || approval.status === "decision_recorded";
}

export function buildAgentAttentionItems(input: AgentAttentionInput): AgentAttentionItem[] {
  const items = new Map<string, AgentAttentionItem>();
  const inAccount = (room: string) => !input.accountRooms || input.accountRooms.has(room) || isLocalRoomIdentifier(room);
  const add = (item: AgentAttentionItem) => { if (inAccount(item.roomIdentifier) && !items.has(item.key)) items.set(item.key, item); };
  for (const [roomIdentifier, room] of input.approvalRooms ?? []) {
    // After a failed listing main has dropped these presentations; they can no longer be decided.
    if (room.stale) continue;
    for (const approval of room.approvals) {
      if (!isActionableHostApproval(approval)) continue;
      add({ kind: "tool_approval", key: JSON.stringify([roomIdentifier, "approval", approval.id]), roomIdentifier,
        timestamp: room.firstSeenAt[approval.id] ?? "", approval });
    }
  }
  for (const entry of input.agents ?? []) {
    if (!agentNeedsAttention(entry)) continue;
    const since = blockedSince(entry) ?? input.agentFirstSeenAt?.[entry.id];
    const sinceMs = Date.parse(since ?? "");
    if (!Number.isFinite(sinceMs) || input.nowMs - sinceMs < AGENT_ATTENTION_GRACE_MS) continue;
    const projection = projectAgentInspector(entry, { roomId: entry.roomId });
    if (!projection) continue;
    add({ kind: "agent_attention", key: JSON.stringify([entry.roomId, "agent", entry.id]), roomIdentifier: entry.roomId,
      timestamp: since!, entry, agentName: projection.displayName, summary: projection.now?.summary || projection.overallDetail });
  }
  for (const room of input.rooms ?? []) {
    for (const intent of room.boardIntents ?? []) {
      const createdMs = Date.parse(intent.createdAt);
      const expiresMs = Date.parse(intent.expiresAt ?? "");
      if (intent.status !== "pending" || !Number.isFinite(createdMs)
        || input.nowMs - createdMs < BOARD_INTENT_ATTENTION_DELAY_MS
        || (Number.isFinite(expiresMs) && expiresMs <= input.nowMs)) continue;
      add({ kind: "board_intent", key: JSON.stringify([room.roomIdentifier, "board-intent", intent.id]),
        roomIdentifier: room.roomIdentifier, timestamp: intent.createdAt, intent });
    }
  }
  return [...items.values()];
}

/**
 * Keep when each agent started needing attention. An agent that recovers
 * briefly keeps its start time, so a flapping agent does not restart the
 * grace each time it returns; only staying clear for two minutes forgets it.
 */
export function trackAgentAttention(
  previous: Readonly<Record<string, { since: string; lastSeen: string }>>,
  agents: readonly DesktopSupervisorManifestEntry[],
  nowMs: number,
): Record<string, { since: string; lastSeen: string }> {
  const now = new Date(nowMs).toISOString();
  const next: Record<string, { since: string; lastSeen: string }> = {};
  const remembered = (id: string) => {
    const seen = previous[id];
    return seen && nowMs - Date.parse(seen.lastSeen) <= AGENT_ATTENTION_CLEAR_MS ? seen : undefined;
  };
  for (const entry of agents) if (agentNeedsAttention(entry)) next[entry.id] = { since: remembered(entry.id)?.since ?? now, lastSeen: now };
  for (const id of Object.keys(previous)) {
    const seen = remembered(id);
    if (!next[id] && seen) next[id] = seen;
  }
  return next;
}

/** A blocked delivery queue is dated by the receipt that stopped it. */
function blockedSince(entry: DesktopSupervisorManifestEntry): string | null {
  const blockedBy = entry.roomAgentState?.inbox.blockedByMessageId;
  const blocked = (entry.deliveryReceipts ?? []).filter((receipt) => receipt.state === "blocked");
  return (blocked.find((receipt) => blockedBy && receipt.sourceMessageId === blockedBy) ?? blocked[0])?.updatedAt ?? null;
}
