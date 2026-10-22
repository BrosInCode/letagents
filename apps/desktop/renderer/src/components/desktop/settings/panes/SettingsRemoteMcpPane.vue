<template>
  <section class="settings-panel" data-testid="settings-remote-mcp-panel">
    <div class="settings-control-list">
      <SettingsRow
        title="Remote sign-ins"
        description="Apps that signed in to your LetAgents account through the remote MCP connector. Each one has the same access as an owner token on that connector. Disconnect an app to end its access at once."
      />

      <section class="settings-remote-steps" aria-labelledby="settings-remote-steps-title" data-testid="settings-remote-steps">
        <p id="settings-remote-steps-title" class="settings-control-title">Add the remote connector to an app</p>
        <ol>
          <li>In the app (for example the Claude app), add a custom connector with the URL <code>{{ connectorUrl }}</code>.</li>
          <li>Click Connect. Leave the OAuth client ID and secret empty.</li>
          <li>In the browser, sign in with GitHub if you are asked to, then check the app name and click Approve.</li>
          <li>In a chat, call <code>join_room</code>, then <code>register_agent_session</code>. The app then shows here.</li>
        </ol>
      </section>

      <p v-if="feedback" class="settings-feedback" :data-state="feedback.state" role="status">{{ feedback.message }}</p>
      <p v-else-if="state.error" class="settings-feedback" data-state="error" role="status">{{ state.error }}</p>

      <SettingsRow
        v-for="connection in connections"
        :key="connection.id"
        :title="connection.client_name ?? 'Unnamed app'"
        :description="describe(connection)"
        :data-testid="`settings-remote-mcp-${connection.id}`"
      >
        <template #action>
          <button
            class="ghost-button"
            type="button"
            :disabled="busyId === connection.id"
            :data-testid="`settings-remote-mcp-disconnect-${connection.id}`"
            @click="disconnect(connection)"
          >
            {{ confirmId === connection.id ? "Confirm disconnect" : "Disconnect" }}
          </button>
        </template>
      </SettingsRow>

      <SettingsRow
        v-if="loaded && !connections.length && !unavailable"
        title="No apps connected"
        description="Add the remote connector in an app such as Claude, then sign in with GitHub. The app shows here."
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";
import { remoteConnectorUrl } from "../connectors";
import { remoteSignInsChanged, remoteSignInsState as state } from "../connectors-store";
import SettingsRow from "../SettingsRow.vue";
import type { SettingsFeedback } from "../types";

type RemoteMcpConnectionView = Awaited<ReturnType<Window["letagentsDesktop"]["mcpConnections"]["list"]>>["connections"][number];

const props = defineProps<{ apiUrl?: string | null }>();

// The Connectors list loads these; this pane shows and changes them.
const connections = computed(() => state.connections);
const loaded = computed(() => state.loaded);
const unavailable = computed(() => Boolean(state.error));
const connectorUrl = computed(() => remoteConnectorUrl(props.apiUrl));
const feedback = ref<SettingsFeedback | null>(null);
const busyId = ref<string | null>(null);
const confirmId = ref<string | null>(null);

const api = () => window.letagentsDesktop.mcpConnections;
const message = (error: unknown, fallback: string) => safeUserVisibleErrorDetail(error, fallback);

function day(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function describe(connection: RemoteMcpConnectionView): string {
  const hosts = connection.redirect_hosts.join(", ");
  return `Returns to ${hosts}. Connected ${day(connection.created_at)}, last used ${day(connection.last_used_at)}.`;
}


async function disconnect(connection: RemoteMcpConnectionView) {
  if (confirmId.value !== connection.id) {
    confirmId.value = connection.id;
    return;
  }
  busyId.value = connection.id;
  feedback.value = null;
  try {
    await api().disconnect(connection.id);
    remoteSignInsChanged();
    state.connections = state.connections.filter((entry) => entry.id !== connection.id);
    feedback.value = { state: "success", message: `${connection.client_name ?? "The app"} is disconnected.` };
  } catch (error) {
    feedback.value = { state: "error", message: message(error, "The app could not be disconnected. Try again.") };
  } finally {
    busyId.value = null;
    confirmId.value = null;
  }
}
</script>

<style scoped>
.settings-remote-steps {
  display: grid;
  gap: 6px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}

.settings-remote-steps p {
  margin: 0;
}

.settings-remote-steps ol {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 20px;
  color: var(--text-secondary);
}

.settings-remote-steps code {
  color: var(--text);
  overflow-wrap: anywhere;
}
</style>
