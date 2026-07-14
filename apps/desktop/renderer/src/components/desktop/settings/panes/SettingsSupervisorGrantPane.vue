<template>
  <section class="settings-panel" data-testid="settings-supervisor-grant-panel">
    <article class="surface-row">
      <div>
        <p class="surface-title">Host grant</p>
        <p class="surface-subtitle">This desktop keeps the credential in macOS Keychain. Only the selected rooms and agent identities can be supervised.</p>
      </div>
      <span class="state-pill" :data-state="metadata ? 'installed' : 'starting'">{{ metadata ? "provisioned" : "not provisioned" }}</span>
    </article>
    <form class="settings-form" @submit.prevent="provision">
      <label>Host ID<input v-model.trim="hostId" required autocomplete="off"></label>
      <label>Installation ID<input v-model.trim="installationId" required autocomplete="off"></label>
      <label>Allowed rooms <small>Comma-separated canonical room IDs</small><textarea v-model="rooms" required /></label>
      <label>Allowed agent identities <small>Comma-separated canonical keys</small><textarea v-model="agents" required /></label>
      <p v-if="feedback" class="surface-subtitle">{{ feedback }}</p>
      <button class="primary-button" :disabled="busy || !hostId || !installationId" type="submit">{{ busy ? "Provisioning" : "Provision host grant" }}</button>
    </form>
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
    feedback.value = "Host grant stored in Keychain.";
  } catch (error) { feedback.value = error instanceof Error ? error.message : "Host grant could not be provisioned."; }
  finally { busy.value = false; }
}
</script>
