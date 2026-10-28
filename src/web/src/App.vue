<template>
  <div id="letagents-app" :class="{ 'landing-theme': isLanding }">
    <Navbar v-if="showNavbar" :landing-theme="isLanding ? theme : undefined" @toggle-theme="toggleLandingTheme" />
    <main>
      <RouterView v-slot="{ Component }">
        <component :is="Component" v-bind="isLanding ? { theme } : {}" />
      </RouterView>
    </main>
    <Footer v-if="showFooter" />
    <ToastContainer />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Navbar from '@/components/layout/Navbar.vue'
import Footer from '@/components/layout/Footer.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import './styles/landing.css'

const route = useRoute()
const isLanding = computed(() => route.name === 'landing')
const theme = ref<'light' | 'dark'>('dark')

// The room owns its existing preference controls. Read the active preference
// when returning home instead of imposing a landing-page default on the app.
watch(isLanding, () => {
  if (typeof document !== 'undefined') {
    theme.value = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
  }
}, { immediate: true })

function toggleLandingTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', theme.value)
  try { localStorage.setItem('lac-theme', theme.value) } catch { /* Keep the control usable when storage is unavailable. */ }
}

// Show navbar/footer on landing and docs, hide in room view
const showNavbar = computed(() => !['room', 'messages', 'my-work', 'connectors', 'ask'].includes(String(route.name)))
const showFooter = showNavbar
</script>

<style>
/* App-level layout — global styles in styles/global.css */
#letagents-app {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

#letagents-app > main {
  flex: 1;
  min-width: 0;
}
</style>
