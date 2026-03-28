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
const showNavbar = computed(() => route.name !== 'room')
const showFooter = computed(() => route.name !== 'room')
</script>

<style>
/* App-level layout — global styles in styles/global.css */
#letagents-app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

main {
  flex: 1;
}
</style>
