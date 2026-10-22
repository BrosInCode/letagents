<template>
  <section
    v-if="visible"
    class="room-settings-section"
    data-section="ticket-filters"
    aria-labelledby="room-settings-heading-ticket-filters"
    data-testid="room-tracker-filters"
  >
    <h3 id="room-settings-heading-ticket-filters">Ticket filters</h3>
    <div class="room-settings-list">
      <div
        v-for="filter in filters"
        :key="filter.id"
        class="room-settings-row"
        data-inline="true"
        :data-testid="`room-tracker-filter-${filter.id}`"
      >
        <div class="room-settings-row-copy">
          <p :id="`room-tracker-filter-title-${filter.id}`" class="room-settings-row-title">
            {{ providerLabel(filter.provider) }} · {{ filter.connection_label }}
          </p>
          <p class="room-settings-mono" :title="filter.filter">{{ filter.filter || "All tickets" }}</p>
          <p
            class="room-settings-row-description"
            :data-tone="filter.last_error ? 'error' : undefined"
          >{{ filterStatus(filter) }}</p>
        </div>
        <div class="room-settings-row-action">
          <DesktopSwitch
            :labelledby="`room-tracker-filter-title-${filter.id}`"
            :checked="filter.enabled"
            :disabled="!filter.can_manage || busy"
            :busy="busy"
            @toggle="setEnabled(filter)"
          />
          <button
            v-if="canManage"
            class="room-settings-button"
            type="button"
            :disabled="busy"
            @click="remove(filter)"
          >Remove</button>
        </div>
      </div>

      <form
        v-if="canManage && connections.length"
        class="room-settings-row"
        data-testid="room-tracker-filter-form"
        @submit.prevent="save"
      >
        <div class="room-settings-row-copy">
          <label class="room-settings-row-title" for="room-tracker-filter-text">Import tickets</label>
          <p
            class="room-settings-row-description"
            :data-tone="error ? 'error' : undefined"
            :role="error ? 'alert' : undefined"
          >{{ error || formDescription }}</p>
        </div>
        <div class="room-settings-row-action room-tracker-filter-fields">
          <select
            v-model="connectionId"
            class="room-settings-input"
            aria-label="Tracker connection"
            :disabled="busy"
          >
            <option v-for="connection in connections" :key="connection.id" :value="connection.id">
              {{ providerLabel(connection.provider) }} · {{ connection.display_name }}
            </option>
          </select>
          <input
            id="room-tracker-filter-text"
            v-model="filterText"
            class="room-settings-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="placeholder"
            :readonly="busy"
          >
          <button class="room-settings-button" type="button" :disabled="busy || !connectionId" @click="test">Test</button>
          <button class="room-settings-button" type="submit" data-variant="primary" :disabled="busy || !connectionId">Save</button>
        </div>
      </form>
      <p v-else-if="!canManage" class="room-settings-row-description">Only room admins can change ticket filters.</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  isTrackerProvider,
  trackerProviderLabel,
  type RoomTrackerFilterView,
  type TrackerConnectionView,
  type TrackerProvider,
} from "../../../../../../../../shared/ticket-connectors.mjs";
import DesktopSwitch from "../../controls/DesktopSwitch.vue";
import { desktopIpc } from "../../../../ipc/index";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";
import { relativeTime } from "../room-board/formatters";

const props = defineProps<{ roomIdentifier: string }>();

const filters = ref<RoomTrackerFilterView[]>([]);
const connections = ref<TrackerConnectionView[]>([]);
const canManage = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const testResult = ref<string | null>(null);
const connectionId = ref("");
const filterText = ref("");
let generation = 0;

// A room without filters, seen by someone with no tracker connection, shows
// nothing new (ticket connectors invariant 1).
const visible = computed(() => filters.value.length > 0 || connections.value.length > 0);
const selectedProvider = computed<TrackerProvider | null>(() =>
  connections.value.find((connection) => connection.id === connectionId.value)?.provider ?? null);
const placeholder = computed(() => selectedProvider.value === "linear"
  ? "team:ENG or project:<id>"
  : selectedProvider.value === "github"
    ? "owner/repo (up to 10, separated by spaces)"
    : "project = HT AND statusCategory != Done");
