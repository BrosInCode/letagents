<template>
  <div class="nav-mobile-panel">
    <div class="nav-mobile-grid">
      <RouterLink
        v-for="link in NAV_SECTION_LINKS"
        :key="`mobile-${link.to}`"
        :to="link.to"
        class="nav-mobile-link"
        @click="$emit('close')"
      >
        {{ link.label }}
      </RouterLink>
      <RouterLink :to="DOCS_LINK.to" class="nav-mobile-link" @click="$emit('close')">
        {{ DOCS_LINK.label }}
      </RouterLink>
      <a
        :href="GITHUB_REPOSITORY_URL"
        target="_blank"
        class="nav-mobile-link"
        @click="$emit('close')"
      >
        GitHub
      </a>
    </div>

    <div class="nav-mobile-auth">
      <NavbarAuthControls mobile @close="$emit('close')" />
    </div>
  </div>
</template>

<script setup lang="ts">
import NavbarAuthControls from './NavbarAuthControls.vue'
import { DOCS_LINK, GITHUB_REPOSITORY_URL, NAV_SECTION_LINKS } from './links'

defineEmits<{
  close: []
}>()
</script>
