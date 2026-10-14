<template>
  <nav :class="['navbar', { 'navbar--scrolled': isScrolled }]">
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
      type="button"
      class="nav-theme-toggle nav-mobile-theme"
      :aria-label="symbiosisBridge.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'"
      @click="toggleTheme"
    >
      <span class="theme-icon-stack" :data-theme-mode="symbiosisBridge.theme">
        <svg class="theme-icon theme-icon--sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
        <svg class="theme-icon theme-icon--moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </span>
    </button>
    <button
      class="nav-mobile-toggle"
      type="button"
      :aria-expanded="mobileMenuOpen"
      aria-label="Toggle navigation"
      @click="toggleMobileMenu"
    >
      <CloseIcon v-if="mobileMenuOpen" :size="18" />
      <MenuIcon v-else :size="18" />
    </button>

    <NavbarMobilePanel v-if="mobileMenuOpen" @close="closeMobileMenu" />
  </nav>
</template>

<script setup lang="ts">
import CloseIcon from '@/components/icons/CloseIcon.vue'
import MenuIcon from '@/components/icons/MenuIcon.vue'
import NavbarBrand from './navbar/NavbarBrand.vue'
import NavbarLinks from './navbar/NavbarLinks.vue'
import NavbarMobilePanel from './navbar/NavbarMobilePanel.vue'
import { ROOM_ENTRY_LINK } from './navbar/links'
import { useNavbarState } from './navbar/useNavbarState'
import { symbiosisBridge, toggleTheme } from '@/components/landing/symbiosisData'

const {
  isScrolled,
  mobileMenuOpen,
  closeMobileMenu,
  toggleMobileMenu,
} = useNavbarState()
</script>

<style src="./navbar/Navbar.css"></style>
