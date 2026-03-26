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
  padding: 0 20px;
  height: 56px;
  border-bottom: 1px solid var(--line, #27272a);
  background: var(--bg-0, #09090b);
}

.menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: none;
  border: none;
  cursor: pointer;
  transition: background 150ms;
}
.menu-btn:hover { background: var(--surface, #18181b); }
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
  font-size: 0.92rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat-title p {
  font-size: 0.72rem;
  color: var(--muted, #71717a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-actions { display: flex; align-items: center; gap: 4px; }

.tab-bar {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 8px;
  background: var(--surface, #18181b);
}
.tab-bar button {
  padding: 5px 14px;
  border-radius: 6px;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--muted, #71717a);
  background: none;
  border: none;
  cursor: pointer;
  transition: all 150ms;
}
.tab-bar button[aria-selected="true"] {
  background: var(--bg-0, #09090b);
  color: var(--text, #fafafa);
}
.tab-bar button:hover:not([aria-selected="true"]) { color: var(--text, #fafafa); }

.presence {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 0.72rem;
  color: var(--muted, #71717a);
  white-space: nowrap;
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
</style>
