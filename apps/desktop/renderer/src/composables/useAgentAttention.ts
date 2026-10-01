import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import type { DesktopSupervisorManifestEntry } from '../../../electron/ipc-types';
import type { DesktopNeedsYou } from '../../../electron/ipc-types/knowledge.js';
import { desktopIpc } from '../ipc/index.js';
import { buildAgentAttentionItems, isActionableHostApproval, trackAgentAttention } from '../components/desktop/content/room-inbox/agent-attention';
import { isLocalRoomIdentifier } from '../domain/room-urls';
import { hostApprovalRooms, refreshHostApprovals } from '../components/desktop/content/room-chat/host-approvals';

/** Providers whose tools can stop on a host approval. */
const APPROVAL_PROVIDERS = new Set(['codex', 'open-model', 'claude-code']);
/** A tool approval can only be asked inside a room turn. */
const ACTIVE_TURN_STATES = new Set(['dispatching', 'responding', 'publishing', 'retrying']);
/** Same bound as the Needs you room reads; each listing opens two daemon requests. */
const APPROVAL_LIST_CONCURRENCY = 4;
/** Re-checks the time-based rules (agent grace, board wait) between data refreshes. No I/O. */
const CLOCK_TICK_MS = 15_000;

/** Tool approvals, stuck agents and waiting board requests, counted with Needs you. */
export function useAgentAttention(data: Ref<DesktopNeedsYou | null>) {
  const now = ref(Date.now());
  let seen: ReturnType<typeof trackAgentAttention> = {};
  const agentFirstSeenAt = ref<Record<string, string>>({});
  // Agents as last reported: by each Needs you read and, in between, by the
  // supervisor push the room view uses, so a stuck or recovered agent shows at once.
  const agents = ref<DesktopSupervisorManifestEntry[] | undefined>(data.value?.agents);
  watch(() => data.value?.agents, (next) => { agents.value = next; }, { flush: 'sync' });
  const stopLiveAgents = desktopIpc.supervisor?.onLiveAgents?.((entries) => { agents.value = entries; }) ?? null;
  onScopeDispose(() => stopLiveAgents?.());
  // Only a stuck agent or a pending board intent can cross a time rule.
  const waitingOnClock = () => Object.keys(agentFirstSeenAt.value).length > 0
    || Boolean(data.value?.rooms.some(room => room.boardIntents?.some(intent => intent.status === 'pending')));
  const clock = setInterval(() => {
    if ((typeof document === 'undefined' || !document.hidden) && waitingOnClock()) now.value = Date.now();
  }, CLOCK_TICK_MS);
  onScopeDispose(() => clearInterval(clock));
  watch(agents, (list) => {
    seen = trackAgentAttention(seen, list ?? [], Date.now());
    agentFirstSeenAt.value = Object.fromEntries(Object.entries(seen).map(([id, value]) => [id, value.since]));
  }, { immediate: true, flush: 'sync' });
  // A capped room list cannot prove a room is not the account's.
  const accountRooms = computed(() => data.value?.limited ? undefined : new Set((data.value?.rooms ?? []).map(room => room.roomIdentifier)));
  const inAccount = (room: string) => !accountRooms.value || accountRooms.value.has(room) || isLocalRoomIdentifier(room);
  const items = computed(() => buildAgentAttentionItems({
    agents: agents.value, agentFirstSeenAt: agentFirstSeenAt.value, approvalRooms: hostApprovalRooms(),
    rooms: data.value?.rooms, accountRooms: accountRooms.value, nowMs: now.value,
  }));
  function countForRoom(roomIdentifier: string): number {
    return items.value.filter(item => item.roomIdentifier === roomIdentifier).length;
  }
  /**
   * Approvals have no push signal. Re-list rooms where an agent that can ask
   * is mid-turn, and rooms still showing an actionable approval so a decision
   * made elsewhere clears it. The open room's composer keeps its own room fresh.
   */
  async function refreshApprovals(): Promise<void> {
    const rooms = new Set((agents.value ?? [])
      .filter(entry => APPROVAL_PROVIDERS.has(entry.provider) && ACTIVE_TURN_STATES.has(entry.roomAgentState?.turn.state ?? 'idle') && inAccount(entry.roomId))
      .map(entry => entry.roomId));
    for (const [room, state] of hostApprovalRooms()) if (inAccount(room) && state.approvals.some(isActionableHostApproval)) rooms.add(room);
    const queue = [...rooms];
    await Promise.all(Array.from({ length: Math.min(APPROVAL_LIST_CONCURRENCY, queue.length) }, async () => {
      for (let room = queue.shift(); room; room = queue.shift()) await refreshHostApprovals(room);
    }));
  }
  return { items, countForRoom, refreshApprovals };
}
