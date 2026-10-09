<template>
  <section class="settings-panel service-health" data-testid="settings-diagnostics-panel" :aria-busy="busy">
    <p v-if="!snapshot && busy" class="settings-muted-note" role="status">Checking the background service…</p>
    <p v-if="restarting" class="settings-muted-note" role="status">The service restarted. Checking recovery…</p>
    <p v-if="error" class="settings-feedback" data-state="error" role="status" data-testid="service-error">{{ error }}</p>

    <template v-if="health && !restarting">
      <section class="service-health-section" aria-labelledby="service-health-title">
        <div class="service-health-heading">
          <h2 id="service-health-title">Background service</h2>
          <span class="state-pill" data-testid="service-state">{{ health.service.stateLabel }}</span>
        </div>
        <p class="settings-muted-note">Keeps your agents connected while the app is closed.</p>
        <dl class="service-health-facts">
          <div><dt>Version</dt><dd data-testid="service-version">{{ health.service.version || 'Unavailable' }}</dd></div>
          <div><dt>Running since</dt><dd data-testid="service-started">{{ formatTime(health.service.startedAt) }}</dd></div>
        </dl>
        <p v-if="health.service.recoveryLabel" class="service-health-recovery" role="status" data-testid="service-recovery">{{ health.service.recoveryLabel }}</p>
      </section>

      <section class="service-health-section" aria-labelledby="service-agents-title">
        <div class="service-health-heading">
          <h2 id="service-agents-title">Agents across all rooms</h2>
          <span v-if="health.counts" class="settings-muted-note">{{ health.counts.total }} total</span>
        </div>
        <template v-if="health.counts">
          <dl class="service-health-counts" data-testid="service-counts">
            <div><dt>Running</dt><dd>{{ health.counts.running }}</dd></div>
            <div><dt>Paused</dt><dd>{{ health.counts.paused }}</dd></div>
            <div><dt>Stopped</dt><dd>{{ health.counts.stopped }}</dd></div>
            <div :data-attention="health.counts.needsAttention > 0"><dt>Need you</dt><dd>{{ health.counts.needsAttention }}</dd></div>
          </dl>
          <p class="settings-muted-note">Agents that need you come first. Open an agent for details.</p>
          <p v-if="approvalsUnavailable" class="settings-muted-note" role="status">Some approval counts are unavailable.</p>
          <ul v-if="health.agents.length" class="service-health-agents" aria-label="Managed agents">
            <li v-for="agent in health.agents" :key="agent.entryId">
              <button type="button" class="service-health-agent" :data-attention="agent.needsAttention"
                :data-testid="`service-agent-${agent.entryId}`" @click="emit('open-agent', { roomIdentifier: agent.roomId, agentEntryId: agent.entryId })">
                <span class="service-health-agent-name"><strong>{{ agent.displayName }}</strong><span>{{ agent.roomName }}</span></span>
                <span class="service-health-agent-state"><strong>{{ agent.stateLabel }}</strong><span v-if="agent.detail">{{ agent.detail }}</span></span>
                <span class="service-health-agent-activity"><span>Last activity</span><time :datetime="agent.lastActivityAt || undefined">{{ formatTime(agent.lastActivityAt) }}</time></span>
                <span class="service-health-agent-waiting"><span>{{ agent.messagesWaiting === null ? 'Messages unavailable' : `${agent.messagesWaiting} ${agent.messagesWaiting === 1 ? 'message' : 'messages'} waiting` }}</span><span>{{ agent.approvalsWaiting === null ? 'Approvals unavailable' : `${agent.approvalsWaiting} ${agent.approvalsWaiting === 1 ? 'approval' : 'approvals'} waiting` }}</span></span>
                <ChevronRight class="service-health-chevron" aria-hidden="true" />
              </button>
            </li>
          </ul>
          <p v-else class="settings-muted-note" data-testid="service-agents-empty">No managed agents yet.</p>
        </template>
        <p v-else class="settings-muted-note" data-testid="service-agents-unavailable">Agent counts are unavailable until the service can be read.</p>
      </section>

      <section class="service-health-section" aria-labelledby="service-events-title">
        <div class="service-health-heading"><h2 id="service-events-title">Recent service events</h2></div>
        <p class="settings-muted-note">Service start and changes observed while this page is open.</p>
        <ol v-if="events.length" class="service-health-events" data-testid="service-events">
          <li v-for="event in events" :key="event.id"><span>{{ event.summary }}</span><time :datetime="event.observedAt">{{ formatTime(event.observedAt) }}</time></li>
        </ol>
        <p v-else class="settings-muted-note">No service events observed yet.</p>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ChevronRight } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import type { DesktopAccountRoomEntry, DesktopSupervisorServiceSnapshot, DesktopSupervisorStateSnapshot } from "../../../../../../electron/ipc-types";
