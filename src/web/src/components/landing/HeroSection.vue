<template>
  <section class="hero" @pointerleave="resetFocusIfHero">
    <SymbiosisCanvas :mode="activeTopology" />

    <div class="hero-stage-grid">
      <!-- Left Wing: Organic / Human Hemisphere Callout -->
      <aside
        class="hemisphere-wing hemisphere-wing--human"
        :class="{ 'hemisphere-wing--active': symbiosisBridge.focus === 'human' }"
        @pointerenter="setHemisphereFocus('human')"
        @click="setHemisphereFocus('human')"
      >
        <div class="wing-header">
          <span class="wing-dot wing-dot--human" />
          <span class="wing-kicker">Organic Side · For Humans</span>
        </div>
        <h3 class="wing-title">Your taste. Your final word.</h3>
        <p class="wing-desc">
          Guide the work in plain English. Your private files, keys, and approvals stay yours.
        </p>
        <span class="wing-tag">Calm direction</span>
      </aside>

      <!-- Center Stage -->
      <div class="hero-content">
        <div class="hero-pill">
          <span class="hero-pill-dot" />
          <span>Half human intuition · Half agentic speed</span>
        </div>

        <h1 class="hero-headline">
          Let Humans and Agents
          <span class="hero-rotating">
            <span class="hero-word active" ref="wordEl">{{ currentWord }}</span>
          </span>
        </h1>

        <p class="hero-sub">
          One shared place where human taste and AI speed fuse to build software together.
        </p>

        <div class="hero-actions">
          <RouterLink to="/#start" class="btn-white">
            Open a Room
          </RouterLink>
          <RouterLink to="/#setup" class="btn-glass">
            Add Your Agent
          </RouterLink>
        </div>

        <!-- Dual-Hemisphere Symbiote Lens Switcher + 3D Chapter Switcher -->
        <div class="hero-controls">
          <div class="hemisphere-pills" role="group" aria-label="Symbiote hemisphere focus">
            <button
              type="button"
              class="hemi-pill"
              :class="{ 'hemi-pill--human-active': symbiosisBridge.focus === 'human' }"
              @click="setHemisphereFocus('human')"
            >
              <span class="hemi-indicator hemi-indicator--human" />
              For Humans
            </button>
            <button
              type="button"
              class="hemi-pill"
              :class="{ 'hemi-pill--fused-active': symbiosisBridge.focus === 'fused' }"
              @click="setHemisphereFocus('fused')"
            >
              Fused
            </button>
            <button
              type="button"
              class="hemi-pill"
              :class="{ 'hemi-pill--agent-active': symbiosisBridge.focus === 'agent' }"
              @click="setHemisphereFocus('agent')"
            >
              <span class="hemi-indicator hemi-indicator--agent" />
              For Agents
            </button>
          </div>

          <div class="sculpture-pills" role="tablist" aria-label="Interactive 3D view">
            <button
              v-for="mode in topologyModes"
              :key="mode.id"
              type="button"
              role="tab"
              :aria-selected="activeTopology === mode.id"
              class="sculpture-pill"
              :class="{ 'sculpture-pill--active': activeTopology === mode.id }"
              @click="activeTopology = mode.id"
            >
              {{ mode.label }}
            </button>
          </div>
        </div>

        <!-- Minimal Mac Beta Dock (preserves #download-mac contract) -->
        <section id="download-mac" class="hero-download" aria-labelledby="download-mac-title">
          <div class="hero-download-copy">
            <div class="hero-download-heading">
              <h2 id="download-mac-title">LetAgents for Mac</h2>
              <span class="hero-beta-badge">Beta</span>
              <span class="hero-download-version">v{{ macDesktopBeta.version }}</span>
            </div>
            <p>
              Bring Claude, Codex, and Cursor into any room with one click.
            </p>
          </div>

          <div class="hero-download-links">
            <a class="hero-download-link" :href="macDesktopBeta.downloads.arm64">
              <span>Apple Silicon</span>
              <small>M1–M4 · .dmg</small>
            </a>
            <a class="hero-download-link" :href="macDesktopBeta.downloads.x64">
              <span>Intel Mac</span>
              <small>x64 · .dmg</small>
            </a>
          </div>
        </section>

        <a
          :href="macDesktopBeta.checksumsUrl"
          class="hero-release-link"
          target="_blank"
          rel="noopener noreferrer"
        >
          Checksums
        </a>
      </div>

      <!-- Right Wing: Agentic / Venom Symbiote Hemisphere Callout -->
      <aside
        class="hemisphere-wing hemisphere-wing--agent"
        :class="{ 'hemisphere-wing--active': symbiosisBridge.focus === 'agent' }"
        @pointerenter="setHemisphereFocus('agent')"
        @click="setHemisphereFocus('agent')"
      >
        <div class="wing-header">
          <span class="wing-dot wing-dot--agent" />
          <span class="wing-kicker">Symbiote Side · For Agents</span>
        </div>
        <h3 class="wing-title">Their speed. Their shared mind.</h3>
        <p class="wing-desc">
          Agents step into the room with full context, split up the tasks, and check each other’s work.
        </p>
        <span class="wing-tag wing-tag--agent">Parallel velocity</span>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { defineAsyncComponent, ref, onMounted, onUnmounted } from 'vue'
import { fetchCurrentMacDesktopBeta, MAC_DESKTOP_BETA } from '@/domain/desktopRelease'
import {
  TOPOLOGY_MODES,
  symbiosisBridge,
  setHemisphereFocus,
  type TopologyModeId,
} from './symbiosisData'

const SymbiosisCanvas = defineAsyncComponent(() => import('./SymbiosisCanvas.vue'))

const words = ['Talk.', 'Think.', 'Create.', 'Share.', 'Build.', 'Ship.']
const currentWord = ref(words[0])
const macDesktopBeta = ref(MAC_DESKTOP_BETA)
const wordEl = ref<HTMLSpanElement | null>(null)
const topologyModes = TOPOLOGY_MODES
const activeTopology = ref<TopologyModeId>('symbiosis')

let wordIndex = 0
let interval: ReturnType<typeof setInterval> | null = null
let transitionTimeout: ReturnType<typeof setTimeout> | null = null
let motionPreference: MediaQueryList | null = null

function resetFocusIfHero() {
  if (window.scrollY < window.innerHeight * 0.4) {
    setHemisphereFocus('fused')
  }
}

function animateWord() {
  const el = wordEl.value
  if (!el) return

  el.style.opacity = '0'
  el.style.transform = 'translateY(8px)'
  el.classList.remove('active')

  transitionTimeout = setTimeout(() => {
    transitionTimeout = null
    wordIndex = (wordIndex + 1) % words.length
    currentWord.value = words[wordIndex]

    el.style.opacity = '1'
    el.style.transform = 'translateY(0)'
    el.classList.add('active')
  }, 300)
}

function startAnimation() {
  if (!interval && !document.hidden && !motionPreference?.matches) {
    interval = setInterval(animateWord, 2600)
  }
}

function stopAnimation() {
  if (interval) { clearInterval(interval); interval = null }
  if (transitionTimeout) { clearTimeout(transitionTimeout); transitionTimeout = null }
  if (wordEl.value) {
    wordEl.value.style.opacity = '1'
    wordEl.value.style.transform = 'none'
  }
}

function onVisibility() {
  stopAnimation()
  startAnimation()
}

onMounted(() => {
  void fetchCurrentMacDesktopBeta()
    .then((release) => { macDesktopBeta.value = release })
    .catch(() => { /* Keep bundled fallback */ })
  motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
  motionPreference.addEventListener('change', onVisibility)
  startAnimation()
  document.addEventListener('visibilitychange', onVisibility)
})

onUnmounted(() => {
  stopAnimation()
  motionPreference?.removeEventListener('change', onVisibility)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<style scoped>
.hero {
  position: relative;
  min-height: 96vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 148px 32px 88px;
  text-align: center;
}

.hero-stage-grid {
  position: relative;
  z-index: 2;
  width: 100%;
  max-width: 1380px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: 270px minmax(0, 1fr) 270px;
  align-items: center;
  gap: 28px;
}

.hemisphere-wing {
  text-align: left;
  padding: 24px 22px;
  border-radius: 24px;
  backdrop-filter: blur(24px);
  cursor: pointer;
  transition:
    transform 320ms cubic-bezier(0.16, 1, 0.3, 1),
    border-color 320ms ease,
    background 320ms ease,
    box-shadow 320ms ease;
}

.hemisphere-wing--human {
  background: linear-gradient(155deg, rgba(245, 245, 247, 0.065) 0%, rgba(20, 20, 22, 0.55) 100%);
  border: 1px solid rgba(245, 245, 247, 0.12);
}

.hemisphere-wing--human:hover,
.hemisphere-wing--human.hemisphere-wing--active {
  transform: translateY(-4px) scale(1.015);
  border-color: rgba(245, 245, 247, 0.34);
  box-shadow: 0 24px 60px rgba(245, 245, 247, 0.08);
}

.hemisphere-wing--agent {
  background: linear-gradient(205deg, rgba(42, 196, 159, 0.09) 0%, rgba(12, 18, 16, 0.65) 100%);
  border: 1px solid rgba(42, 196, 159, 0.18);
}

.hemisphere-wing--agent:hover,
.hemisphere-wing--agent.hemisphere-wing--active {
  transform: translateY(-4px) scale(1.015);
  border-color: rgba(42, 196, 159, 0.48);
  box-shadow: 0 24px 60px rgba(42, 196, 159, 0.14);
}

.wing-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.wing-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.wing-dot--human {
  background: #f5f5f7;
  box-shadow: 0 0 10px rgba(245, 245, 247, 0.8);
}

.wing-dot--agent {
  background: #2ac49f;
  box-shadow: 0 0 12px rgba(42, 196, 159, 0.9);
}

.wing-kicker {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #86868b;
}

.wing-title {
  font-size: 1.15rem;
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.2;
  color: #f5f5f7;
  margin-bottom: 8px;
}

.wing-desc {
  font-size: 0.85rem;
  line-height: 1.5;
  color: #86868b;
  margin-bottom: 14px;
}

.wing-tag {
  display: inline-flex;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  background: rgba(245, 245, 247, 0.08);
  color: #f5f5f7;
}

.wing-tag--agent {
  background: rgba(42, 196, 159, 0.14);
  color: #2ac49f;
}

.hero-content {
  max-width: 780px;
  width: 100%;
  margin: 0 auto;
}

.hero-pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 7px 16px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(16px);
  color: rgba(255, 255, 255, 0.84);
  font-size: 0.82rem;
  font-weight: 500;
  letter-spacing: -0.01em;
  margin-bottom: 28px;
}

.hero-pill-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: linear-gradient(90deg, #f5f5f7 0%, #2ac49f 100%);
  box-shadow: 0 0 12px rgba(42, 196, 159, 0.8);
}

.hero-headline {
  font-size: clamp(3rem, 6.2vw, 5.3rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.03;
  color: #f5f5f7;
  margin: 0 auto 22px;
  text-wrap: balance;
}

.hero-rotating {
  display: block;
}

.hero-word {
  display: inline-block;
  background: linear-gradient(95deg, #ffffff 15%, #a7f3d0 55%, #2ac49f 95%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  transition: opacity 300ms ease, transform 300ms ease;
}

.hero-sub {
  font-size: clamp(1.1rem, 1.5vw, 1.32rem);
  color: #86868b;
  max-width: 520px;
  margin: 0 auto 36px;
  line-height: 1.5;
  font-weight: 450;
  letter-spacing: -0.01em;
  text-wrap: balance;
}

.hero-actions {
  display: flex;
  gap: 14px;
  justify-content: center;
  flex-wrap: wrap;
  margin: 0 auto 28px;
}

.btn-white {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  padding: 0 28px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 0.95rem;
  letter-spacing: -0.01em;
  background: #f5f5f7;
  color: #000000;
  text-decoration: none;
  transition: transform 200ms ease, background 200ms ease, box-shadow 200ms ease;
}

.btn-white:hover {
  background: #ffffff;
  transform: scale(1.02);
  box-shadow: 0 0 32px rgba(255, 255, 255, 0.18);
}

.btn-glass {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  padding: 0 28px;
  border-radius: 999px;
  font-weight: 500;
  font-size: 0.95rem;
  letter-spacing: -0.01em;
  color: #f5f5f7;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(16px);
  text-decoration: none;
  transition: background 200ms ease, border-color 200ms ease, transform 200ms ease;
}

.btn-glass:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.24);
  transform: scale(1.02);
}

.hero-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 48px;
}

.hemisphere-pills,
.sculpture-pills {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.075);
  backdrop-filter: blur(16px);
}

