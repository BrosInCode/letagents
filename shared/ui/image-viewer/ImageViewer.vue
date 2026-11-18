<template>
  <Teleport to="body">
    <div class="image-viewer-backdrop" data-testid="image-viewer" @click.self="emit('close')">
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
            <p class="image-viewer-count">{{ activeIndex + 1 }} of {{ images.length }}</p>
            <h2 :id="titleId">{{ activeImage.name }}</h2>
            <p v-if="activeImage.meta" class="image-viewer-meta">{{ activeImage.meta }}</p>
          </div>
          <div class="image-viewer-actions">
            <button
              v-if="showNavigation"
              class="image-viewer-action is-subtle"
              type="button"
              aria-label="View previous image"
              @click="emit('previous')"
            >
              Previous
            </button>
            <button
              v-if="showNavigation"
              class="image-viewer-action is-subtle"
              type="button"
              aria-label="View next image"
              @click="emit('next')"
            >
              Next
            </button>
            <a class="image-viewer-action" :href="activeImage.href" :download="activeImage.name">Download</a>
            <a class="image-viewer-action" :href="activeImage.href" target="_blank" rel="noopener noreferrer">Open original</a>
            <button ref="closeButtonRef" class="image-viewer-action is-primary" type="button" @click="emit('close')">
              Close
            </button>
          </div>
        </header>

        <figure class="image-viewer-stage">
          <img :src="activeImage.href" :alt="activeImage.name">
          <figcaption v-if="caption">{{ caption }}</figcaption>
        </figure>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { RoomImage } from './types'

const props = defineProps<{
  images: readonly RoomImage[]
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

const activeIndex = computed(() => Math.max(0, props.images.findIndex((image) => image.id === props.activeImageId)))
const activeImage = computed(() => props.images[activeIndex.value] || props.images[0])
const showNavigation = computed(() => props.images.length > 1)
const caption = computed(() =>
  [activeImage.value.sender, formatImageTime(activeImage.value.timestamp)].filter(Boolean).join(' · '),
)

onMounted(() => {
  previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  void nextTick(() => closeButtonRef.value?.focus())
})

onUnmounted(() => {
  document.body.style.overflow = previousBodyOverflow
  previousActiveElement?.focus?.()
})

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
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
  if (event.key === 'Tab') keepFocusInside(event)
}

function keepFocusInside(event: KeyboardEvent): void {
  const focusable = dialogRef.value
    ? Array.from(dialogRef.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter((element) => element.getClientRects().length > 0)
    : []
  if (!focusable.length) {
    event.preventDefault()
    dialogRef.value?.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const outside = !active || !dialogRef.value?.contains(active)
  if (event.shiftKey && (outside || active === first)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (outside || active === last)) {
    event.preventDefault()
    first.focus()
  }
}

function formatImageTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
</script>

<style scoped>
.image-viewer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1300;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--overlay-scrim, rgba(0, 0, 0, 0.62));
  animation: image-viewer-in 160ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1));
}

.image-viewer-dialog {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: min(1100px, calc(100vw - 48px));
  height: min(90vh, 920px);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 24px;
  background:
    radial-gradient(circle at 0% 0%, rgba(255, 255, 255, 0.08), transparent 32%),
    rgba(13, 13, 13, 0.98);
  box-shadow: 0 32px 100px rgba(0, 0, 0, 0.58);
  color: #f4f4f5;
}

.image-viewer-dialog:focus {
  outline: none;
}

.image-viewer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.image-viewer-heading {
  min-width: 0;
}

.image-viewer-heading p,
.image-viewer-heading h2,
.image-viewer-stage,
.image-viewer-stage figcaption {
  margin: 0;
}

.image-viewer-count {
  color: rgba(255, 255, 255, 0.5);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.image-viewer-heading h2 {
  margin-top: 4px;
  max-width: min(56vw, 720px);
  overflow: hidden;
  font-size: 1.05rem;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-viewer-meta,
.image-viewer-stage figcaption {
  color: rgba(255, 255, 255, 0.5);
  font-size: 0.78rem;
}

.image-viewer-stage figcaption {
  justify-self: center;
}

.image-viewer-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.image-viewer-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 38px;
  padding: 0 15px;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.035));
  color: rgba(255, 255, 255, 0.82);
  font: inherit;
  font-size: 0.82rem;
  font-weight: 800;
  line-height: 1;
  text-decoration: none;
  cursor: pointer;
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.08);
  transition:
    transform 140ms var(--ease-out, ease-out),
    border-color 140ms var(--ease-out, ease-out),
    background 140ms var(--ease-out, ease-out),
    color 140ms var(--ease-out, ease-out);
}

.image-viewer-action:hover {
  transform: translateY(-1px);
  border-color: rgba(255, 255, 255, 0.24);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.06));
  color: #ffffff;
}

.image-viewer-action:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.55);
  outline-offset: 2px;
}

.image-viewer-action.is-subtle {
  min-width: 76px;
  color: rgba(255, 255, 255, 0.68);
}

.image-viewer-action.is-primary {
  border-color: rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.92);
  color: #0b0b0c;
}

.image-viewer-action.is-primary:hover {
  background: #ffffff;
  color: #000000;
}

.image-viewer-stage {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 10px;
  min-height: 0;
  padding: 18px;
}

.image-viewer-stage img {
  justify-self: center;
  align-self: center;
  max-width: 100%;
  max-height: 100%;
  min-height: 0;
  object-fit: contain;
  border-radius: 16px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
}

@keyframes image-viewer-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .image-viewer-backdrop { animation: none; }
  .image-viewer-action { transition: none; }
  .image-viewer-action:hover { transform: none; }
}

@media (max-width: 760px) {
  .image-viewer-backdrop { padding: 8px; }

  .image-viewer-dialog {
    width: 100%;
    height: calc(100dvh - 16px);
    border-radius: 16px;
  }

  .image-viewer-header {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    padding: 12px;
  }

  .image-viewer-heading h2 {
    max-width: 100%;
  }

  .image-viewer-actions {
    justify-content: flex-start;
  }

  .image-viewer-action {
    flex: 1 1 auto;
    min-height: 44px;
  }

  .image-viewer-stage {
    gap: 8px;
    padding: 12px;
  }
}
</style>