import type { DesktopHostApproval } from "../../../../../../shared/host-approvals";
import type { AttentionNavigationIntent } from "../../content/room-shell/types";
import { projectServiceHealth, updateServiceEvents } from "../../../../domain/service-health";
import { desktopIpc } from "../../../../ipc/index.js";

const props = defineProps<{ rooms?: readonly DesktopAccountRoomEntry[] }>();
const emit = defineEmits<{ "open-agent": [intent: AttentionNavigationIntent] }>();
const snapshot = shallowRef<DesktopSupervisorServiceSnapshot | null>(null);
const events = shallowRef<ReturnType<typeof updateServiceEvents>>([]);
const approvals = shallowRef<DesktopHostApproval[]>([]);
const approvalRooms = shallowRef(new Set<string>());
const approvalsUnavailable = ref(false);
const busy = ref(false);
const restarting = ref(false);
const error = ref<string | null>(null);
const roomNames = computed(() => new Map((props.rooms ?? []).flatMap(room => [room, ...room.focusRooms]).map(room => [room.roomIdentifier, room.displayName])));
const health = computed(() => snapshot.value ? projectServiceHealth(snapshot.value, { approvals: approvals.value, approvalRooms: approvalRooms.value, roomNames: roomNames.value }) : null);
let disposed = false;
let stopState: (() => void) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let latestState: DesktopSupervisorStateSnapshot | null = null;
let approvalEpoch = 0;
let refreshAgain = false;

function accept(next: DesktopSupervisorServiceSnapshot): void {
  events.value = updateServiceEvents(snapshot.value, next, events.value);
  snapshot.value = next;
}

function formatTime(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unavailable";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
}

async function refreshApprovals(current: DesktopSupervisorServiceSnapshot): Promise<void> {
  const epoch = ++approvalEpoch;
  const rooms = [...new Set((current.state?.entries ?? []).map(entry => entry.roomId))];
  const bridge = desktopIpc.supervisor;
  const loaded = new Set<string>();
  const next: DesktopHostApproval[] = [];
  await Promise.all(Array.from({ length: Math.min(4, rooms.length) }, async () => {
    for (let room = rooms.shift(); room; room = rooms.shift()) {
      try {
        const result = await bridge?.listHostApprovals?.(room);
        if (result?.available) { loaded.add(room); next.push(...result.approvals); }
      } catch { /* An unreadable approval count stays unknown. */ }
      if (disposed || epoch !== approvalEpoch) return;
    }
  }));
  if (disposed || epoch !== approvalEpoch) return;
  approvals.value = next;
  approvalRooms.value = loaded;
  approvalsUnavailable.value = (current.state?.entries ?? []).some(entry => !loaded.has(entry.roomId));
}

async function refresh(): Promise<void> {
  if (busy.value || disposed) return;
  busy.value = true;
  error.value = null;
  try {
    const read = desktopIpc.supervisor?.getServiceSnapshot;
    if (!read) throw new Error("missing bridge");
    const next = await read();
    if (disposed) return;
    // A stream update can overtake the initial read. Never roll it back or
    // pair a new service's agents with an old service's version/start time.
    if (latestState && next.status && latestState.daemonGeneration > next.status.generation) {
      return;
    }
    if (latestState && next.state && next.status?.generation === latestState.daemonGeneration
      && next.state.sequence < latestState.sequence) next.state = latestState;
    accept(next);
    restarting.value = false;
    if (next.state) latestState = next.state;
    void refreshApprovals(next);
  } catch {
    if (disposed) return;
    error.value = "Could not read the background service. Try Refresh.";
    restarting.value = false;
    accept({ status: null, state: null, observedAt: new Date().toISOString() });
    approvals.value = [];
    approvalRooms.value = new Set();
    approvalEpoch++;
  } finally {
    busy.value = false;
    const needsRefresh = refreshAgain && latestState?.daemonGeneration !== snapshot.value?.status?.generation;
    refreshAgain = false;
    if (needsRefresh && !disposed) void refresh();
  }
}

