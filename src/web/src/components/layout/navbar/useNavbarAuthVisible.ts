import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '@/composables/useAuth'

/**
 * The docs offer no sign-in: a signed-out reader sees no auth controls there.
 * A signed-in reader keeps their account links and Sign Out.
 */
export function useNavbarAuthVisible() {
  const route = useRoute()
  const auth = useAuth()
  return computed(() => auth.isSignedIn.value || route.name !== 'docs')
}
