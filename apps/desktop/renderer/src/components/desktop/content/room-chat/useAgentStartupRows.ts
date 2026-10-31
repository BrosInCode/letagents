import { computed, shallowRef, watch } from "vue";
import type { DesktopSupervisorManifestEntry } from "../../../../../../electron/ipc-types";
import {
  agentStartupView,
  initialAgentStartupState,
  reduceAgentStartups,
  type AgentStartupEvent,
  type AgentStartupView,
} from "../../../../domain/agent-startup";
import { friendlyRoomLabel } from "../../../../domain/git-rooms";
import { desktopIpc } from "../../../../ipc/index.js";
import { agentStartupAnchors } from "./agent-startup-anchors";
import type { TimelineAgentStartup } from "./timeline";

/** "#repo" for a repository room, "#name" otherwise. */
export function agentStartupRoomLabel(roomIdentifier: string): string {
  const friendly = friendlyRoomLabel(roomIdentifier.trim());
  const repo = /^github\.com\/[^/\s]+\/([^/\s]+)$/.exec(friendly)?.[1];
  const name = repo ?? friendly.split("/").filter(Boolean).at(-1) ?? friendly;
  return name.startsWith("#") ? name : `#${name}`;
}

/** The start-up rows of one room's timeline, from the daemon entries the room view already receives. */
export function useAgentStartupRows(options: {
  roomIdentifier: () => string;
  entries: () => readonly DesktopSupervisorManifestEntry[] | undefined;
}) {
  const state = shallowRef(initialAgentStartupState());
  const dispatch = (event: AgentStartupEvent) => { state.value = reduceAgentStartups(state.value, event); };

  watch(() => [options.roomIdentifier(), options.entries() ?? []] as const, ([room, entries], previous) => {
    if (previous && previous[0] !== room) state.value = initialAgentStartupState();
    dispatch({ type: "entries", entries, nowMs: Date.now() });
  }, { immediate: true });
  watch(() => [...agentStartupAnchors()].filter(([, anchor]) => anchor.roomIdentifier === options.roomIdentifier()), (anchors) => {
    for (const [entryId, anchor] of anchors) {
      const row = state.value.rows.find((candidate) => candidate.entryId === entryId);
      if (row?.anchorMessageId === anchor.messageId || state.value.pendingAnchors[entryId]?.messageId === anchor.messageId) continue;
      dispatch({ type: "anchor", entryId, messageId: anchor.messageId, effort: anchor.effort });
    }
  }, { immediate: true });

  const entriesById = computed(() => new Map((options.entries() ?? []).map((entry) => [entry.id, entry])));
  const roomLabel = computed(() => agentStartupRoomLabel(options.roomIdentifier()));

  /**
   * One row's view at `nowMs`. Each start-up row calls it with its own clock,
   * so a tick redraws that row only, not the whole timeline.
   */
  function viewFor(entryId: string, nowMs: number): AgentStartupView | null {
    const row = state.value.rows.find((candidate) => candidate.entryId === entryId);
    const entry = entriesById.value.get(entryId);
    if (!row || !entry) return null;
    return agentStartupView(entry, {
      roomLabel: roomLabel.value,
      effort: row.effort,
      retryRequestedAtMs: row.retryRequestedAtMs,
      cancelRequested: row.cancelRequested,
    }, nowMs);
  }

  // The same array while the rows are the same, so an entry update that does
  // not add, move or remove a row does not rebuild the timeline.
  const timelineStartups = computed<TimelineAgentStartup[]>((previous) => {
    const next = state.value.rows.flatMap((row) => {
      const entry = entriesById.value.get(row.entryId);
      return entry ? [{ entryId: row.entryId, anchorMessageId: row.anchorMessageId, startedAt: entry.createdAt }] : [];
    });
    return previous && sameTimelineStartups(previous, next) ? previous : next;
  });

  /** Starts the saved agent again; the daemon picks up after the stages it already finished. */
  async function retry(entryId: string): Promise<void> {
    dispatch({ type: "retry", entryId, nowMs: Date.now() });
    try {
      await desktopIpc.supervisor.setDesiredState(entryId, "running");
    } catch (error) {
      dispatch({ type: "retry", entryId, nowMs: null });
      throw error;
    }
  }

  async function cancel(entryId: string): Promise<void> {
    dispatch({ type: "cancel", entryId });
    try {
      await desktopIpc.supervisor.setDesiredState(entryId, "stopped");
    } catch (error) {
      dispatch({ type: "cancel_failed", entryId });
      throw error;
    }
  }

  return { viewFor, timelineStartups, retry, cancel };
}

function sameTimelineStartups(a: readonly TimelineAgentStartup[], b: readonly TimelineAgentStartup[]): boolean {
  return a.length === b.length && a.every((row, index) => {
    const other = b[index]!;
    return row.entryId === other.entryId && row.anchorMessageId === other.anchorMessageId && row.startedAt === other.startedAt;
  });
}
