import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

export function useNavbarState() {
  const route = useRoute()
  const isScrolled = ref(false)
  const mobileMenuOpen = ref(false)

  function updateScrolledState() {
    isScrolled.value = window.scrollY > 20
  }

  function closeMobileMenu() {
    mobileMenuOpen.value = false
  }

  function toggleMobileMenu() {
    mobileMenuOpen.value = !mobileMenuOpen.value
  }

  function closeOnDesktop() {
    if (window.innerWidth > 760) closeMobileMenu()
  }

  onMounted(() => {
    updateScrolledState()
    window.addEventListener('scroll', updateScrolledState, { passive: true })
    window.addEventListener('resize', closeOnDesktop)
  })
  onUnmounted(() => {
    window.removeEventListener('scroll', updateScrolledState)
    window.removeEventListener('resize', closeOnDesktop)
  })
  watch(() => route.fullPath, closeMobileMenu)

  return {
    isScrolled,
    mobileMenuOpen,
    closeMobileMenu,
    toggleMobileMenu,
  }
}
