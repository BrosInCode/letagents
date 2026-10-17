<template>
  <div class="nav-links">
    <RouterLink
      v-for="link in NAV_SECTION_LINKS"
      :key="link.to"
      :to="link.to"
      class="nav-link nav-section-link"
    >
      {{ link.label }}
    </RouterLink>
    <RouterLink :to="DOCS_LINK.to" class="nav-link">
      {{ DOCS_LINK.label }}
    </RouterLink>
    <a :href="GITHUB_REPOSITORY_URL" target="_blank" class="nav-link">GitHub</a>

    <div class="nav-divider" />

    <button
      type="button"
      class="nav-theme-toggle"
      :aria-label="symbiosisBridge.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'"
      :title="symbiosisBridge.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'"
      @click="toggleTheme"
    >
      <span class="theme-icon-stack" :data-theme-mode="symbiosisBridge.theme">
        <!-- Sun Icon (shown in light mode) -->
        <svg class="theme-icon theme-icon--sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
        <!-- Moon Icon (shown in dark mode) -->
        <svg class="theme-icon theme-icon--moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </span>
    </button>

    <NavbarAuthControls />

    <RouterLink :to="ROOM_ENTRY_LINK.to" class="nav-btn nav-btn-primary nav-btn-sm">
      Open a Room &rarr;
    </RouterLink>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import NavbarAuthControls from './NavbarAuthControls.vue'
import { DOCS_LINK, GITHUB_REPOSITORY_URL, NAV_SECTION_LINKS, ROOM_ENTRY_LINK } from './links'
import { symbiosisBridge, syncThemeFromDom, toggleTheme } from '@/components/landing/symbiosisData'

onMounted(() => {
  syncThemeFromDom()
})
</script>
