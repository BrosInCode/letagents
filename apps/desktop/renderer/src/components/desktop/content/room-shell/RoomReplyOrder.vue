<template>
  <div class="room-settings-row" data-inline="true" data-testid="room-reply-order" :aria-busy="busy">
    <div class="room-settings-row-copy">
      <p id="room-settings-reply-order-title" class="room-settings-row-title">
        Answer in turns <span class="room-settings-pill">Beta</span>
      </p>
      <Transition name="room-settings-text" mode="out-in">
        <p
          id="room-settings-reply-order-description"
          :key="description"
          class="room-settings-row-description"
          :data-tone="error ? 'error' : undefined"
          :role="error ? 'alert' : undefined"
        >{{ description }}</p>
      </Transition>
      <p class="sr-only" role="status">{{ busy ? "Saving…" : "" }}</p>
    </div>
    <div class="room-settings-row-action">
      <DesktopSwitch
        v-if="settings"
        labelledby="room-settings-reply-order-title"
        describedby="room-settings-reply-order-description"
        :checked="pendingEnabled ?? settings.enabled"
        :disabled="!settings.can_manage"
        :busy="busy"
        @toggle="toggle"
      />
      <button v-else-if="error" class="room-settings-button" type="button" @click="load">Try again</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import DesktopSwitch from "../../controls/DesktopSwitch.vue";
import type { DesktopReplyOrderSettings } from "../../../../../../electron/ipc-types/api";
import { desktopIpc } from "../../../../ipc/index";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";

const props = defineProps<{ roomIdentifier: string }>();
const emit = defineEmits<{ summary: [text: string | null] }>();
const settings = ref<DesktopReplyOrderSettings | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
// The switch answers the click at once; the saved value replaces it, so a
// failed save slides back.
const pendingEnabled = ref<boolean | null>(null);
let generation = 0;

const description = computed(() => {
  if (error.value) return error.value;
  if (!settings.value) return "Loading reply order…";
  if (!settings.value.can_manage) return "Only room admins can change this setting.";
  return "Agents who are all asked the same question answer one after another, each building on the earlier replies.";
});

async function load(): Promise<void> {
  const version = ++generation;
  settings.value = null;
  error.value = null;
  busy.value = false;
  pendingEnabled.value = null;
  try {
    const value = await desktopIpc.room.getReplyOrder(props.roomIdentifier);
    if (generation === version) settings.value = value;
  } catch (cause) {
    if (generation === version) error.value = safeUserVisibleErrorDetail(cause, "Reply order could not be loaded.");
  }
}

async function toggle(): Promise<void> {
  if (!settings.value?.can_manage || busy.value) return;
  const version = generation;
  busy.value = true;
  error.value = null;
  pendingEnabled.value = !settings.value.enabled;
  try {
    const value = await desktopIpc.room.setReplyOrder(props.roomIdentifier, pendingEnabled.value);
    if (generation === version) settings.value = value;
  } catch (cause) {
    if (generation === version) error.value = safeUserVisibleErrorDetail(cause, "Reply order could not be saved.");
  } finally {
    if (generation === version) {
      busy.value = false;
      pendingEnabled.value = null;
    }
  }
}

watch(() => props.roomIdentifier, load, { immediate: true, flush: "sync" });
watch(settings, (value) => {
  emit("summary", value ? (value.enabled ? "In turns" : null) : null);
}, { immediate: true });
onBeforeUnmount(() => { generation++; });
</script>
