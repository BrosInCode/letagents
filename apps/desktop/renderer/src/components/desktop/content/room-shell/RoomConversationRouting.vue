<template>
  <div class="room-settings-row" data-inline="true" data-testid="room-conversation-routing" :aria-busy="busy">
    <div class="room-settings-row-copy">
      <p id="room-settings-routing-title" class="room-settings-row-title">
        Smart conversation routing <span class="room-settings-pill">Beta</span>
      </p>
      <Transition name="room-settings-text" mode="out-in">
        <p
          id="room-settings-routing-description"
          :key="description"
          class="room-settings-row-description"
          :data-tone="error ? 'error' : undefined"
          :role="error ? 'alert' : undefined"
        >{{ description }}</p>
      </Transition>
      <p class="sr-only" role="status">{{ busy ? "Saving…" : "" }}</p>
    </div>
    <div class="room-settings-row-action">
      <button
        v-if="settings"
        class="room-settings-switch"
        type="button"
        role="switch"
        aria-labelledby="room-settings-routing-title"
        aria-describedby="room-settings-routing-description"
        :aria-checked="pendingEnabled ?? settings.enabled"
        :disabled="!settings.can_manage || (!settings.enabled && !settings.available)"
        :aria-disabled="busy"
        @click="toggle"
      >
        <span class="room-settings-switch-track"><span class="room-settings-switch-knob" /></span>
      </button>
      <button v-else-if="error" class="room-settings-button" type="button" @click="load">Try again</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { DesktopConversationRoutingSettings } from "../../../../../../electron/ipc-types/api";
import { desktopIpc } from "../../../../ipc/index";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";

const props = defineProps<{ roomIdentifier: string }>();
const emit = defineEmits<{ summary: [text: string | null] }>();
const settings = ref<DesktopConversationRoutingSettings | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
// The switch answers the click at once; the saved value replaces it, so a
// failed save slides back.
const pendingEnabled = ref<boolean | null>(null);
let generation = 0;

const description = computed(() => {
  if (error.value) return error.value;
  if (!settings.value) return "Loading routing settings…";
  if (!settings.value.available) return "Jev is currently unavailable. Standard routing is active.";
  if (!settings.value.can_manage) return "Only room admins can change this setting.";
  return "Picks which agent should answer a message that doesn't mention anyone.";
});

async function load(): Promise<void> {
  const version = ++generation;
  settings.value = null;
  error.value = null;
  busy.value = false;
  pendingEnabled.value = null;
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
  pendingEnabled.value = !settings.value.enabled;
  try {
    const value = await desktopIpc.room.setConversationRouting(props.roomIdentifier, pendingEnabled.value);
    if (generation === version) settings.value = value;
  } catch (cause) {
    if (generation === version) error.value = safeUserVisibleErrorDetail(cause, "Routing settings could not be saved.");
  } finally {
    if (generation === version) {
      busy.value = false;
      pendingEnabled.value = null;
    }
  }
}

watch(() => props.roomIdentifier, load, { immediate: true, flush: "sync" });
watch(settings, (value) => {
  emit("summary", value ? (value.enabled && value.available ? "Smart" : "Standard") : null);
}, { immediate: true });
onBeforeUnmount(() => { generation++; });
</script>
