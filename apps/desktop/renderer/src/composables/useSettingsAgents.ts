import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { DesktopAccountRoomEntry, DesktopAgentProvider, DesktopRoomLiveMetadata, DesktopSupervisorStateSnapshot } from "../../../electron/ipc-types";
import type { DesktopHostApproval } from "../../../shared/host-approvals";
import { desktopIpc } from "../ipc/index.js";
import { supervisedAgentsSupported } from "../domain/supervised-agents-support";
import { settingsAgentRooms, settingsAgentRows } from "../domain/settings-agents";

/**
 * Supervised agents arrive over the state push this composable subscribes to,
 * so the only thing left on a clock is the server-side room roster, which has
 * no push here. That read is a whole-account fan-out, so it runs a minute
 * apart rather than every 15 s.
 */
const ROSTER_REFRESH_MS = 60_000;
/** The roster reads only these two sources; the other three would be wasted requests. */
const ROSTER_METADATA = { include: ["participants", "presence"] } as const;

/** Settings reads joined rooms without starting/stopping the active room's stream. */
export function useSettingsAgents(accountRooms: () => readonly DesktopAccountRoomEntry[]) {
  const rooms = computed(() => settingsAgentRooms(accountRooms()));
  const state = shallowRef<DesktopSupervisorStateSnapshot | null>(null);
  const supervisorFresh = ref(!supervisedAgentsSupported.value);
  const metadata = shallowRef(new Map<string, DesktopRoomLiveMetadata>());
  const staleRooms = shallowRef(new Set<string>());
  const approvals = shallowRef<DesktopHostApproval[]>([]);
  const providers = shallowRef<DesktopAgentProvider[]>([]);
  const busy = ref(false);
  const loaded = ref(false);
  const errors = ref<string[]>([]);
  const archiveBusy = ref(false);
  const archiveFeedback = ref<string | null>(null);
  const archiveError = ref<string | null>(null);
  let mounted = false;
  let disposed = false;
  let pending = false;
  let running = false;
  let roomEpoch = 0;
  let stopState: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function accept(next: DesktopSupervisorStateSnapshot): void {
    const current = state.value;
    if (!current || next.daemonGeneration > current.daemonGeneration
      || (next.daemonGeneration === current.daemonGeneration && next.sequence >= current.sequence)) state.value = next;
  }

  /**
   * A background round keeps `busy` untouched, so an automatic refresh cannot
   * flip the header button to "Refreshing" or blank the empty state under a
   * reader who never asked for it.
   */
  async function refresh(options: { background?: boolean } = {}): Promise<void> {
    if (disposed) return;
    const background = options.background === true;
    if (running) { pending = true; return; }
    running = true;
    if (!background) busy.value = true;
    const epoch = roomEpoch;
    const current = () => !disposed && epoch === roomEpoch;
    const nextErrors: string[] = [];
    const nextMetadata = new Map(metadata.value);
    const nextStaleRooms = new Set<string>();
    const nextApprovals: DesktopHostApproval[] = [];
    const queue = [...rooms.value];
    try {
      await Promise.all([
        (async () => {
          if (!supervisedAgentsSupported.value) { supervisorFresh.value = true; return; }
          try {
            const snapshot = await desktopIpc.supervisor?.getServiceSnapshot?.();
            if (!current()) return;
            if (!snapshot?.state || !snapshot.status || snapshot.state.daemonGeneration !== snapshot.status.generation) throw new Error("unavailable");
            accept(snapshot.state);
            supervisorFresh.value = state.value?.daemonGeneration === snapshot.status.generation;
            if (!supervisorFresh.value) nextErrors.push("Agent management restarted. Refresh to check its current state.");
          } catch {
            if (!current()) return;
            supervisorFresh.value = false;
            nextErrors.push("Managed agent status is unavailable. Showing the last known agents.");
          }
        })(),
        (async () => {
          try {
            const next = await desktopIpc.workers.listAgentProviders();
            if (current()) providers.value = next;
          } catch { nextErrors.push("Provider information is unavailable."); }
        })(),
      ]);
      if (!current()) return;
      // With the supervisor snapshot already in hand, the room pass can skip
      // the signed approval read for every room that hosts no local agent.
      const roomsWithLocalAgents = new Set((state.value?.entries ?? []).map(entry => entry.roomId));
      await Promise.all([
        ...Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let room = queue.shift(); room && current(); room = queue.shift()) {
            const selectedRoom = room;
            await Promise.all([
              (async () => {
                try {
                  const next = await (desktopIpc.room.getLiveMetadata?.(selectedRoom.id, ROSTER_METADATA) ?? desktopIpc.room.getSnapshot(selectedRoom.id));
                  if (!current()) return;
                  // A failed source must not turn a known roster into a false empty state.
                  const old = nextMetadata.get(selectedRoom.id);
                  const participantsFailed = next.sourceStates.participants.status === "error";
                  const presenceFailed = next.sourceStates.presence.status === "error";
                  nextMetadata.set(selectedRoom.id, { ...next,
                    participants: participantsFailed ? old?.participants ?? [] : next.participants,
                    presence: presenceFailed ? old?.presence ?? [] : next.presence,
                  });
                  if (participantsFailed || presenceFailed) throw new Error("partial");
                } catch { nextStaleRooms.add(selectedRoom.id); }
              })(),
              (async () => {
                if (!supervisedAgentsSupported.value || !roomsWithLocalAgents.has(selectedRoom.id)) return;
                try {
                  const result = await desktopIpc.supervisor?.listHostApprovals?.(selectedRoom.id);
                  if (!result?.available) throw new Error("unavailable");
                  nextApprovals.push(...result.approvals);
                } catch { nextErrors.push("Some room approvals could not be checked."); }
              })(),
            ]);
          }
        }),
      ]);
      if (!current()) return;
      metadata.value = nextMetadata;
      staleRooms.value = nextStaleRooms;
      approvals.value = nextApprovals;
      if (nextStaleRooms.size) nextErrors.push(`Could not refresh ${nextStaleRooms.size} ${nextStaleRooms.size === 1 ? "room" : "rooms"}. Some agents may be missing or out of date.`);
      errors.value = [...new Set(nextErrors)];
      loaded.value = true;
    } finally {
      running = false;
      if (!background) busy.value = false;
      if (pending && !disposed) { pending = false; void refresh({ background }); }
    }
  }

  function visibleRefresh(): void { if (document.visibilityState !== "hidden") void refresh({ background: true }); }
  watch(() => rooms.value.map(room => room.id).join("\n"), () => {
    roomEpoch++;
    if (mounted) void refresh();
  });
  onMounted(() => {
    mounted = true;
    if (supervisedAgentsSupported.value) stopState = desktopIpc.supervisor?.onState?.(next => {
      if (disposed) return;
      const generation = state.value?.daemonGeneration;
      accept(next);
      if (generation !== state.value?.daemonGeneration) {
        supervisorFresh.value = false;
        void refresh();
      }
    });
    void refresh();
    timer = setInterval(visibleRefresh, ROSTER_REFRESH_MS);
    document.addEventListener("visibilitychange", visibleRefresh);
  });
  onBeforeUnmount(() => {
    disposed = true;
    roomEpoch++;
    stopState?.();
    if (timer) clearInterval(timer);
    document.removeEventListener("visibilitychange", visibleRefresh);
  });
  const rows = computed(() => settingsAgentRows({ rooms: rooms.value, entries: state.value?.entries ?? [],
    supervisorFresh: supervisorFresh.value, metadata: metadata.value, staleRooms: staleRooms.value, approvals: approvals.value }));

  async function archiveAgents(ids: readonly string[]): Promise<void> {
    if (archiveBusy.value || disposed) return;
    archiveFeedback.value = null;
    archiveError.value = null;
    const archive = desktopIpc.room.archiveAgents;
    if (!archive) { archiveError.value = "Restart LetAgents Desktop to archive agents."; return; }
    const requested = new Set(ids);
    const targets = rows.value.filter(row => requested.has(row.id) && row.archiveParticipantKey);
    const groups = new Map<string, typeof targets>();
    for (const target of targets) groups.set(target.roomId, [...(groups.get(target.roomId) ?? []), target]);
    let archived = 0;
    let skipped = requested.size - targets.length;
    const failedRooms: string[] = [];
    archiveBusy.value = true;
    // A read begun before this mutation must not restore archived rows.
    roomEpoch++;
    try {
      for (const [identifier, agents] of groups) {
        for (let offset = 0; offset < agents.length; offset += 500) {
          const batch = agents.slice(offset, offset + 500);
          try {
            const result = await archive(identifier, batch.map(agent => agent.archiveParticipantKey!));
            const keys = new Set(result.archivedParticipantKeys);
            archived += keys.size;
            skipped += batch.length - keys.size;
            if (disposed) return;
            roomEpoch++;
            const next = new Map(metadata.value);
            const room = next.get(identifier);
            if (room) next.set(identifier, { ...room, participants: room.participants.filter(participant => !keys.has(participant.participantKey)) });
            metadata.value = next;
          } catch { failedRooms.push(batch[0]!.roomName); }
        }
      }
      if (disposed) return;
      archiveFeedback.value = `${archived} ${archived === 1 ? "agent" : "agents"} archived. Messages, history, and workspace files are preserved.`
        + (skipped ? ` ${skipped} ${skipped === 1 ? "agent was" : "agents were"} skipped because availability changed.` : "");
      if (failedRooms.length) archiveError.value = `Could not archive agents in ${[...new Set(failedRooms)].join(", ")}. Check room-admin access and your connection, then retry.`;
    } finally {
      archiveBusy.value = false;
      if (!disposed) void refresh();
    }
  }
  return { rooms, rows, providers, busy, loaded, errors, refresh, archiveAgents, archiveBusy, archiveFeedback, archiveError };
}
