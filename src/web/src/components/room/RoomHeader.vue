<template>
  <header class="chat-header">
    <button class="menu-btn" @click="$emit('toggleDrawer')" type="button" aria-label="Open menu">
      <svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>

    <div class="chat-title">
      <h2>{{ title }}</h2>
      <p>{{ subtitle }}</p>
    </div>

    <div class="header-actions">
      <div class="tab-bar" role="tablist">
        <button
          role="tab"
          :aria-selected="activeTab === 'chat'"
          @click="$emit('update:activeTab', 'chat')"
          type="button"
        >Chat</button>
        <button
          role="tab"
          :aria-selected="activeTab === 'board'"
          @click="$emit('update:activeTab', 'board')"
          type="button"
        >Board</button>
      </div>

      <div class="presence" :data-state="connectionState">
        {{ presenceLabel }}
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  title: string
  subtitle: string
  activeTab: 'chat' | 'board'
  connectionState: 'idle' | 'connecting' | 'live' | 'error'
}>()

defineEmits<{
  toggleDrawer: []
  'update:activeTab': [tab: 'chat' | 'board']
}>()

const presenceLabel = computed(() => {
  switch (props.connectionState) {
    case 'live': return 'Connected'
    case 'connecting': return 'Connecting…'
    case 'error': return 'Reconnecting…'
    default: return 'Waiting for room'
  }
})
</script>

<style scoped>
.chat-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 22px 16px;
  min-height: 84px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 72%),
    rgba(28, 28, 30, 0.76);
  backdrop-filter: blur(20px);
}

.menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: background 150ms, border-color 150ms, transform 150ms;
}
.menu-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.12);
  transform: translateY(-1px);
}
.menu-btn svg {
  width: 18px;
  height: 18px;
  stroke: var(--text, #fafafa);
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
}

.chat-title { flex: 1; min-width: 0; }
.chat-title h2 {
  font-size: 1rem;
  font-weight: 720;
  letter-spacing: -0.03em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat-title p {
  margin-top: 3px;
  font-size: 0.74rem;
  color: rgba(255, 255, 255, 0.52);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tab-bar {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}
.tab-bar button {
  padding: 8px 16px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.48);
  background: none;
  border: none;
  cursor: pointer;
  transition: all 150ms ease;
}
.tab-bar button[aria-selected="true"] {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text, #fafafa);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 8px 22px rgba(0, 0, 0, 0.22);
}
.tab-bar button:hover:not([aria-selected="true"]) {
  color: rgba(255, 255, 255, 0.82);
}

.presence {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 999px;
  font-size: 0.7rem;
  color: rgba(255, 255, 255, 0.58);
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.presence::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warning, #fbbf24);
  transition: background 150ms;
}
.presence[data-state="live"]::before { background: var(--success, #34d399); }
.presence[data-state="error"]::before { background: var(--danger, #f87171); }

@media (max-width: 900px) {
  .chat-header {
    flex-wrap: wrap;
    align-items: stretch;
    gap: 14px;
    padding: 16px;
  }

  .header-actions {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
