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
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

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
  padding: 140px 40px 100px;
  text-align: center;
  max-width: var(--max-width);
  margin: 0 auto;
}

.hero-headline {
  font-size: clamp(3rem, 8vw, 6.5rem);
  font-weight: 900;
  letter-spacing: -0.04em;
  line-height: 1.05;
  margin-bottom: var(--space-lg);
  color: #fafafa;
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
  font-size: 1.2rem;
  color: var(--text-secondary);
  max-width: 580px;
  margin: 0 auto var(--space-2xl);
  line-height: 1.7;
}

.hero-actions {
  display: flex;
  gap: var(--space-md);
  justify-content: center;
  flex-wrap: wrap;
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
  .hero { padding: 120px 20px 80px; }
  .hero-actions { flex-direction: column; width: 100%; }
  .btn-white, .btn-ghost-lg { width: 100%; justify-content: center; }
}

@media (max-width: 480px) {
  .hero { padding: 112px 16px 72px; }
  .hero-headline { word-break: break-word; }
  .hero-sub { font-size: 1rem; margin-bottom: 36px; }
}
</style>
