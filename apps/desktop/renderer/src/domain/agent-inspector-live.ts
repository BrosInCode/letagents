import type { DesktopAgentStreamBatch, DesktopAgentStreamEvent } from "../../../electron/ipc-types";
import type { AgentInspectorOverallState } from "./agent-inspector";

// The fold and the tool reading are shared with the daemon, which publishes
// the room's version of this same trace when the owner shares it.
export {
  describeLiveToolCall,
  foldAgentStreamEvents,
  isShellToolName,
} from "../../../../../shared/agent-live-trace.mjs";
export type {
  AgentLiveTranscript,
  LiveBackgroundCommand,
  LiveToolPresentation,
  LiveTranscriptItem,
} from "../../../../../shared/agent-live-trace.mjs";
import { foldAgentStreamEvents } from "../../../../../shared/agent-live-trace.mjs";
import type { LiveBackgroundCommand } from "../../../../../shared/agent-live-trace.mjs";
import { LIVE_BACKGROUND_COMMAND_METHOD } from "../../../../../shared/live-command-output.mjs";

/**
 * The commands that the agent started in the background, from the whole
 * feed: a server that a turn started still runs while later turns work, so
 * the background list is never scoped to the current turn.
 */
export function liveBackgroundCommands(feed: { events: readonly DesktopAgentStreamEvent[]; ended: boolean }): LiveBackgroundCommand[] {
  const events = feed.events.filter((event) => event.method === LIVE_BACKGROUND_COMMAND_METHOD);
  return events.length ? foldAgentStreamEvents(events, feed.ended).background : [];
}

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

/**
 * Append a bounded native batch, retaining loss accounting across updates. A
 * latest value (live command output) takes the place of the earlier event
 * with its key, so output that keeps arriving never pushes the agent's other
 * events out of the bounded list.
 */
export function appendAgentInspectorLiveBatch(
  feed: { events: DesktopAgentStreamEvent[]; ended: boolean; droppedEvents: number },
  batch: DesktopAgentStreamBatch,
  limit = 400,
): typeof feed {
  const priorEvents = batch.reset ? [] : feed.events;
  if (!batch.events.length) return { events: priorEvents, ended: batch.ended, droppedEvents: (batch.reset ? 0 : feed.droppedEvents) + Math.max(0, batch.droppedEvents) };
  const newestOfKey = new Map<string, number>();
  for (const event of batch.events) if (event.latestKey) newestOfKey.set(event.latestKey, event.sequence);
  const replaced = (event: DesktopAgentStreamEvent) => event.latestKey !== undefined
    && newestOfKey.has(event.latestKey) && newestOfKey.get(event.latestKey) !== event.sequence;
  const merged = [...priorEvents, ...batch.events].filter((event) => !replaced(event));
  const localOverflow = Math.max(0, merged.length - limit);
  return {
    events: localOverflow ? merged.slice(-limit) : merged,
    ended: batch.ended,
    droppedEvents: (batch.reset ? 0 : feed.droppedEvents) + Math.max(0, batch.droppedEvents) + localOverflow,
  };
}
