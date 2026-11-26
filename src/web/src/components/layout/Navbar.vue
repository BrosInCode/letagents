<template>
  <nav :class="['navbar', { 'navbar--scrolled': isScrolled }]" aria-label="Main navigation" @keydown.esc="dismissMobileMenu">
    <NavbarBrand />
    <NavbarLinks />

    <RouterLink
      :to="ROOM_ENTRY_LINK.to"
      class="nav-btn nav-btn-primary nav-btn-sm nav-mobile-primary"
      @click="closeMobileMenu"
    >
      {{ ROOM_ENTRY_LINK.mobileLabel }}
    </RouterLink>
    <button
      ref="mobileToggle"
      class="nav-mobile-toggle"
      type="button"
      :aria-expanded="mobileMenuOpen"
      aria-controls="public-mobile-navigation"
      aria-label="Toggle navigation"
      @click="toggleMobileMenu"
    >
      <CloseIcon v-if="mobileMenuOpen" :size="18" />
      <MenuIcon v-else :size="18" />
    </button>

    <NavbarMobilePanel v-if="mobileMenuOpen" id="public-mobile-navigation" @close="closeMobileMenu" />
  </nav>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import CloseIcon from '@/components/icons/CloseIcon.vue'
import MenuIcon from '@/components/icons/MenuIcon.vue'
import NavbarBrand from './navbar/NavbarBrand.vue'
import NavbarLinks from './navbar/NavbarLinks.vue'
import NavbarMobilePanel from './navbar/NavbarMobilePanel.vue'
import { ROOM_ENTRY_LINK } from './navbar/links'
import { useNavbarState } from './navbar/useNavbarState'

const {
  isScrolled,
  mobileMenuOpen,
  closeMobileMenu,
  toggleMobileMenu,
} = useNavbarState()

const mobileToggle = ref<HTMLButtonElement>()
function dismissMobileMenu() {
  if (!mobileMenuOpen.value) return
  closeMobileMenu()
  mobileToggle.value?.focus({ preventScroll: true })
}
</script>

<style src="./navbar/Navbar.css"></style>
