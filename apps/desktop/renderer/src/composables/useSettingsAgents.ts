import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { DesktopAccountRoomEntry, DesktopAgentProvider, DesktopRoomLiveMetadata, DesktopSupervisorStateSnapshot } from "../../../electron/ipc-types";
import type { DesktopHostApproval } from "../../../shared/host-approvals";
import { desktopIpc } from "../ipc/index.js";
import { supervisedAgentsSupported } from "../domain/supervised-agents-support";
import { settingsAgentRooms, settingsAgentRows } from "../domain/settings-agents";

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
  let mounted = false;
  let disposed = false;
  let pending = false;
  let roomEpoch = 0;
  let stopState: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function accept(next: DesktopSupervisorStateSnapshot): void {
    const current = state.value;
    if (!current || next.daemonGeneration > current.daemonGeneration
      || (next.daemonGeneration === current.daemonGeneration && next.sequence >= current.sequence)) state.value = next;
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    if (busy.value) { pending = true; return; }
    busy.value = true;
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
        ...Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let room = queue.shift(); room && current(); room = queue.shift()) {
            const selectedRoom = room;
            await Promise.all([
              (async () => {
                try {
                  const next = await (desktopIpc.room.getLiveMetadata?.(selectedRoom.id) ?? desktopIpc.room.getSnapshot(selectedRoom.id));
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
                if (!supervisedAgentsSupported.value) return;
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
      busy.value = false;
      if (pending && !disposed) { pending = false; void refresh(); }
    }
  }

  function visibleRefresh(): void { if (document.visibilityState !== "hidden") void refresh(); }
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
    timer = setInterval(visibleRefresh, 15_000);
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
  return { rooms, rows, providers, busy, loaded, errors, refresh };
}
