<template>
  <slot />
  <Teleport :to="portalTarget || 'body'">
  <section ref="panel" popover="auto" role="dialog" class="task-link-preview board-plan-fields" :aria-labelledby="titleId" :style="position" :data-instant="instant" @beforetoggle="toggled" @keydown.esc.stop.prevent="close(true)" @focusout="focusLeft">
    <header class="task-preview-heading">
      <div><span>{{ task?.ticket?.key || selectedId?.replace(/^task_/, 'T') }}</span><span v-if="task" class="task-preview-status">{{ statusLabel(task.status) }}</span></div>
      <button ref="closeButton" type="button" class="board-icon-button" aria-label="Close task preview" @click="close(true)"><BoardIcon name="close" /></button>
    </header>
    <template v-if="task">
      <h2 :id="titleId">{{ task.title }}</h2>
      <div class="task-preview-meta">
        <span>{{ task.assigneeLabel || 'Unassigned' }}</span>
        <a v-if="prUrl" :href="prUrl" class="board-pr" @click.prevent="external(prUrl)"><BoardIcon name="pr" />{{ task.pr?.number ? '#' + task.pr.number : 'Pull request' }}<BoardIcon name="external" /></a>
      </div>
      <div v-if="task.description" class="task-preview-description"><slot name="description" :text="task.description">{{ task.description }}</slot></div>
    </template>
    <h2 v-else :id="titleId">Task details are unavailable.</h2>
    <p v-if="error" class="task-preview-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="task-preview-notice" role="status">{{ notice }}</p>
    <footer>
      <button type="button" class="board-button" @click="openBoard">Open on board<BoardIcon name="right" /></button>
      <button v-if="canAccept" type="button" class="board-button board-primary" :disabled="busy" @click="acceptTask">{{ busy ? 'Accepting…' : 'Accept task' }}</button>
    </footer>
  </section>
  </Teleport>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, useId, watch } from 'vue';
import BoardIcon from './BoardIcon.vue';
import { statusLabel } from './model';
import { safeWorkUrl } from '../my-work/model';
import { taskLinkPreviewKey } from './task-link-preview';
import type { BoardTask } from './types';
import './board.css';
import './task-link-preview.css';

const props = withDefaults(defineProps<{ roomId: string; tasks: readonly BoardTask[]; active?: boolean; accept: (id: string) => Promise<boolean>; openExternal: (url: string) => unknown }>(), { active: true });
const emit = defineEmits<{ openBoard: [id: string] }>();
const panel = ref<HTMLElement>(), closeButton = ref<HTMLButtonElement>(), anchor = shallowRef<HTMLElement>();
const portalTarget = shallowRef<HTMLElement | null>(null);
const selectedId = ref<string | null>(null), open = ref(false), instant = ref(false), busy = ref(false), error = ref(''), notice = ref('');
const position = ref<Record<string, string>>({}), titleId = `task-preview-${useId()}`;
let generation = 0;
let beforeNavigate: (() => void) | undefined;
const task = computed(() => props.tasks.find(item => item.id === selectedId.value));
const canAccept = computed(() => !notice.value && task.value?.status === 'proposed' && task.value.allowedTransitions.some(action => action.targetStatus === 'accepted'));
const prUrl = computed(() => safeWorkUrl(task.value?.pr?.url || null));

function place() {
  const rect = anchor.value?.getBoundingClientRect();
  if (!rect || !anchor.value?.isConnected || rect.bottom < 0 || rect.top > window.innerHeight) { close(); return false; }
  const width = Math.min(420, window.innerWidth - 24), below = window.innerHeight - rect.bottom - 20;
  position.value = { left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
    ...(below >= 250 || below >= rect.top ? { top: `${Math.max(12, rect.bottom + 8)}px`, bottom: 'auto', maxHeight: `${Math.max(80, below)}px`, transformOrigin: 'top left' }
      : { top: 'auto', bottom: `${window.innerHeight - rect.top + 8}px`, maxHeight: `${Math.max(80, rect.top - 20)}px`, transformOrigin: 'bottom left' }) };
  return true;
}
async function show(id: string, source: HTMLElement, keyboard: boolean, onNavigate?: () => void) {
  if (!props.active) return;
  const room = props.roomId;
  beforeNavigate = onNavigate;
  portalTarget.value = source.closest<HTMLElement>('dialog[open]');
  selectedId.value = id; anchor.value = source; instant.value = keyboard; error.value = ''; notice.value = '';
  await nextTick();
  if (room !== props.roomId || !props.active || anchor.value !== source) return;
  if (!place()) return;
  panel.value?.showPopover(); open.value = true;
  closeButton.value?.focus({ preventScroll: true });
}
provide(taskLinkPreviewKey, show);
function close(returnFocus = false) { if (panel.value?.isConnected) panel.value.hidePopover(); open.value = false; if (returnFocus && anchor.value?.isConnected) anchor.value.focus({ preventScroll: true }); }
function toggled(event: Event) { open.value = (event as ToggleEvent).newState === 'open'; }
function focusLeft(event: FocusEvent) { if (event.relatedTarget instanceof Node && !panel.value?.contains(event.relatedTarget)) close(); }
function openBoard() { const id = selectedId.value; close(); beforeNavigate?.(); if (id) emit('openBoard', id); }
async function acceptTask() {
  if (!canAccept.value || busy.value || !task.value) return;
  const id = task.value.id, room = props.roomId, request = ++generation;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const accepted = await props.accept(id);
    if (request !== generation || room !== props.roomId || id !== selectedId.value) return;
    if (accepted) notice.value = 'Task accepted.';
    else error.value = 'Task could not be accepted. Try again.';
  } catch { if (request === generation && id === selectedId.value) error.value = 'Task could not be accepted. Try again.'; }
  finally { if (request === generation) busy.value = false; }
}
async function external(url: string) { const room = props.roomId, id = selectedId.value; try { await props.openExternal(url); } catch { if (room === props.roomId && id === selectedId.value) error.value = 'The link could not be opened.'; } }
watch(() => props.roomId, () => { generation++; busy.value = false; close(); selectedId.value = null; error.value = ''; notice.value = ''; });
watch(() => props.active, value => { if (!value) close(); });
function reposition(event?: Event) { if (open.value && !(event?.target instanceof Node && panel.value?.contains(event.target))) place(); }
onMounted(() => { window.addEventListener('resize', reposition); window.addEventListener('scroll', reposition, true); });
onBeforeUnmount(() => { generation++; window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); });
</script>
