<template>
  <Teleport to="body">
    <Transition name="image-viewer">
      <div
        v-if="open && currentImage"
        class="image-viewer-backdrop"
        role="presentation"
        @click.self="emit('close')"
      >
        <section
          ref="viewerDialog"
          class="image-viewer-dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
        >
          <header class="image-viewer-header">
            <div class="image-viewer-copy">
              <p class="image-viewer-eyebrow">Image {{ activeIndex + 1 }} of {{ images.length }}</p>
              <h2 :id="titleId">{{ currentImage.name }}</h2>
              <p v-if="currentMetaLine" class="image-viewer-meta">{{ currentMetaLine }}</p>
            </div>
            <button class="image-viewer-close" type="button" @click="emit('close')">
              Close
            </button>
          </header>

          <div class="image-viewer-stage">
            <button
              v-if="hasMultiple"
              class="image-viewer-nav"
              type="button"
              aria-label="Previous image"
              @click="showPrevious"
            >
              <span aria-hidden="true">‹</span>
            </button>

            <figure class="image-viewer-figure">
              <img
                class="image-viewer-image"
                :src="currentImage.src"
                :alt="currentImage.name"
              >
            </figure>

            <button
              v-if="hasMultiple"
              class="image-viewer-nav"
              type="button"
              aria-label="Next image"
              @click="showNext"
            >
              <span aria-hidden="true">›</span>
            </button>
          </div>

          <footer class="image-viewer-footer">
            <div class="image-viewer-actions">
              <button
                v-if="hasMultiple"
                class="image-viewer-action mobile-nav-only"
                type="button"
                @click="showPrevious"
              >
                Previous
              </button>
              <button
                v-if="hasMultiple"
                class="image-viewer-action mobile-nav-only"
                type="button"
                @click="showNext"
              >
                Next
              </button>
              <a
                class="image-viewer-action"
                :href="currentImage.downloadUrl"
                :download="currentImage.name"
              >
                Download
              </a>
              <a
                class="image-viewer-action"
                :href="currentImage.openUrl"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open original
              </a>
            </div>
            <button class="image-viewer-action primary" type="button" @click="emit('close')">
              Done
            </button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

interface ImageViewerItem {
  id: string
  src: string
  name: string
  meta: string
  timestamp: string | null
  downloadUrl: string
  openUrl: string
}

const props = defineProps<{
  open: boolean
  images: ImageViewerItem[]
  activeImageId: string | null
}>()

const emit = defineEmits<{
  close: []
  'update:activeImageId': [imageId: string]
}>()

const viewerDialog = ref<HTMLElement | null>(null)
const previousActiveElement = ref<HTMLElement | null>(null)
const titleId = 'room-image-viewer-title'
let previousBodyOverflow = ''

const activeIndex = computed(() => {
  if (!props.images.length || !props.activeImageId) return 0
  const found = props.images.findIndex((image) => image.id === props.activeImageId)
  return found >= 0 ? found : 0
})

const currentImage = computed(() => props.images[activeIndex.value] || null)
const hasMultiple = computed(() => props.images.length > 1)
const currentMetaLine = computed(() => {
  if (!currentImage.value) return ''

  const parts = [currentImage.value.meta]
  if (currentImage.value.timestamp) {
    try {
      parts.push(new Date(currentImage.value.timestamp).toLocaleString())
    } catch {
      // Ignore malformed timestamps and keep attachment metadata visible.
    }
  }
  return parts.filter(Boolean).join(' • ')
})

watch(
  () => props.open,
  async (open) => {
    if (open) {
      previousActiveElement.value = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      previousBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      window.addEventListener('keydown', handleWindowKeydown)
      await nextTick()
      viewerDialog.value?.focus()
      return
    }

    cleanupViewer()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  cleanupViewer()
})

function cleanupViewer() {
  document.body.style.overflow = previousBodyOverflow
  window.removeEventListener('keydown', handleWindowKeydown)
  previousActiveElement.value?.focus()
  previousActiveElement.value = null
}

function showPrevious() {
  if (!props.images.length) return
  const previousIndex = (activeIndex.value - 1 + props.images.length) % props.images.length
  emit('update:activeImageId', props.images[previousIndex]!.id)
}

function showNext() {
  if (!props.images.length) return
  const nextIndex = (activeIndex.value + props.images.length + 1) % props.images.length
  emit('update:activeImageId', props.images[nextIndex]!.id)
}

function handleWindowKeydown(event: KeyboardEvent) {
  if (!props.open) return

  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }

  if (event.key === 'ArrowLeft' && hasMultiple.value) {
    event.preventDefault()
    showPrevious()
    return
  }

  if (event.key === 'ArrowRight' && hasMultiple.value) {
    event.preventDefault()
    showNext()
    return
  }

  if (event.key === 'Tab') {
    trapFocus(event)
  }
}

