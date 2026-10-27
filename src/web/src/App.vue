<template>
  <div id="letagents-app">
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

const route = useRoute()

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
