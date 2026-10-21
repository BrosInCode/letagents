<template>
  <section class="settings-panel" data-testid="settings-connectors-panel">
    <div class="settings-control-list">
      <SettingsRow
        title="Ticket trackers"
        description="Connect Jira or Linear once. Board cards can then carry ticket keys and show each ticket's state from the tracker."
      />

      <p v-if="feedback" class="settings-feedback" :data-state="feedback.state" role="status">{{ feedback.message }}</p>

      <article
        v-for="connection in connections"
        :key="connection.id"
        class="settings-connector"
        :data-testid="`settings-connector-${connection.provider}`"
      >
        <SettingsRow
          :title="`${trackerLabel(connection.provider)} · ${connection.display_name}`"
          :description="connectionDescription(connection)"
          :badge="connectionStateLabel(connection).label"
          :badge-state="connectionStateLabel(connection).state"
        >
          <template #action>
            <div class="settings-connector-actions">
              <button class="ghost-button" type="button" :disabled="busyId === connection.id" @click="test(connection)">
                {{ busyId === connection.id && busyAction === "test" ? "Testing" : "Test connection" }}
              </button>
              <button class="ghost-button" type="button" :disabled="busyId === connection.id" @click="toggleWebhook(connection)">
                {{ webhooks[connection.id] ? "Hide webhook" : "Webhook" }}
              </button>
              <button
                class="ghost-button"
                type="button"
                :disabled="busyId === connection.id"
                :data-testid="`settings-connector-remove-${connection.id}`"
                @click="remove(connection)"
              >
                {{ confirmRemoveId === connection.id ? "Confirm remove" : "Remove" }}
              </button>
            </div>
          </template>
        </SettingsRow>

        <div v-if="webhooks[connection.id]" class="settings-connector-webhook" :data-testid="`settings-connector-webhook-${connection.id}`">
          <p class="settings-control-description">
            Optional. Add this webhook in {{ trackerLabel(connection.provider) }} for issue events, so ticket states
            change on the board at once instead of at the next poll. Keep the secret private.
          </p>
          <label>URL <input class="settings-input" type="text" readonly :value="webhooks[connection.id]!.url" @focus="selectAll"></label>
          <label>Secret <input class="settings-input" type="text" readonly :value="webhooks[connection.id]!.secret" @focus="selectAll"></label>
        </div>

        <ul v-if="testResults[connection.id]?.length" class="settings-connector-items" aria-label="Tickets assigned to you">
          <li v-for="item in testResults[connection.id]" :key="item.key">
            <strong>{{ item.key }}</strong>
            <span>{{ item.title }}</span>
            <span class="state-pill" :data-state="item.unmapped ? 'away' : 'connected'">
              {{ item.raw_status }} → {{ ticketStateLabel(item.ticket_state) }}
            </span>
          </li>
        </ul>
        <p v-else-if="testResults[connection.id]" class="settings-control-description">No open tickets are assigned to you.</p>

        <p v-if="connection.unmapped_statuses.length" class="settings-feedback" data-state="error">
          {{ connection.unmapped_statuses.length === 1 ? "One status has" : `${connection.unmapped_statuses.length} statuses have` }}
          no column: {{ connection.unmapped_statuses.join(", ") }}. They show as In progress until you map them below.
        </p>

        <details class="settings-connector-map" :open="connection.unmapped_statuses.length > 0">
          <summary>Status map</summary>
          <p class="settings-control-description">Choose the board column for each tracker status. Names are not case sensitive.</p>
          <div v-for="(row, index) in mapDrafts[connection.id] ?? []" :key="`${row.name}-${index}`" class="settings-connector-map-row">
            <span :data-unmapped="row.unmapped || undefined">{{ statusMapRowLabel(row.name) }}</span>
            <select v-model="row.state" :aria-label="`Column for ${statusMapRowLabel(row.name)}`">
              <option v-for="option in ticketStateOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <button class="ghost-button" type="button" :aria-label="`Remove ${row.name}`" @click="mapDrafts[connection.id].splice(index, 1)">Remove</button>
          </div>
          <form class="settings-connector-map-row" @submit.prevent="addMapRow(connection.id)">
            <input v-model.trim="newStatus[connection.id]" type="text" placeholder="Status name" aria-label="New status name" maxlength="200" />
            <button class="ghost-button" type="submit" :disabled="!newStatus[connection.id]">Add status</button>
          </form>
          <button class="primary-button" type="button" :disabled="busyId === connection.id" @click="saveMap(connection)">Save status map</button>
        </details>

        <SettingsRow
          title="Link pull requests with Jev"
          :description="disclosure"
          :description-id="`settings-connector-jev-${connection.id}`"
        >
          <template #action>
            <DesktopSwitch
              label="Link pull requests with Jev"
              :describedby="`settings-connector-jev-${connection.id}`"
              :test-id="`settings-connector-jev-switch-${connection.id}`"
              :checked="connection.jev_linking_enabled"
              :busy="busyId === connection.id"
              @toggle="toggleJev(connection)"
            />
          </template>
        </SettingsRow>

        <SettingsConnectorRules :connection="connection" />
      </article>

      <SettingsRow
        v-if="loaded && !connections.length && !unavailable"
        title="No trackers connected"
        description="Add Jira or Linear to see ticket states on your boards."
      />

      <div v-if="!unavailable" class="settings-connector-actions">
        <button class="primary-button" type="button" data-testid="settings-connector-add-jira" @click="openForm('jira')">Add Jira</button>
        <button class="primary-button" type="button" data-testid="settings-connector-add-linear" @click="openForm('linear')">Add Linear</button>
      </div>

      <form v-if="form" class="settings-form settings-connector-form" data-testid="settings-connector-form" @submit.prevent="saveToken">
        <p class="settings-control-title">Add {{ trackerLabel(form) }}</p>
        <template v-if="providers?.[form]?.oauth">
          <p class="settings-control-description">Sign in with {{ trackerLabel(form) }} in your browser, then return here.</p>
          <div class="settings-connector-actions">
            <button class="primary-button" type="button" :disabled="busyAction === 'oauth'" @click="startOAuth(form)">
              {{ busyAction === "oauth" ? "Waiting for your browser" : `Sign in with ${trackerLabel(form)}` }}
            </button>
            <button v-if="busyAction === 'oauth'" class="ghost-button" type="button" @click="cancelOAuth">Cancel sign-in</button>
          </div>
          <p class="settings-control-description">Or use an API token:</p>
        </template>
        <template v-if="form === 'jira'">
          <label class="settings-field"><span>Jira site</span>
            <input v-model.trim="siteUrl" type="text" placeholder="https://your-team.atlassian.net" autocomplete="off" required />
          </label>
          <label class="settings-field"><span>Atlassian email</span>
            <input v-model.trim="email" type="email" autocomplete="off" required />
          </label>
          <label class="settings-field"><span>API token</span>
            <input v-model="apiToken" type="password" autocomplete="off" required />
          </label>
        </template>
        <label v-else class="settings-field"><span>Linear API key</span>
          <input v-model="apiToken" type="password" autocomplete="off" placeholder="lin_api_…" required />
        </label>
        <p class="settings-control-description">The token is sent to the LetAgents server, checked with the tracker, and stored encrypted. It is never shown again.</p>
        <div class="settings-connector-actions">
          <button class="primary-button" type="submit" :disabled="busyAction === 'save' || !apiToken">{{ busyAction === "save" ? "Connecting" : "Connect" }}</button>
          <button class="ghost-button" type="button" @click="closeForm">Cancel</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type {
  TrackerConnectionView,
  TrackerItemSummary,
  TrackerWebhookSetup,
  TrackerProvider,
  TrackerProviderAvailability,
} from "../../../../../../../../shared/ticket-connectors.mjs";
import DesktopSwitch from "../../controls/DesktopSwitch.vue";
import SettingsRow from "../SettingsRow.vue";
import SettingsConnectorRules from "./SettingsConnectorRules.vue";
import {
  connectionStateLabel,
  statusMapFromRows,
  statusMapRowLabel,
  statusMapRows,
  ticketStateLabel,
  ticketStateOptions,
  trackerLabel,
  type StatusMapRow,
} from "../connectors";
import type { SettingsFeedback } from "../types";

