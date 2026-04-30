import type { Message, RoomAgentPresence } from "./db.js";
import { parseAgentActorLabel } from "../shared/agent-identity.js";
import { type AgentPresenceStatus } from "../shared/agent-presence.js";
import {
  buildRoomActivitySourceFlags,
  type RoomAgentActivityState,
} from "../shared/room-agent-activity.js";

const IDLE_STATUS_RE = /\b(idle|available|online|polling|monitoring|watch(?:ing)?|ready|standby)\b/i;
const IDLE_WAITING_STATUS_RE = /\b(?:awaiting|waiting)\s+(?:for\s+)?(?:tasks?|work|instructions?|direction|assignment|assignments|next(?:\s+task)?|queue)\b/i;
const REVIEWING_STATUS_RE = /\b(review|reviewing|approve|approval|approving)\b/i;
const BLOCKED_STATUS_RE = /\b(blocked|waiting|stuck)\b/i;

function extractStatusText(text: string): string {
  return text.trim().replace(/^\[status\]\s*/i, "").trim();
}

function classifyPresenceStatusText(statusText: string): AgentPresenceStatus {
  if (!statusText) {
    return "working";
  }

  if (IDLE_WAITING_STATUS_RE.test(statusText)) {
    return "idle";
  }

  if (BLOCKED_STATUS_RE.test(statusText)) {
    return "blocked";
  }

  if (IDLE_STATUS_RE.test(statusText)) {
    return "idle";
  }

  if (REVIEWING_STATUS_RE.test(statusText)) {
    return "reviewing";
  }

  return "working";
}

function getOwnerLabel(ownerAttribution: string | null | undefined): string | null {
  const normalized = String(ownerAttribution ?? "").trim();
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(.+?)(?:'s|s')?\s+agent$/i);
  return match?.[1]?.trim() || normalized;
}

function isPresenceCandidateMessage(message: Message): boolean {
  return (message.source || "").toLowerCase() === "agent"
    && Boolean(message.sender?.trim())
    && Boolean(message.text?.trim());
}

function comparePresence(left: RoomAgentPresence, right: RoomAgentPresence): number {
  if (left.activity_state !== right.activity_state) {
    const rank = new Map([
      ["active", 0],
      ["away", 1],
      ["offline", 2],
    ] as const);
    return (rank.get(left.activity_state) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(right.activity_state) ?? Number.MAX_SAFE_INTEGER);
  }

  const leftHeartbeat = Date.parse(left.last_heartbeat_at);
  const rightHeartbeat = Date.parse(right.last_heartbeat_at);
  if (Number.isFinite(leftHeartbeat) && Number.isFinite(rightHeartbeat) && leftHeartbeat !== rightHeartbeat) {
    return rightHeartbeat - leftHeartbeat;
  }

  return left.display_name.localeCompare(right.display_name);
}

export function buildFallbackPresenceFromMessages(input: {
  roomId: string;
  messages: readonly Message[];
  now?: number;
}): RoomAgentPresence[] {
  const latestBySender = new Map<string, Message>();

  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const message = input.messages[i];
    if (!message || !isPresenceCandidateMessage(message) || latestBySender.has(message.sender)) {
      continue;
    }

    latestBySender.set(message.sender, message);
  }

  return Array.from(latestBySender.entries())
    .map(([actorLabel, message]) => {
      const parsed = parseAgentActorLabel(actorLabel);
      const lastHeartbeatAt = message.timestamp;
      const statusText = extractStatusText(message.text);

      return {
        room_id: input.roomId,
        actor_label: actorLabel,
        agent_key: null,
        agent_instance_id: null,
        agent_session_id: null,
        session_kind: "controller",
        runtime: "unknown",
        display_name: parsed?.display_name || actorLabel,
        owner_label: getOwnerLabel(parsed?.owner_attribution),
        ide_label: parsed?.ide_label ?? null,
        status: classifyPresenceStatusText(statusText),
        status_text: statusText || null,
        last_heartbeat_at: lastHeartbeatAt,
        created_at: lastHeartbeatAt,
        updated_at: lastHeartbeatAt,
        freshness: "stale",
        activity_state: "offline" satisfies RoomAgentActivityState,
        source_flags: buildRoomActivitySourceFlags(["messages"]),
      } satisfies RoomAgentPresence;
    })
    .sort(comparePresence);
}

export function buildSyntheticPresenceEntry(input: {
  roomId: string;
  actorLabel: string;
  agentKey: string | null;
  displayName: string;
  ownerLabel: string | null;
  ideLabel: string | null;
  status: AgentPresenceStatus;
  statusText: string | null;
  now?: number;
}): RoomAgentPresence {
  const timestamp = new Date(input.now ?? Date.now()).toISOString();
  return {
    room_id: input.roomId,
    actor_label: input.actorLabel,
    agent_key: input.agentKey,
    agent_instance_id: null,
    agent_session_id: null,
    session_kind: "controller",
    runtime: "unknown",
    display_name: input.displayName,
    owner_label: input.ownerLabel,
    ide_label: input.ideLabel,
    status: input.status,
    status_text: input.statusText,
    last_heartbeat_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    freshness: "stale",
    activity_state: "offline",
    source_flags: buildRoomActivitySourceFlags(["presence"]),
  };
}
