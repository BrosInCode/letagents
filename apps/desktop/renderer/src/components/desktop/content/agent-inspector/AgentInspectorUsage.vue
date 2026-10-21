<template>
  <section class="agent-inspector-overview-section agent-inspector-usage" aria-labelledby="agent-inspector-usage-title">
    <div class="agent-inspector-section-heading"><p id="agent-inspector-usage-title">Usage</p></div>
    <div v-if="windows.length" class="inspector-usage-windows">
      <div v-for="window in windows" :key="window.id" class="inspector-usage-window" :data-tone="tone(100 - window.usedPercent)">
        <div class="inspector-usage-dial" role="meter" :aria-label="`${window.label} remaining`" :aria-valuenow="remaining(window.usedPercent)" :aria-valuemin="0" :aria-valuemax="100">
          <svg viewBox="0 0 160 132" aria-hidden="true">
            <rect v-for="tick in 40" :key="tick" x="78.5" y="6" width="3" :height="tick % 5 === 0 ? 12 : 9" rx="1"
              :transform="`rotate(${-130 + (tick - 1) * 260 / 39} 80 80)`" :data-filled="tick <= Math.ceil((100 - window.usedPercent) * .4)" />
          </svg>
          <div class="inspector-usage-dial-value"><strong>{{ remaining(window.usedPercent) }}<span>%</span></strong><small>remaining</small></div>
        </div>
        <p class="inspector-usage-window-label">{{ window.label }}</p>
        <p class="inspector-usage-reset">{{ resetLabel(window.resetsAt) }}</p>
      </div>
    </div>
    <p v-else class="agent-inspector-work-empty">{{ loading ? 'Reading account limits…' : 'Account limits are not available from this provider yet.' }}</p>
    <p v-if="windows.length && accountStale" class="inspector-usage-stale">Last reported limits · waiting for an update</p>
    <div class="agent-inspector-context-heading"><span>Context window</span><span>{{ contextLabel }}</span></div>
    <div class="agent-inspector-context-meter" :data-compacting="isCompacting" :data-compacted="usage?.compaction === 'compacted'"
      :role="contextPercent === null ? undefined : 'meter'" :aria-label="contextPercent === null ? undefined : 'Context window used'"
      :aria-valuenow="contextPercent ?? undefined" :aria-valuemin="contextPercent === null ? undefined : 0" :aria-valuemax="contextPercent === null ? undefined : 100" :aria-hidden="contextPercent === null ? true : undefined">
      <span v-for="bar in 48" :key="bar" :data-filled="contextPercent !== null && bar <= Math.ceil(contextPercent * .48)" :style="{ '--bar': bar }"></span>
    </div>
    <div v-if="usage?.context" class="inspector-usage-context-values"><span>{{ tokens(usage.context.usedTokens) }}{{ usage.context.capacityTokens ? ` / ${tokens(usage.context.capacityTokens)}` : '' }} tokens</span><span v-if="contextPercent !== null">{{ 100 - contextPercent }}% free</span></div>
    <p v-if="isCompacting" class="agent-inspector-context-note">Compacting context…</p>
    <p v-else-if="usage?.compaction === 'compacted' && !usage.context" class="inspector-usage-stale">Context compacted · waiting for the next reading</p>
    <p v-else-if="stale && usage?.context" class="inspector-usage-stale">Last reported context</p>
  </section>
</template>

<script setup lang="ts">
import { formatCompactNumber, formatDate } from "../../../../domain/formatters";
import { computed } from "vue";
import type { ProviderUsage } from "../../../../../../shared/provider-usage";
const props = defineProps<{ usage: ProviderUsage | null; loading: boolean; stale: boolean; compacting: boolean }>();
const windows = computed(() => props.usage?.account.windows ?? []);
const isCompacting = computed(() => !props.stale && (props.compacting || props.usage?.compaction === 'compacting'));
const accountStale = computed(() => props.stale || props.usage?.account.state === 'stale'
  || windows.value.some(window => Date.now() - Date.parse(window.observedAt) > 90_000 || (window.resetsAt && Date.parse(window.resetsAt) <= Date.now())));
const contextPercent = computed(() => {
  const context = props.usage?.context;
  return context?.capacityTokens ? Math.min(100, Math.round(context.usedTokens / context.capacityTokens * 100)) : null;
});
const contextLabel = computed(() => isCompacting.value ? 'Compacting' : contextPercent.value !== null ? `${contextPercent.value}% used`
  : props.usage?.context ? 'Capacity not reported' : props.loading ? 'Reading…' : 'Not reported');
function tone(remaining: number): string { return remaining < 10 ? 'red' : remaining < 30 ? 'amber' : remaining < 80 ? 'blue' : 'green'; }
function remaining(used: number): number { return Math.max(0, Math.round((100 - used) * 10) / 10); }
function tokens(value: number): string { return formatCompactNumber(value); }
function resetLabel(value: string | null): string {
  if (!value) return 'Reset not reported';
  const date = new Date(value);
  if (date.getTime() <= Date.now()) return 'Awaiting reset';
  const today = date.toDateString() === new Date().toDateString();
  return `Resets ${formatDate(today ? 'hourMinute' : 'weekdayHourMinute', date)}`;
}
</script>

<style scoped>
.inspector-usage-windows { display: grid; grid-template-columns: repeat(auto-fit, minmax(125px, 1fr)); gap: 16px 24px; }
.inspector-usage-window { --usage-color: var(--green, #4ade80); min-width: 0; text-align: center; }
.inspector-usage-window[data-tone="blue"] { --usage-color: var(--blue, #60a5fa); }
.inspector-usage-window[data-tone="amber"] { --usage-color: var(--amber, #fbbf24); }
.inspector-usage-window[data-tone="red"] { --usage-color: var(--red, #f87171); }
.inspector-usage-dial { position: relative; width: min(100%, 172px); margin: 0 auto; }
.inspector-usage-dial svg { display: block; width: 100%; }
.inspector-usage-dial rect { fill: var(--border-strong); }
.inspector-usage-dial rect[data-filled="true"] { fill: var(--usage-color); }
.inspector-usage-dial-value { position: absolute; inset: 44% 0 auto; display: grid; gap: 5px; }
.inspector-usage-dial-value strong { font-size: 1.65rem; font-weight: 500; letter-spacing: -.04em; line-height: 1; font-variant-numeric: tabular-nums; }
.inspector-usage-dial-value strong span { font-size: .9rem; margin-left: 2px; color: var(--text-secondary); }
.inspector-usage-dial-value small, .inspector-usage-reset, .inspector-usage-context-values, .inspector-usage-stale { color: var(--text-secondary); font-size: .7rem; }
.inspector-usage-window-label { margin: 0 0 5px; font-size: .76rem; }
.inspector-usage-reset { margin: 0; line-height: 1.5; }
.inspector-usage-context-values { display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; font-variant-numeric: tabular-nums; }
.inspector-usage-stale { margin: 10px 0 0; line-height: 1.5; }
.agent-inspector-context-meter span[data-filled="true"] { background: var(--green, #4ade80); }
.agent-inspector-context-meter[data-compacting="true"] span { background: light-dark(#8253b3, #b79ada); }
.agent-inspector-context-meter[data-compacted="true"] span[data-filled="true"] { background: var(--green, #4ade80); }
</style>
