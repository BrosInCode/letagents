<template>
  <section class="settings-panel" data-testid="settings-remote-mcp-panel">
    <div class="settings-control-list">
      <SettingsRow
        title="Remote connector"
        description="Apps that signed in to your LetAgents account through the remote MCP connector. Each one has the same access as an owner token on that connector. Disconnect an app to end its access at once."
      />

      <p v-if="feedback" class="settings-feedback" :data-state="feedback.state" role="status">{{ feedback.message }}</p>

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
import { onMounted, ref } from "vue";
import SettingsRow from "../SettingsRow.vue";
import type { SettingsFeedback } from "../types";

type RemoteMcpConnectionView = Awaited<ReturnType<Window["letagentsDesktop"]["mcpConnections"]["list"]>>["connections"][number];

const connections = ref<RemoteMcpConnectionView[]>([]);
const loaded = ref(false);
const unavailable = ref(false);
const feedback = ref<SettingsFeedback | null>(null);
const busyId = ref<string | null>(null);
const confirmId = ref<string | null>(null);

const api = () => window.letagentsDesktop.mcpConnections;
const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

function day(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function describe(connection: RemoteMcpConnectionView): string {
  const hosts = connection.redirect_hosts.join(", ");
  return `Returns to ${hosts}. Connected ${day(connection.created_at)}, last used ${day(connection.last_used_at)}.`;
}

async function load() {
  try {
    connections.value = (await api().list()).connections;
    unavailable.value = false;
  } catch (error) {
    unavailable.value = true;
    feedback.value = { state: "error", message: message(error, "Connected apps are not available. Sign in, then try again.") };
  } finally {
    loaded.value = true;
  }
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
    connections.value = connections.value.filter((entry) => entry.id !== connection.id);
    feedback.value = { state: "success", message: `${connection.client_name ?? "The app"} is disconnected.` };
  } catch (error) {
    feedback.value = { state: "error", message: message(error, "The app could not be disconnected. Try again.") };
  } finally {
    busyId.value = null;
    confirmId.value = null;
  }
}

onMounted(load);
</script>
