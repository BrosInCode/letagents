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
const isSigningIn = ref(false)
const isCheckingSession = ref(false)
const hasCheckedSession = ref(false)
let sessionRequestVersion = 0
let authSyncInstalled = false

export const AUTH_SYNC_STORAGE_KEY = 'letagents:auth-sync'

function clearLocalAuthState() {
  sessionRequestVersion += 1
  user.value = null
  isSignedIn.value = false
  hasCheckedSession.value = true
  isCheckingSession.value = false
}

function installAuthSync() {
  if (authSyncInstalled || typeof window === 'undefined') return
  authSyncInstalled = true
  window.addEventListener('storage', (event) => {
    if (event.key !== AUTH_SYNC_STORAGE_KEY || !event.newValue) return
    try {
      const message = JSON.parse(event.newValue) as { type?: string }
      if (message.type === 'signed_out') clearLocalAuthState()
    } catch {
      // Ignore malformed or unrelated local storage values.
    }
  })
}

function broadcastSignOut() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(AUTH_SYNC_STORAGE_KEY, JSON.stringify({
      type: 'signed_out',
      at: Date.now(),
      nonce: Math.random().toString(36).slice(2),
    }))
  } catch {
    // Local logout still applies when storage is unavailable.
  }
}

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
  installAuthSync()

  async function checkSession() {
    const requestVersion = ++sessionRequestVersion
    isCheckingSession.value = true
    try {
      const res = await fetch('/auth/session', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        if (data.authenticated && data.account) {
          if (requestVersion !== sessionRequestVersion) return
          user.value = data.account
          isSignedIn.value = true
          return
        }
      }
    } catch {
      // silent — no session
    } finally {
      if (requestVersion === sessionRequestVersion) {
        hasCheckedSession.value = true
        isCheckingSession.value = false
      }
    }
    if (requestVersion !== sessionRequestVersion) return
    user.value = null
    isSignedIn.value = false
  }

  async function signIn(redirectTo?: string) {
    isLoading.value = true
    isSigningIn.value = true
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
      isSigningIn.value = false
    }
  }

  async function signOut() {
    clearLocalAuthState()
    broadcastSignOut()
    isLoading.value = true
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'include' })
    } catch {
      // silent
    } finally {
      isLoading.value = false
    }
  }

  return {
    isSignedIn: readonly(isSignedIn),
    user: readonly(user),
    isLoading: readonly(isLoading),
    isSigningIn: readonly(isSigningIn),
    isCheckingSession: readonly(isCheckingSession),
    hasCheckedSession: readonly(hasCheckedSession),
    checkSession,
    signIn,
    signOut,
  }
}