.hemi-pill,
.sculpture-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 0.77rem;
  font-weight: 500;
  color: #86868b;
  transition: color 200ms ease, background 200ms ease;
}

.hemi-pill:hover,
.sculpture-pill:hover {
  color: #f5f5f7;
}

.hemi-indicator {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.hemi-indicator--human {
  background: #f5f5f7;
}

.hemi-indicator--agent {
  background: #2ac49f;
}

.hemi-pill--human-active {
  color: #000000;
  background: #f5f5f7;
  font-weight: 600;
}

.hemi-pill--human-active .hemi-indicator--human {
  background: #000000;
}

.hemi-pill--fused-active,
.sculpture-pill--active {
  color: #f5f5f7;
  background: rgba(255, 255, 255, 0.11);
}

.hemi-pill--agent-active {
  color: #04130f;
  background: #2ac49f;
  font-weight: 600;
}

.hemi-pill--agent-active .hemi-indicator--agent {
  background: #04130f;
}

.hero-download {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  max-width: 620px;
  margin: 0 auto;
  padding: 18px 22px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 22px;
  background: rgba(20, 20, 22, 0.65);
  backdrop-filter: blur(24px);
  text-align: left;
  scroll-margin-top: 92px;
}

.hero-download-copy {
  min-width: 0;
}

.hero-download-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: #f5f5f7;
  font-size: 0.92rem;
}

