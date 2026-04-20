<template>
  <div class="long-message">
    <div
      :id="contentId"
      class="long-message-content"
      :class="{ collapsed: isLong && !expanded }"
    >
      <div class="md-content" v-html="html" />
      <span v-if="isLong && !expanded" class="long-message-fade" aria-hidden="true" />
    </div>

    <div v-if="isLong" class="long-message-actions">
      <span class="long-message-stats">{{ statsLabel }}</span>
      <button
        class="long-message-button"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="contentId"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Collapse' : 'Show full message' }}
      </button>
      <button class="long-message-button" type="button" @click="openReader">
        Open reader
      </button>
    </div>

    <Teleport to="body">
      <div
        v-if="readerOpen"
        class="reader-backdrop"
        @click.self="closeReader"
      >
        <section
          ref="readerDialog"
          class="reader-dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="readerTitleId"
          tabindex="-1"
          @keydown.esc="closeReader"
        >
          <header class="reader-header">
            <div>
              <p class="reader-eyebrow">{{ statsLabel }}</p>
              <h2 :id="readerTitleId">Message reader</h2>
            </div>
            <button class="reader-close" type="button" @click="closeReader">
              Close
            </button>
          </header>

          <div class="reader-content md-content" v-html="html" />

          <footer class="reader-footer">
            <button class="reader-action" type="button" @click="copyText">
              {{ copyLabel }}
            </button>
            <button class="reader-action primary" type="button" @click="closeReader">
              Done
            </button>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'

const props = withDefaults(defineProps<{
  text: string
  html: string
  messageId: string
  collapseAfterChars?: number
  collapseAfterLines?: number
}>(), {
  collapseAfterChars: 1400,
  collapseAfterLines: 18,
})

const expanded = ref(false)
const readerOpen = ref(false)
const copied = ref(false)
const readerDialog = ref<HTMLElement | null>(null)

const lineCount = computed(() => {
  if (!props.text) return 0
  return props.text.split(/\r\n|\r|\n/).length
})

const characterCount = computed(() => props.text.length)

const isLong = computed(() =>
  characterCount.value > props.collapseAfterChars || lineCount.value > props.collapseAfterLines
)

const safeMessageId = computed(() => {
  const safe = props.messageId.replace(/[^A-Za-z0-9_-]/g, '-')
  return safe || 'message'
})

const contentId = computed(() => `message-content-${safeMessageId.value}`)
const readerTitleId = computed(() => `message-reader-title-${safeMessageId.value}`)

const statsLabel = computed(() => {
  const lines = lineCount.value
  const chars = new Intl.NumberFormat().format(characterCount.value)
  return `${lines} ${lines === 1 ? 'line' : 'lines'} / ${chars} chars`
})

const copyLabel = computed(() => copied.value ? 'Copied' : 'Copy text')

function openReader() {
  readerOpen.value = true
  copied.value = false
  nextTick(() => readerDialog.value?.focus())
}

function closeReader() {
  readerOpen.value = false
}

async function copyText() {
  try {
    await navigator.clipboard.writeText(props.text)
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1600)
  } catch {
    copied.value = false
  }
}
</script>

<style scoped>
.long-message {
  min-width: 0;
}

.long-message-content {
  position: relative;
  min-width: 0;
}

.long-message-content.collapsed {
  max-height: 260px;
  overflow: hidden;
}

.long-message-fade {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 56px;
  pointer-events: none;
  background: linear-gradient(to bottom, transparent, var(--bg-1, #111113) 85%);
}

.long-message-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.long-message-stats {
  color: var(--muted, #a1a1aa);
  font-size: 0.72rem;
  line-height: 1.3;
}

.long-message-button,
.reader-close,
.reader-action {
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--surface, #18181b);
  color: var(--text, #fafafa);
  cursor: pointer;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 700;
  line-height: 1;
  padding: 8px 10px;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.long-message-button:hover,
.long-message-button:focus-visible,
.reader-close:hover,
.reader-close:focus-visible,
.reader-action:hover,
.reader-action:focus-visible {
  background: color-mix(in srgb, var(--surface, #18181b) 84%, var(--text, #fafafa) 8%);
  border-color: var(--muted, #71717a);
  outline: none;
}

.reader-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(9, 9, 11, 0.78);
}

.reader-dialog {
  display: flex;
  flex-direction: column;
  width: min(960px, 100%);
  max-height: min(86vh, 900px);
  overflow: hidden;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--bg-0, #09090b);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.4);
}

.reader-dialog:focus {
  outline: none;
}

.reader-header,
.reader-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line, #27272a);
}

.reader-footer {
  justify-content: flex-end;
  border-top: 1px solid var(--line, #27272a);
  border-bottom: none;
}

.reader-eyebrow {
  margin: 0 0 4px;
  color: var(--muted, #a1a1aa);
  font-size: 0.72rem;
  line-height: 1.2;
}

.reader-header h2 {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 1rem;
  line-height: 1.2;
}

.reader-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 18px 20px;
  color: var(--text, #fafafa);
}

.reader-action.primary {
  background: var(--text, #fafafa);
  color: var(--bg-0, #09090b);
  border-color: var(--text, #fafafa);
}

.reader-content,
.long-message-content :deep(.md-content) {
  line-height: 1.6;
  font-size: 0.88rem;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.reader-content :deep(a),
.long-message-content :deep(a) {
  color: #60a5fa;
  text-decoration: none;
  word-break: break-all;
}

.reader-content :deep(a:hover),
.long-message-content :deep(a:hover) {
  text-decoration: underline;
}

.reader-content :deep(code),
.long-message-content :deep(code) {
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--surface, #18181b);
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.84em;
}

.reader-content :deep(.mention-token),
.long-message-content :deep(.mention-token) {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(125, 211, 252, 0.14);
  color: #7dd3fc;
  font-weight: 600;
}

@media (max-width: 768px) {
  .long-message-content.collapsed {
    max-height: 220px;
  }

  .reader-backdrop {
    align-items: stretch;
    padding: 10px;
  }

  .reader-dialog {
    max-height: calc(100vh - 20px);
  }

  .reader-header,
  .reader-footer {
    align-items: flex-start;
    flex-direction: column;
    padding: 12px;
  }

  .reader-close,
  .reader-action {
    width: 100%;
  }

  .reader-content {
    padding: 14px;
  }
}
</style>
