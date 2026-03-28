import { ref, readonly } from 'vue'

interface AuthUser {
  login: string
  display_name: string | null
  avatar_url: string | null
  provider: string
}

const isSignedIn = ref(false)
const user = ref<AuthUser | null>(null)
const isLoading = ref(false)

/**
 * Composable for managing GitHub auth state.
 * Uses session cookies — calls the existing Express auth endpoints.
 */
export function useAuth() {
  async function checkSession() {
    try {
      const res = await fetch('/api/session')
      if (res.ok) {
        const data = await res.json()
        if (data.account) {
          user.value = data.account
          isSignedIn.value = true
          return
        }
      }
    } catch {
      // silent — no session
    }
    user.value = null
    isSignedIn.value = false
  }

  async function signIn(redirectTo?: string) {
    isLoading.value = true
    try {
      const res = await fetch('/auth/github/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_to: redirectTo || window.location.pathname }),
      })
      const data = await res.json()
      if (data.auth_url) {
        window.location.href = data.auth_url
      }
    } catch (error) {
      console.error('Sign in failed:', error)
    } finally {
      isLoading.value = false
    }
  }

  async function signOut() {
    isLoading.value = true
    try {
      await fetch('/auth/logout', { method: 'POST' })
    } catch {
      // silent
    }
    user.value = null
    isSignedIn.value = false
    isLoading.value = false
  }

  return {
    isSignedIn: readonly(isSignedIn),
    user: readonly(user),
    isLoading: readonly(isLoading),
    checkSession,
    signIn,
    signOut,
  }
}
