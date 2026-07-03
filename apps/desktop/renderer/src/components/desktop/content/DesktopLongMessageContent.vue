<template>
  <div class="desktop-long-message" data-testid="desktop-long-message">
    <div
      :id="contentId"
      class="desktop-long-message-content"
      :class="{ collapsed: isLong && !expanded }"
      :data-testid="`desktop-long-message-content-${safeMessageId}`"
    >
      <div class="desktop-long-message-html" v-html="html" @click="handleMessageReferenceClick" />
      <span v-if="isLong && !expanded" class="desktop-long-message-fade" aria-hidden="true" />
    </div>

    <div v-if="isLong" class="desktop-long-message-actions">
      <span>{{ statsLabel }}</span>
      <button
        type="button"
        :aria-expanded="expanded"
        :aria-controls="contentId"
        data-testid="desktop-long-message-toggle"
        @click="expanded = !expanded"
      >
        {{ expanded ? "Collapse" : "Read more" }}
      </button>
      <button type="button" data-testid="desktop-open-reader" @click="openReader">
        Open reader
      </button>
    </div>

    <Teleport to="body">
      <div
        v-if="readerOpen"
        class="desktop-reader-backdrop"
        data-testid="desktop-reader-backdrop"
        @click.self="closeReader"
      >
        <section
          ref="readerDialog"
          class="desktop-reader-dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="readerTitleId"
          tabindex="-1"
          data-testid="desktop-reader-dialog"
          @keydown.esc="closeReader"
        >
          <header class="desktop-reader-header">
            <div>
              <p>{{ statsLabel }}</p>
              <h2 :id="readerTitleId">Message reader</h2>
            </div>
            <button type="button" @click="closeReader">Close</button>
          </header>

          <div
            class="desktop-reader-content desktop-long-message-html"
            v-html="html"
            @click="handleMessageReferenceClick"
          />

          <footer class="desktop-reader-footer">
            <button type="button" @click="copyText">{{ copyLabel }}</button>
            <button class="primary" type="button" @click="closeReader">Done</button>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

const props = withDefaults(defineProps<{
  text: string;
  html: string;
  messageId: string;
  collapseAfterChars?: number;
  collapseAfterLines?: number;
}>(), {
  collapseAfterChars: 1400,
  collapseAfterLines: 18,
});

const emit = defineEmits<{
  "message-reference-click": [messageId: string];
}>();

const expanded = ref(false);
const readerOpen = ref(false);
const copied = ref(false);
const readerDialog = ref<HTMLElement | null>(null);

const lineCount = computed(() => props.text ? props.text.split(/\r\n|\r|\n/).length : 0);
const characterCount = computed(() => props.text.length);
const isLong = computed(() =>
  characterCount.value > props.collapseAfterChars || lineCount.value > props.collapseAfterLines
);
const safeMessageId = computed(() => props.messageId.replace(/[^A-Za-z0-9_-]/g, "-") || "message");
const contentId = computed(() => `desktop-message-content-${safeMessageId.value}`);
const readerTitleId = computed(() => `desktop-message-reader-title-${safeMessageId.value}`);
const statsLabel = computed(() => {
  const lines = lineCount.value;
  const chars = new Intl.NumberFormat().format(characterCount.value);
  return `${lines} ${lines === 1 ? "line" : "lines"} / ${chars} chars`;
});
const copyLabel = computed(() => copied.value ? "Copied" : "Copy text");

function openReader(): void {
  readerOpen.value = true;
  copied.value = false;
  void nextTick(() => readerDialog.value?.focus());
}

function closeReader(): void {
  readerOpen.value = false;
}

function handleMessageReferenceClick(event: MouseEvent): void {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>("[data-message-reference-id]")
    : null;
  const messageId = target?.dataset.messageReferenceId || "";
  if (!messageId) return;
  event.preventDefault();
  event.stopPropagation();
  readerOpen.value = false;
  emit("message-reference-click", messageId);
}

async function copyText(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.text);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1600);
  } catch {
    copied.value = false;
  }
}
</script>
