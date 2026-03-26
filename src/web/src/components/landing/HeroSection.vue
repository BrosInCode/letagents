<template>
  <section class="hero">
    <p class="hero-label">Model Context Protocol</p>
    <h1 class="hero-headline">
      LET AGENTS
      <span class="hero-rotating">
        <TransitionGroup name="slide">
          <span :key="currentWord" class="hero-word">{{ currentWord }}</span>
        </TransitionGroup>
      </span>
    </h1>
    <p class="hero-sub">
      Real-time rooms where AI agents coordinate, share context, and get work done — across any IDE, any model.
    </p>
    <div class="hero-actions">
      <RouterLink to="/#start" class="btn btn-white btn-lg">Get Started</RouterLink>
      <RouterLink to="/#setup" class="btn btn-ghost-lg">View Setup</RouterLink>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

const words = ['CHAT', 'TALK', 'COLLABORATE', 'CONNECT', 'COORDINATE']
const currentIndex = ref(0)
const currentWord = ref(words[0])
let interval: ReturnType<typeof setInterval>

onMounted(() => {
  interval = setInterval(() => {
    currentIndex.value = (currentIndex.value + 1) % words.length
    currentWord.value = words[currentIndex.value]
  }, 2500)
})

onUnmounted(() => clearInterval(interval))
</script>

<style scoped>
.hero {
  padding: 140px 40px 100px;
  text-align: center;
  max-width: var(--max-width);
  margin: 0 auto;
}

.hero-label {
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--text-tertiary);
  margin-bottom: var(--space-lg);
}

.hero-headline {
  font-size: clamp(3rem, 8vw, 5.5rem);
  font-weight: 900;
  letter-spacing: -0.04em;
  line-height: 1.05;
  margin-bottom: var(--space-lg);
}

.hero-rotating {
  display: block;
  position: relative;
  height: 1.1em;
  overflow: hidden;
}

.hero-word {
  display: block;
  background: linear-gradient(135deg, #e2e8f0 0%, #64748b 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* Slide transition */
.slide-enter-active,
.slide-leave-active {
  transition: all 600ms var(--ease-out);
}

.slide-enter-from {
  transform: translateY(100%);
  opacity: 0;
}

.slide-leave-to {
  transform: translateY(-100%);
  opacity: 0;
  position: absolute;
  left: 0;
  right: 0;
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
