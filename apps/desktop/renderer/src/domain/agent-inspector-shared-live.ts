import { readRoomLiveSnapshot, type RoomLiveSnapshot } from "../../../../../shared/agent-live-trace.mjs";
import type { DesktopReasoningSession } from "../../../electron/ipc-types";
import { normalizeAgentKey } from "./agents";

/** The turn an agent's owner shares with the room, as other members see it. */
export interface SharedLiveView {
  sessionId: string;
  snapshot: RoomLiveSnapshot;
  /** The current step, in fixed product language. */
  currentStep: string | null;
  updatedAt: string | null;
}

/**
 * The shared turn of exactly this agent, by its durable key: a label never
 * selects another agent's activity. Null when its owner does not share it,
 * or when what is stored does not have the shape the room may show.
 */
export function sharedLiveViewForAgent(
  agentKey: string | null | undefined,
  sessions: readonly DesktopReasoningSession[],
): SharedLiveView | null {
  const key = normalizeAgentKey(agentKey);
  if (!key) return null;
  const session = sessions
    .filter((candidate) => candidate.kind === "live" && normalizeAgentKey(candidate.agentKey) === key)
    .sort((left, right) => timestamp(right.updatedAt ?? right.createdAt) - timestamp(left.updatedAt ?? left.createdAt))[0];
  if (!session) return null;
  const snapshot = readRoomLiveSnapshot(session.latestPayload?.live);
  return snapshot
    ? { sessionId: session.id, snapshot, currentStep: session.summary?.trim() || null, updatedAt: session.updatedAt ?? session.createdAt }
    : null;
}

function timestamp(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export type SharedLiveState = "working" | "finished" | "delayed" | "attention" | "stopped";

/**
 * What the shared view may claim. A turn the snapshot calls running is shown
 * as running only while the agent's presence says it works: an agent that is
 * idle, offline or needs attention stopped updating it (its desktop may have
 * stopped before the turn's last snapshot), and a stale presence delays the claim.
 */
export function sharedLiveState(snapshot: RoomLiveSnapshot, presence: "responding" | "online" | "needs_attention" | "disconnected" | "stale" | "unshared" | string): SharedLiveState {
  if (snapshot.state === "ended") return "finished";
  if (presence === "responding") return "working";
  if (presence === "stale") return "delayed";
  // Waiting for an approval, for example: the turn is not over, but nothing moves until its owner acts.
  if (presence === "needs_attention") return "attention";
  return "stopped";
}