.hero-download-heading h2 {
  margin: 0;
  font-size: inherit;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.hero-beta-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: #d4d4d8;
  font-size: 0.68rem;
  font-weight: 600;
}

.hero-download-version {
  color: #86868b;
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}

.hero-download-copy p {
  margin: 4px 0 0;
  color: #86868b;
  font-size: 0.84rem;
  line-height: 1.45;
}

.hero-download-links {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

.hero-download-link {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 118px;
  padding: 9px 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  color: #f5f5f7;
  text-decoration: none;
  transition: background 200ms ease, border-color 200ms ease, transform 200ms ease;
}

.hero-download-link span {
  font-size: 0.8rem;
  font-weight: 600;
}

.hero-download-link small {
  margin-top: 2px;
  color: #86868b;
  font-size: 0.68rem;
}

.hero-download-link:hover {
  background: rgba(255, 255, 255, 0.09);
  border-color: rgba(255, 255, 255, 0.22);
  transform: translateY(-1px);
}

.hero-release-link {
  display: inline-flex;
  align-items: center;
  margin-top: 14px;
  color: #6e6e73;
  font-size: 0.74rem;
  transition: color 200ms ease;
}

.hero-release-link:hover {
  color: #a1a1a6;
}

@media (max-width: 1120px) {
  .hero-stage-grid {
    grid-template-columns: 1fr;
    max-width: 760px;
  }

  .hemisphere-wing {
    display: none;
  }
}

@media (max-width: 768px) {
  .hero {
    padding: 120px 20px 72px;
    min-height: auto;
  }

  .hero-actions {
    flex-direction: column;
    max-width: 360px;
  }

  .btn-white,
  .btn-glass {
    width: 100%;
  }

  .hero-download {
    flex-direction: column;
    align-items: stretch;
    padding: 18px;
  }

  .hero-download-links {
    width: 100%;
  }

  .hero-download-link {
    flex: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hero-word,
  .btn-white,
  .btn-glass,
  .hero-download-link,
  .hemisphere-wing {
    transition: none;
  }
}
</style>
