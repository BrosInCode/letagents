<template>
  <AgentRoster :rows="rosterRows" @select="selectAgent">
    <template #provider="{ row }"><IdeBadge :label="row.provider" /></template>
    <template #detail="{ row }"><WakeRuleLine v-if="row.state === 'Online' && wakeRulesForAgent(activeWakeRules, byId.get(row.id)?.agentKey).length" :rules="wakeRulesForAgent(activeWakeRules, byId.get(row.id)?.agentKey)" /><template v-else>{{ row.detail }}</template></template>
  </AgentRoster>
  <div v-if="canManageParticipants && recentlyDisconnectedAgents.length" class="agents-live-actions"><button class="agents-quiet" type="button" :disabled="clearBusy" @click="emit('clearDisconnected')">{{ clearBusy ? 'Clearing…' : 'Clear disconnected' }}</button></div>
  <dialog ref="dialog" :data-instant="instantDialog" class="agents-live-dialog" aria-label="Agent details" @close="openedId = null" @click.self="dialog?.close()">
    <button type="button" class="agents-quiet agents-dialog-close" aria-label="Close agent details" @click="dialog?.close()">✕</button>
    <ActivityLiveDetail v-if="dialogAgent" :participant="dialogAgent" :task-github-status="taskGithubStatus" :room-identifier="roomIdentifier" :wake-rules="wakeRulesForAgent(activeWakeRules, dialogAgent.agentKey)" :recent-wake-rules="wakeRulesForAgent(recentWakeRules, dialogAgent.agentKey)" :wake-rule-api="wakeRuleApi" @open-reasoning="openReasoning" @open-message="openMessage" />
  </dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import AgentRoster from '../../../../../../shared/ui/agents/AgentRoster.vue'
import type { AgentRosterRow } from '../../../../../../shared/ui/agents/types'
import WakeRuleLine from '../../../../../../shared/ui/WakeRuleLine.vue'
import IdeBadge from '../chat-message/IdeBadge.vue'
import type { WakeRule, WakeRuleApi } from '../../../../../../shared/wake-rules.mjs'
import type { TaskGitHubArtifactStatus } from '@/composables/useRoom'
import { wakeRulesForAgent } from '@/composables/roomWakeRules'
import ActivityLiveDetail from './ActivityLiveDetail.vue'
import type { ActivityParticipant } from './types'

const props = defineProps<{
  participants: readonly ActivityParticipant[]
  connectedAgents: readonly ActivityParticipant[]
  recentlyDisconnectedAgents: readonly ActivityParticipant[]
  humans: readonly ActivityParticipant[]
  selectedParticipant: ActivityParticipant | null
  clearedLiveCount: number
  canManageParticipants: boolean
  clearBusy: boolean
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
  roomIdentifier: string
  activeWakeRules: ReadonlyMap<string, readonly WakeRule[]>
  recentWakeRules: ReadonlyMap<string, readonly WakeRule[]>
  wakeRuleApi: Pick<WakeRuleApi, 'cancel' | 'restore'> | null
}>()

const emit = defineEmits<{
  clearDisconnected: []
  openReasoning: [sessionId: string]
  openMessage: [messageId: string]
}>()

const selectedParticipantKey = defineModel<string | null>('selectedParticipantKey', { required: true })
const dialog = ref<HTMLDialogElement>();
const instantDialog = ref(false);
const openedId = ref<string | null>(null);
const liveAgents = computed(() => [...props.connectedAgents, ...props.recentlyDisconnectedAgents]);
const byId = computed(() => new Map(liveAgents.value.map(agent => [agent.key, agent])));
const dialogAgent = computed(() => openedId.value ? byId.value.get(openedId.value) : null);
const rosterRows = computed<AgentRosterRow[]>(() => liveAgents.value.map(agent => {
  const stale = agent.freshness === 'stale';
  const reachable = !stale && (agent.activityState === 'active' || agent.activityState === 'away');
  const working = reachable && (agent.status === 'working' || agent.status === 'reviewing');
  const attention = reachable && agent.status === 'blocked';
  return { id: agent.key, name: agent.label, provider: agent.ideLabel || 'Agent', owner: agent.ownerLabel || '', state: stale ? 'Updates delayed' : attention ? 'Needs attention' : working ? (agent.status === 'reviewing' ? 'Reviewing' : 'Working') : reachable ? 'Online' : 'Offline', detail: stale ? 'Waiting for a fresh update from the host.' : agent.statusText || (reachable ? 'Ready for room work.' : 'Shared work is still available.'), tone: stale || attention ? 'amber' : working ? 'blue' : reachable ? 'green' : 'neutral', working, attention, moving: working };
}));
async function selectAgent(id: string, event: MouseEvent) { instantDialog.value = event.detail === 0; openedId.value = id; selectedParticipantKey.value = id; await nextTick(); dialog.value?.showModal(); }
function openReasoning(id: string) { dialog.value?.close(); emit('openReasoning', id); }
function openMessage(id: string) { dialog.value?.close(); emit('openMessage', id); }
watch(liveAgents, agents => { if (!agents.some(agent => agent.key === openedId.value)) dialog.value?.close(); });
</script>

<style scoped>
.agents-live-actions { display: flex; justify-content: flex-end; padding: 8px 0; }
.agents-live-dialog { margin: auto; overflow: auto; border: 1px solid var(--agents-line); border-radius: 18px; padding: 24px; width: 620px; max-width: calc(100vw - 32px); max-height: calc(100dvh - 40px); background: var(--bg, #0a0a0a); color: var(--agents-text); overscroll-behavior: contain; }
.agents-live-dialog::backdrop { background: #0009; }
.agents-live-dialog[open] { animation: agent-dialog-in 220ms cubic-bezier(.22,1,.36,1); }
.agents-live-dialog[data-instant=true] { animation: none; }
.agents-dialog-close { position: sticky; top: 0; float: right; z-index: 1; background: var(--bg, #0a0a0a); }
.agents-live-dialog :deep(.activity-detail) { border: 0; background: transparent; padding: 0; overflow: visible; max-height: none; }
@media (max-width: 640px) {
  .agents-live-dialog { width: calc(100vw - 24px); max-width: none; max-height: calc(100dvh - 24px); padding: 16px; padding-bottom: max(16px, env(safe-area-inset-bottom)); border-radius: 12px; }
  .agents-dialog-close { min-width: 44px; min-height: 44px; }
}
@keyframes agent-dialog-in { from { opacity: 0; transform: translateY(6px) scale(.99); } to { opacity: 1; transform: none; } }
@media(prefers-reduced-motion:reduce) { .agents-live-dialog[open] { animation: none; } }
</style>
