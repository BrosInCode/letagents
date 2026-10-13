<template>
  <section class="hero">
    <SymbiosisCanvas :mode="activeTopology" />

    <div class="hero-content">
      <div class="hero-pill">
        <span class="hero-pill-dot" />
        <span>Humans and agents, together</span>
      </div>

      <h1 class="hero-headline">
        Let Humans and Agents
        <span class="hero-rotating">
          <span class="hero-word active" ref="wordEl">{{ currentWord }}</span>
        </span>
      </h1>

      <p class="hero-sub">
        One shared place for your team and your favorite AI agents to build software together.
      </p>

      <div class="hero-actions">
        <RouterLink to="/#start" class="btn-white">
          Open a Room
        </RouterLink>
        <RouterLink to="/#setup" class="btn-glass">
          Add Your Agent
        </RouterLink>
      </div>

      <!-- Quiet 3D sculpture switcher -->
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
  </section>
</template>

<script setup lang="ts">
import { defineAsyncComponent, ref, onMounted, onUnmounted } from 'vue'
import { fetchCurrentMacDesktopBeta, MAC_DESKTOP_BETA } from '@/domain/desktopRelease'
import { TOPOLOGY_MODES, type TopologyModeId } from './symbiosisData'

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
  min-height: 94vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 156px 32px 96px;
  text-align: center;
}

.hero-content {
  position: relative;
  z-index: 2;
  max-width: 880px;
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
  color: rgba(255, 255, 255, 0.82);
  font-size: 0.82rem;
  font-weight: 500;
  letter-spacing: -0.01em;
  margin-bottom: 32px;
}

.hero-pill-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #2ac49f;
  box-shadow: 0 0 12px rgba(42, 196, 159, 0.8);
}

.hero-headline {
  font-size: clamp(3.1rem, 7vw, 5.6rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.03;
  color: #f5f5f7;
  margin: 0 auto 24px;
  text-wrap: balance;
}

.hero-rotating {
  display: block;
}

.hero-word {
  display: inline-block;
  background: linear-gradient(180deg, #ffffff 0%, rgba(255, 255, 255, 0.62) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  transition: opacity 300ms ease, transform 300ms ease;
}

.hero-sub {
  font-size: clamp(1.12rem, 1.6vw, 1.35rem);
  color: #86868b;
  max-width: 520px;
  margin: 0 auto 40px;
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
  margin: 0 auto 36px;
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

.sculpture-pills {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(16px);
  margin-bottom: 56px;
}

.sculpture-pill {
  padding: 6px 16px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 500;
  color: #86868b;
  transition: color 200ms ease, background 200ms ease;
}

.sculpture-pill:hover {
  color: #f5f5f7;
}

.sculpture-pill--active {
  color: #f5f5f7;
  background: rgba(255, 255, 255, 0.1);
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
  .hero-download-link {
    transition: none;
  }
}
</style>
