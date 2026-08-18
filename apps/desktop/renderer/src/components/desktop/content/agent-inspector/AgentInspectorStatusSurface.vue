<template>
  <aside
    ref="surfaceElement"
    class="agent-inspector-surface agent-inspector-status-surface"
    :data-compact="compact"
    :role="compact ? 'dialog' : 'complementary'"
    :aria-modal="compact ? 'true' : undefined"
    aria-labelledby="agent-inspector-status-title"
    @keydown="handleKeydown"
  >
    <header class="agent-inspector-header">
      <div class="agent-inspector-identity">
        <div>
          <div class="agent-inspector-name-line">
            <h2 id="agent-inspector-status-title">{{ title }}</h2>
          </div>
          <p>{{ eyebrow }}</p>
        </div>
      </div>
      <button ref="closeButton" type="button" class="agent-inspector-close" aria-label="Close agent inspector" @click="emit('close')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </header>
    <div class="agent-inspector-status-copy">
      <strong>{{ heading }}</strong>
      <p>{{ detail }}</p>
    </div>
    <div v-if="canRetry" class="agent-inspector-actions agent-inspector-status-actions">
      <button type="button" @click="emit('retry')">Try again</button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{
  compact: boolean;
  title: string;
  eyebrow: string;
  heading: string;
  detail: string;
  canRetry: boolean;
}>();
const emit = defineEmits<{ close: []; retry: [] }>();
const surfaceElement = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);

function focusInitial(): void {
  closeButton.value?.focus({ preventScroll: true });
}

function containsFocus(): boolean {
  return Boolean(surfaceElement.value?.contains(document.activeElement));
}

defineExpose({ focusInitial, containsFocus });

function handleKeydown(event: KeyboardEvent): void {
  if (!props.compact && event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (!props.compact || event.key !== "Tab" || !surfaceElement.value) return;
  const focusable = [...surfaceElement.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>
