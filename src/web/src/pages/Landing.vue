<template>
  <div class="landing">
    <HeroSection />
    <!-- More sections will be added as we migrate -->
    <div class="section" style="text-align: center; padding: 200px 20px;">
      <p style="color: var(--text-tertiary);">🚧 Landing page migration in progress...</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useAuth } from '@/composables/useAuth'
import HeroSection from '@/components/landing/HeroSection.vue'

const auth = useAuth()

onMounted(() => {
  auth.checkSession()
})
</script>

<style scoped>
.landing {
  min-height: 100vh;
}
</style>
