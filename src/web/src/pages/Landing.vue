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

    <HeroSection :theme="theme" />
    <SymbiosisSection />
    <SetupSection />
    <ComputeLendingSection />
    <SwarmOrchestrationSection />
    <RoomEntrySection />
    <FeaturesSection />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '@/composables/useAuth'
import HeroSection from '@/components/landing/HeroSection.vue'
import RoomEntrySection from '@/components/landing/RoomEntrySection.vue'
import SetupSection from '@/components/landing/SetupSection.vue'
import FeaturesSection from '@/components/landing/FeaturesSection.vue'
import SymbiosisSection from '@/components/landing/SymbiosisSection.vue'
import ComputeLendingSection from '@/components/landing/ComputeLendingSection.vue'
import SwarmOrchestrationSection from '@/components/landing/SwarmOrchestrationSection.vue'

withDefaults(defineProps<{ theme?: 'light' | 'dark' }>(), { theme: 'dark' })

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
  --text-tertiary: var(--text-secondary);
  --text-muted: var(--text-secondary);
  min-height: 100vh;
  min-height: 100svh;
}

.landing > :deep(section:not(.hero)) {
  position: relative;
  z-index: 2;
}

.repo-access-banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  max-width: var(--max-width);
  margin: 0 auto;
  padding: calc(112px + env(safe-area-inset-top, 0px)) 40px 0;
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
    padding: calc(96px + env(safe-area-inset-top, 0px)) 20px 0;
  }
}
</style>
