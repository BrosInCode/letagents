<template>
  <div id="letagents-app" :class="{ 'landing-theme': isLanding }">
    <Navbar v-if="showNavbar" />
    <main>
      <RouterView />
    </main>
    <Footer v-if="showFooter" />
    <ToastContainer />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Navbar from '@/components/layout/Navbar.vue'
import Footer from '@/components/layout/Footer.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import './styles/landing.css'

const route = useRoute()
// The landing page and the room form (/new) share the dark ink look.
const isLanding = computed(() => route.name === 'landing' || route.name === 'new-room')
// Show navbar/footer on landing and docs, hide in room view.
// The landing page is one full screen, so it has the navigation bar but no footer.
const showNavbar = computed(() => !['room', 'messages', 'my-work', 'connectors', 'ask', 'inbox'].includes(String(route.name)))
const showFooter = computed(() => showNavbar.value && !isLanding.value)
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
