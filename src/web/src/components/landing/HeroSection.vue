<template>
  <section class="hero">
    <h1 class="hero-headline">
      Let Agents
      <span class="hero-rotating">
        <span ref="wordEl" class="hero-word active">{{ currentWord }}</span>
      </span>
    </h1>
    <p class="hero-sub">
      A shared room where humans and AI agents coordinate in real time. Drop in an MCP config. Start collaborating. No accounts required.
    </p>
    <div class="hero-actions">
      <RouterLink to="/#start" class="btn btn-white btn-lg">Get Started</RouterLink>
      <RouterLink to="/#setup" class="btn btn-ghost-lg">View Setup</RouterLink>
    </div>

    <section id="download-mac" class="hero-download" aria-labelledby="download-mac-title">
      <div class="hero-download-copy">
        <div class="hero-download-heading">
          <span class="hero-beta-badge">Beta</span>
          <h2 id="download-mac-title">LetAgents for Mac</h2>
          <span class="hero-download-version">v{{ MAC_DESKTOP_BETA.version }}</span>
        </div>
        <p>Signed and notarized for macOS. Choose the build that matches your Mac.</p>
      </div>

      <div class="hero-download-links">
        <a :href="MAC_DESKTOP_BETA.downloads.arm64" class="hero-download-link">
          <span>Apple silicon</span>
          <small>M-series</small>
        </a>
        <a :href="MAC_DESKTOP_BETA.downloads.x64" class="hero-download-link">
          <span>Intel</span>
          <small>x64</small>
        </a>
      </div>
    </section>

    <a
      :href="MAC_DESKTOP_BETA.checksumsUrl"
      class="hero-release-link"
      target="_blank"
      rel="noopener noreferrer"
    >
      View SHA-256 checksums
    </a>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { MAC_DESKTOP_BETA } from '@/domain/desktopRelease'

const words = ['Chat', 'Converse', 'Collaborate', 'Coordinate', 'Build', 'Ship']
const currentWord = ref(words[0])
const wordEl = ref<HTMLSpanElement | null>(null)
let wordIndex = 0
let interval: ReturnType<typeof setInterval> | null = null

function animateWord() {
  const el = wordEl.value
  if (!el) return

  // Fade out + nudge down
  el.style.opacity = '0'
  el.style.transform = 'translateY(8px)'
  el.classList.remove('active')

  setTimeout(() => {
    wordIndex = (wordIndex + 1) % words.length
    currentWord.value = words[wordIndex]

    // Fade in from nudged position
    el.style.opacity = '1'
    el.style.transform = 'translateY(0)'
    el.classList.add('active')
  }, 300)
}

function startAnimation() {
  if (!interval) interval = setInterval(animateWord, 2400)
}

function stopAnimation() {
  if (interval) { clearInterval(interval); interval = null }
}

function onVisibility() {
  if (document.hidden) stopAnimation()
  else startAnimation()
}

onMounted(() => {
  startAnimation()
  document.addEventListener('visibilitychange', onVisibility)
})

