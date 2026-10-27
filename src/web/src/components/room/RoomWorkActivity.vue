<template>
  <div ref="root" class="web-work-activity" @keydown.esc.stop.prevent="close(true)" @focusout="onFocusOut">
    <span class="web-work-announcement" role="status" aria-live="polite" aria-atomic="true">{{ label }}</span>
    <button ref="trigger" type="button" class="web-work-pill" :aria-expanded="expanded" :aria-controls="expanded ? listId : undefined"
      :aria-label="label" :data-motion-work="single && !expanded ? '' : undefined"
      :data-motion-session="single?.session" :data-motion-agent="single?.key" :data-motion-after="single?.after"
      @click="expanded = !expanded">
      <span class="room-activity-pulse" aria-hidden="true"><ActivityOrb state="working" /></span>
      <span v-if="single" class="web-work-text room-activity-copy"><strong>{{ single.name }}</strong> <span>{{ single.summary }}</span></span>
      <span v-else class="web-work-text"><strong>{{ work.length }} agents</strong> are working</span>
      <svg class="web-work-caret" :class="{ expanded }" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 10 4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
      <!-- One anchor per agent preserves the existing thinking-to-reply handoff. -->
      <template v-if="!single && !expanded">
        <span v-for="item in work" :key="item.id" class="web-work-anchor" aria-hidden="true"
          data-motion-work :data-motion-session="item.session" :data-motion-agent="item.key" :data-motion-after="item.after">
          <span class="room-activity-pulse"></span><strong></strong><span class="room-activity-copy"><span></span></span>
        </span>
      </template>
    </button>
    <div v-if="expanded" :id="listId" class="web-work-list" :style="{ maxHeight: `${listHeight}px` }" role="region" aria-label="Working agents" tabindex="0">
      <div v-for="item in work" :key="item.id" class="web-work-row"
        data-motion-work :data-motion-session="item.session" :data-motion-agent="item.key" :data-motion-after="item.after">
        <span class="room-activity-pulse" aria-hidden="true"><ActivityOrb state="working" /></span>
        <span class="room-activity-copy"><strong>{{ item.name }}</strong><span>{{ item.summary }}</span></span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import ActivityOrb from '../../../../../shared/ui/ActivityOrb.vue'
import type { RoomWorkIndicator } from './roomWorkIndicators'

const props = defineProps<{ work: readonly RoomWorkIndicator[] }>()
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const expanded = ref(false)
const listHeight = ref(260)
let resizeObserver: ResizeObserver | null = null
const listId = useId()
const single = computed(() => props.work.length === 1 ? props.work[0] : null)
const label = computed(() => single.value ? `${single.value.name}: ${single.value.summary}` : `${props.work.length} agents are working`)

function close(restoreFocus = false) {
  expanded.value = false
  if (restoreFocus) trigger.value?.focus()
}
function onFocusOut(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !root.value?.contains(event.relatedTarget)) close()
}
function onOutsidePress(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target)) close()
}
function fitList() {
  const viewport = root.value?.closest('.messages-wrap')
  if (viewport && root.value) listHeight.value = Math.max(0, Math.min(260, root.value.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 8))
}
function stopWatching() {
  document.removeEventListener('pointerdown', onOutsidePress, true)
  resizeObserver?.disconnect()
  resizeObserver = null
}
// Collapsed pills do no document-wide work on every pointer interaction.
watch(expanded, (open) => {
  stopWatching()
  if (!open) return
  document.addEventListener('pointerdown', onOutsidePress, true)
  fitList()
  const viewport = root.value?.closest('.messages-wrap')
  if (viewport && typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(fitList)
    resizeObserver.observe(viewport)
  }
}, { flush: 'sync' })
onBeforeUnmount(stopWatching)
</script>

<style scoped>
.web-work-activity { position: relative; display: flex; align-items: center; height: 44px; width: 100%; margin: 0 auto; }
.web-work-pill { position: relative; display: inline-flex; align-items: center; gap: 8px; max-width: 100%; min-width: 0; min-height: 32px; padding: 4px 10px 4px 6px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-elevated); color: var(--text-secondary); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer; }
.web-work-pill:focus-visible, .web-work-list:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.room-activity-pulse { display: grid; flex: 0 0 20px; place-items: center; width: 20px; height: 20px; color: var(--text); }
.web-work-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.room-activity-copy strong, .web-work-text strong { color: var(--text); font-weight: 550; }
.web-work-caret { flex: 0 0 auto; }
.web-work-caret.expanded { transform: rotate(180deg); }
.web-work-list { position: absolute; z-index: 6; left: 0; bottom: calc(100% + 4px); width: min(480px, 100%); max-height: min(260px, 45dvh); overflow-y: auto; overscroll-behavior: contain; padding: 6px; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-elevated); box-shadow: 0 8px 24px rgb(0 0 0 / .16); }
.web-work-row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px; }
.web-work-row .room-activity-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; line-height: 1.45; color: var(--text-secondary); overflow-wrap: anywhere; }
.web-work-anchor { position: absolute; left: 6px; top: 6px; width: 20px; height: 20px; visibility: hidden; }
.web-work-announcement { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (hover: hover) and (pointer: fine) { .web-work-pill:hover { color: var(--text); } }
@media (max-width: 768px), (pointer: coarse) { .web-work-pill { min-height: 44px; } }
</style>
