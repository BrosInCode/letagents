<template>
  <section class="hero">
    <SymbiosisCanvas :mode="activeTopology" />

    <div class="hero-content">
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

      <!-- Whisper-clean Mac download line (preserves #download-mac & scroll-margin-top: 92px) -->
      <div id="download-mac" class="hero-mac-line">
        <a class="mac-primary-link" :href="macDesktopBeta.downloads.arm64">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.33c.64-.78 1.08-1.86.96-2.94-.93.04-2.06.62-2.72 1.4-.58.68-1.1 1.79-.96 2.84 1.04.08 2.08-.52 2.72-1.3" />
          </svg>
          <span>Download for Mac</span>
        </a>
        <span class="mac-divider" aria-hidden="true">·</span>
        <a class="mac-secondary-link" :href="macDesktopBeta.downloads.x64">
          Intel Mac
        </a>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { defineAsyncComponent, ref, onMounted, onUnmounted } from 'vue'
import { fetchCurrentMacDesktopBeta, MAC_DESKTOP_BETA } from '@/domain/desktopRelease'
import type { TopologyModeId } from './symbiosisData'

const SymbiosisCanvas = defineAsyncComponent(() => import('./SymbiosisCanvas.vue'))

const words = ['Talk.', 'Think.', 'Create.', 'Share.', 'Build.', 'Ship.']
const currentWord = ref(words[0])
const macDesktopBeta = ref(MAC_DESKTOP_BETA)
const wordEl = ref<HTMLSpanElement | null>(null)
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
  min-height: 92vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 156px 32px 96px;
  text-align: center;
}

.hero-content {
  position: relative;
  z-index: 2;
  max-width: 820px;
  width: 100%;
  margin: 0 auto;
}

.hero-headline {
  font-size: clamp(3.2rem, 7vw, 5.6rem);
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
  color: #86868b;
  transition: opacity 300ms ease, transform 300ms ease;
}

.hero-sub {
  font-size: clamp(1.12rem, 1.6vw, 1.35rem);
  color: #a1a1a6;
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
  background: rgba(16, 16, 18, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.14);
  backdrop-filter: blur(20px);
  text-decoration: none;
  transition: background 200ms ease, border-color 200ms ease, transform 200ms ease;
}

.btn-glass:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.24);
  transform: scale(1.02);
}

.hero-mac-line {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 0.85rem;
  color: #86868b;
  scroll-margin-top: 92px;
}

.mac-primary-link {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #d4d4d8;
  font-weight: 500;
  text-decoration: none;
  transition: color 200ms ease;
}

.mac-primary-link:hover {
  color: #ffffff;
}

.mac-divider {
  color: rgba(255, 255, 255, 0.2);
}

.mac-secondary-link {
  color: #86868b;
  text-decoration: none;
  transition: color 200ms ease;
}

.mac-secondary-link:hover {
  color: #d4d4d8;
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
}

@media (prefers-reduced-motion: reduce) {
  .hero-word,
  .btn-white,
  .btn-glass,
  .mac-primary-link,
  .mac-secondary-link {
    transition: none;
  }
}
</style>
