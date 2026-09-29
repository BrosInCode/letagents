<template>
  <div class="desktop-room-property-row" data-testid="room-conversation-routing" :aria-busy="busy">
    <span class="desktop-room-action-icon is-blue" aria-hidden="true"><Sparkles :size="22" /></span>
    <span class="desktop-room-property-copy">
      <strong>Smart conversation routing · Beta</strong>
      <small v-if="error" role="alert">{{ error }}</small>
      <small v-else-if="!settings">Loading routing settings…</small>
      <small v-else-if="!settings.available">Jev is currently unavailable. Standard routing is active.</small>
      <small v-else-if="!settings.can_manage">Only room admins can change this setting.</small>
    </span>
    <button
      v-if="settings"
      class="routing-switch"
      type="button"
      role="switch"
      aria-label="Smart conversation routing"
      :aria-checked="settings.enabled"
      :disabled="busy || !settings.can_manage || (!settings.enabled && !settings.available)"
      @click="toggle"
    >
      <span class="desktop-room-toggle" :data-active="settings.enabled"><span /></span>
      <span>{{ busy ? "Saving…" : settings.enabled ? "On" : "Off" }}</span>
    </button>
    <button v-else-if="error" type="button" @click="load">Retry</button>
  </div>
</template>

<script setup lang="ts">
import { Sparkles } from "@lucide/vue";
import { onBeforeUnmount, ref, watch } from "vue";
import type { DesktopConversationRoutingSettings } from "../../../../../../electron/ipc-types/api";
import { desktopIpc } from "../../../../ipc/index";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";

const props = defineProps<{ roomIdentifier: string }>();
const settings = ref<DesktopConversationRoutingSettings | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
let generation = 0;

async function load(): Promise<void> {
  const version = ++generation;
  settings.value = null;
  error.value = null;
  busy.value = false;
  try {
    const value = await desktopIpc.room.getConversationRouting(props.roomIdentifier);
    if (generation === version) settings.value = value;
  } catch (cause) {
    if (generation === version) error.value = safeUserVisibleErrorDetail(cause, "Routing settings could not be loaded.");
  }
}

async function toggle(): Promise<void> {
  if (!settings.value?.can_manage || busy.value) return;
  const version = generation;
  busy.value = true;
  error.value = null;
  try {
    const value = await desktopIpc.room.setConversationRouting(props.roomIdentifier, !settings.value.enabled);
    if (generation === version) settings.value = value;
  } catch (cause) {
    if (generation === version) error.value = safeUserVisibleErrorDetail(cause, "Routing settings could not be saved.");
  } finally {
    if (generation === version) busy.value = false;
  }
}

watch(() => props.roomIdentifier, load, { immediate: true, flush: "sync" });
onBeforeUnmount(() => { generation++; });
</script>

<style scoped>
.routing-switch {
  display: grid;
  justify-items: center;
  gap: 4px;
  padding: 4px;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 0.76rem;
  cursor: pointer;
}
.routing-switch:disabled { opacity: 0.5; cursor: default; }
.routing-switch:focus-visible { outline: 2px solid var(--text-secondary); outline-offset: 3px; border-radius: 6px; }
</style>
