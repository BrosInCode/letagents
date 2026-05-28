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
    <NavbarAuthControls />

    <RouterLink :to="ROOM_ENTRY_LINK.to" class="nav-btn nav-btn-primary nav-btn-sm">
      Open a Room &rarr;
    </RouterLink>
  </div>
</template>

<script setup lang="ts">
import NavbarAuthControls from './NavbarAuthControls.vue'
import { DOCS_LINK, GITHUB_REPOSITORY_URL, NAV_SECTION_LINKS, ROOM_ENTRY_LINK } from './links'
</script>
