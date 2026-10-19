import type { DesktopAgentStreamBatch, DesktopAgentStreamEvent } from "../../../electron/ipc-types";
import type { AgentInspectorOverallState } from "./agent-inspector";

// The fold and the tool reading are shared with the daemon, which publishes
// the room's version of this same trace when the owner shares it.
export {
  describeLiveToolCall,
  foldAgentStreamEvents,
} from "../../../../../shared/agent-live-trace.mjs";
export type {
  AgentLiveTranscript,
  LiveToolPresentation,
  LiveTranscriptItem,
} from "../../../../../shared/agent-live-trace.mjs";

/** Select only evidence owned by the durable room turn. An open provider
 * stream can span many idle periods and turns, so its replay is not itself a
 * work boundary. Idle views intentionally retain the bounded recent replay. */
export function scopeAgentStreamEventsToWork(
  events: readonly DesktopAgentStreamEvent[],
  work: { active: boolean; startedAt: string | null },
): readonly DesktopAgentStreamEvent[] {
  if (!work.active) return events;
  const startedAt = Date.parse(work.startedAt ?? "");
  if (!Number.isFinite(startedAt)) return [];
  return events.filter((event) => Date.parse(event.observedAt) >= startedAt);
}

export type AgentLiveAvailability =
  | "closed"
  | "stale"
  | "active"
  | "stopped"
  | "paused"
  | "disconnected"
  | "attention"
  | "transitioning"
  | "idle";

/** One precedence table for the Live tab's claims about availability. */
export function agentLiveAvailability(
  work: { active: boolean; freshness: "fresh" | "stale"; agentState: AgentInspectorOverallState },
  streamEnded: boolean,
): AgentLiveAvailability {
  if (streamEnded) return "closed";
  if (work.freshness === "stale") return "stale";
  if (work.active) return "active";
  if (work.agentState === "retired") return "stopped";
  if (work.agentState === "paused") return "paused";
  if (work.agentState === "disconnected") return "disconnected";
  if (work.agentState === "needs_attention") return "attention";
  if (["restoring_conversation", "recovering", "reconnecting", "starting"].includes(work.agentState)) return "transitioning";
  return "idle";
}

/** Compact elapsed copy for the live-work header. Invalid timestamps are
 * ignored instead of leaking `NaN` into the inspector. */
export function formatLiveWorkDuration(
  startedAt: string | null,
  endedAt: string | null,
  now = Date.now(),
): string | null {
  const started = Date.parse(startedAt || "");
  const ended = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;

  const seconds = Math.max(0, Math.floor((ended - started) / 1_000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Append a bounded native batch, retaining loss accounting across updates. */
export function appendAgentInspectorLiveBatch(
  feed: { events: DesktopAgentStreamEvent[]; ended: boolean; droppedEvents: number },
  batch: DesktopAgentStreamBatch,
  limit = 400,
): typeof feed {
  const priorEvents = batch.reset ? [] : feed.events;
  const localOverflow = Math.max(0, priorEvents.length + batch.events.length - limit);
  return {
    events: batch.events.length ? [...priorEvents, ...batch.events].slice(-limit) : priorEvents,
    ended: batch.ended,
    droppedEvents: (batch.reset ? 0 : feed.droppedEvents) + Math.max(0, batch.droppedEvents) + localOverflow,
  };
}