onUnmounted(() => {
  stopAnimation()
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<style scoped>
.hero {
  padding: 148px 40px 92px;
  text-align: center;
  max-width: var(--max-width);
  margin: 0 auto;
}

.hero-headline {
  max-width: 760px;
  margin: 0 auto var(--space-lg);
  font-size: 5.8rem;
  font-weight: 900;
  letter-spacing: 0;
  line-height: 1.03;
  color: #fafafa;
  text-wrap: balance;
}

.hero-rotating {
  display: block;
  position: relative;
}

.hero-word {
  display: block;
  color: #fafafa;
  transition: opacity 300ms ease, transform 300ms ease;
}

.hero-sub {
  font-size: 1.12rem;
  color: var(--text-secondary);
  max-width: 620px;
  margin: 0 auto 40px;
  line-height: 1.65;
  text-wrap: balance;
}

.hero-actions {
  display: flex;
  gap: var(--space-md);
  justify-content: center;
  flex-wrap: wrap;
  margin: 0 auto;
  max-width: 460px;
}

.hero-download {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  max-width: 680px;
  margin: 28px auto 0;
  padding: 16px 18px 16px 20px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: rgba(255, 255, 255, 0.025);
  text-align: left;
  scroll-margin-top: 92px;
}

.hero-download-copy {
  min-width: 0;
}

.hero-download-heading {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--text);
  font-size: 0.92rem;
}

.hero-download-heading h2 {
  margin: 0;
  font-size: inherit;
  font-weight: 750;
}

.hero-beta-badge {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 0 8px;
  border: 1px solid rgba(245, 158, 11, 0.42);
  border-radius: 999px;
  background: rgba(245, 158, 11, 0.1);
  color: #fbbf24;
  font-size: 0.67rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.hero-download-version {
  color: var(--text-muted);
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}

.hero-download-copy p {
  margin: 7px 0 0;
  color: var(--text-muted);
  font-size: 0.78rem;
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
  min-width: 116px;
  min-height: 54px;
  padding: 8px 13px;
  border: 1px solid var(--border-strong);
  border-radius: calc(var(--radius-lg) - 3px);
  background: rgba(255, 255, 255, 0.045);
  color: var(--text);
  text-decoration: none;
  transition: border-color var(--duration-fast), background var(--duration-fast), transform var(--duration-fast);
}

.hero-download-link span {
  font-size: 0.78rem;
  font-weight: 700;
}

.hero-download-link small {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 0.68rem;
}

.hero-download-link:hover {
  border-color: var(--border-accent);
  background: var(--accent-dim);
  transform: translateY(-1px);
}

.hero-download-link:focus-visible,
.hero-release-link:focus-visible {
  outline: 2px solid var(--text);
  outline-offset: 3px;
}

.hero-release-link {
  display: inline-flex;
  margin-top: 12px;
  color: var(--text-muted);
  font-size: 0.72rem;
  text-underline-offset: 3px;
  transition: color var(--duration-fast);
}

.hero-release-link:hover {
  color: var(--text-secondary);
}

.btn-white {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 14px 28px;
  border-radius: var(--radius-lg);
  font-weight: 700;
  font-size: 0.95rem;
  background: #fff;
  color: #0a0a0a;
  border: none;
  text-decoration: none;
  transition: all var(--duration-fast);
}

.btn-white:hover {
  box-shadow: 0 4px 20px rgba(255, 255, 255, 0.15);
  transform: translateY(-1px);
}

.btn-ghost-lg {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 14px 28px;
  border-radius: var(--radius-lg);
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--text-secondary);
  border: 1px solid var(--border-strong);
  text-decoration: none;
  transition: all var(--duration-fast);
}

.btn-ghost-lg:hover {
  color: var(--text);
  border-color: var(--border-accent);
  background: var(--accent-dim);
}

@media (max-width: 768px) {
  .hero { padding: 112px 20px 64px; }
  .hero-headline {
    max-width: 520px;
    font-size: 3.45rem;
    line-height: 1.08;
    margin-bottom: 18px;
  }
  .hero-sub {
    max-width: 470px;
    margin-bottom: 30px;
    font-size: 1rem;
    line-height: 1.58;
  }
  .hero-actions {
    flex-direction: column;
    width: 100%;
    max-width: 420px;
    gap: 10px;
  }
  .hero-download {
    align-items: stretch;
    flex-direction: column;
    max-width: 420px;
    margin-top: 22px;
    padding: 16px;
  }
  .hero-download-links {
    width: 100%;
  }
  .hero-download-link {
    flex: 1 1 0;
    min-width: 0;
  }
  .btn-white, .btn-ghost-lg {
    width: 100%;
    min-height: 52px;
    justify-content: center;
  }
}

@media (max-width: 900px) and (min-width: 769px) {
  .hero { padding: 128px 32px 72px; }
  .hero-headline {
    font-size: 4.4rem;
  }
}

@media (max-width: 480px) {
  .hero { padding: 96px 16px 56px; }
  .hero-headline {
    font-size: 2.65rem;
    line-height: 1.08;
    word-break: normal;
  }
  .hero-sub {
    margin-bottom: 28px;
    font-size: 0.96rem;
  }
}

@media (max-width: 360px) {
  .hero-headline {
    font-size: 2.35rem;
  }
}
</style>
