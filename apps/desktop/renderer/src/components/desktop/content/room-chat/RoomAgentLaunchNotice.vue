<template>
  <div class="room-agent-launch-notice" :data-state="view.status" data-testid="room-agent-launch-notice">
    <button type="button" class="room-agent-launch-open" @click="emit('open')" :aria-label="`View ${view.name} in Agents: ${view.line}`">
      <span data-agent-launch-destination><AgentAvatar :avatar="entry.avatar" :name="view.name" :size="30" /></span>
      <span class="room-agent-launch-copy"><strong>{{ view.name }}</strong><span aria-live="polite">{{ view.line }}</span></span>
      <span class="room-agent-launch-link">View in Agents <ArrowUpRight :size="13" /></span>
    </button>
    <button type="button" class="room-agent-launch-dismiss" aria-label="Dismiss agent progress notice" @click="emit('dismiss')"><X :size="14" /></button>
  </div>
</template>
<script setup lang="ts">
import { ArrowUpRight, X } from '@lucide/vue';
import AgentAvatar from '../../../../../../../../shared/ui/agent-identity/AgentAvatar.vue';
import type { DesktopSupervisorManifestEntry } from '../../../../../../electron/ipc-types';
import type { AgentStartupView } from '../../../../domain/agent-startup';
defineProps<{ entry: DesktopSupervisorManifestEntry; view: AgentStartupView }>();
const emit = defineEmits<{ open: []; dismiss: [] }>();
</script>
<style scoped>
.room-agent-launch-notice{display:flex;align-items:center;gap:4px;width:100%;margin:0 0 8px;padding:5px 7px 5px 9px;border:1px solid var(--border);border-radius:15px;background:var(--bg-secondary);color:var(--text)}
.room-agent-launch-open{display:flex;align-items:center;gap:11px;min-width:0;flex:1;padding:3px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}
.room-agent-launch-copy{display:flex;gap:9px;align-items:baseline;min-width:0;font-size:12px;line-height:1.4}
.room-agent-launch-copy strong{font-weight:600;flex:none}.room-agent-launch-copy>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)}
.room-agent-launch-link{display:flex;align-items:center;gap:4px;margin-left:auto;white-space:nowrap;font-size:11px;color:var(--text-secondary)}
.room-agent-launch-dismiss{display:grid;place-items:center;border:0;background:transparent;color:var(--text-tertiary);border-radius:8px;padding:7px;cursor:pointer}
.room-agent-launch-open:hover .room-agent-launch-link{color:var(--text)}.room-agent-launch-dismiss:hover{background:var(--hover)}
.room-agent-launch-open:focus-visible,.room-agent-launch-dismiss:focus-visible{outline:2px solid var(--blue);outline-offset:2px;border-radius:7px}
.room-agent-launch-notice[data-state='failed'] .room-agent-launch-copy>span{color:var(--red-text)}
@media(max-width:600px){.room-agent-launch-copy{display:grid;gap:0}.room-agent-launch-link{font-size:10px}}
</style>
