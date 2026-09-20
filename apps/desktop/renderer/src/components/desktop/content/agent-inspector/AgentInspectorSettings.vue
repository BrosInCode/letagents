<template>
  <div class="agent-inspector-settings">
    <p v-if="resource.status === 'unavailable'" class="agent-inspector-settings-note" role="status">{{ resource.error || 'Agent settings are unavailable. Update LetAgents and try again.' }}</p>
    <p v-else-if="(resource.status === 'idle' || resource.status === 'loading') && !resource.configuration" class="agent-inspector-settings-note" role="status">Loading settings…</p>
    <section v-else-if="resource.status === 'error' && !resource.configuration" class="agent-inspector-settings-load-error" role="alert">
      <strong>Couldn’t load settings.</strong>
      <p>{{ resource.error || "Try loading this agent’s settings again." }}</p>
      <button type="button" :disabled="busy" @click="emit('reload')">Retry</button>
    </section>
    <template v-else-if="resource.configuration && resource.draft">
      <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-config-title">
        <div class="agent-inspector-section-heading"><p id="agent-inspector-config-title">Settings</p></div>
        <p class="agent-inspector-settings-note" :data-tone="runtimeLag ? 'warning' : 'status'">
          <template v-if="runtimeLag">Your changes are saved. Restart the agent to apply them.</template>
          <template v-else>The agent is using your saved settings.</template>
        </p>
        <div v-if="runtimeLag && !retired" class="agent-inspector-settings-actions">
          <button type="button" :disabled="busy || applyPending || !settingsEditable" @click="emit('apply')">{{ applyPending ? 'Restarting…' : 'Restart to apply changes' }}</button>
          <span class="agent-inspector-settings-note">Save your edits before restarting.</span>
        </div>
        <label class="agent-inspector-field"><span>Agent app</span><input :value="provider?.name || resource.configuration.provider" readonly aria-readonly="true" /><small>The agent app cannot be changed after creation.</small></label>
        <label class="agent-inspector-field"><span>Model</span><input :value="resource.draft.model || ''" :disabled="busy || !settingsEditable || !canEditModel" placeholder="Default model" @input="patch({ model: ($event.target as HTMLInputElement).value.trim() || null })" /><small v-if="!canEditModel">{{ provider ? 'The model cannot be changed for this agent.' : 'Available models could not be checked.' }}</small></label>
        <label v-if="canEditEffort" class="agent-inspector-field"><span>Reasoning effort</span><select :value="resource.draft.reasoningEffort || ''" :disabled="busy || !settingsEditable" @change="patch({ reasoningEffort: (($event.target as HTMLSelectElement).value || null) as any })"><option v-for="option in inspectorEffortOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
        <label class="agent-inspector-field"><span>Initial message</span><textarea :value="resource.draft.charter" rows="4" readonly aria-readonly="true"></textarea><small>The first message sent when this agent was created.</small></label>
        <fieldset v-if="resource.configuration.supervisedPermissionProfiles.length" class="agent-inspector-permissions" :disabled="busy || !settingsEditable" :aria-describedby="'agent-inspector-permission-detail'">
          <legend>Permissions</legend>
          <p id="agent-inspector-permission-detail" class="agent-inspector-settings-note">Choose what the agent can access the next time it starts.</p>
          <label v-for="profile in resource.configuration.supervisedPermissionProfiles" :key="profile.id" class="agent-inspector-permission-choice" :data-selected="resource.draft.permissionProfileId === profile.id" :data-state="profile.status">
            <input
              type="radio"
              name="agent-inspector-permission-profile"
              :value="profile.id"
              :checked="resource.draft.permissionProfileId === profile.id"
              :disabled="profile.status !== 'available'"
              @change="patch({ permissionProfileId: profile.id })"
            />
            <span>
              <strong>{{ profile.label }}</strong>
              <small>{{ resource.draft.permissionProfileId === profile.id ? `Selected · ${profile.description}` : profile.description }}</small>
              <small v-if="profile.detail || profile.status !== 'available'">{{ profile.detail || (profile.status === 'gated' ? 'This access option is not available yet.' : 'This agent app does not support this access option.') }}</small>
            </span>
          </label>
        </fieldset>
        <p v-if="resource.status === 'error'" class="agent-inspector-settings-error" role="alert">{{ resource.error }}</p>
        <div v-if="conflict" class="agent-inspector-conflict" role="alert"><strong>These settings were changed elsewhere.</strong><p>Your edits are still here. Reload to use the latest saved settings, or Overwrite to replace them with your edits.</p><button type="button" :disabled="busy" @click="emit('reload')">Reload</button><button type="button" class="primary" :disabled="busy || !settingsEditable || !validDraft" @click="emit('save', true)">Overwrite</button></div>
        <div v-else class="agent-inspector-settings-actions"><button type="button" :disabled="busy || !settingsEditable || !validDraft" @click="emit('save', false)">{{ busy ? 'Saving…' : 'Save changes' }}</button><button type="button" :disabled="busy" @click="emit('reload')">Reload</button></div>
      </section>

      <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-move-title">
        <div class="agent-inspector-section-heading"><p id="agent-inspector-move-title">Move room</p></div>
        <p v-if="!moveAvailable || move.status === 'unavailable'" class="agent-inspector-settings-note">{{ move.error || AGENT_INSPECTOR_ROOM_MOVE_UNAVAILABLE }}</p>
        <template v-else>
          <p class="agent-inspector-settings-note">If a move is interrupted, reopen these settings to resume it.</p>
          <p v-if="move.status === 'loading' && !move.move" class="agent-inspector-settings-note" role="status">Checking for a saved room move…</p>
          <label class="agent-inspector-field"><span>Destination room</span><select v-model="destination" :disabled="busy || move.status === 'loading' || Boolean(move.move && !moveTerminal)"><option value="">Choose a room</option><option v-for="room in destinations" :key="room.identifier" :value="room.identifier">{{ room.displayName }}</option></select></label>
          <div v-if="move.move" class="agent-inspector-move-status" :data-phase="move.move.phase" role="status"><strong>{{ movePresentation?.label }}</strong><span>{{ movePresentation?.detail }}</span></div>
          <p v-if="move.error" class="agent-inspector-settings-error" role="alert">{{ move.error }}</p>
          <div class="agent-inspector-settings-actions">
            <button v-if="!move.move || moveTerminal" type="button" :disabled="busy || move.status === 'loading' || !destination" @click="emit('prepare-move', destination)">Prepare move</button>
            <button v-else-if="move.move.phase === 'prepared'" type="button" :disabled="busy" @click="emit('commit-move')">Continue move</button>
            <span v-else class="agent-inspector-settings-note">Recovery continues automatically.</span>
          </div>
        </template>
      </section>

      <section class="agent-inspector-danger" aria-labelledby="agent-inspector-danger-title">
        <div class="agent-inspector-section-heading"><p id="agent-inspector-danger-title">Danger zone</p></div>
        <p>Retire stops the agent and keeps its history and files. After retiring, you can permanently delete its saved records. Its project files will remain.</p>
        <template v-if="!retired">
          <button v-if="!confirmRetire" type="button" class="danger" :disabled="busy" @click="confirmRetire = true">Retire agent</button>
          <div v-else class="agent-inspector-retire-confirmation" role="alert">
            <p>{{ AGENT_INSPECTOR_RETIRE_CONFIRMATION }}</p>
            <button type="button" :disabled="busy" @click="confirmRetireAgent">Confirm retire agent</button>
            <button type="button" :disabled="busy" @click="confirmRetire = false">Cancel</button>
          </div>
        </template>
        <div v-if="retired" class="agent-inspector-purge">
          <label class="agent-inspector-field"><span>Type <code>{{ displayName }}</code> to permanently delete this agent’s history and settings</span><input v-model="purgeConfirmation" autocomplete="off" :disabled="busy" /></label>
          <p v-if="workspacePath">Project files kept: <code>{{ workspacePath }}</code></p>
          <button type="button" class="danger" :disabled="busy || purgeConfirmation !== displayName" @click="emit('purge')">Delete history and settings</button>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DesktopAgentProvider, DesktopFocusRoomInfo } from "../../../../../../electron/ipc-types";
