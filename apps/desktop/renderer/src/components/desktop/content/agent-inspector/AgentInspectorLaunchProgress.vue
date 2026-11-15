<template>
  <section v-if="visible && view" class="agent-inspector-launch" data-testid="agent-inspector-launch-progress" aria-label="Adding agent progress">
    <div class="agent-inspector-launch-heading"><strong>Adding {{ view.name }}</strong><span :data-state="view.status" aria-live="polite">{{ view.line }}</span></div>
    <ol>
      <li v-for="stage in view.stages" :key="stage.key" :data-state="stage.state">
        <span class="agent-inspector-launch-mark" aria-hidden="true"><Check v-if="stage.state === 'done'" :size="12" /><X v-else-if="stage.state === 'failed'" :size="12" /><i v-else /></span>
        <span>{{ stage.label }}<span class="agent-inspector-live-region">{{ stage.state === 'done' ? ' complete' : stage.state === 'now' ? ' in progress' : stage.state === 'failed' ? ' failed' : ' pending' }}</span></span>
        <time>{{ stage.ms == null ? '' : formatStartupElapsed(stage.ms) }}</time>
      </li>
    </ol>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { Check, X } from '@lucide/vue';
import type { DesktopSupervisorManifestEntry } from '../../../../../../electron/ipc-types';
import { agentStartupView, formatStartupElapsed } from '../../../../domain/agent-startup';
import { useNow } from '../../../../composables/useNow';
const props = defineProps<{ entry: DesktopSupervisorManifestEntry; roomLabel: string }>();
const now = useNow(1_000, () => !props.entry.readyReachedAt && view.value?.status === 'running');
// Inspector hydration can expose an incomplete row before its details arrive.
const view = computed(() => typeof props.entry.displayName === 'string' && typeof props.entry.provider === 'string'
  ? agentStartupView(props.entry, { roomLabel: props.roomLabel }, now.value) : null);
const visible = computed(() => !props.entry.readyReachedAt && view.value && view.value.status !== 'cancelled' && view.value.status !== 'joined');
</script>
<style scoped>
.agent-inspector-launch{margin:0 0 20px;padding:16px;border-radius:16px;background:var(--bg-secondary);border:1px solid var(--border)}
.agent-inspector-launch-heading{display:grid;gap:4px;font-size:12px;line-height:1.5}.agent-inspector-launch-heading strong{font-weight:600;color:var(--text)}.agent-inspector-launch-heading>span{color:var(--text-secondary)}.agent-inspector-launch-heading>span[data-state=failed]{color:var(--red-text)}
.agent-inspector-launch ol{display:grid;gap:11px;list-style:none;margin:16px 0 0;padding:0}.agent-inspector-launch li{display:flex;align-items:center;gap:9px;color:var(--text-tertiary);font-size:11px;line-height:1.5}
.agent-inspector-launch li[data-state=now],.agent-inspector-launch li[data-state=done]{color:var(--text-secondary)}.agent-inspector-launch li[data-state=failed]{color:var(--red-text)}
.agent-inspector-launch-mark{display:grid;place-items:center;width:16px;height:16px;flex:none}.agent-inspector-launch-mark i{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.35}.agent-inspector-launch li[data-state=now] i{opacity:1;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 12%,transparent);animation:agent-launch-pulse 1.5s ease-in-out infinite}
.agent-inspector-launch time{margin-left:auto;font-variant-numeric:tabular-nums}
@keyframes agent-launch-pulse{50%{opacity:.4}}
@media(prefers-reduced-motion:reduce){.agent-inspector-launch li[data-state=now] i{animation:none}}
</style>
