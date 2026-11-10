<template>
  <div class="release-widget board-plan-fields" :data-open="open">
    <button v-if="snapshot?.document.releaseRule && ((snapshot.releases?.items.length || 0) > 0 || open)" ref="trigger" class="release-widget-trigger" type="button" aria-haspopup="dialog" :aria-expanded="open" :aria-label="`${open ? 'Hide' : 'Show'} work waiting for release (${snapshot.releases?.items.length || 0} tickets)`" :popovertarget="panelId" @click="refresh"><BoardIcon name="branch" /><strong>Work</strong></button>
    <section :id="panelId" ref="panel" popover="auto" role="dialog" class="release-popover" :aria-labelledby="titleId" :style="position" @beforetoggle="toggled">
      <div class="release-popover-top"><span class="release-popover-chip">Release queue</span><button type="button" class="board-icon-button" aria-label="Close release queue" @click="close(true)"><BoardIcon name="close" /></button></div>
      <header class="release-popover-heading"><span class="release-popover-icon"><BoardIcon name="pr" /></span><div><small>Waiting for release</small><h2 :id="titleId">{{ snapshot?.releases?.items.length || 0 }} {{ snapshot?.releases?.items.length === 1 ? 'ticket' : 'tickets' }}</h2></div></header>
      <div class="release-popover-body">
        <p v-if="error" class="release-notice" role="alert">{{ error }}</p>
        <ReleaseQueue v-if="snapshot" :items="snapshot.releases?.items || []" :unavailable="snapshot.releases?.unavailable || 0" :description="releaseDescription(snapshot)" @select="select" @external="external" />
      </div>
      <footer class="release-popover-footer"><button type="button" :disabled="loading" @click="refresh"><BoardIcon name="refresh" />{{ loading ? 'Refreshing…' : 'Refresh' }}</button></footer>
    </section>
  </div>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import type { BoardPlanningSnapshot } from '../../board-planning.mjs';
import { safeWorkUrl } from '../my-work/model';
import BoardIcon from './BoardIcon.vue';
import ReleaseQueue from './ReleaseQueue.vue';
import { releaseDescription } from './release-queue';
import './board.css';
const props = defineProps<{ roomId: string; load: () => Promise<BoardPlanningSnapshot>; openExternal: (url: string) => unknown }>();
const emit = defineEmits<{ select: [id: string] }>();
const snapshot = ref<BoardPlanningSnapshot | null>(null), panel = ref<HTMLElement>(), trigger = ref<HTMLButtonElement>();
const open = ref(false), loading = ref(false), error = ref(''), panelId = `release-${useId()}`, titleId = `${panelId}-title`;
const position = ref<Record<string, string>>({});
let generation = 0, timer: ReturnType<typeof setInterval> | undefined;
async function refresh() {
  if (loading.value) return;
  const current = ++generation, room = props.roomId;
  loading.value = true;
  try {
    const result = await props.load();
    if (current !== generation || room !== props.roomId) return;
    snapshot.value = result; error.value = '';
    if (!result.document.releaseRule) close();
  } catch { if (current === generation) error.value = 'Could not refresh. Showing the last loaded release queue.'; }
  finally { if (current === generation) loading.value = false; }
}
function place() {
  const rect = trigger.value?.getBoundingClientRect();
  if (!rect || typeof window === 'undefined') return;
  const below = window.innerHeight - rect.bottom - 24;
  position.value = {
    right: `${Math.max(16, window.innerWidth - rect.right)}px`,
    ...(below >= 180 ? { top: `${rect.bottom + 8}px`, bottom: 'auto', maxHeight: `${below}px`, transformOrigin: 'top right' }
      : { top: 'auto', bottom: `${window.innerHeight - rect.top + 8}px`, maxHeight: `${Math.max(80, rect.top - 24)}px`, transformOrigin: 'bottom right' }),
  };
}
function toggled(event: Event) { open.value = (event as ToggleEvent).newState === 'open'; if (open.value) place(); }
function close(returnFocus = false) { open.value = false; panel.value?.hidePopover(); if (returnFocus) trigger.value?.focus({ preventScroll: true }); }
function select(id: string) { close(); emit('select', id); }
async function external(url: string) { const safe = safeWorkUrl(url); if (!safe) return; try { await props.openExternal(safe); } catch { error.value = 'The link could not be opened.'; } }
watch(() => props.roomId, () => { generation++; snapshot.value = null; loading.value = false; error.value = ''; close(); void refresh(); }, { immediate: true });
function visibleRefresh() { if (document.visibilityState === 'visible') void refresh(); }
function reposition() { if (open.value) place(); }
onMounted(() => { timer = setInterval(visibleRefresh, 60_000); document.addEventListener('visibilitychange', visibleRefresh); if (typeof window !== 'undefined') { window.addEventListener('resize', reposition); window.addEventListener('scroll', reposition, true); } });
onBeforeUnmount(() => { generation++; clearInterval(timer); document.removeEventListener('visibilitychange', visibleRefresh); if (typeof window !== 'undefined') { window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); } });
</script>