const connections = ref<TrackerConnectionView[]>([]);
const providers = ref<Record<TrackerProvider, TrackerProviderAvailability> | null>(null);
const disclosure = ref("");
const loaded = ref(false);
const unavailable = ref(false);
const feedback = ref<SettingsFeedback | null>(null);
const busyId = ref<string | null>(null);
const busyAction = ref<"test" | "save" | "oauth" | "update" | null>(null);
const confirmRemoveId = ref<string | null>(null);
const testResults = reactive<Record<string, TrackerItemSummary[]>>({});
const webhooks = reactive<Record<string, TrackerWebhookSetup>>({});
const mapDrafts = reactive<Record<string, StatusMapRow[]>>({});
const newStatus = reactive<Record<string, string>>({});
const form = ref<TrackerProvider | null>(null);
const siteUrl = ref("");
const email = ref("");
const apiToken = ref("");

const api = () => window.letagentsDesktop.connectors;
const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

function connectionDescription(connection: TrackerConnectionView): string {
  const who = connection.tracker_user_label ? `Signed in as ${connection.tracker_user_label}` : "Signed in";
  const where = connection.site_url ? ` on ${connection.site_url.replace(/^https:\/\//, "")}` : "";
  return connection.last_error && connection.status !== "active" ? `${who}${where}. ${connection.last_error}` : `${who}${where}.`;
}

function replace(connection: TrackerConnectionView) {
  const index = connections.value.findIndex((entry) => entry.id === connection.id);
  if (index >= 0) connections.value.splice(index, 1, connection);
  else connections.value.push(connection);
  mapDrafts[connection.id] = statusMapRows(connection);
}

