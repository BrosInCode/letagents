<template>
  <div class="landing">
    <section v-if="repoAccessBanner" class="repo-access-banner" :class="repoAccessBanner.kind">
      <div class="repo-access-copy">
        <span class="repo-access-eyebrow">Repo Room Access</span>
        <h2 class="repo-access-title">{{ repoAccessBanner.title }}</h2>
        <p class="repo-access-body">{{ repoAccessBanner.body }}</p>
      </div>
      <div class="repo-access-actions">
        <button
          v-if="repoAccessBanner.kind === 'signin'"
          class="repo-access-btn"
          @click="auth.signIn(repoAccessBanner.redirectTo)"
        >
          Sign in with GitHub
        </button>
        <button
          v-else-if="repoAccessBanner.room"
          class="repo-access-btn secondary"
          @click="retryRepoRoom(repoAccessBanner.room)"
        >
          Try Room Again
        </button>
      </div>
    </section>

    <InkWelcome />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '@/composables/useAuth'
import InkWelcome from '@/components/landing/InkWelcome.vue'

const auth = useAuth()
const route = useRoute()
const repoAccessBanner = computed(() => {
  const reason = typeof route.query.reason === 'string' ? route.query.reason : ''
  const room = typeof route.query.room === 'string' ? route.query.room : ''
  const redirectTo = typeof route.query.redirect_to === 'string'
    ? route.query.redirect_to
    : room
      ? `/in/${room}`
      : '/'

  if (reason === 'repo_signin_required') {
    return {
      kind: 'signin' as const,
      room,
      redirectTo,
      title: 'GitHub sign-in required',
      body: room
        ? `${room} is a repo-backed room. Sign in with GitHub first, then you will be sent straight back into the room.`
        : 'This repo-backed room requires GitHub sign-in before you can enter.',
    }
  }

  if (reason === 'repo_access_denied') {
    return {
      kind: 'denied' as const,
      room,
      redirectTo,
      title: 'No repo access',
      body: room
        ? `Your current account does not appear to have access to ${room}.`
        : 'Your current account does not appear to have access to this repo-backed room.',
    }
  }

  if (reason === 'repo_provider_unsupported') {
    return {
      kind: 'denied' as const,
      room: '',
      redirectTo,
      title: 'Repo provider not supported',
      body: room
        ? `${room} cannot be opened. Repo rooms are supported for github.com repositories only. A room name with two slashes is read as a repo room (host/owner/repo). For a plain room, use a name without two slashes.`
        : 'Repo rooms are supported for github.com repositories only. A room name with two slashes is read as a repo room (host/owner/repo). For a plain room, use a name without two slashes.',
    }
  }

  return null
})

onMounted(() => {
  auth.checkSession()
})

function retryRepoRoom(room: string) {
  window.location.assign(`/in/${encodeURIComponent(room)}`)
}
</script>

<style scoped>
.landing {
  position: relative;
}

/* A repo-room sign-in bounce sits over the welcome screen, under the navigation bar. */
.repo-access-banner {
  position: absolute;
  z-index: 3;
  top: calc(92px + env(safe-area-inset-top, 0px));
  left: 50%;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  width: min(var(--max-width), calc(100% - 40px));
  box-sizing: border-box;
  transform: translateX(-50%);
  padding: 20px 24px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 16px;
  background: rgba(14, 15, 14, 0.86);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}

.repo-access-copy {
  max-width: 720px;
}

.repo-access-eyebrow {
  display: inline-flex;
  margin-bottom: 10px;
  color: #f59e0b;
  font-size: 0.74rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.repo-access-title {
  margin: 0 0 8px;
  color: var(--text, #fafafa);
  font-size: 1.4rem;
  font-weight: 800;
}

.repo-access-body {
  overflow-wrap: anywhere;
  margin: 0;
  color: var(--text-secondary, #d4d4d8);
  line-height: 1.65;
}

.repo-access-actions {
  display: flex;
  align-items: center;
}

.repo-access-btn {
  min-height: 44px;
  padding: 0 16px;
  border: none;
  border-radius: 999px;
  background: #f8fafc;
  color: #09090b;
  font-size: 0.84rem;
  font-weight: 700;
  cursor: pointer;
}

.repo-access-btn.secondary {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text, #fafafa);
  border: 1px solid var(--border, #27272a);
}

@media (max-width: 820px) {
  .repo-access-banner {
    flex-direction: column;
    top: calc(76px + env(safe-area-inset-top, 0px));
    padding: 16px 18px;
  }
}
</style>
