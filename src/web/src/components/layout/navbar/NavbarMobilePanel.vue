<template>
  <div class="nav-mobile-panel">
    <div class="nav-mobile-grid">
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

    <div v-if="showAuth" class="nav-mobile-auth">
      <NavbarAuthControls mobile @close="$emit('close')" />
    </div>
  </div>
</template>

<script setup lang="ts">
import NavbarAuthControls from './NavbarAuthControls.vue'
import { DOCS_LINK, GITHUB_REPOSITORY_URL } from './links'
import { useNavbarAuthVisible } from './useNavbarAuthVisible'

const showAuth = useNavbarAuthVisible()

defineEmits<{
  close: []
}>()
</script>
