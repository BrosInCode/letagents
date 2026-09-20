<template>
  <section class="settings-panel" data-testid="settings-supervisor-grant-panel">
    <article class="surface-row">
      <div>
        <p class="surface-title">Agent access on this Mac</p>
        <p class="surface-subtitle">Allow this Mac to run specific agents in specific rooms. Access credentials are stored in macOS Keychain.</p>
      </div>
      <span class="state-pill" :data-state="metadata ? 'installed' : 'starting'">{{ metadata ? "Connected" : "Not connected" }}</span>
    </article>
    <details :open="!metadata">
      <summary>Advanced connection setup</summary>
      <p class="surface-subtitle">Use the identifiers from your connection setup. Room and agent names cannot be used here.</p>
    <form class="settings-form" @submit.prevent="provision">
      <label>Computer ID<input v-model.trim="hostId" required autocomplete="off"></label>
      <label>Installation ID<input v-model.trim="installationId" required autocomplete="off"></label>
      <label>Allowed rooms <small>Room IDs, separated by commas</small><textarea v-model="rooms" required /></label>
      <label>Allowed agents <small>Agent keys, separated by commas</small><textarea v-model="agents" required /></label>
      <p v-if="feedback" class="surface-subtitle">{{ feedback }}</p>
      <button v-if="!metadata" class="primary-button" :disabled="busy || !hostId || !installationId" type="submit">{{ busy ? "Connecting…" : "Connect this Mac" }}</button>
      <button v-else class="ghost-button" :disabled="busy" type="button" @click="revoke">{{ busy ? "Disconnecting…" : "Remove access" }}</button>
    </form>
    </details>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { DesktopSupervisorGrantMetadata } from "../../../../../../electron/ipc-types";

const metadata = ref<DesktopSupervisorGrantMetadata | null>(null);
const hostId = ref(""); const installationId = ref(""); const rooms = ref(""); const agents = ref("");
const busy = ref(false); const feedback = ref("");
const split = (value: string) => [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
onMounted(async () => { metadata.value = await window.letagentsDesktop.supervisorGrant.get(); });
async function provision() {
  busy.value = true; feedback.value = "";
  try {
    metadata.value = await window.letagentsDesktop.supervisorGrant.provision({ hostId: hostId.value, installationId: installationId.value, allowedRoomIds: split(rooms.value), allowedAgentKeys: split(agents.value) });
    feedback.value = "This Mac is connected. Access credentials are saved in Keychain.";
  } catch (error) { feedback.value = error instanceof Error ? error.message : "Could not connect this Mac. Check the setup details and try again."; }
  finally { busy.value = false; }
}
async function revoke() {
  busy.value = true; feedback.value = "";
  try { await window.letagentsDesktop.supervisorGrant.revoke(); metadata.value = null; feedback.value = "Access removed from this Mac and Keychain."; }
  catch (error) { feedback.value = error instanceof Error ? error.message : "Could not remove access. Try again."; }
  finally { busy.value = false; }
}
</script>
