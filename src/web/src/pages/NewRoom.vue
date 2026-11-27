<template>
  <div class="new-room-page">
    <RoomEntrySection />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import RoomEntrySection from '@/components/landing/RoomEntrySection.vue'
import { useAuth } from '@/composables/useAuth'

// The Blank room tab needs to know whether the person is signed in.
const auth = useAuth()
onMounted(() => { if (!auth.hasCheckedSession.value && !auth.isCheckingSession.value) void auth.checkSession() })
</script>

<style scoped>
.new-room-page {
  min-height: 100vh;
  min-height: 100dvh;
  padding-top: 40px;
  background: radial-gradient(ellipse 70% 50% at 50% 0%, rgba(42, 196, 159, .08), transparent 70%), #0a0a0a;
}
</style>