const formDescription = computed(() => testResult.value
  ?? "Cards are created for matching tickets. Your connection reads them; the tracker owns their state.");

function providerLabel(provider: string): string {
  return isTrackerProvider(provider) ? trackerProviderLabel(provider) : provider;
}

function filterStatus(filter: RoomTrackerFilterView): string {
  if (filter.last_error) return filter.last_error;
  if (!filter.enabled) return "Off. Imported cards stay on the board.";
  return filter.last_synced_at ? `Synced ${relativeTime(filter.last_synced_at)}` : "Waiting for the first sync.";
}

async function load(): Promise<void> {
  const version = ++generation;
  filters.value = [];
  connections.value = [];
  canManage.value = false;
  busy.value = false;
  error.value = null;
  testResult.value = null;
  const [filterList, connectionList] = await Promise.allSettled([
    Promise.resolve().then(() => desktopIpc.room.listTrackerFilters(props.roomIdentifier)),
    Promise.resolve().then(() => desktopIpc.connectors.list()),
  ]);
  if (version !== generation) return;
  if (filterList.status === "fulfilled") {
    filters.value = filterList.value.filters;
    canManage.value = filterList.value.can_manage;
  }
  // A server without connectors, or a signed-out app, simply has none.
  connections.value = connectionList.status === "fulfilled"
    ? connectionList.value.connections.filter((connection) => connection.status === "active")
    : [];
  if (!connections.value.some((connection) => connection.id === connectionId.value)) {
    connectionId.value = connections.value[0]?.id ?? "";
  }
}

/** Runs an action for the room shown now; a result that lands after a room change is dropped. */
async function run(action: (current: () => boolean) => Promise<void>, fallback: string): Promise<void> {
  if (busy.value) return;
  const version = generation;
  busy.value = true;
  error.value = null;
  try {
    await action(() => version === generation);
  } catch (cause) {
    if (version === generation) error.value = safeUserVisibleErrorDetail(cause, fallback);
  } finally {
    if (version === generation) busy.value = false;
  }
}

function applyList(list: { filters: RoomTrackerFilterView[]; can_manage: boolean }, current: () => boolean): void {
  if (!current()) return;
  filters.value = list.filters;
  canManage.value = list.can_manage;
}

function test(): Promise<void> {
  testResult.value = null;
  return run(async (current) => {
    const result = await desktopIpc.room.testTrackerFilter(props.roomIdentifier, {
      connectionId: connectionId.value,
      filter: filterText.value,
    });
    if (!current()) return;
    if (!result.ok) throw new Error(result.error || "The tracker refused the filter.");
    const count = result.count >= result.limit ? `${result.limit} or more` : String(result.count);
    testResult.value = `${count} ${result.count === 1 ? "ticket matches" : "tickets match"}.`;
  }, "The filter could not be tested.");
}

function save(): Promise<void> {
  return run(async (current) => {
    applyList(await desktopIpc.room.saveTrackerFilter(props.roomIdentifier, {
      connectionId: connectionId.value,
      filter: filterText.value,
      enabled: true,
    }), current);
    if (!current()) return;
    filterText.value = "";
    testResult.value = "Saved. The first sync starts within two minutes.";
  }, "The filter could not be saved.");
}

function setEnabled(filter: RoomTrackerFilterView): Promise<void> {
  return run(async (current) => {
    applyList(await desktopIpc.room.setTrackerFilterEnabled(props.roomIdentifier, filter.id, !filter.enabled), current);
  }, "The filter could not be changed.");
}

function remove(filter: RoomTrackerFilterView): Promise<void> {
  return run(async (current) => {
    applyList(await desktopIpc.room.removeTrackerFilter(props.roomIdentifier, filter.id), current);
  }, "The filter could not be removed.");
}

// Loaded on mount (never during a server render) and again when the room changes.
onMounted(() => { void load(); });
watch(() => props.roomIdentifier, () => { void load(); });
onBeforeUnmount(() => { generation++; });
</script>

<style scoped>
.room-tracker-filter-fields { flex-wrap: wrap; gap: 6px; }
.room-tracker-filter-fields input { min-width: 220px; }
</style>