function trapFocus(event: KeyboardEvent) {
  const dialog = viewerDialog.value
  if (!dialog) return

  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.hasAttribute('disabled'))

  if (focusable.length === 0) {
    event.preventDefault()
    dialog.focus()
    return
  }

  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null

  if (event.shiftKey && (activeElement === first || activeElement === dialog)) {
    event.preventDefault()
    last.focus()
    return
  }

  if (!event.shiftKey && activeElement === last) {
    event.preventDefault()
    first.focus()
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
  padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
  background: rgba(9, 9, 11, 0.82);
  backdrop-filter: blur(6px);
}

.image-viewer-dialog {
  display: flex;
  flex-direction: column;
  width: min(1120px, 100%);
  max-height: min(92vh, 980px);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--line, #27272a) 88%, white 8%);
  border-radius: 16px;
  background: color-mix(in srgb, var(--bg-0, #09090b) 94%, black 6%);
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.44);
}

.image-viewer-dialog:focus {
  outline: none;
}

.image-viewer-header,
.image-viewer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--line, #27272a);
}

.image-viewer-footer {
  border-top: 1px solid var(--line, #27272a);
  border-bottom: none;
}

.image-viewer-copy {
  min-width: 0;
}

.image-viewer-eyebrow,
.image-viewer-meta {
  margin: 0;
  color: var(--muted, #a1a1aa);
  font-size: 0.76rem;
  line-height: 1.35;
}

.image-viewer-eyebrow {
  margin-bottom: 6px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.image-viewer-copy h2 {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 1rem;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.image-viewer-meta {
  margin-top: 6px;
}

.image-viewer-stage {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  min-height: 0;
  padding: 18px;
}

.image-viewer-figure {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  margin: 0;
  padding: 0;
}

.image-viewer-image {
  display: block;
  max-width: 100%;
  max-height: min(68vh, 760px);
  object-fit: contain;
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface, #18181b) 82%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--line, #27272a) 82%, transparent);
}

.image-viewer-nav,
.image-viewer-close,
.image-viewer-action {
  border: 1px solid var(--line, #27272a);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface, #18181b) 88%, transparent);
  color: var(--text, #fafafa);
  cursor: pointer;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 700;
  line-height: 1;
  text-decoration: none;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
}

.image-viewer-nav:hover,
.image-viewer-nav:focus-visible,
.image-viewer-close:hover,
.image-viewer-close:focus-visible,
.image-viewer-action:hover,
.image-viewer-action:focus-visible {
  background: color-mix(in srgb, var(--surface, #18181b) 82%, var(--text, #fafafa) 8%);
  border-color: var(--muted, #71717a);
  outline: none;
}

.image-viewer-nav {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  padding: 0;
  border-radius: 999px;
  font-size: 1.8rem;
  font-weight: 400;
}

.image-viewer-nav:active,
.image-viewer-action:active,
.image-viewer-close:active {
  transform: translateY(1px);
}

.image-viewer-close,
.image-viewer-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 14px;
}

.image-viewer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.image-viewer-action.primary {
  background: var(--text, #fafafa);
  color: var(--bg-0, #09090b);
  border-color: var(--text, #fafafa);
}

.mobile-nav-only {
  display: none;
}

.image-viewer-enter-active,
.image-viewer-leave-active {
  transition: opacity 180ms ease;
}

.image-viewer-enter-active .image-viewer-dialog,
.image-viewer-leave-active .image-viewer-dialog {
  transition: transform 200ms ease, opacity 200ms ease;
}

.image-viewer-enter-from,
.image-viewer-leave-to {
  opacity: 0;
}

.image-viewer-enter-from .image-viewer-dialog,
.image-viewer-leave-to .image-viewer-dialog {
  opacity: 0;
  transform: translateY(10px) scale(0.985);
}

@media (max-width: 900px) {
  .image-viewer-stage {
    grid-template-columns: minmax(0, 1fr);
    justify-items: stretch;
  }

  .image-viewer-nav {
    display: none;
  }

  .mobile-nav-only {
    display: inline-flex;
  }
}

@media (max-width: 768px) {
  .image-viewer-backdrop {
    align-items: stretch;
    padding: 10px 10px max(10px, env(safe-area-inset-bottom)) 10px;
  }

  .image-viewer-dialog {
    width: 100%;
    max-height: 100%;
    border-radius: 14px;
  }

  .image-viewer-header,
  .image-viewer-footer {
    flex-direction: column;
    align-items: stretch;
    padding: 14px;
  }

  .image-viewer-stage {
    gap: 12px;
    padding: 12px 14px 16px;
  }

  .image-viewer-image {
    max-height: min(58vh, 560px);
  }

  .image-viewer-actions {
    width: 100%;
  }

  .image-viewer-close,
  .image-viewer-action {
    width: 100%;
  }
}
</style>
