<template>
  <span class="task-person-chip">
    <span class="task-person-copy">
      <span class="task-person-role">{{ role }}</span>
      <span class="task-person-name">{{ identity.displayName }}</span>
      <span v-if="identity.ownerAttribution" class="task-person-subtitle">
        {{ identity.ownerAttribution }}
      </span>
    </span>
    <span v-if="identity.ideLabel" class="agent-runtime-badge compact" :class="ideBadgeClass">
      <span class="ide-icon-wrap" v-html="ideBadgeIcon" />
      {{ identity.ideLabel }}
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { parseAgentIdentity } from '@/composables/useRoom'

const props = defineProps<{
  label: string
  role: string
}>()

const identity = computed(() => parseAgentIdentity(props.label))

const IDE_ICONS: Record<string, string> = {
  codex: '<svg class="ide-icon" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  antigravity: '<svg class="ide-icon" viewBox="0 0 24 24"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/></svg>',
  claude: '<svg class="ide-icon" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
  cursor: '<svg class="ide-icon" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
}

const ideBadgeClass = computed(() => {
  const ide = (identity.value.ideLabel || '').toLowerCase()
  const known = ['codex', 'antigravity', 'claude', 'cursor']
  return known.includes(ide) ? `ide-${ide}` : 'ide-default'
})

const ideBadgeIcon = computed(() => {
  const ide = (identity.value.ideLabel || '').toLowerCase()
  return IDE_ICONS[ide] || '<svg class="ide-icon" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
})
</script>

<style scoped>
.task-person-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 6px; border-radius: 6px;
  background: var(--surface); border: 1px solid var(--line);
}
.task-person-copy { display: flex; flex-direction: column; gap: 0; }
.task-person-role {
  font-size: 0.58rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.04em; color: var(--muted);
}
.task-person-name { font-size: 0.72rem; font-weight: 700; color: var(--text); }
.task-person-subtitle { font-size: 0.62rem; color: var(--muted); }

.agent-runtime-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 4px;
  font-size: 0.58rem; font-weight: 700; letter-spacing: 0.02em;
  white-space: nowrap;
}
.agent-runtime-badge.compact { font-size: 0.58rem; }
.ide-icon-wrap { display: inline-flex; align-items: center; }
.ide-icon-wrap :deep(.ide-icon) {
  width: 10px; height: 10px; fill: none;
  stroke: currentColor; stroke-width: 2;
  stroke-linecap: round; stroke-linejoin: round;
}
.agent-runtime-badge.ide-codex { background: rgba(34,197,94,0.08); color: #22c55e; }
.agent-runtime-badge.ide-antigravity { background: rgba(96,165,250,0.08); color: #60a5fa; }
.agent-runtime-badge.ide-claude { background: rgba(251,146,60,0.08); color: #fb923c; }
.agent-runtime-badge.ide-cursor { background: rgba(168,85,247,0.08); color: #a855f7; }
.agent-runtime-badge.ide-default { background: var(--surface); color: var(--muted); }
</style>
