import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '@/composables/useAuth'

/**
 * The docs offer no sign-in: a signed-out reader sees no auth controls there.
 * A signed-in reader keeps their account links and Sign Out, so a reader who opens the docs
 * first has their session checked (other public pages check it themselves).
 */
export function useNavbarAuthVisible() {
  const route = useRoute()
  const auth = useAuth()
  watch(() => route.name, (name) => {
    if (name === 'docs' && !auth.hasCheckedSession.value && !auth.isCheckingSession.value) void auth.checkSession()
  }, { immediate: true })
  return computed(() => auth.isSignedIn.value || route.name !== 'docs')
}
