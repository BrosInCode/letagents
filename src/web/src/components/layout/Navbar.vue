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
      v-if="landingTheme"
      type="button"
      class="nav-theme-toggle"
      :aria-label="landingTheme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'"
      @click="$emit('toggle-theme')"
    >
      <svg v-if="landingTheme === 'dark'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
      </svg>
      <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    </button>
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

defineProps<{ landingTheme?: 'light' | 'dark' }>()
defineEmits<{ 'toggle-theme': [] }>()

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
