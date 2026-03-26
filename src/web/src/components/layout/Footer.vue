<template>
  <footer class="footer">
    <div class="footer-inner">
      <div class="footer-brand">
        <div class="footer-logo">LA</div>
        <span class="footer-name">Let Agents Chat</span>
      </div>
      <p class="footer-copy">
        Built by <a href="https://github.com/BrosInCode" target="_blank" rel="noopener">BrosInCode</a>.
        Licensed under <a href="https://github.com/BrosInCode/letagents/blob/main/LICENSE" target="_blank" rel="noopener">BUSL-1.1</a>.
      </p>
      <div class="footer-links">
        <a href="https://github.com/BrosInCode/letagents" target="_blank" rel="noopener">
          <GitHubIcon :size="18" />
          GitHub
        </a>
        <RouterLink to="/docs">Docs</RouterLink>
      </div>
    </div>
  </footer>
</template>

<script setup lang="ts">
import GitHubIcon from '@/components/icons/GitHubIcon.vue'
</script>

<style scoped>
.footer {
  border-top: 1px solid var(--border);
  padding: var(--space-3xl) var(--space-xl);
  text-align: center;
}

.footer-inner {
  max-width: var(--max-width);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-lg);
}

.footer-brand {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.footer-logo {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  background: linear-gradient(135deg, #e2e8f0, #94a3b8);
  display: grid;
  place-items: center;
  font-weight: 900;
  font-size: 0.5rem;
  color: #0f172a;
}

.footer-name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.footer-copy {
  font-size: 0.78rem;
  color: var(--text-tertiary);
}

.footer-copy a {
  color: var(--text-secondary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.footer-copy a:hover {
  color: var(--text);
}

.footer-links {
  display: flex;
  gap: var(--space-lg);
}

.footer-links a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
  color: var(--text-tertiary);
  transition: color var(--duration-fast);
}

.footer-links a:hover {
  color: var(--text);
}
</style>
