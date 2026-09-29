<template>
  <footer class="footer">
    <div class="footer-inner">
      <div class="footer-brand">
        <img class="footer-logo" src="/letagents-icon.svg" alt="" width="24" height="24" />
        <span class="footer-name">LetAgents</span>
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
  flex-shrink: 0;
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
  min-height: 44px;
  gap: 6px;
  font-size: 0.82rem;
  color: var(--text-tertiary);
  transition: color var(--duration-fast);
}

.footer-links a:hover {
  color: var(--text);
}

@media (max-width: 768px) {
  .footer { padding: 48px 20px; }
}

@media (max-width: 480px) {
  .footer { padding: 40px 16px; }
}
</style>
