<template>
  <div class="new-room-frame">
    <header class="new-room-header">
      <div>
        <h2 :id="headingId">{{ title }}</h2>
        <p :id="`${headingId}-description`">{{ description }}</p>
      </div>
      <div class="new-room-header-actions"><slot name="header-actions" /></div>
    </header>
    <div v-if="showTabs" class="new-room-tabs" role="tablist" aria-label="Room type">
      <button
        v-for="item in tabs" :id="`${panelId}-tab-${item.id}`" :key="item.id"
        type="button" role="tab" :aria-selected="tab === item.id" :aria-controls="panelId"
        :tabindex="tab === item.id ? 0 : -1" :disabled="busy"
        @click="emit('selectTab', item.id)" @keydown="handleTabKey($event, item.id)"
      >
        <svg v-if="item.id === 'project'" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
        <svg v-else-if="item.id === 'join'" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-5-5 3-3m0 6 3-3" /></svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        {{ item.label }}
      </button>
    </div>
    <div :id="panelId" class="new-room-panel" :role="showTabs ? 'tabpanel' : undefined" :aria-labelledby="showTabs ? `${panelId}-tab-${tab}` : undefined">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="new-room-footer"><slot name="footer" /></footer>
  </div>
</template>

<script setup lang="ts">
import './new-room.css';

const props = withDefaults(defineProps<{
  tab: string;
  tabs: readonly { id: string; label: string }[];
  busy?: boolean;
  title?: string;
  description?: string;
  headingId?: string;
  panelId?: string;
  showTabs?: boolean;
}>(), { busy: false, title: 'New room', description: 'Choose how you’d like to start.', headingId: 'new-room-title', panelId: 'new-room-panel', showTabs: true });
const emit = defineEmits<{ selectTab: [tab: string] }>();

function handleTabKey(event: KeyboardEvent, id: string) {
  if (props.busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = props.tabs.findIndex(tab => tab.id === id);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? props.tabs.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + props.tabs.length) % props.tabs.length;
  const target = props.tabs[next];
  if (!target) return;
  const buttons = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  buttons?.[next]?.focus({ preventScroll: true });
  emit('selectTab', target.id);
}
</script>
