import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { AUTH_SYNC_STORAGE_KEY, useAuth } from '../src/composables/useAuth'
import { resolveRoomAccessState } from '../src/pages/room/roomAuth'

test('room access stays gated until the session check finishes', () => {
  assert.equal(resolveRoomAccessState({
    hasCheckedSession: false,
    isCheckingSession: false,
    isSignedIn: false,
  }), 'checking')

  assert.equal(resolveRoomAccessState({
    hasCheckedSession: true,
    isCheckingSession: true,
    isSignedIn: true,
  }), 'checking')
})

test('signed-out users never receive the authorized room state', () => {
  assert.equal(resolveRoomAccessState({
    hasCheckedSession: true,
    isCheckingSession: false,
    isSignedIn: false,
  }), 'signed_out')
})

test('sign out closes the local authorization boundary before the request finishes', async () => {
  const originalFetch = globalThis.fetch
  let finishLogout!: () => void
  const logoutPending = new Promise<void>((resolve) => {
    finishLogout = resolve
  })

  globalThis.fetch = async (input) => {
    if (String(input) === '/auth/session') {
      return new Response(JSON.stringify({
        authenticated: true,
        account: { login: 'octocat', display_name: 'Octocat', avatar_url: null, provider: 'github' },
      }), { status: 200 })
    }
    await logoutPending
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }

  try {
    const auth = useAuth()
    await auth.checkSession()
    assert.equal(auth.isSignedIn.value, true)

    const logout = auth.signOut()
    assert.equal(auth.isSignedIn.value, false)
    assert.equal(auth.user.value, null)

    finishLogout()
    await logout
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a logout broadcast closes the authorization boundary in another tab', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  let storageListener: ((event: { key: string | null, newValue: string | null }) => void) | null = null

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener(type: string, listener: typeof storageListener) {
        if (type === 'storage') storageListener = listener
      },
      localStorage: { setItem() {} },
    },
  })
  globalThis.fetch = async () => new Response(JSON.stringify({
    authenticated: true,
    account: { login: 'octocat', display_name: 'Octocat', avatar_url: null, provider: 'github' },
  }), { status: 200 })

  try {
    const auth = useAuth()
    await auth.checkSession()
    assert.equal(auth.isSignedIn.value, true)
    assert.ok(storageListener)

    storageListener({
      key: AUTH_SYNC_STORAGE_KEY,
      newValue: JSON.stringify({ type: 'signed_out', at: Date.now() }),
    })

    assert.equal(auth.isSignedIn.value, false)
    assert.equal(auth.user.value, null)
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      })
    }
  }
})

test('the room shell mounts only inside the authorized branch', () => {
  const roomPath = fileURLToPath(new URL('../src/pages/Room.vue', import.meta.url))
  const source = readFileSync(roomPath, 'utf8')

  assert.match(source, /<RoomAuthGate[\s\S]*v-if="roomAccessState !== 'authorized'"/)
  assert.match(source, /<div v-else class="room-shell"/)
  assert.match(source, /hasCheckedSession: roomSessionValidated\.value && auth\.hasCheckedSession\.value/)
})
