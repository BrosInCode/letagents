<template>
  <aside :class="['sidebar', { open }]">
    <div v-for="section in sections" :key="section.label" class="sidebar-section">
      <div class="sidebar-label">{{ section.label }}</div>
      <a
        v-for="link in section.links"
        :key="link.id"
        :href="`#${link.id}`"
        :class="['sidebar-link', { active: activeSection === link.id }]"
        @click="emit('navigate')"
      >
        {{ link.label }}
      </a>
    </div>
  </aside>
</template>

<script setup lang="ts">
import type { DocsNavSection } from './docs-data'

defineProps<{
  sections: DocsNavSection[]
  activeSection: string
  open: boolean
}>()

const emit = defineEmits<{
  navigate: []
}>()
</script>
