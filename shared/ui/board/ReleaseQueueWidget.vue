<template>
  <div class="release-widget board-plan-fields">
    <button v-if="snapshot?.document.releaseRule && ((snapshot.releases?.items.length || 0) > 0 || open)" ref="trigger" class="release-widget-trigger" type="button" aria-haspopup="dialog" :aria-expanded="open" @click="show"><BoardIcon name="pr" />Waiting for release<span>· {{ snapshot.releases?.items.length || 0 }} {{ snapshot.releases?.items.length === 1 ? 'ticket' : 'tickets' }}</span></button>
    <dialog ref="dialog" class="board-dialog release-dialog" :aria-labelledby="titleId" @cancel.prevent="close" @click="backdrop">
      <header class="board-dialog-header"><h2 :id="titleId">Waiting for release</h2><button type="button" class="board-icon-button" aria-label="Close release queue" @click="close"><BoardIcon name="close" /></button></header>
      <div class="board-dialog-body">
        <p v-if="error" class="release-notice" role="alert">{{ error }}</p>
        <ReleaseQueue v-if="snapshot" :items="snapshot.releases?.items || []" :unavailable="snapshot.releases?.unavailable || 0" :description="releaseDescription(snapshot)" @select="select" @external="external" />
      </div>
      <footer class="board-dialog-footer"><button type="button" class="board-button" :disabled="loading" @click="refresh">{{ loading ? 'Refreshing…' : 'Refresh' }}</button></footer>
    </dialog>
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
const snapshot = ref<BoardPlanningSnapshot | null>(null), dialog = ref<HTMLDialogElement>(), trigger = ref<HTMLButtonElement>();
const open = ref(false), loading = ref(false), error = ref(''), titleId = `release-${useId()}`;
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
function show() { open.value = true; dialog.value?.showModal(); void refresh(); }
function close() { open.value = false; dialog.value?.close(); trigger.value?.focus({ preventScroll: true }); }
function select(id: string) { close(); emit('select', id); }
async function external(url: string) { const safe = safeWorkUrl(url); if (!safe) return; try { await props.openExternal(safe); } catch { error.value = 'The link could not be opened.'; } }
function backdrop(event: MouseEvent) { if (event.target !== dialog.value) return; const r = dialog.value.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); }
watch(() => props.roomId, () => { generation++; snapshot.value = null; loading.value = false; error.value = ''; close(); void refresh(); }, { immediate: true });
function visibleRefresh() { if (document.visibilityState === 'visible') void refresh(); }
onMounted(() => { timer = setInterval(visibleRefresh, 60_000); document.addEventListener('visibilitychange', visibleRefresh); });
onBeforeUnmount(() => { generation++; clearInterval(timer); document.removeEventListener('visibilitychange', visibleRefresh); });
</script>
