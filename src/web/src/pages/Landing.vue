<template>
  <div class="landing" :data-focus="symbiosisBridge.focus">
    <!-- Awwwards-style Fixed Chapter Progress Rail (inspired by morphowater.com) -->
    <nav class="journey-rail" aria-label="Page chapters">
      <div class="rail-counter">
        <span class="rail-current">0{{ symbiosisBridge.activeChapter + 1 }}</span>
        <span class="rail-sep">/</span>
        <span class="rail-total">06</span>
      </div>

      <div class="rail-ticks">
        <a
          v-for="(item, idx) in railChapters"
          :key="item.id"
          :href="item.href"
          class="rail-tick-link"
          :class="{ 'rail-tick-link--active': symbiosisBridge.activeChapter === idx }"
          :title="item.label"
        >
          <span class="rail-tick-bar" />
          <span class="rail-tick-label">{{ item.label }}</span>
        </a>
      </div>

      <div class="rail-hemisphere-status">
        <span
          class="rail-hemi-dot"
          :class="`rail-hemi-dot--${symbiosisBridge.focus}`"
        />
        <span class="rail-hemi-text">
          {{
            symbiosisBridge.focus === 'human'
              ? 'Human Side'
              : symbiosisBridge.focus === 'agent'
                ? 'Agent Side'
                : 'Fused'
          }}
        </span>
      </div>
    </nav>

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

    <HeroSection />
    <SymbiosisSection />
    <SetupSection />
    <ComputeLendingSection />
    <SwarmOrchestrationSection />
    <RoomEntrySection />
    <FeaturesSection />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '@/composables/useAuth'
import HeroSection from '@/components/landing/HeroSection.vue'
import SymbiosisSection from '@/components/landing/SymbiosisSection.vue'
import SetupSection from '@/components/landing/SetupSection.vue'
import ComputeLendingSection from '@/components/landing/ComputeLendingSection.vue'
import SwarmOrchestrationSection from '@/components/landing/SwarmOrchestrationSection.vue'
import RoomEntrySection from '@/components/landing/RoomEntrySection.vue'
import FeaturesSection from '@/components/landing/FeaturesSection.vue'
import { symbiosisBridge } from '@/components/landing/symbiosisData'

const auth = useAuth()
const route = useRoute()

const railChapters = [
  { id: 'hero', label: 'Origin', href: '#' },
  { id: 'symbiosis', label: 'Two Sides', href: '#symbiosis' },
  { id: 'setup', label: 'Your Agents', href: '#setup' },
  { id: 'lending', label: 'Share Agent', href: '#lending' },
  { id: 'swarms', label: 'Open Rooms', href: '#swarms' },
  { id: 'start', label: 'Enter Room', href: '#start' },
]

let revealObserver: IntersectionObserver | null = null

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

  if (typeof IntersectionObserver !== 'undefined') {
    const sections = document.querySelectorAll('.landing > section')
    revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('section-revealed')
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    )
    sections.forEach((sec) => {
      sec.classList.add('section-scroll-reveal')
      revealObserver?.observe(sec)
    })
  }
})

onUnmounted(() => {
  revealObserver?.disconnect()
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
}

/* ─── Awwwards Fixed Left Chapter Rail ─── */
.journey-rail {
  position: fixed;
  left: 24px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 14px 12px;
  border-radius: 20px;
  background: rgba(14, 14, 16, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(20px);
}

.rail-counter {
  display: flex;
  align-items: baseline;
  gap: 3px;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
  color: #6e6e73;
}

.rail-current {
  color: #f5f5f7;
  font-weight: 700;
}

.rail-ticks {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rail-tick-link {
  display: flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
  color: #6e6e73;
  transition: color 200ms ease;
}

.rail-tick-bar {
  width: 12px;
  height: 1.5px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.2);
  transition: width 260ms cubic-bezier(0.16, 1, 0.3, 1), background 260ms ease;
}

.rail-tick-label {
  font-size: 0.68rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  opacity: 0.65;
  transition: opacity 200ms ease, color 200ms ease;
}

.rail-tick-link:hover .rail-tick-label,
.rail-tick-link--active .rail-tick-label {
  opacity: 1;
  color: #f5f5f7;
}

.rail-tick-link--active .rail-tick-bar {
  width: 24px;
  background: #2ac49f;
  box-shadow: 0 0 10px rgba(42, 196, 159, 0.8);
}

.rail-hemisphere-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}

.rail-hemi-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  transition: background 250ms ease, box-shadow 250ms ease;
}

.rail-hemi-dot--human {
  background: #f5f5f7;
  box-shadow: 0 0 8px rgba(245, 245, 247, 0.9);
}

.rail-hemi-dot--agent {
  background: #2ac49f;
  box-shadow: 0 0 8px rgba(42, 196, 159, 0.9);
}

.rail-hemi-dot--fused {
  background: linear-gradient(135deg, #f5f5f7 0%, #2ac49f 100%);
}

.rail-hemi-text {
  font-size: 0.66rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #86868b;
}

/* ─── Scroll-Triggered Section Reveal Choreography ─── */
:deep(.section-scroll-reveal) {
  opacity: 0;
  transform: translateY(34px) scale(0.985);
  transition:
    opacity 820ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 820ms cubic-bezier(0.16, 1, 0.3, 1);
}

:deep(.section-scroll-reveal.section-revealed),
:deep(.hero.section-scroll-reveal) {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.repo-access-banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  max-width: var(--max-width);
  margin: 0 auto;
  padding: 112px 40px 0;
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
  min-height: 42px;
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

@media (max-width: 1280px) {
  .journey-rail {
    display: none;
  }
}

@media (max-width: 820px) {
  .repo-access-banner {
    flex-direction: column;
    padding: 96px 20px 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  :deep(.section-scroll-reveal) {
    opacity: 1;
    transform: none;
    transition: none;
  }
}
</style>
