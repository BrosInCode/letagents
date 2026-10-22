<template>
  <div class="connector-tracker-details">
    <div class="connector-detail-state">
      <span
        class="connector-status"
        :data-attention="connection.status !== 'active'"
        >{{ connectionStateLabel(connection).label }}</span
      ><button class="connector-secondary" :disabled="!!busy" @click="test">
        {{ busy === "test" ? "Testing…" : "Test connection" }}
      </button>
    </div>
    <p v-if="feedback" class="connector-feedback" role="status">
      {{ feedback }}
    </p>
    <div v-if="connection.status !== 'active'" class="connector-notice">
      <strong>Reconnect to resume updates</strong>
      <p>
        {{
          connection.last_error ||
          "This connection needs your attention. Imported cards keep their last known ticket status."
        }}
      </p>
      <button
        class="connector-secondary"
        @click="$emit('reconnect', connection.provider)"
      >
        Reconnect {{ trackerLabel(connection.provider) }}
      </button>
    </div>
    <dl class="connector-facts">
      <div>
        <dt>Connected as</dt>
        <dd>{{ connection.tracker_user_label || "Account connected" }}</dd>
      </div>
      <div>
        <dt>
          {{ connection.provider === "github" ? "Installation" : "Workspace" }}
        </dt>
        <dd>{{ connection.display_name }}</dd>
      </div>
      <div v-if="connection.site_url">
        <dt>Site</dt>
        <dd>{{ connection.site_url }}</dd>
      </div>
      <div>
        <dt>Sign-in method</dt>
        <dd>
          {{
            connection.auth_kind === "oauth"
              ? "OAuth"
              : connection.auth_kind === "github_app"
                ? "GitHub App"
                : "API token"
          }}
        </dd>
      </div>
      <div>
        <dt>Access</dt>
        <dd>
          {{
            connection.provider === "github"
              ? "Read issues"
              : "Read tickets · Writes through rules"
          }}
        </dd>
      </div>
    </dl>
    <section class="connector-detail-section">
      <h3>Tickets in your rooms</h3>
      <p>
        Choose which tickets each room imports in its Board settings. Ticket
        labels stay separate from your agents’ work status.
      </p>
      <p>Connecting a tracker does not import tickets by itself.</p>
    </section>
    <div v-if="testItems" class="connector-detail-section">
      <h3>Tickets assigned to you</h3>
      <p v-if="!testItems.length">No open tickets are assigned to you.</p>
      <ul v-else class="connector-ticket-list">
        <li v-for="item in testItems" :key="item.key">
          <strong>{{ item.key }}</strong
          ><span>{{ item.title }}</span
          ><small
            >{{ item.raw_status }} →
            {{ ticketStateLabel(item.ticket_state) }}</small
          >
        </li>
      </ul>
    </div>
    <ConnectorDisclosure
      title="Ticket status mapping"
      :initially-open="connection.unmapped_statuses.length > 0"
    >
      <p>
        Translate tracker statuses into ticket labels. This does not move cards
        between board columns.
      </p>
      <p v-if="connection.unmapped_statuses.length" class="connector-notice">
        Unmapped statuses show as In progress until you map them.
      </p>
      <div
        v-for="(row, index) in mapping"
        :key="index"
        class="connector-map-row"
      >
        <span>{{ statusMapRowLabel(row.name) }}</span
        ><FilterDropdown
          :model-value="row.state"
          :label="`Ticket label for ${statusMapRowLabel(row.name)}`"
          :options="stateOptions"
          @update:model-value="row.state = $event as TicketState"
        /><button
          class="connector-icon"
          :aria-label="`Remove ${row.name}`"
          @click="mapping.splice(index, 1)"
        >
          ×
        </button>
      </div>
      <form class="connector-map-add" @submit.prevent="addStatus">
        <input
          v-model.trim="newStatus"
          placeholder="Status name"
          aria-label="New status name"
          maxlength="200"
        /><button class="connector-secondary" :disabled="!newStatus">
          Add
        </button>
      </form>
      <button class="connector-secondary" :disabled="!!busy" @click="saveMap">
        Save mapping
      </button>
    </ConnectorDisclosure>
    <SettingsConnectorRules
      v-if="connection.provider !== 'github'"
      :key="connection.id"
      :connection="connection"
      :rules-api="api.rules"
    />
    <section v-else class="connector-detail-section">
      <h3>Read-only connection</h3>
      <p>
        GitHub Issues can be imported and kept up to date. Rules that write to
        issues are not supported yet.
      </p>
    </section>
    <section class="connector-detail-section">
      <div class="connector-switch-row">
        <h3>Jev linking</h3>
        <DesktopSwitch
          label="Jev linking"
          :checked="connection.jev_linking_enabled"
          :busy="!!busy"
          :disabled="!disclosure"
          :describedby="`connector-jev-${connection.id}`"
          @toggle="toggleJev"
        />
      </div>
      <p :id="`connector-jev-${connection.id}`">
        {{
          disclosure ||
          "The server did not provide the Jev disclosure. Refresh before changing this setting."
        }}
      </p>
    </section>
    <ConnectorDisclosure
      v-if="connection.provider !== 'github'"
      title="Faster updates"
      ><p>
        Add a webhook in {{ trackerLabel(connection.provider) }} to receive
        ticket changes sooner. Background sync continues without it.
      </p>
      <button
        v-if="!webhook"
        class="connector-secondary"
        :disabled="!!busy"
        @click="showWebhook"
      >
        Show webhook setup</button
      ><template v-else
        ><p>Keep the signing secret private.</p>
        <label class="connector-field"
          >URL<input :value="webhook.url" readonly @focus="selectAll" /></label
        ><label class="connector-field"
          >Signing secret<input
            :value="webhook.secret"
            readonly
            @focus="selectAll" /></label
        ><button class="connector-secondary" @click="webhook = null">
          Hide setup
        </button></template
      ></ConnectorDisclosure
    >
    <div class="connector-danger">
      <p>Imported cards stay on your boards.</p>
      <template v-if="confirmRemove"
        ><p>
          Disconnect {{ trackerLabel(connection.provider) }} from your account?
        </p>
        <div class="connector-actions">
          <button
            class="connector-danger-button"
            :disabled="!!busy"
            @click="remove"
          >
            Confirm disconnect</button
          ><button
            class="connector-secondary"
            :disabled="!!busy"
            @click="confirmRemove = false"
          >
            Cancel
          </button>
        </div></template
      ><button
        v-else
        class="connector-danger-button"
        :disabled="!!busy"
        @click="confirmRemove = true"
      >
        Disconnect {{ trackerLabel(connection.provider) }}
      </button>
    </div>
  </div>
