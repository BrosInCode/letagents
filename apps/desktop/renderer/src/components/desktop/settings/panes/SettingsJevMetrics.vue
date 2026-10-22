<template>
  <section v-if="metrics && (metrics.enabled_connections > 0 || total > 0)" class="service-health-section jev-metrics" aria-labelledby="jev-metrics-title" data-testid="settings-jev-metrics">
    <div class="service-health-heading">
      <h2 id="jev-metrics-title">Jev for ticket trackers</h2>
      <span class="settings-muted-note">Last 7 days</span>
    </div>
    <p class="settings-muted-note">
      Questions LetAgents asked Jev for your tracker connections. Jev only suggests; a person approves every ticket change.
    </p>
    <p v-if="!metrics.available" class="settings-muted-note" role="status" data-testid="settings-jev-metrics-unavailable">
      Jev is not available on this server, so no question is asked.
    </p>
    <table class="jev-metrics-table">
      <thead><tr><th scope="col">Question</th><th scope="col">Asked</th><th scope="col">Average</th><th scope="col">95th percentile</th><th scope="col">Outcomes</th></tr></thead>
      <tbody>
        <tr v-for="kind in metrics.kinds" :key="kind.kind" :data-testid="`settings-jev-metrics-${kind.kind}`">
          <th scope="row">{{ kindLabel(kind.kind) }}</th>
          <td>{{ kind.count }}</td>
          <td>{{ latency(kind.latency_ms_avg) }}</td>
          <td>{{ latency(kind.latency_ms_p95) }}</td>
          <td>{{ outcomes(kind.outcomes) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";
import type { JevQuestionKind, TrackerJevMetrics } from "../../../../../../../../shared/ticket-connectors.mjs";

const metrics = shallowRef<TrackerJevMetrics | null>(null);
const total = computed(() => metrics.value?.kinds.reduce((sum, kind) => sum + kind.count, 0) ?? 0);

const KIND_LABELS: Record<JevQuestionKind, string> = {
  link: "Link a pull request",
  exception: "Closed without a merge",
  needs_me: "Who a card waits on",
  rule_draft: "Rule drafts",
};

function kindLabel(kind: JevQuestionKind): string {
  return KIND_LABELS[kind] ?? kind;
}

function latency(value: number | null): string {
  return value === null ? "—" : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
}

function outcomes(values: Record<string, number>): string {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([outcome, count]) => `${outcome.replaceAll("_", " ")} ${count}`).join(", ") : "—";
}

onMounted(async () => {
  // Read once when the pane opens. An older main process or a signed-out app shows nothing.
  try {
    const read = window.letagentsDesktop?.connectors?.jevMetrics;
    if (read) metrics.value = await read();
  } catch {
    metrics.value = null;
  }
});
</script>

<style scoped>
.jev-metrics-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; border: 1px solid var(--border); border-radius: 8px; }
.jev-metrics-table th, .jev-metrics-table td { padding: 10px 12px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.jev-metrics-table thead th { color: var(--text-tertiary); font-weight: 500; font-size: 0.75rem; }
.jev-metrics-table tbody tr { border-top: 1px solid var(--border); }
.jev-metrics-table td { font-variant-numeric: tabular-nums; }
</style>
