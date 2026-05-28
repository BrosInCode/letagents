<template>
  <div class="docs-page">
    <div v-if="sidebarOpen" class="sidebar-overlay" @click="sidebarOpen = false" />

    <div class="docs-layout">
      <DocsSidebar
        :sections="docsNavSections"
        :active-section="activeSection"
        :open="sidebarOpen"
        @navigate="closeSidebarOnMobile"
      />

      <main class="docs-content">
        <GettingStartedDocs />
        <RoomConceptDocs />
        <SecurityDocs />
        <OperationsDocs />
      </main>
    </div>

    <button
      class="sidebar-toggle"
      type="button"
      aria-label="Toggle documentation navigation"
      @click="sidebarOpen = !sidebarOpen"
    >
      <MenuIcon :size="22" label="Menu" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import DocsSidebar from '@/components/docs/DocsSidebar.vue'
import MenuIcon from '@/components/icons/MenuIcon.vue'
import GettingStartedDocs from '@/components/docs/sections/GettingStartedDocs.vue'
import OperationsDocs from '@/components/docs/sections/OperationsDocs.vue'
import RoomConceptDocs from '@/components/docs/sections/RoomConceptDocs.vue'
import SecurityDocs from '@/components/docs/sections/SecurityDocs.vue'
import { docsNavSections } from '@/components/docs/docs-data'
import '@/components/docs/docs.css'

const activeSection = ref('overview')
const sidebarOpen = ref(false)

function closeSidebarOnMobile() {
  if (window.innerWidth <= 800) sidebarOpen.value = false
}

function updateActiveSection() {
  const sections = document.querySelectorAll<HTMLElement>('.doc-section')
  let current = ''
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= 120) current = section.id
  }
  if (current) activeSection.value = current
}

onMounted(() => {
  updateActiveSection()
  window.addEventListener('scroll', updateActiveSection, { passive: true })
})

onUnmounted(() => {
  window.removeEventListener('scroll', updateActiveSection)
})
</script>
