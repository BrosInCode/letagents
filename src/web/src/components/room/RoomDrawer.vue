<template>
  <aside class="drawer open">
    <div class="drawer-brand">
      <div class="drawer-brand-mark">LA</div>
      <div>
        <h1>Let Agents Chat</h1>
        <p>Real-time multi-agent collaboration.</p>
      </div>
    </div>

    <button class="theme-toggle" type="button" @click="$emit('toggleTheme')">
      <span>Theme</span>
      <span class="theme-icon" v-html="themeIcon" />
    </button>

    <!-- Share Card -->
    <div class="drawer-section share-block">
      <div class="drawer-section-title">
        <h2>{{ shareKind === 'url' ? 'Room URL' : 'Invite Code' }}</h2>
        <span>{{ room ? room.displayName : 'No active room' }}</span>
      </div>
      <div class="join-code-display">
        <button class="join-code-copy" type="button" :data-share-kind="shareKind" @click="$emit('copyShare')">
          <span>
            <span class="copy-help">{{ shareKind === 'url' ? 'Share this room URL instantly' : 'Share this room instantly' }}</span>
            <strong>{{ shareDisplayValue || '----' }}</strong>
          </span>
          <span class="copy-pill">Copy</span>
        </button>
      </div>
    </div>

    <!-- Sender Palette -->
    <div class="drawer-section">
      <div class="drawer-section-title">
        <h2>Sender Palette</h2>
        <span>identity</span>
      </div>
      <div class="legend">
        <span
          v-for="owner in visibleOwners"
          :key="owner.label"
          class="legend-chip"
          :style="{ '--chip-color': owner.color }"
          :title="owner.label"
        >
          <span class="legend-chip-label">{{ owner.label }}</span>
        </span>
        <span v-if="overflowCount > 0" class="legend-chip overflow-chip" :title="overflowTitle">
          +{{ overflowCount }} more
        </span>
        <span class="legend-chip" style="--chip-color: var(--sender-default)" title="System messages">
          <span class="legend-chip-label">system</span>
        </span>
      </div>
    </div>

    <!-- Room Notes -->
    <div class="drawer-section">
      <div class="drawer-section-title">
        <h2>Room Notes</h2>
      </div>
      <div class="drawer-actions">
        <button type="button" @click="$emit('toggleSound')">
          <span class="icon-inline" v-html="soundIcon" />
          {{ soundEnabled ? 'Sounds On' : 'Sounds Off' }}
        </button>
        <button type="button" @click="$emit('export')">
          <span class="icon-inline">
            <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </span>
          Export
        </button>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { RoomInfo } from '@/composables/useRoom'

const props = defineProps<{
  room: RoomInfo | null
  theme: string
  soundEnabled: boolean
  ownerLegend: { label: string; color: string }[]
  shareKind: 'code' | 'url'
  shareValue: string
  shareDisplayValue: string
}>()

defineEmits<{
  close: []
  toggleTheme: []
  toggleSound: []
  export: []
  copyShare: []
}>()

const MAX_VISIBLE = 6

const visibleOwners = computed(() => props.ownerLegend.slice(0, MAX_VISIBLE))
const overflowCount = computed(() => Math.max(0, props.ownerLegend.length - MAX_VISIBLE))
const overflowTitle = computed(() =>
  props.ownerLegend.slice(MAX_VISIBLE).map(o => o.label).join(', ')
)

const themeIcon = computed(() =>
  props.theme === 'light'
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
)

const soundIcon = computed(() =>
  props.soundEnabled
    ? '<svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
)
</script>

<style scoped>
.drawer {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 100;
  width: 320px;
  max-width: 85vw;
  background: var(--bg-1);
  border-right: 1px solid var(--line);
  padding: 24px 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  transform: translateX(-100%);
  transition: transform 260ms cubic-bezier(.4, 0, .2, 1);
  overflow-y: auto;
}
.drawer.open { transform: translateX(0); }

.drawer-brand { display: flex; align-items: center; gap: 12px; }
.drawer-brand-mark {
  width: 36px; height: 36px; border-radius: 10px;
  background: var(--text); color: var(--bg-0);
  display: grid; place-items: center;
  font-weight: 800; font-size: 0.75rem; letter-spacing: 0.06em;
}
.drawer-brand h1 { font-size: 0.92rem; font-weight: 700; letter-spacing: -0.02em; }
.drawer-brand p { margin-top: 2px; color: var(--muted); font-size: 0.78rem; }

.drawer-section { display: flex; flex-direction: column; gap: 8px; }
.drawer-section-title {
  display: flex; align-items: center; justify-content: space-between;
}
.drawer-section-title h2 {
  font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted);
}
.drawer-section-title span { font-size: 0.72rem; color: var(--muted); }

.theme-toggle {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-radius: 8px;
  background: var(--surface); border: 1px solid var(--line);
  font-size: 0.82rem; font-weight: 500; color: var(--text);
  cursor: pointer; transition: background 150ms;
}
.theme-toggle:hover { background: var(--surface-hover); }
.theme-icon { display: flex; align-items: center; }

.icon-inline {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; flex-shrink: 0;
}
.icon-inline :deep(svg) {
  width: 16px; height: 16px; fill: none;
  stroke: currentColor; stroke-width: 2;
  stroke-linecap: round; stroke-linejoin: round;
}

.share-block {
  padding: 12px; border-radius: 10px;
  background: var(--surface); border: 1px solid var(--line);
}
.join-code-display { display: flex; align-items: center; gap: 8px; }
.join-code-copy {
  width: 100%; display: flex; align-items: center;
  justify-content: space-between; gap: 8px;
  background: none; border: none; color: var(--text); cursor: pointer; padding: 0;
}
.join-code-copy strong { font-size: 1.1rem; font-weight: 700; letter-spacing: 0.12em; }
.join-code-copy[data-share-kind="url"] strong {
  font-size: 0.76rem; letter-spacing: 0; font-weight: 500;
  color: var(--muted); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
}
.copy-pill {
  flex-shrink: 0; padding: 5px 12px; border-radius: 6px;
  background: var(--bg-2); font-size: 0.72rem; font-weight: 600;
  transition: background 150ms;
}
.join-code-copy:hover .copy-pill { background: var(--surface-hover); }
.copy-help { font-size: 0.72rem; color: var(--muted); margin-top: 6px; display: block; }

.legend { display: flex; flex-wrap: wrap; gap: 4px; }
.legend-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 6px; border-radius: 4px;
  background: var(--surface); font-size: 0.65rem; color: var(--muted);
  max-width: 120px; cursor: default;
}
.legend-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.legend-chip::before {
  content: ''; width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0;
  background: var(--chip-color, var(--sender-default));
}
.legend-chip.overflow-chip {
  background: var(--line); color: var(--text); font-weight: 600; max-width: none;
}
.legend-chip.overflow-chip::before { display: none; }

.drawer-actions { display: flex; gap: 6px; }
.drawer-actions button {
  flex: 1; display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; border-radius: 8px;
  background: var(--surface); border: 1px solid var(--line);
  font-size: 0.78rem; font-weight: 600; color: var(--text);
  cursor: pointer; transition: background 150ms;
}
.drawer-actions button:hover { background: var(--surface-hover); }
</style>
