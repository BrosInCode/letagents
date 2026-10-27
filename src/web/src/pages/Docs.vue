<template>
  <div class="docs-page" @keydown="handlePageKeydown">
    <div v-if="sidebarOpen" class="sidebar-overlay" @click="closeSidebar" />

    <div class="docs-layout">
      <DocsSidebar
        :sections="docsNavSections"
        :active-section="activeSection"
        :open="sidebarOpen"
        :mobile="mobile"
        @navigate="closeSidebarOnMobile"
        @close="closeSidebar"
      />

      <main class="docs-content" :inert="sidebarOpen && mobile">
        <GettingStartedDocs />
        <RoomConceptDocs />
        <SecurityDocs />
        <OperationsDocs />
      </main>
    </div>

    <button
      ref="sidebarToggle"
      class="sidebar-toggle"
      type="button"
      aria-label="Toggle documentation navigation"
      :aria-expanded="sidebarOpen"
      aria-controls="docs-navigation"
      @click="sidebarOpen ? closeSidebar() : sidebarOpen = true"
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
const mobile = ref(false)
const sidebarToggle = ref<HTMLButtonElement>()

function closeSidebar() {
  sidebarOpen.value = false
  sidebarToggle.value?.focus({ preventScroll: true })
}

function handlePageKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !sidebarOpen.value) return
  event.preventDefault()
  closeSidebar()
}

function updateViewport() {
  mobile.value = window.innerWidth <= 800
  if (!mobile.value) sidebarOpen.value = false
}

function closeSidebarOnMobile() {
  if (mobile.value) closeSidebar()
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
  updateViewport()
  updateActiveSection()
  window.addEventListener('scroll', updateActiveSection, { passive: true })
  window.addEventListener('resize', updateViewport)
})

onUnmounted(() => {
  window.removeEventListener('scroll', updateActiveSection)
  window.removeEventListener('resize', updateViewport)
})
</script>