async function load() {
  try {
    const list = await api().list();
    connections.value = list.connections;
    providers.value = list.providers;
    disclosure.value = list.jev_linking_disclosure;
    for (const connection of list.connections) mapDrafts[connection.id] = statusMapRows(connection);
    unavailable.value = false;
  } catch (error) {
    unavailable.value = true;
    feedback.value = { state: "error", message: message(error, "Ticket trackers are not available. Sign in, then try again.") };
  } finally {
    loaded.value = true;
  }
}

async function run(id: string | null, action: NonNullable<typeof busyAction.value>, task: () => Promise<void>) {
  busyId.value = id;
  busyAction.value = action;
  feedback.value = null;
  try {
    await task();
  } catch (error) {
    feedback.value = { state: "error", message: message(error, "The tracker request failed. Try again.") };
  } finally {
    busyId.value = null;
    busyAction.value = null;
  }
}

function toggleWebhook(connection: TrackerConnectionView) {
  if (webhooks[connection.id]) {
    delete webhooks[connection.id];
    return;
  }
  return run(connection.id, "update", async () => {
    webhooks[connection.id] = await api().webhook(connection.id);
  });
}

function selectAll(event: FocusEvent) {
  (event.target as HTMLInputElement).select();
}

function test(connection: TrackerConnectionView) {
  return run(connection.id, "test", async () => {
    const result = await api().test(connection.id);
    replace(result.connection);
    if (result.ok) testResults[connection.id] = result.items;
    else feedback.value = { state: "error", message: result.error ?? "The tracker refused the request." };
  });
}

function remove(connection: TrackerConnectionView) {
  if (confirmRemoveId.value !== connection.id) {
    confirmRemoveId.value = connection.id;
    return;
  }
  confirmRemoveId.value = null;
  return run(connection.id, "update", async () => {
    await api().remove(connection.id);
    connections.value = connections.value.filter((entry) => entry.id !== connection.id);
    feedback.value = { state: "success", message: `${trackerLabel(connection.provider)} connection removed.` };
  });
}

function addMapRow(id: string) {
  const name = newStatus[id]?.trim();
  if (!name) return;
  (mapDrafts[id] ??= []).push({ name, state: "in_progress", unmapped: false });
  newStatus[id] = "";
}

function saveMap(connection: TrackerConnectionView) {
  return run(connection.id, "update", async () => {
    replace(await api().update(connection.id, { status_map: statusMapFromRows(mapDrafts[connection.id] ?? []) }));
    feedback.value = { state: "success", message: "Status map saved." };
  });
}

function toggleJev(connection: TrackerConnectionView) {
  return run(connection.id, "update", async () => {
    replace(await api().update(connection.id, { jev_linking_enabled: !connection.jev_linking_enabled }));
  });
}

function openForm(provider: TrackerProvider) {
  form.value = provider;
  siteUrl.value = "";
  email.value = "";
  apiToken.value = "";
}

function closeForm() {
  form.value = null;
  apiToken.value = "";
}

function saveToken() {
  const provider = form.value;
  if (!provider) return;
  return run(null, "save", async () => {
    const connection = await api().saveApiToken(provider === "jira"
      ? { provider, site_url: siteUrl.value, email: email.value, api_token: apiToken.value }
      : { provider, api_token: apiToken.value });
    replace(connection);
    closeForm();
    feedback.value = { state: "success", message: `${trackerLabel(provider)} connected. Use Test connection to see your tickets.` };
  });
}

function startOAuth(provider: TrackerProvider) {
  return run(null, "oauth", async () => {
    feedback.value = { state: "info", message: `Approve access in your browser. LetAgents finishes connecting ${trackerLabel(provider)} when you return.` };
    const connection = await api().connectOAuth(provider);
    replace(connection);
    closeForm();
    feedback.value = { state: "success", message: `${trackerLabel(provider)} connected. Use Test connection to see your tickets.` };
  });
}

function cancelOAuth() {
  void api().cancelOAuth();
}

// Another window or device may have changed the connections; refresh when the app is back.
const onFocus = () => { if (loaded.value && !busyAction.value) void load(); };
onMounted(() => {
  void load();
  window.addEventListener("focus", onFocus);
});
onBeforeUnmount(() => window.removeEventListener("focus", onFocus));
</script>

<style scoped>
.settings-connector {
  display: grid;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}

.settings-connector-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.settings-connector-webhook {
  display: grid;
  gap: 6px;
  margin: 8px 0 0;
}
.settings-connector-webhook label { display: grid; gap: 2px; font-size: 12px; }
.settings-connector-items {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.settings-connector-items li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
}

.settings-connector-map {
  display: grid;
  gap: 8px;
}

.settings-connector-map summary {
  cursor: pointer;
  color: var(--text-secondary);
  font-weight: 600;
}

.settings-connector-map-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.settings-connector-map-row > span {
  min-width: 180px;
  color: var(--text);
}

.settings-connector-map-row > span[data-unmapped] {
  color: var(--amber);
}

.settings-connector-map-row select,
.settings-connector-map-row input {
  min-height: 36px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(10, 10, 10, 0.36);
  color: var(--text);
  font: inherit;
  padding: 0 10px;
}

.settings-connector-form {
  display: grid;
  gap: 12px;
}
</style>
