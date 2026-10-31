<template>
  <section class="agent-inspector-permissions agent-inspector-home-harness" aria-labelledby="agent-inspector-home-harness-title">
    <div class="agent-inspector-home-harness-row">
      <strong id="agent-inspector-home-harness-title">{{ homeHarnessTitle(configuration.provider) }}</strong>
      <DesktopSwitch
        v-if="!unavailableReason"
        labelledby="agent-inspector-home-harness-title"
        describedby="agent-inspector-home-harness-description"
        test-id="agent-inspector-home-harness"
        :checked="shown"
        :busy="saving"
        :disabled="disabled || unsavedEdits"
        @toggle="toggle"
      />
    </div>
    <p v-if="unavailableReason" class="agent-inspector-settings-note">{{ unavailableReason }}</p>
    <template v-else>
      <p id="agent-inspector-home-harness-description" class="agent-inspector-settings-note">
        {{ homeHarnessDescription(configuration.provider, configuration.permissionProfileId) }}
        {{ homeHarnessApprovalNote(configuration.provider, configuration.permissionProfileId) }}
        {{ homeHarnessLimitNote(configuration.provider) }}
      </p>
      <p
        class="agent-inspector-settings-note"
        :data-tone="roomWarning ? 'warning' : undefined"
        :role="roomWarning ? 'alert' : undefined"
        data-testid="agent-inspector-home-harness-room"
      >{{ homeHarnessRoomNote(audience) }}</p>
      <p class="agent-inspector-settings-note" data-testid="agent-inspector-home-harness-timing">{{ homeHarnessTimingNote(state) }}</p>
      <p
        v-if="restartNote"
        class="agent-inspector-settings-note"
        :data-tone="restartNote.warning ? 'warning' : undefined"
        role="status"
        data-testid="agent-inspector-home-harness-restart"
      >{{ restartNote.text }}</p>
      <p v-if="savedRulesNote" class="agent-inspector-settings-note" data-testid="agent-inspector-home-harness-rules">{{ savedRulesNote }}</p>
      <p v-if="unsavedEdits" class="agent-inspector-settings-note">Save or reload your other changes before changing this.</p>
      <p class="sr-only" role="status">{{ saving ? "Saving…" : "" }}</p>
      <p v-if="error" class="agent-inspector-settings-error" role="alert">{{ error }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import type { DesktopSupervisorAgentConfiguration } from "../../../../../../electron/ipc-types";
import {
  agentRoomAudienceKey,
  homeHarnessApprovalNote,
  homeHarnessDescription,
  homeHarnessLimitNote,
  homeHarnessRestartNote,
  homeHarnessRoomNote,
  homeHarnessSavedRulesNote,
  homeHarnessTimingNote,
  homeHarnessTitle,
  homeHarnessUnavailableReason,
  type AgentHomeHarnessState,
} from "../../../../domain/agent-home-harness";
import { desktopIpc } from "../../../../ipc";
import DesktopSwitch from "../../controls/DesktopSwitch.vue";

/**
 * Lets the owner turn their own provider setup on for this one agent. It is
 * saved on its own, straight away, through a request the desktop app signs:
 * it is not part of the draft that Save changes sends.
 */
const props = defineProps<{
  configuration: DesktopSupervisorAgentConfiguration;
  state: AgentHomeHarnessState;
  /** The agent's other settings cannot be changed right now. */
  disabled: boolean;
  /** Reloading after a change would throw away edits that are not saved yet. */
  unsavedEdits: boolean;
  /** How many tools this agent has under Always allowed. */
  savedRules?: number;
}>();
const emit = defineEmits<{ changed: [] }>();

const roomAudience = inject(agentRoomAudienceKey, null);
const audience = computed(() => roomAudience?.value ?? "private");
const saving = ref(false);
const pending = ref<boolean | null>(null);
const error = ref<string | null>(null);
const restartNote = ref<ReturnType<typeof homeHarnessRestartNote>>(null);
let requestEpoch = 0;

const savedRulesNote = computed(() => homeHarnessSavedRulesNote(props.savedRules ?? 0));
const unavailableReason = computed(() => homeHarnessUnavailableReason(props.state, props.configuration.provider));
const shown = computed(() => pending.value ?? props.state.enabled);
const roomWarning = computed(() => shown.value && audience.value !== "private");

async function toggle(): Promise<void> {
  const set = desktopIpc.supervisor?.setAgentHomeHarness;
  if (!set || saving.value || props.disabled || props.unsavedEdits) return;
  const epoch = ++requestEpoch;
  const enabled = !props.state.enabled;
  pending.value = enabled;
  saving.value = true;
  error.value = null;
  restartNote.value = null;
  try {
    const result = await set({
      entryId: props.configuration.entryId,
      daemonGeneration: props.configuration.daemonGeneration,
      expectedRevision: props.configuration.configRevision,
      enabled,
    });
    if (epoch !== requestEpoch) return;
    if (result.outcome === "invalid") {
      error.value = result.error;
      pending.value = null;
    } else if (result.outcome === "conflict") {
      error.value = "These settings were changed elsewhere, so nothing was changed. Try again.";
      pending.value = null;
    } else {
      restartNote.value = homeHarnessRestartNote(result.restart);
    }
    // The saved settings are the truth either way.
    emit("changed");
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
  if (next[0] !== previous[0]) { requestEpoch++; saving.value = false; error.value = null; restartNote.value = null; }
});
onBeforeUnmount(() => { requestEpoch++; });
</script>
