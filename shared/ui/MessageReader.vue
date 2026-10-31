<template>
  <Teleport to="body">
    <dialog ref="dialog" class="message-reader" :data-text-size="selectedReaderTextSize"
      :aria-labelledby="titleId" tabindex="-1" data-testid="message-reader-dialog"
      @cancel.prevent="cancel" @click="handleDialogClick" @keydown.stop @contextmenu.stop @close="emit('close')">
      <header class="message-reader-header">
        <div class="message-reader-sender">
          <ChatAvatar :name="sender?.name || 'Message'" :avatar-url="sender?.avatarUrl" :agent="sender?.agent"
            :provider="sender?.provider" :agent-key="sender?.agentKey" />
          <div class="message-reader-identity">
            <h2 :id="titleId">{{ sender?.name || 'Message reader' }}</h2>
            <p v-if="sender?.context || formattedTime">
              <span v-if="sender?.context">{{ sender.context }}</span>
              <span v-if="sender?.context && formattedTime" class="message-reader-dot" aria-hidden="true">·</span>
              <time v-if="formattedTime" :datetime="sender?.timestamp || undefined" :title="fullTimestamp">{{ formattedTime }}</time>
            </p>
          </div>
        </div>
        <div class="message-reader-actions">
          <button class="message-reader-copy" type="button" :aria-label="copied ? 'Message copied' : 'Copy message'" @click="copyText">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="copied" d="m5 12 4 4L19 6"/><template v-else><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></template></svg>
            <span>{{ copied ? 'Copied' : 'Copy' }}</span>
          </button>
          <div ref="typeControl" class="message-reader-type-control">
            <button ref="typeToggle" type="button" class="message-reader-icon message-reader-type-toggle"
              aria-label="Reading text size" title="Text size" :aria-expanded="optionsOpen" :aria-controls="optionsId" @click="toggleOptions">Aa</button>
            <div v-if="optionsOpen" :id="optionsId" class="message-reader-type-options">
              <p>{{ preview ? `Preview · ${sizeLabels[preview]}` : 'Text size' }}</p>
              <div role="group" aria-label="Text size">
                <button v-for="size in sizes" :key="size" type="button" :data-size="size"
                  :aria-label="`${sizeLabels[size]} text`" :aria-pressed="selectedReaderTextSize === size"
                  @pointerenter="previewPointer($event, size)" @pointerleave="restorePreview"
                  @focus="previewFocus($event, size)" @blur="restorePreview" @click="commitSize(size)">A</button>
              </div>
            </div>
          </div>
          <span class="message-reader-action-divider" aria-hidden="true" />
          <button class="message-reader-icon" type="button" aria-label="Close reader" title="Close reader (Esc)" @click="emit('close')">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </div>
      </header>
      <div ref="scroll" class="message-reader-scroll" tabindex="0" aria-label="Message content">
        <div class="message-reader-column">
          <p v-if="roomLabel" class="message-reader-room">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4Z"/></svg>{{ roomLabel }}
          </p>
          <article ref="content" class="message-reader-prose" v-html="html" @click="emit('contentClick', $event)" />
        </div>
      </div>
      <p class="message-reader-status" role="status">{{ copyStatus }}</p>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import ChatAvatar from './ChatAvatar.vue';
import { captureReadingPosition, restoreReadingPosition, selectedReaderTextSize,
  type MessageReaderSender, type ReaderTextSize, type ReadingPosition } from './message-reader';
import './message-reader.css';

const props = defineProps<{ text: string; html: string; sender?: MessageReaderSender; roomIdentifier?: string | null }>();
const emit = defineEmits<{ close: []; contentClick: [event: MouseEvent] }>();
const id = useId();
const titleId = `message-reader-title-${id}`;
const optionsId = `message-reader-size-${id}`;
const dialog = ref<HTMLDialogElement | null>(null);
const scroll = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const typeControl = ref<HTMLElement | null>(null);
const typeToggle = ref<HTMLButtonElement | null>(null);
const optionsOpen = ref(false);
const preview = ref<ReaderTextSize | null>(null);
const copied = ref(false);
const copyStatus = ref('');
const sizes: ReaderTextSize[] = ['small', 'default', 'large'];
const sizeLabels = { small: 'Small', default: 'Default', large: 'Large' };
let position: ReadingPosition | null = null;
let opener: HTMLElement | null = null;
let disposed = false;
const roomLabel = computed(() => props.roomIdentifier?.replace(/^github\.com\//i, '') || '');
const sentAt = computed(() => {
  const date = new Date(props.sender?.timestamp || '');
  return Number.isFinite(date.getTime()) ? date : null;
});
const fullTimestamp = computed(() => sentAt.value?.toLocaleString() || '');
const formattedTime = computed(() => {
  const date = sentAt.value;
  if (!date) return '';
  const day = date.toDateString() === new Date().toDateString() ? 'Today' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day}, ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
});

onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.value?.showModal();
  dialog.value?.focus({ preventScroll: true });
});
onBeforeUnmount(() => {
  disposed = true;
  dialog.value?.close();
  if (opener?.isConnected) opener.focus({ preventScroll: true });
});
function applySize(size: ReaderTextSize, anchor?: ReadingPosition | null) {
  if (dialog.value) dialog.value.dataset.textSize = size;
  if (scroll.value && anchor) restoreReadingPosition(scroll.value, anchor);
}
function restorePreview() {
  if (!preview.value) return;
  applySize(selectedReaderTextSize.value);
  if (scroll.value && position) restoreReadingPosition(scroll.value, position, true);
  position = null;
  preview.value = null;
}
function previewSize(size: ReaderTextSize) {
  if (!optionsOpen.value || !scroll.value || !content.value) return;
  position ??= captureReadingPosition(content.value, scroll.value);
  preview.value = size;
  applySize(size, position);
}
function previewPointer(event: PointerEvent, size: ReaderTextSize) {
  if (event.pointerType !== 'touch' && window.matchMedia('(hover: hover) and (pointer: fine)').matches) previewSize(size);
}
function previewFocus(event: FocusEvent, size: ReaderTextSize) {
  if ((event.target as HTMLElement).matches(':focus-visible')) previewSize(size);
}
function closeOptions() {
  restorePreview();
  optionsOpen.value = false;
  dialog.value?.style.removeProperty('height');
}
function toggleOptions() {
  if (optionsOpen.value) { closeOptions(); return; }
  if (dialog.value) dialog.value.style.height = `${dialog.value.getBoundingClientRect().height}px`;
  optionsOpen.value = true;
}
function commitSize(size: ReaderTextSize) {
  const anchor = position ?? (content.value && scroll.value ? captureReadingPosition(content.value, scroll.value) : null);
  restorePreview();
  selectedReaderTextSize.value = size;
  applySize(size, anchor);
  closeOptions();
  typeToggle.value?.focus({ preventScroll: true });
}
function cancel() {
  if (optionsOpen.value) { closeOptions(); typeToggle.value?.focus({ preventScroll: true }); }
  else emit('close');
}
function handleDialogClick(event: MouseEvent) {
  if (event.target === dialog.value) {
    const rect = dialog.value!.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      emit('close');
      return;
    }
  }
  if (!typeControl.value?.contains(event.target as Node)) closeOptions();
}
async function copyText() {
  try {
    await navigator.clipboard.writeText(props.text);
    if (!disposed) { copied.value = true; copyStatus.value = 'Message copied'; }
  } catch {
    if (!disposed) { copied.value = false; copyStatus.value = 'Could not copy. Select the message text and copy it manually.'; }
  }
}
</script>