onMounted(() => {
  stopState = desktopIpc.supervisor?.onState?.((state) => {
    if (disposed || (latestState && (state.daemonGeneration < latestState.daemonGeneration
      || (state.daemonGeneration === latestState.daemonGeneration && state.sequence <= latestState.sequence)))) return;
    latestState = state;
    if (snapshot.value?.status?.generation === state.daemonGeneration) {
      // Null fleet state is an explicit unavailable result. Only a fresh
      // supported read can restore it, including after maintenance ends.
      if (snapshot.value.state) accept({ ...snapshot.value, state, observedAt: new Date().toISOString() });
    } else {
      restarting.value = Boolean(snapshot.value?.status);
      approvals.value = [];
      approvalRooms.value = new Set();
      approvalEpoch++;
      if (busy.value) refreshAgain = true;
      else void refresh();
    }
  });
  void refresh();
  timer = setInterval(() => { void refresh(); }, 15_000);
});
onBeforeUnmount(() => { disposed = true; approvalEpoch++; stopState?.(); if (timer) clearInterval(timer); });
defineExpose({ refresh, busy });
</script>

<style scoped>
.service-health { max-width: 1100px; display: grid; gap: 28px; }
.service-health-section { display: grid; gap: 12px; min-width: 0; }
.service-health-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.service-health-heading h2 { margin: 0; font-size: 1rem; font-weight: 600; }
.service-health p { margin: 0; line-height: 1.5; }
.service-health-facts, .service-health-counts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin: 0; padding: 16px; border: 1px solid var(--border); border-radius: 8px; }
.service-health-counts { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.service-health dt { color: var(--text-tertiary); font-size: 0.78rem; }
.service-health dd { margin: 6px 0 0; font-size: 0.9rem; overflow-wrap: anywhere; }
.service-health-counts dd { font-size: 1.5rem; font-variant-numeric: tabular-nums; }
.service-health-counts [data-attention="true"], .service-health-recovery { color: var(--amber); }
.service-health-recovery { font-size: 0.85rem; }
.service-health-agents, .service-health-events { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 8px; }
.service-health-agents { max-height: 460px; overflow-y: auto; }
.service-health-agents li + li, .service-health-events li + li { border-top: 1px solid var(--border); }
.service-health-agent { display: grid; grid-template-columns: minmax(110px, 1fr) minmax(110px, 1.2fr) minmax(95px, 1fr) minmax(115px, 1fr) 16px; gap: 14px; align-items: center; width: 100%; padding: 14px; border: 0; color: var(--text); background: transparent; text-align: left; font: inherit; font-size: 0.8rem; cursor: pointer; }
.service-health-agent:hover { background: var(--bg-subtle); }
.service-health-agent:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.service-health-agent > span { display: grid; gap: 5px; min-width: 0; overflow-wrap: anywhere; }
.service-health-agent strong { font-weight: 600; }
.service-health-agent span span, .service-health-agent time { color: var(--text-tertiary); font-size: 0.75rem; line-height: 1.4; }
.service-health-agent[data-attention="true"] .service-health-agent-state strong { color: var(--amber); }
.service-health-chevron { width: 16px; height: 16px; color: var(--text-tertiary); }
.service-health-events li { display: flex; justify-content: space-between; gap: 20px; padding: 12px 14px; font-size: 0.8rem; }
.service-health-events time { flex-shrink: 0; color: var(--text-tertiary); font-size: 0.75rem; }
@media (max-width: 1120px) {
  .service-health-agent { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 16px; }
  .service-health-agent-activity { grid-column: 1; }
  .service-health-chevron { grid-column: 3; grid-row: 1 / 3; }
}
@media (max-width: 560px) {
  .service-health-counts, .service-health-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .service-health-events li { flex-direction: column; gap: 5px; }
}
</style>
