<template>
  <section class="agent-workspace" aria-label="Agent workspace">
    <div class="agent-workspace-heading"><button v-if="turn" type="button" @click="showFullWorkspace">← Full workspace</button><span v-else>Full workspace</span><button v-if="!turn && selected && latest && selected.revision !== latest.revision || !turn && selected && latest && selected.attemptId !== latest.attemptId" type="button" @click="showFullWorkspace">View newer snapshot</button><span v-if="status !== 'ready'">Updates unavailable</span></div>
    <template v-if="snapshot">
      <header class="agent-workspace-context"><h3>{{ turn ? 'Changes during this turn' : 'Changes since workspace started' }}</h3><p><GitBranch :size="13" aria-hidden="true" />{{ snapshot.branch || 'Workspace' }}</p><div><span>{{ snapshot.files.length + snapshot.hidden_files }} files</span><b>+{{ snapshot.additions }}</b><b>−{{ snapshot.deletions }}</b><time :datetime="snapshot.captured_at">Captured {{ formatShortDateTime(snapshot.captured_at) }}</time></div></header>
      <p v-if="turn && summary" class="agent-workspace-summary">{{ summary }}</p>
      <WorkspaceDiff :snapshot="snapshot" />
    </template>
    <div v-else class="agent-workspace-empty"><FileDiff :size="28" aria-hidden="true" /><h3>No workspace snapshot available</h3><p>Changes appear here after this agent finishes a turn and its host shares a snapshot.</p></div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { FileDiff, GitBranch } from '@lucide/vue';
import type { DesktopRoomAgentWork } from '../../../../../../electron/ipc-types';
import { contributionSummary } from '../../../../domain/room-contributions';
import { formatShortDateTime } from '../../../../domain/time';
import WorkspaceDiff from './WorkspaceDiff.vue';
const props = defineProps<{ work: readonly DesktopRoomAgentWork[]; agentKey: string | null; sourceMessageId?: string | null; status: string }>();
const selected = ref<DesktopRoomAgentWork | null>(null);
const turn = ref(false);
const latest = computed(() => props.work.filter(entry => entry.agentKey === props.agentKey && 'workspace' in entry.summary)
  .sort((a, b) => Date.parse('workspace' in b.summary ? b.summary.workspace?.captured_at ?? '' : '') - Date.parse('workspace' in a.summary ? a.summary.workspace?.captured_at ?? '' : ''))[0] ?? null);
function showFullWorkspace() { turn.value = false; selected.value = latest.value; }
watch([() => props.agentKey, () => props.sourceMessageId], () => {
  turn.value = Boolean(props.sourceMessageId);
  selected.value = turn.value ? props.work.find(entry => entry.agentKey === props.agentKey && entry.sourceMessageId === props.sourceMessageId) ?? null : latest.value;
}, { immediate: true });
watch(() => props.work, work => {
  // Keep the review still while reading. Cleared/evicted snapshots must disappear.
  if (selected.value && !work.some(entry => entry.attemptId === selected.value?.attemptId && 'workspace' in entry.summary)) selected.value = null;
  if (!selected.value) selected.value = turn.value ? work.find(entry => entry.agentKey === props.agentKey && entry.sourceMessageId === props.sourceMessageId && 'workspace' in entry.summary) ?? null : latest.value;
});
const snapshot = computed(() => selected.value && 'workspace' in selected.value.summary
  ? turn.value ? selected.value.summary.contribution?.changes : selected.value.summary.workspace : null);
const summary = computed(() => selected.value ? contributionSummary(selected.value) : '');
</script>
<style scoped>
.agent-workspace { display: flex; flex-direction: column; min-height: 440px; height: 100%; }
.agent-workspace-heading { display: flex; justify-content: space-between; gap: 12px; color: var(--text-secondary); font-size: 11px; margin: 4px 0 18px; }
.agent-workspace-heading button { padding: 0; border: 0; background: none; color: var(--text-secondary); font: inherit; cursor: pointer; }
.agent-workspace-heading button:focus-visible { outline: 2px solid var(--blue); outline-offset: 4px; }
.agent-workspace-context h3 { margin: 0 0 10px; font-size: 17px; letter-spacing: -.025em; font-weight: 600; }
.agent-workspace-context p { display: flex; align-items: center; gap: 6px; margin: 0 0 14px; color: var(--text-secondary); font-size: 11px; overflow-wrap: anywhere; }
.agent-workspace-context p svg { flex-shrink: 0; }
.agent-workspace-context div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 9px; font-size: 11px; font-variant-numeric: tabular-nums; margin-bottom: 18px; }
.agent-workspace-context b { color: light-dark(#167544, #88d9a2); font-weight: 500; }
.agent-workspace-context b + b { color: light-dark(#bd3548, #ef9ba5); }
.agent-workspace-context time { margin-left: auto; color: var(--text-secondary); font-size: 10px; }
.agent-workspace-summary { margin: 0 0 18px; color: var(--text-secondary); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.agent-workspace-empty { display: grid; place-items: center; text-align: center; margin: auto; padding: 36px 20px; color: var(--text-secondary); }
.agent-workspace-empty h3 { color: var(--text); font-size: 15px; }
.agent-workspace-empty p { font-size: 12px; line-height: 1.65; }
</style>
