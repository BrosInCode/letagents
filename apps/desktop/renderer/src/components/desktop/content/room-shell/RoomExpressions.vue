<template>
  <div class="room-settings-row" data-inline="true" data-testid="room-expressions" :aria-busy="busy">
    <div class="room-settings-row-copy">
      <p id="room-settings-expressions-title" class="room-settings-row-title">
        GIFs and agent reactions <span class="room-settings-pill">Beta</span>
      </p>
      <Transition name="room-settings-text" mode="out-in">
        <p
          id="room-settings-expressions-description"
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
        labelledby="room-settings-expressions-title"
        describedby="room-settings-expressions-description"
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
import type { RoomExpressionsSetting } from "../../../../../../../../shared/room-expressions.mjs";
import { desktopIpc } from "../../../../ipc/index";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";

const props = defineProps<{ roomIdentifier: string }>();
const emit = defineEmits<{ summary: [text: string | null] }>();
const settings = ref<RoomExpressionsSetting | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
// The switch answers the click at once; the saved value replaces it, so a
// failed save slides back.
const pendingEnabled = ref<boolean | null>(null);
let generation = 0;

const description = computed(() => {
  if (error.value) return error.value;
  if (!settings.value) return "Loading expressions…";
  if (!settings.value.can_manage) return "Only room admins can change this setting.";
  if (!settings.value.gif_provider_configured) return "Agent reactions are available. GIF search needs the server’s GIPHY key.";
  return "People and agents can share GIFs, and agents can react under their own names. Expressions are optional; turning this off keeps existing messages and reactions.";
});

async function load(): Promise<void> {
  const version = ++generation;
  settings.value = null;
  error.value = null;
  busy.value = false;
  pendingEnabled.value = null;
  try {
    const value = await desktopIpc.room.getExpressions(props.roomIdentifier);
    if (generation === version) settings.value = value;
  } catch (cause) {
    if (generation === version) error.value = safeUserVisibleErrorDetail(cause, "Expressions could not be loaded.");
  }
}

async function toggle(): Promise<void> {
  if (!settings.value?.can_manage || busy.value) return;
  const version = generation;
  busy.value = true;
  error.value = null;
  pendingEnabled.value = !settings.value.enabled;
  try {
    const value = await desktopIpc.room.setExpressions(props.roomIdentifier, pendingEnabled.value);
    if (generation === version) { settings.value = value; window.dispatchEvent(new Event("letagents:expressions-changed")); }
  } catch (cause) {
    if (generation === version) error.value = safeUserVisibleErrorDetail(cause, "Expressions could not be saved.");
  } finally {
    if (generation === version) {
      busy.value = false;
      pendingEnabled.value = null;
    }
  }
}

watch(() => props.roomIdentifier, load, { immediate: true, flush: "sync" });
watch(settings, (value) => {
  emit("summary", value ? (value.enabled ? "Expressions" : null) : null);
}, { immediate: true });
onBeforeUnmount(() => { generation++; });
</script>
