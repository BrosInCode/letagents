<template>
  <section class="agent-workspace" aria-label="Agent workspace">
    <div class="agent-workspace-heading"><button v-if="turn" type="button" @click="showFullWorkspace">← Full workspace</button><span v-else>Full workspace</span><button v-if="!turn && latest && selected?.attemptId !== latest.attemptId" type="button" @click="showFullWorkspace">View newer snapshot</button><span v-if="status !== 'ready'">Updates unavailable</span></div>
    <template v-if="snapshot">
      <header class="agent-workspace-context"><h3>{{ turn ? 'Changes during this turn' : 'Changes since workspace started' }}</h3><p><GitBranch :size="13" aria-hidden="true" />{{ snapshot.branch || 'Workspace' }}</p><div><span>{{ snapshot.files.length + snapshot.hidden_files }} {{ snapshot.files.length + snapshot.hidden_files === 1 ? 'file' : 'files' }}</span><b>+{{ snapshot.additions }}</b><b>−{{ snapshot.deletions }}</b><time :datetime="snapshot.captured_at">Captured {{ formatShortDateTime(snapshot.captured_at) }}</time></div></header>
      <ContributionDescription v-if="turn && selected" :work="selected" />
      <div v-if="reviewState !== 'idle' && reviewState !== 'ready'" class="agent-workspace-load" role="status">
        <span>{{ reviewState === 'loading' ? 'Loading complete review…' : reviewState === 'pending' ? 'The host is still sharing this review.' : reviewState === 'error' ? 'Couldn’t load the complete review.' : 'Only the original preview is available for this capture.' }}</span>
        <button v-if="reviewState !== 'loading'" type="button" @click="retryReview++">Try again</button>
      </div>
      <WorkspaceDiff :snapshot="snapshot" :view-key="`${activeRequestId}:${turn}`" :load-page="reviewState === 'ready' ? loadPage : undefined" />
    </template>
    <div v-else class="agent-workspace-empty"><FileDiff :size="28" aria-hidden="true" /><h3>No workspace snapshot available</h3><p>Changes appear here after this agent finishes a turn and its host shares a snapshot.</p></div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { FileDiff, GitBranch } from '@lucide/vue';
import type { DesktopRoomAgentWork } from '../../../../../../electron/ipc-types';
import ContributionDescription from '../room-chat/ContributionDescription.vue';
import { formatShortDateTime } from '../../../../domain/time';
import WorkspaceDiff from './WorkspaceDiff.vue';
const props = defineProps<{ work: readonly DesktopRoomAgentWork[]; agentKey: string | null; sourceMessageId?: string | null; requestVersion?: number; status: string }>();
const selected = ref<DesktopRoomAgentWork | null>(null);
const turn = ref(false);
const latest = computed(() => props.work.filter(entry => entry.agentKey === props.agentKey && 'workspace' in entry.summary)
  .sort((a, b) => Date.parse('workspace' in b.summary ? b.summary.workspace?.captured_at ?? '' : '') - Date.parse('workspace' in a.summary ? a.summary.workspace?.captured_at ?? '' : ''))[0] ?? null);
function showFullWorkspace() { turn.value = false; selected.value = latest.value; }
watch([() => props.agentKey, () => props.sourceMessageId, () => props.requestVersion], () => {
  turn.value = Boolean(props.sourceMessageId);
  selected.value = turn.value ? props.work.find(entry => entry.agentKey === props.agentKey && entry.sourceMessageId === props.sourceMessageId) ?? null : latest.value;
}, { immediate: true });
watch(() => props.work, work => {
  // Keep the review still while reading. Cleared/evicted snapshots must disappear.
  if (selected.value && !work.some(entry => entry.attemptId === selected.value?.attemptId && 'workspace' in entry.summary)) selected.value = null;
  if (!selected.value) selected.value = turn.value ? work.find(entry => entry.agentKey === props.agentKey && entry.sourceMessageId === props.sourceMessageId && 'workspace' in entry.summary) ?? null : latest.value;
});
const previewSnapshot = computed(() => selected.value && 'workspace' in selected.value.summary
  ? turn.value ? selected.value.summary.contribution?.changes : selected.value.summary.workspace : null);

const review = shallowRef<import('../../../../../../../../shared/workspace-review.mjs').WorkspaceReview | null>(null);
const reviewState = ref<'idle' | 'loading' | 'ready' | 'pending' | 'unavailable' | 'error'>('idle');
const retryReview = ref(0);
const activeRequestId = ref('');
watch([selected, retryReview], async ([work], _, onCleanup) => {
  let cancelled = false;
  const requestId = crypto.randomUUID();
  activeRequestId.value = requestId;
  onCleanup(() => { cancelled = true; void window.letagentsDesktop?.app.closeWorkspaceReview?.({ requestId }).catch(() => {}); });
  review.value = null; reviewState.value = 'idle';
  if (!work || !('workspace' in work.summary)) return;
  const needsFullReview = [work.summary.workspace, work.summary.contribution?.changes].some(value => value && (value.patch_truncated || value.hidden_files));
  if (!needsFullReview) return;
  const load = window.letagentsDesktop?.app.readWorkspaceReview;
  if (!load) { reviewState.value = 'unavailable'; return; }
  reviewState.value = 'loading';
  try {
    const result = await load({ requestId, roomId: work.roomId, agentKey: work.agentKey, sourceMessageId: work.sourceMessageId, attemptId: work.attemptId });
    if (cancelled) return;
    if (result.status === 'ready') {
      // The full payload must describe the same immutable capture being read.
      for (const [full, small] of [[result.review.workspace, work.summary.workspace], [result.review.contribution, work.summary.contribution?.changes]] as const) {
        if (small && (full.captured_at !== small.captured_at || full.base_revision !== small.base_revision
          || full.additions !== small.additions || full.deletions !== small.deletions)) throw new Error('Different capture returned.');
      }
      review.value = result.review;
    }
    reviewState.value = result.status;
  } catch { if (!cancelled) reviewState.value = 'error'; }
}, { immediate: true });
async function loadPage(path: string, options: import('../../../../domain/workspace-diff').WorkspaceDiffPageOptions) {
  const load = window.letagentsDesktop?.app.readWorkspaceReviewPage;
  if (!load) throw new Error('Review is unavailable.');
  return load({ requestId: activeRequestId.value, view: turn.value ? 'contribution' : 'workspace', path, ...options });
}
const snapshot = computed(() => review.value ? turn.value ? review.value.contribution : review.value.workspace : previewSnapshot.value);
</script>
<style scoped>
.agent-workspace-load { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 10px 0; font-size: 12px; color: var(--text-secondary); }
.agent-workspace-load button { flex-shrink: 0; background: none; border: 0; color: var(--blue); font: inherit; cursor: pointer; }
.agent-workspace-load button:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
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
.agent-workspace-empty { display: grid; place-items: center; text-align: center; margin: auto; padding: 36px 20px; color: var(--text-secondary); }
.agent-workspace-empty h3 { color: var(--text); font-size: 15px; }
.agent-workspace-empty p { font-size: 12px; line-height: 1.65; }
</style>
