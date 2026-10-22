<template>
  <ConnectorsOverview
    :rows="rows"
    :catalog="catalog"
    :not-configured="trackerConnectionsState.notConfigured"
    :load-error="trackerConnectionsState.error"
    @open="$emit('open', $event)"
    @add="add"
  />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import type { DesktopMcpInstallState } from "../../../../../../electron/ipc-types";
import ConnectorsOverview from "../ConnectorsOverview.vue";
import { connectorCatalog, connectorRows, type ConnectorCatalogId } from "../connectors";
import {
  loadRemoteSignIns,
  loadTrackerConnections,
  remoteSignInsState,
  trackerConnectionsState,
} from "../connectors-store";
import type { SettingsPaneId } from "../types";

const props = defineProps<{
  mcpInstallState: DesktopMcpInstallState;
}>();

const emit = defineEmits<{
  open: [pane: SettingsPaneId];
}>();

const rows = computed(() => connectorRows({
  trackers: trackerConnectionsState.connections,
  agentApps: props.mcpInstallState.targets,
  remoteSignIns: remoteSignInsState.connections,
}));

const catalog = computed(() => connectorCatalog({
  notConfigured: trackerConnectionsState.notConfigured,
  providers: trackerConnectionsState.providers,
}));

function add(id: ConnectorCatalogId) {
  if (id === "agent_app") {
    emit("open", "account:connectors-setup");
  } else if (id === "remote") {
    emit("open", "account:connectors-remote");
  } else {
    trackerConnectionsState.requestedForm = id;
    emit("open", "account:connectors");
  }
}

// Another window or device may have changed the connections; refresh when the app is back.
const onFocus = () => {
  void loadTrackerConnections();
  void loadRemoteSignIns();
};
onMounted(() => {
  onFocus();
  window.addEventListener("focus", onFocus);
});
onBeforeUnmount(() => window.removeEventListener("focus", onFocus));
</script>
