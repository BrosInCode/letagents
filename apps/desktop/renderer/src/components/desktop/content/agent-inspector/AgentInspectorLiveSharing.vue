<template>
  <section class="agent-inspector-permissions agent-inspector-home-harness" aria-labelledby="agent-inspector-live-sharing-title">
    <div class="agent-inspector-home-harness-row">
      <strong id="agent-inspector-live-sharing-title">Share live activity with the room</strong>
      <DesktopSwitch
        v-if="!unavailableReason || shown"
        labelledby="agent-inspector-live-sharing-title"
        describedby="agent-inspector-live-sharing-description"
        test-id="agent-inspector-live-sharing"
        :checked="shown"
        :busy="saving"
        :disabled="shown ? false : disabled || unsavedEdits || Boolean(unavailableReason)"
        @toggle="toggle"
      />
    </div>
    <p v-if="unavailableReason" class="agent-inspector-settings-note">{{ unavailableReason }}</p>
    <template v-if="!unavailableReason || shown">
      <p id="agent-inspector-live-sharing-description" class="agent-inspector-settings-note">{{ LIVE_SHARING_DESCRIPTION }}</p>
      <p class="agent-inspector-settings-note" data-testid="agent-inspector-live-sharing-state">{{ shown ? LIVE_SHARING_ON_NOTE : LIVE_SHARING_OFF_NOTE }}</p>
      <p v-if="unsavedEdits && !shown" class="agent-inspector-settings-note">Save or reload your other changes before turning this on.</p>
      <p class="sr-only" role="status">{{ saving ? "Saving…" : "" }}</p>
      <p v-if="error" class="agent-inspector-settings-error" role="alert">{{ error }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { DesktopSupervisorAgentConfiguration } from "../../../../../../electron/ipc-types";
import {
  LIVE_SHARING_DESCRIPTION,
  LIVE_SHARING_OFF_NOTE,
  LIVE_SHARING_ON_NOTE,
  liveSharingUnavailableReason,
} from "../../../../domain/agent-live-sharing";
import { desktopIpc } from "../../../../ipc";
import DesktopSwitch from "../../controls/DesktopSwitch.vue";

/**
 * Lets the owner share this one agent's live activity with its room. Off
 * until the owner turns it on. It is saved on its own, straight away, through
 * a request the desktop app signs: it is not part of the draft that Save
 * changes sends, and the agent keeps running. Turning it off is always
 * possible, whatever else the settings are doing.
 */
const props = defineProps<{
  configuration: DesktopSupervisorAgentConfiguration;
  state: NonNullable<DesktopSupervisorAgentConfiguration["liveSharing"]>;
  /** The agent's other settings cannot be changed right now. */
  disabled: boolean;
  /** Reloading after a change would throw away edits that are not saved yet. */
  unsavedEdits: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();

const saving = ref(false);
const pending = ref<boolean | null>(null);
const error = ref<string | null>(null);
let requestEpoch = 0;

const unavailableReason = computed(() => liveSharingUnavailableReason(props.state));
const shown = computed(() => pending.value ?? props.state.enabled);

async function toggle(): Promise<void> {
  const set = desktopIpc.supervisor?.setAgentLiveSharing;
  const enabled = !shown.value;
  if (!set || saving.value) return;
  if (enabled && (props.disabled || props.unsavedEdits || unavailableReason.value)) return;
  const epoch = ++requestEpoch;
  pending.value = enabled;
  saving.value = true;
  error.value = null;
  try {
    const result = await set({
      entryId: props.configuration.entryId,
      daemonGeneration: props.configuration.daemonGeneration,
      enabled,
    });
    if (epoch !== requestEpoch) return;
    if (result.outcome === "invalid") {
      error.value = result.error;
      pending.value = null;
    }
    // The saved settings are the truth either way; with edits not saved yet,
    // they are read again when those edits are saved or thrown away.
    if (!props.unsavedEdits) emit("changed");
  } catch {
    if (epoch !== requestEpoch) return;
    error.value = "Couldn’t change this. Reload the settings to check it, then try again.";
    pending.value = null;
  } finally {
    if (epoch === requestEpoch) saving.value = false;
  }
}

// The reloaded settings replace the optimistic value.
watch(() => [props.configuration.entryId, props.configuration.configRevision, props.state.enabled], (next, previous) => {
  pending.value = null;
  if (next[0] !== previous[0]) { requestEpoch++; saving.value = false; error.value = null; }
});
onBeforeUnmount(() => { requestEpoch++; });
</script>
