<template>
  <header class="workspace-nav">
    <RouterLink to="/" class="workspace-brand" aria-label="LetAgents home">
      <img src="/letagents-icon.svg" alt="" width="24" height="24" />
      LetAgents
    </RouterLink>
    <nav aria-label="Workspace">
      <RouterLink to="/my-work">My work</RouterLink>
      <RouterLink to="/messages">Messages</RouterLink>
      <RouterLink to="/connectors">Connectors</RouterLink>
    </nav>
  </header>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<style scoped>
.workspace-nav {
  flex: none;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  min-height: 64px;
  padding: env(safe-area-inset-top, 0px) max(24px, env(safe-area-inset-right, 0px)) 0 max(24px, env(safe-area-inset-left, 0px));
  border-bottom: 1px solid var(--border-strong);
  background: var(--bg);
}
.workspace-brand {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.workspace-nav nav { display: flex; gap: 4px; }
.workspace-nav a {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  min-height: 44px;
  border-radius: 7px;
}
.workspace-nav nav a {
  padding: 8px 12px;
  color: var(--text-secondary);
  font-size: 13px;
  white-space: nowrap;
}
.workspace-nav nav a[aria-current="page"] {
  color: var(--text);
  background: var(--accent-hover);
}
.workspace-nav a:focus-visible { outline: 2px solid var(--blue-text); outline-offset: 2px; }
@media (hover: hover) and (pointer: fine) {
  .workspace-nav nav a:hover { color: var(--text); background: var(--accent-dim); }
}
@media (max-width: 600px) {
  .workspace-nav {
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    padding: env(safe-area-inset-top, 0px) max(12px, env(safe-area-inset-right, 0px)) 8px max(12px, env(safe-area-inset-left, 0px));
  }
  .workspace-brand { align-self: flex-start; }
  .workspace-nav nav { width: 100%; }
  .workspace-nav nav a { flex: 1; padding-inline: 8px; }
}
</style>
