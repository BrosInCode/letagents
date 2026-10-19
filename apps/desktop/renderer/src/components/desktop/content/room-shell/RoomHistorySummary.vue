<template>
  <div class="room-settings-row" data-inline="true" data-testid="room-history-summary" :aria-busy="busy">
    <div class="room-settings-row-copy">
      <p id="room-settings-history-summary-title" class="room-settings-row-title">
        History summaries <span class="room-settings-pill">Beta</span>
      </p>
      <Transition name="room-settings-text" mode="out-in">
        <p
          id="room-settings-history-summary-description"
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
        labelledby="room-settings-history-summary-title"
        describedby="room-settings-history-summary-description"
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
import type { RoomHistorySummarySetting } from "../../../../../../../../shared/room-history-summary.mjs";
import { desktopIpc } from "../../../../ipc/index";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";

const props = defineProps<{ roomIdentifier: string }>();
const settings = ref<RoomHistorySummarySetting | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
// The switch answers the click at once; the saved value replaces it, so a
// failed save slides back.
const pendingEnabled = ref<boolean | null>(null);
let generation = 0;

const PURPOSE = "A small model summarizes this room’s messages so agents can catch up on its whole history.";

function retryTime(value: string | null): string {
  if (!value) return "soon";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "soon" : `at ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

const description = computed(() => {
  if (error.value) return error.value;
  const value = settings.value;
  if (!value) return "Loading history summaries…";
  const admins = value.can_manage ? "" : " Only room admins can change this setting.";
  switch (value.state) {
    case "off":
      return `Off. Agents read only recent messages.${admins}`;
    case "unavailable":
      return `On, but this server has no summarizer key, so nothing is summarized.${admins}`;
    case "waiting":
      return `${value.last_error ?? "The summarizer failed."} It tries again ${retryTime(value.retry_at)}.${admins}`;
    case "building":
      return `${PURPOSE} Summarizing (${value.summarized_messages} messages read).${admins}`;
    default:
      return `${PURPOSE} Up to date (${value.summarized_messages} messages).${admins}`;
  }
});

async function load(): Promise<void> {
  const version = ++generation;
  settings.value = null;
  error.value = null;
  busy.value = false;
  pendingEnabled.value = null;
  try {
    const value = await desktopIpc.room.getHistorySummarySetting(props.roomIdentifier);
    if (generation === version) settings.value = value;
  } catch (cause) {
    if (generation === version) error.value = safeUserVisibleErrorDetail(cause, "History summaries could not be loaded.");
  }
}

async function toggle(): Promise<void> {
  if (!settings.value?.can_manage || busy.value) return;
  const version = generation;
  busy.value = true;
  error.value = null;
  pendingEnabled.value = !settings.value.enabled;
  try {
    const value = await desktopIpc.room.setHistorySummarySetting(props.roomIdentifier, pendingEnabled.value);
    if (generation === version) settings.value = value;
  } catch (cause) {
    if (generation === version) error.value = safeUserVisibleErrorDetail(cause, "History summaries could not be saved.");
  } finally {
    if (generation === version) {
      busy.value = false;
      pendingEnabled.value = null;
    }
  }
}

watch(() => props.roomIdentifier, load, { immediate: true, flush: "sync" });
onBeforeUnmount(() => { generation++; });
</script>
