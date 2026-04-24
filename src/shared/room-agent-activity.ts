import type {
  AgentPresenceFreshness,
  AgentPresenceStatus,
} from "./agent-presence.js";

export const ROOM_AGENT_ACTIVITY_STATES = [
  "active",
  "away",
  "offline",
] as const;

export const RECENTLY_OFFLINE_WINDOW_MS = 15 * 60 * 1000;
export const RECENTLY_OFFLINE_MAX_AGENTS = 20;

export type RoomAgentActivityState = (typeof ROOM_AGENT_ACTIVITY_STATES)[number];

export const ROOM_ACTIVITY_SOURCE_FLAGS = [
  "delivery",
  "presence",
  "messages",
  "tasks",
] as const;

export type RoomActivitySourceFlag = (typeof ROOM_ACTIVITY_SOURCE_FLAGS)[number];

export function deriveRoomAgentActivityState(input: {
  hidden: boolean;
  hasPresence: boolean;
  freshness: AgentPresenceFreshness | null;
  status: AgentPresenceStatus | null;
}): RoomAgentActivityState {
  if (input.hidden) {
    return "offline";
  }

  if (!input.hasPresence) {
    return "offline";
  }

  if (input.freshness !== "active") {
    return "offline";
  }

  return input.status === "idle" ? "away" : "active";
}

export function buildRoomActivitySourceFlags(
  flags: Iterable<RoomActivitySourceFlag | null | undefined>
): RoomActivitySourceFlag[] {
  const seen = new Set<RoomActivitySourceFlag>();
  for (const flag of flags) {
    if (flag && ROOM_ACTIVITY_SOURCE_FLAGS.includes(flag)) {
      seen.add(flag);
    }
  }

  return ROOM_ACTIVITY_SOURCE_FLAGS.filter((flag) => seen.has(flag));
}

export function isReachableRoomAgentActivityState(
  value: RoomAgentActivityState | null | undefined
): boolean {
  return value === "active" || value === "away";
}

export function isWithinRecentlyOfflineWindow(
  lastSeenAt: string | null | undefined,
  now = Date.now(),
  windowMs = RECENTLY_OFFLINE_WINDOW_MS
): boolean {
  const parsed = Date.parse(String(lastSeenAt ?? ""));
  return Number.isFinite(parsed) && now - parsed <= windowMs;
}
