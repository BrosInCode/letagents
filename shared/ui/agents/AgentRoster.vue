<template>
  <div class="agents-roster">
    <div class="agents-tools">
      <div class="agents-filters" aria-label="Filter agents">
        <button
          v-for="option in filters"
          :key="option.id"
          type="button"
          :aria-pressed="filter === option.id"
          @click="filter = option.id"
        >
          {{ option.label }} <span>{{ option.count }}</span>
        </button>
      </div>
      <input
        v-model="query"
        class="agents-search"
        type="search"
        aria-label="Search agents"
        placeholder="Find an agent…"
      />
    </div>
    <div class="agents-columns" aria-hidden="true">
      <span>Agent</span><span>Owner</span><span>Now</span><span />
    </div>
    <div
      v-for="row in visible"
      :key="row.id"
      class="agents-row-wrap"
      :data-attention="row.attention"
    >
      <button
        class="agents-row"
        type="button"
        @click="emit('select', row.id, $event)"
      >
        <span class="agents-identity"
          ><span class="agents-provider"
            ><slot name="provider" :row="row">{{
              row.name.slice(0, 1)
            }}</slot></span
          ><span class="agents-copy"
            ><strong>{{ row.name }}</strong
            ><small>{{
              [agentProviderLabel(row.provider), row.model]
                .filter(Boolean)
                .join(" · ")
            }}</small></span
          ></span
        >
        <span class="agents-owner">{{ row.owner || "—" }}</span>
        <span class="agents-now"
          ><span class="agents-state" :data-tone="row.tone"
            ><i /><span>{{ row.state }}</span
            ><svg
              v-if="row.moving"
              class="agents-trace"
              viewBox="0 0 44 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M0 8h9l3-5 5 10 4-7 3 2h20"
                stroke="currentColor"
                stroke-linejoin="round"
              /></svg></span
          ><span class="agents-work"
            ><slot name="detail" :row="row">{{ row.detail }}</slot></span
          ><slot name="badges" :row="row"
        /></span>
        <svg
          class="agents-chevron"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m6 4 4 4-4 4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <slot name="action" :row="row" />
    </div>
    <div v-if="!visible.length" class="agents-empty">
      <h3>{{ rows.length ? "No matching agents" : "No agents here yet" }}</h3>
      <p>
        {{
          rows.length
            ? "Try another name or filter."
            : "Agents appear here when they connect to this room."
        }}
      </p>
      <button
        v-if="query || filter !== 'all'"
        class="agents-quiet"
        type="button"
        @click="
          query = '';
          filter = 'all';
        "
      >
        Clear filters</button
      ><slot v-else name="empty" />
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, ref } from "vue";
import { agentProviderLabel, type AgentRosterRow } from "./types";
const props = defineProps<{ rows: readonly AgentRosterRow[] }>();
const emit = defineEmits<{ select: [id: string, event: MouseEvent] }>();
const filter = ref("all");
const query = ref("");
const filters = computed(() => [
  { id: "all", label: "All", count: props.rows.length },
  {
    id: "working",
    label: "Working",
    count: props.rows.filter((row) => row.working).length,
  },
  {
    id: "attention",
    label: "Needs attention",
    count: props.rows.filter((row) => row.attention).length,
  },
]);
const visible = computed(() =>
  props.rows
    .filter(
      (row) =>
        (filter.value === "all" ||
          (filter.value === "working" ? row.working : row.attention)) &&
        [row.name, agentProviderLabel(row.provider), row.model, row.owner]
          .join(" ")
          .toLowerCase()
          .includes(query.value.trim().toLowerCase()),
    )
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
);
</script>
<style src="./agents.css"></style>
