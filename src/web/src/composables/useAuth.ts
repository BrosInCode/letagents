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

interface SignInLocation {
  pathname: string
  search: string
  hash: string
}

function getBrowserLocation(): SignInLocation | null {
  if (typeof window === 'undefined') {
    return null
  }
  return window.location
}

function appendLocationHash(redirectTo: string, hash: string): string {
  if (!hash || redirectTo.includes('#')) {
    return redirectTo
  }
  return `${redirectTo}${hash.startsWith('#') ? hash : `#${hash}`}`
}

function isRepoSigninBounce(location: SignInLocation): boolean {
  const params = new URLSearchParams(location.search)
  return (
    location.pathname === '/' && params.get('reason') === 'repo_signin_required'
  )
}

export function resolveSignInRedirect(
  redirectTo?: string,
  location: SignInLocation | null = getBrowserLocation(),
): string {
  const explicitRedirect = redirectTo?.trim()
  if (explicitRedirect) {
    return location && isRepoSigninBounce(location)
      ? appendLocationHash(explicitRedirect, location.hash)
      : explicitRedirect
  }

  if (!location) {
    return '/'
  }

  const params = new URLSearchParams(location.search)
  if (isRepoSigninBounce(location)) {
    const queryRedirect = params.get('redirect_to')?.trim()
    if (queryRedirect) {
      return appendLocationHash(queryRedirect, location.hash)
    }

    const repoRoom = params.get('room')?.trim()
    if (repoRoom) {
      return appendLocationHash(`/in/${repoRoom}`, location.hash)
    }
  }

  return `${location.pathname || '/'}${location.search || ''}${location.hash || ''}`
}

/**
 * Composable for managing GitHub auth state.
 * Uses session cookies — calls the existing Express auth endpoints.
 */
export function useAuth() {
  async function checkSession() {
    try {
      const res = await fetch('/auth/session', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        if (data.authenticated && data.account) {
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
        credentials: 'include',
        body: JSON.stringify({ redirect_to: resolveSignInRedirect(redirectTo) }),
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
      await fetch('/auth/logout', { method: 'POST', credentials: 'include' })
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