</template>
<script setup lang="ts">
import { safeUserVisibleErrorDetail } from "../../../apps/desktop/renderer/src/domain/user-visible-error";
import { onBeforeUnmount, ref, watch } from "vue";
import type {
  TrackerConnectionView,
  TrackerItemSummary,
  TrackerWebhookSetup,
  TicketState,
  TrackerProvider,
} from "../../ticket-connectors.mjs";
import type { TrackerApi } from "./types";
import ConnectorDisclosure from "./ConnectorDisclosure.vue";
import FilterDropdown from "../FilterDropdown.vue";
import DesktopSwitch from "../../../apps/desktop/renderer/src/components/desktop/controls/DesktopSwitch.vue";
import SettingsConnectorRules from "../../../apps/desktop/renderer/src/components/desktop/settings/panes/SettingsConnectorRules.vue";
import {
  connectionStateLabel,
  trackerLabel,
  statusMapRows,
  statusMapFromRows,
  statusMapRowLabel,
  ticketStateLabel,
  ticketStateOptions,
} from "../../../apps/desktop/renderer/src/components/desktop/settings/connectors";
const props = defineProps<{
  connection: TrackerConnectionView;
  api: TrackerApi;
  disclosure: string;
}>();
const emit = defineEmits<{
  updated: [connection: TrackerConnectionView];
  reconnect: [provider: TrackerProvider];
}>();
const busy = ref(""),
  feedback = ref(""),
  confirmRemove = ref(false),
  newStatus = ref("");
const mapping = ref(statusMapRows(props.connection));
let savedMapping = statusMapRows(props.connection);
const testItems = ref<TrackerItemSummary[] | null>(null),
  webhook = ref<TrackerWebhookSetup | null>(null);
const stateOptions = ticketStateOptions.map((option) => ({
  id: option.value,
  label: option.label,
}));
let live = true;
onBeforeUnmount(() => {
  live = false;
});
watch(
  () => props.connection,
  (connection, previous) => {
    const fresh = statusMapRows(connection);
    const changedConnection = connection.id !== previous.id;
    if (
      changedConnection ||
      JSON.stringify(mapping.value) === JSON.stringify(savedMapping)
    ) {
      mapping.value = fresh;
    } else {
      // A test/refresh may discover statuses while the person edits existing rows.
      // Keep their draft (including deliberate removals), and add only newly seen names.
      const known = new Set(
        [...savedMapping, ...mapping.value].map((row) =>
          row.name.toLowerCase(),
        ),
      );
      mapping.value.push(
        ...fresh.filter((row) => !known.has(row.name.toLowerCase())),
      );
    }
    savedMapping = fresh;
    if (changedConnection) {
      testItems.value = null;
      webhook.value = null;
      confirmRemove.value = false;
    }
  },
);

async function run(action: string, task: () => Promise<void>) {
  if (busy.value) return;
  busy.value = action;
  feedback.value = "";
  try {
    await task();
  } catch (error) {
    if (live)
      feedback.value = safeUserVisibleErrorDetail(
        error,
        "The request failed. Try again.",
      );
  } finally {
    if (live) busy.value = "";
  }
}
const test = () =>
  run("test", async () => {
    const result = await props.api.test(props.connection.id);
    if (!live) return;
    emit("updated", result.connection);
    if (result.ok) {
      testItems.value = result.items;
      feedback.value = "Connection checked.";
    } else feedback.value = result.error || "The tracker refused the request.";
  });
function addStatus() {
  if (!newStatus.value) return;
  mapping.value.push({
    name: newStatus.value,
    state: "in_progress",
    unmapped: false,
  });
  newStatus.value = "";
}
const saveMap = () =>
  run("map", async () => {
    const connection = await props.api.update(props.connection.id, {
      status_map: statusMapFromRows(mapping.value),
    });
    if (!live) return;
    savedMapping = statusMapRows(connection);
    mapping.value = savedMapping;
    emit("updated", connection);
    feedback.value = "Ticket status mapping saved.";
  });
const toggleJev = () =>
  run("jev", async () => {
    const connection = await props.api.update(props.connection.id, {
      jev_linking_enabled: !props.connection.jev_linking_enabled,
    });
    if (live) emit("updated", connection);
  });
const showWebhook = () =>
  run("webhook", async () => {
    const result = await props.api.webhook(props.connection.id);
    if (live) webhook.value = result;
  });
const remove = () =>
  run("remove", async () => {
    const id = props.connection.id;
    await props.api.remove(id);
  });
const selectAll = (event: FocusEvent) =>
  (event.target as HTMLInputElement).select();
</script>
