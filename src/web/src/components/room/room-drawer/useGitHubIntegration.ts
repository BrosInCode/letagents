import { computed, ref, watch, type Ref } from 'vue'
import type { RoomInfo } from '../../../composables/room/types'
import type { GitHubIntegrationStatus } from './types'

export function useGitHubIntegration(room: Readonly<Ref<RoomInfo | null>>) {
  const ghStatus = ref<GitHubIntegrationStatus | null>(null)
  const ghLoading = ref(false)
  const ghInstalling = ref(false)
  const ghError = ref('')

  const githubIntegrationRoomId = computed(() => {
    if (!room.value) return ''
    if (room.value.kind === 'focus' && room.value.parentRoomId) {
      return room.value.parentRoomId
    }
    return room.value.projectId || room.value.identifier
  })

  async function fetchGitHubStatus() {
    const roomId = githubIntegrationRoomId.value
    if (!roomId) return
    ghLoading.value = true
    ghError.value = ''
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/integrations/github`, {
        credentials: 'include',
      })
      ghStatus.value = res.ok ? await res.json() : null
    } catch {
      ghStatus.value = null
    } finally {
      ghLoading.value = false
    }
  }

  async function installGitHubApp() {
    const roomId = githubIntegrationRoomId.value
    if (!roomId) return
    ghInstalling.value = true
    ghError.value = ''
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/integrations/github/install-url`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        ghError.value = body.error || `Failed (${res.status})`
        return
      }
      const data = await res.json()
      if (data.install_url) {
        window.location.assign(data.install_url)
      }
    } catch {
      ghError.value = 'Network error'
    } finally {
      ghInstalling.value = false
    }
  }

  async function setupGitHubAppManifest() {
    const roomId = githubIntegrationRoomId.value
    if (!roomId) return
    ghInstalling.value = true
    ghError.value = ''
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/integrations/github/setup-manifest`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        ghError.value = body.error || `Failed to start setup (${res.status})`
        return
      }
      const data = await res.json()
      if (data.action && data.manifest) {
        const form = document.createElement('form')
        form.method = 'POST'
        form.action = data.action

        const input = document.createElement('input')
        input.type = 'hidden'
        input.name = 'manifest'
        input.value = data.manifest

        form.appendChild(input)
        document.body.appendChild(form)
        form.submit()
      } else {
        ghError.value = 'Invalid setup response configuration'
      }
    } catch {
      ghError.value = 'Network error'
    } finally {
      ghInstalling.value = false
    }
  }

  watch(githubIntegrationRoomId, (newId) => {
    if (newId) fetchGitHubStatus()
  }, { immediate: true })

  return {
    fetchGitHubStatus,
    ghError,
    ghInstalling,
    ghLoading,
    ghStatus,
    installGitHubApp,
    setupGitHubAppManifest,
  }
}
