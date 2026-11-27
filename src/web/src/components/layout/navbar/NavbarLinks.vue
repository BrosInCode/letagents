<template>
  <div class="nav-links">
    <RouterLink :to="DOCS_LINK.to" class="nav-link">
      {{ DOCS_LINK.label }}
    </RouterLink>
    <a :href="GITHUB_REPOSITORY_URL" target="_blank" class="nav-link">GitHub</a>

    <template v-if="showAuth">
      <div class="nav-divider" />
      <NavbarAuthControls />
    </template>
  </div>
</template>

<script setup lang="ts">
import NavbarAuthControls from './NavbarAuthControls.vue'
import { DOCS_LINK, GITHUB_REPOSITORY_URL } from './links'
import { useNavbarAuthVisible } from './useNavbarAuthVisible'

const showAuth = useNavbarAuthVisible()
</script>
