<template>
  <section class="settings-connectors-overview" data-testid="settings-connectors-overview" aria-labelledby="settings-connectors-overview-title">
    <div class="settings-connectors-overview-head">
      <div>
        <p id="settings-connectors-overview-title" class="settings-control-title">Your connectors</p>
        <p class="settings-control-description">Trackers bring tickets to your boards. Agent apps and remote sign-ins bring LetAgents to your agents.</p>
      </div>
      <button
        class="primary-button"
        type="button"
        data-testid="settings-connectors-add"
        :aria-expanded="catalogOpen"
        aria-controls="settings-connectors-catalog"
        @click="catalogOpen = !catalogOpen"
      >
        <Plus aria-hidden="true" />
        <span>Add connector</span>
      </button>
    </div>

    <p v-if="notConfigured" class="settings-connectors-notice" role="status" data-testid="settings-connectors-not-configured">
      {{ notConfiguredMessage }}
    </p>
    <p v-else-if="loadError" class="settings-feedback" data-state="error" role="status">{{ loadError }}</p>

    <ul v-if="catalogOpen" id="settings-connectors-catalog" class="settings-connectors-catalog" aria-label="Connectors you can add" data-testid="settings-connectors-catalog">
      <li v-for="entry in catalog" :key="entry.id" :data-testid="`settings-connectors-catalog-${entry.id}`" :data-unavailable="entry.unavailable ? 'true' : undefined">
        <div>
          <p class="settings-connectors-catalog-name">{{ entry.name }}</p>
          <p class="settings-connectors-catalog-kind">{{ connectorKindLabel(entry.kind) }}</p>
          <p class="settings-control-description">{{ entry.unavailable ?? entry.description }}</p>
        </div>
        <button
          class="ghost-button"
          type="button"
          :disabled="Boolean(entry.unavailable)"
          :aria-label="`Add ${entry.name}`"
          @click="choose(entry.id)"
        >
          {{ entry.kind === "remote" ? "Show steps" : "Add" }}
        </button>
      </li>
    </ul>

    <table v-if="rows.length" class="settings-connectors-table" data-testid="settings-connectors-table">
      <thead>
        <tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Status</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" :data-testid="`settings-connector-row-${row.id}`" :data-status="row.status">
          <th scope="row">
            <button class="settings-connectors-row-link" type="button" :title="row.detail" @click="$emit('open', row.pane)">{{ row.name }}</button>
            <span class="settings-connectors-row-detail">{{ row.detail }}</span>
          </th>
          <td>{{ connectorKindLabel(row.kind) }}</td>
          <td><span class="state-pill" :data-state="connectorStatusTone(row.status)">{{ connectorStatusLabel(row.status) }}</span></td>
        </tr>
      </tbody>
    </table>
    <p v-else class="settings-control-description" data-testid="settings-connectors-empty">Nothing is connected yet. Use Add connector to start.</p>
  </section>
</template>

<script setup lang="ts">
import { Plus } from "@lucide/vue";
import { ref, watch } from "vue";
import { CONNECTORS_NOT_CONFIGURED_MESSAGE } from "../../../../../../../shared/ticket-connectors.mjs";
import {
  connectorKindLabel,
  connectorStatusLabel,
  connectorStatusTone,
  type ConnectorCatalogEntry,
  type ConnectorCatalogId,
  type ConnectorRow,
} from "./connectors";
import type { SettingsPaneId } from "./types";

const props = defineProps<{
  rows: ConnectorRow[];
  catalog: ConnectorCatalogEntry[];
  notConfigured: boolean;
  loadError?: string | null;
  /** Opens the catalog at first (tests and deep links). */
  catalogInitiallyOpen?: boolean;
}>();

const emit = defineEmits<{
  open: [pane: SettingsPaneId];
  add: [entry: ConnectorCatalogId];
}>();

const notConfiguredMessage = CONNECTORS_NOT_CONFIGURED_MESSAGE;
const catalogOpen = ref(props.catalogInitiallyOpen === true);
watch(() => props.catalogInitiallyOpen, (open) => { if (open) catalogOpen.value = true; });

function choose(id: ConnectorCatalogId) {
  catalogOpen.value = false;
  emit("add", id);
}
</script>

<style scoped>
.settings-connectors-overview {
  display: grid;
  gap: 12px;
  margin-bottom: 20px;
}

.settings-connectors-overview-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.settings-connectors-overview-head .primary-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.settings-connectors-overview-head .primary-button svg {
  width: 16px;
  height: 16px;
}

.settings-connectors-notice {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  background: rgba(255, 255, 255, 0.03);
}

.settings-connectors-catalog {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.settings-connectors-catalog li {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.settings-connectors-catalog li[data-unavailable] {
  opacity: 0.7;
}

.settings-connectors-catalog p {
  margin: 0;
}

.settings-connectors-catalog-name {
  color: var(--text);
  font-weight: 600;
}

.settings-connectors-catalog-kind {
  color: var(--text-secondary);
  font-size: 12px;
}

.settings-connectors-catalog .ghost-button {
  align-self: flex-start;
}

.settings-connectors-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.settings-connectors-table th,
.settings-connectors-table td {
  padding: 8px;
  border-top: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
  font-weight: normal;
}

.settings-connectors-table thead th {
  border-top: 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.settings-connectors-row-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.settings-connectors-row-link:hover,
.settings-connectors-row-link:focus-visible {
  text-decoration: underline;
}

.settings-connectors-row-detail {
  display: block;
  color: var(--text-secondary);
  font-size: 12px;
}
</style>
