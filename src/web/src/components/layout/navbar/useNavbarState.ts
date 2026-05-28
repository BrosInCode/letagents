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

  onMounted(() => {
    updateScrolledState()
    window.addEventListener('scroll', updateScrolledState, { passive: true })
  })
  onUnmounted(() => window.removeEventListener('scroll', updateScrolledState))
  watch(() => route.fullPath, closeMobileMenu)

  return {
    isScrolled,
    mobileMenuOpen,
    closeMobileMenu,
    toggleMobileMenu,
  }
}
