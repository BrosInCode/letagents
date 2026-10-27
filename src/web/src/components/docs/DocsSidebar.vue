<template>
  <aside ref="sidebar" id="docs-navigation" :class="['sidebar', { open }]" :role="mobile ? 'dialog' : 'navigation'" :aria-modal="mobile && open ? true : undefined" aria-label="Documentation sections" @keydown="handleKeydown">
    <button v-if="mobile" type="button" class="sidebar-close" @click="emit('close')">Close navigation <span aria-hidden="true">×</span></button>
    <div v-for="section in sections" :key="section.label" class="sidebar-section">
      <div class="sidebar-label">{{ section.label }}</div>
      <a
        v-for="link in section.links"
        :key="link.id"
        :href="`#${link.id}`"
        :class="['sidebar-link', { active: activeSection === link.id }]"
        :aria-current="activeSection === link.id ? 'location' : undefined"
        @click="emit('navigate')"
      >
        {{ link.label }}
      </a>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { DocsNavSection } from './docs-data'

const props = defineProps<{
  sections: DocsNavSection[]
  activeSection: string
  open: boolean
  mobile: boolean
}>()

const emit = defineEmits<{
  navigate: []
  close: []
}>()

const sidebar = ref<HTMLElement>()
watch([() => props.open, () => props.mobile, sidebar], ([open, mobile, element]) => {
  if (!open || !mobile) return
  element?.querySelector<HTMLElement>('.sidebar-link.active, .sidebar-link')?.focus({ preventScroll: true })
}, { flush: 'post' })
function handleKeydown(event: KeyboardEvent) {
  if (!props.mobile || !props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
  if (event.key !== 'Tab') return
  const controls = sidebar.value?.querySelectorAll<HTMLElement>('button, a[href]')
  if (!controls?.length) return
  const first = controls[0], last = controls[controls.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
</script>