import {
  AGENT_INSPECTOR_RETIRE_CONFIRMATION,
  AGENT_INSPECTOR_ROOM_MOVE_UNAVAILABLE,
  agentInspectorProviderSupportsEffort,
  configurationHasRuntimeLag,
  inspectorEffortOptions,
  roomMovePresentation,
  type AgentInspectorConfigurationDraft,
  type AgentInspectorConfigurationResource,
  type AgentInspectorRoomMoveResource,
} from "../../../../domain/agent-inspector-settings";
const props = defineProps<{ entryId: string; displayName: string; workspacePath: string | null; retired: boolean; resource: AgentInspectorConfigurationResource; move: AgentInspectorRoomMoveResource; moveAvailable: boolean; providers: readonly DesktopAgentProvider[]; destinations: readonly DesktopFocusRoomInfo[]; busy: boolean; applyPending: boolean; conflict: boolean }>();
const emit = defineEmits<{ patch: [patch: Partial<AgentInspectorConfigurationDraft>]; save: [overwrite: boolean]; apply: []; reload: []; "prepare-move": [destination: string]; "commit-move": []; retire: []; purge: [] }>();
const destination = ref(""); const purgeConfirmation = ref(""); const confirmRetire = ref(false);
const provider = computed(() => props.providers.find((item) => item.id === props.resource.configuration?.provider) ?? null);
const canEditModel = computed(() => Boolean(provider.value?.capabilities.includes("desktop_managed_runtime")));
const canEditEffort = computed(() => agentInspectorProviderSupportsEffort(provider.value?.id));
const runtimeLag = computed(() => configurationHasRuntimeLag(props.resource.configuration));
const settingsEditable = computed(() => props.resource.status === "ready");
const validDraft = computed(() => Boolean(props.resource.draft));
const movePresentation = computed(() => props.move.move ? roomMovePresentation(props.move.move) : null);
const moveTerminal = computed(() => Boolean(movePresentation.value?.terminal));
function patch(value: Partial<AgentInspectorConfigurationDraft>) { emit("patch", value); }
function confirmRetireAgent(): void { confirmRetire.value = false; emit("retire"); }
watch(() => props.entryId, () => { destination.value = ""; purgeConfirmation.value = ""; confirmRetire.value = false; });
</script>
