<template>
  <section class="hero">
    <SymbiosisCanvas :theme="theme" />

    <div class="hero-content">
      <h1 class="hero-headline">
        Let Humans and Agents
        <span class="sr-only">Build together.</span>
        <span class="hero-rotating" aria-hidden="true">
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

      <div id="download-mac" class="hero-mac-line" role="group" aria-label="Download the desktop app">
        <a class="mac-primary-link" :href="downloadOffer.primary.href">
          <DesktopPlatformIcon :icon="downloadOffer.primary.icon" />
          <span>{{ downloadOffer.primary.label }}</span>
        </a>
        <template v-for="link in downloadOffer.others" :key="link.href">
          <span class="mac-divider" aria-hidden="true">·</span>
          <a class="mac-secondary-link" :href="link.href">
            <DesktopPlatformIcon :icon="link.icon" />
            <span>{{ link.label }}</span>
          </a>
        </template>
        <a class="mac-secondary-link" :href="macDesktopBeta.checksumsUrl">Checksums</a>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, onMounted, onUnmounted } from 'vue'
import DesktopPlatformIcon from './DesktopPlatformIcon.vue'
import {
  desktopDownloadOffer,
  detectDesktopVisitorPlatform,
  fetchCurrentMacDesktopBeta,
  MAC_DESKTOP_BETA,
} from '@/domain/desktopRelease'

withDefaults(defineProps<{ theme?: 'light' | 'dark' }>(), { theme: 'dark' })

// Decorative content may fail to load; the heading and actions remain available.
const SymbiosisCanvas = defineAsyncComponent({
  loader: () => import('./SymbiosisCanvas.vue'),
  errorComponent: { render: () => null },
})

const words = ['Talk.', 'Think.', 'Create.', 'Share.', 'Build.', 'Ship.']
const currentWord = ref(words[0])
const macDesktopBeta = ref(MAC_DESKTOP_BETA)
const visitorPlatform = detectDesktopVisitorPlatform(typeof navigator === 'undefined' ? undefined : navigator)
const downloadOffer = computed(() => desktopDownloadOffer(macDesktopBeta.value, visitorPlatform))
const wordEl = ref<HTMLSpanElement | null>(null)

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
  min-height: 92svh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(156px + env(safe-area-inset-top, 0px)) max(32px, env(safe-area-inset-right, 0px)) 96px max(32px, env(safe-area-inset-left, 0px));
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
  color: var(--l-text);
  margin: 0 auto 24px;
  text-wrap: balance;
}

.hero-rotating {
  display: block;
}

.hero-word {
  display: inline-block;
  color: var(--l-text-dim);
  transition: opacity 300ms ease, transform 300ms ease, color 380ms ease;
}

.hero-sub {
  font-size: clamp(1.12rem, 1.6vw, 1.35rem);
  color: var(--l-text-sub);
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
  background: var(--l-cta-bg);
  color: var(--l-cta-fg);
  text-decoration: none;
  transition: transform 200ms ease, background 200ms ease, color 200ms ease, box-shadow 200ms ease;
}

@media (hover: hover) and (pointer: fine) {
.btn-white:hover {
  background: var(--l-cta-hover-bg);
  transform: scale(1.02);
  box-shadow: var(--l-cta-shadow);
}
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
  color: var(--l-text);
  background: var(--l-glass-bg-elevated);
  border: 1px solid var(--l-glass-border);
  backdrop-filter: blur(20px) saturate(150%);
  -webkit-backdrop-filter: blur(20px) saturate(150%);
  box-shadow: var(--l-glass-pill-shadow);
  text-decoration: none;
  transition: background 200ms ease, border-color 200ms ease, color 200ms ease, transform 200ms ease;
}

@media (hover: hover) and (pointer: fine) {
.btn-glass:hover {
  background: var(--l-glass-bg-hover);
  border-color: var(--l-glass-border-strong);
  transform: scale(1.02);
}
}

.hero-mac-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0 12px;
  font-size: 0.85rem;
  color: var(--l-text-dim);
  scroll-margin-top: calc(92px + env(safe-area-inset-top, 0px));
}

.mac-primary-link,
.mac-secondary-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 4px 2px;
  touch-action: manipulation;
}

.mac-primary-link {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--l-text-sub);
  font-weight: 500;
  text-decoration: none;
  transition: color 200ms ease;
}

@media (hover: hover) and (pointer: fine) {
.mac-primary-link:hover {
  color: var(--l-text);
}
}

.mac-divider {
  color: var(--l-hairline);
}

.mac-secondary-link {
  gap: 7px;
  color: var(--l-text-dim);
  text-decoration: none;
  transition: color 200ms ease;
}

@media (hover: hover) and (pointer: fine) {
.mac-secondary-link:hover {
  color: var(--l-text);
}
}

@media (max-width: 768px) {
  .hero {
    padding: calc(112px + env(safe-area-inset-top, 0px)) max(20px, env(safe-area-inset-right, 0px)) 64px max(20px, env(safe-area-inset-left, 0px));
    min-height: auto;
  }

  .hero-headline { font-size: clamp(2.5rem, 11vw, 3.2rem); margin-bottom: 20px; }
  .hero-sub { font-size: 1.05rem; max-width: 340px; margin-bottom: 28px; }
  .btn-glass { backdrop-filter: none; -webkit-backdrop-filter: none; }

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
