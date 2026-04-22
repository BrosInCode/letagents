<template>
  <Teleport to="body">
    <div class="image-viewer-backdrop" @click.self="emit('close')">
      <section
        ref="dialogRef"
        class="image-viewer-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @keydown="handleKeydown"
      >
        <header class="image-viewer-header">
          <div class="image-viewer-heading">
            <p class="image-viewer-count">Image {{ activeIndexLabel }}</p>
            <h2 :id="titleId">{{ activeImage.name }}</h2>
            <p class="image-viewer-meta">{{ captionLabel }}</p>
          </div>
          <div class="image-viewer-actions">
            <button
              v-if="showNavigation"
              class="image-viewer-action"
              type="button"
              aria-label="View previous image"
              @click="emit('previous')"
            >
              Previous
            </button>
            <button
              v-if="showNavigation"
              class="image-viewer-action"
              type="button"
              aria-label="View next image"
              @click="emit('next')"
            >
              Next
            </button>
            <a
              class="image-viewer-action"
              :href="activeImage.href"
              :download="activeImage.name"
            >
              Download
            </a>
            <a
              class="image-viewer-action"
              :href="activeImage.href"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open original
            </a>
            <button
              ref="closeButtonRef"
              class="image-viewer-action image-viewer-close"
              type="button"
              @click="emit('close')"
            >
              Close
            </button>
          </div>
        </header>

        <figure class="image-viewer-stage">
          <img
            class="image-viewer-image"
            :src="activeImage.href"
            :alt="activeImage.name"
          >
          <figcaption class="image-viewer-caption">
            <span>{{ activeImage.name }}</span>
            <span>{{ activeImage.metaLabel }}</span>
          </figcaption>
        </figure>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { MessageImageAttachment } from './messageAttachments'

const props = defineProps<{
  images: readonly MessageImageAttachment[]
  activeImageId: string
}>()

const emit = defineEmits<{
  close: []
  previous: []
  next: []
}>()

const dialogRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLElement | null>(null)
const titleId = `image-viewer-title-${Math.random().toString(36).slice(2, 10)}`
let previousActiveElement: HTMLElement | null = null
let previousBodyOverflow = ''

const activeIndex = computed(() => props.images.findIndex((image) => image.id === props.activeImageId))
const activeImage = computed(() => props.images[activeIndex.value] || props.images[0])
const showNavigation = computed(() => props.images.length > 1)
const activeIndexLabel = computed(() => `${Math.max(activeIndex.value, 0) + 1} of ${props.images.length}`)
const captionLabel = computed(() => {
  const parts = [activeImage.value.metaLabel, formatTimestamp(activeImage.value.timestamp)]
    .filter(Boolean)
  return parts.join(' • ')
})

onMounted(() => {
  previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  nextTick(() => {
    closeButtonRef.value?.focus()
  })
})

onUnmounted(() => {
  document.body.style.overflow = previousBodyOverflow
  previousActiveElement?.focus?.()
})

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key === 'ArrowLeft' && showNavigation.value) {
    event.preventDefault()
    emit('previous')
    return
  }
  if (event.key === 'ArrowRight' && showNavigation.value) {
    event.preventDefault()
    emit('next')
    return
  }
  if (event.key !== 'Tab') return

  const focusable = getFocusableElements()
  if (!focusable.length) {
    event.preventDefault()
    dialogRef.value?.focus()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null

  if (event.shiftKey) {
    if (!active || active === first || !dialogRef.value?.contains(active)) {
      event.preventDefault()
      last.focus()
    }
    return
  }

  if (!active || active === last || !dialogRef.value?.contains(active)) {
    event.preventDefault()
    first.focus()
  }
}

function getFocusableElements(): HTMLElement[] {
  if (!dialogRef.value) return []
  return Array.from(
    dialogRef.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  ).filter((element) => element.getClientRects().length > 0)
}

function formatTimestamp(value: string): string {
  try {
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}
</script>

<style scoped>
.image-viewer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1300;
  display: grid;
  place-items: center;
  padding: clamp(12px, 3vw, 24px);
  background: rgba(9, 9, 11, 0.84);
  backdrop-filter: blur(6px);
}

.image-viewer-dialog {
  width: min(1120px, 100%);
  max-height: calc(100vh - 24px);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--line, #27272a);
  border-radius: 18px;
  background: color-mix(in srgb, var(--bg-0, #09090b) 94%, black);
  box-shadow: 0 26px 90px rgba(0, 0, 0, 0.48);
}

.image-viewer-dialog:focus {
  outline: none;
}

.image-viewer-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 16px;
  border-bottom: 1px solid var(--line, #27272a);
}

.image-viewer-heading {
  min-width: 0;
}

.image-viewer-count,
.image-viewer-meta,
.image-viewer-caption span:last-child {
  color: var(--muted, #a1a1aa);
}

.image-viewer-count {
  margin: 0 0 4px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.image-viewer-heading h2 {
  margin: 0;
  font-size: 1rem;
  line-height: 1.3;
  color: var(--text, #fafafa);
  word-break: break-word;
}

.image-viewer-meta {
  margin: 6px 0 0;
  font-size: 0.76rem;
  line-height: 1.4;
}

.image-viewer-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.image-viewer-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--line, #27272a);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface, #18181b) 88%, transparent);
  color: var(--text, #fafafa);
  cursor: pointer;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 700;
  text-decoration: none;
  transition: border-color 150ms ease, background 150ms ease, color 150ms ease;
}

.image-viewer-action:hover,
.image-viewer-action:focus-visible {
  border-color: var(--line-strong, #52525b);
  background: color-mix(in srgb, var(--surface, #18181b) 76%, white 10%);
  outline: none;
}

.image-viewer-close {
  background: color-mix(in srgb, var(--surface, #18181b) 82%, white 6%);
}

.image-viewer-stage {
  display: grid;
  gap: 14px;
  min-height: 0;
  padding: clamp(14px, 2vw, 24px);
}

.image-viewer-image {
  width: 100%;
  max-height: calc(100vh - 220px);
  min-height: 0;
  object-fit: contain;
  border-radius: 14px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0)),
    repeating-linear-gradient(
      45deg,
      rgba(255, 255, 255, 0.04) 0,
      rgba(255, 255, 255, 0.04) 12px,
      rgba(255, 255, 255, 0.01) 12px,
      rgba(255, 255, 255, 0.01) 24px
    ),
    var(--bg-1, #111113);
  border: 1px solid color-mix(in srgb, var(--line, #27272a) 85%, white 6%);
}

.image-viewer-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 0.78rem;
  line-height: 1.4;
  color: var(--text, #fafafa);
}

.image-viewer-caption span {
  word-break: break-word;
}

@media (max-width: 760px) {
  .image-viewer-dialog {
    max-height: calc(100vh - 16px);
    border-radius: 14px;
  }

  .image-viewer-header {
    padding: 16px 16px 14px;
  }

  .image-viewer-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .image-viewer-action {
    flex: 1 1 140px;
  }

  .image-viewer-image {
    max-height: calc(100vh - 290px);
  }
}
</style>
