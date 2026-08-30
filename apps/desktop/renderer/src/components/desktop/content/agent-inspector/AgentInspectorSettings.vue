<template>
  <div class="agent-inspector-settings">
    <p v-if="resource.status === 'unavailable'" class="agent-inspector-settings-note" role="status">{{ resource.error || 'Inspector settings are unavailable in this desktop supervisor.' }}</p>
    <p v-else-if="(resource.status === 'idle' || resource.status === 'loading') && !resource.configuration" class="agent-inspector-settings-note" role="status">Loading saved configuration…</p>
    <section v-else-if="resource.status === 'error' && !resource.configuration" class="agent-inspector-settings-load-error" role="alert">
      <strong>Couldn’t load saved configuration.</strong>
      <p>{{ resource.error || "The desktop supervisor could not return this agent’s settings." }}</p>
      <button type="button" :disabled="busy" @click="emit('reload')">Retry</button>
    </section>
    <template v-else-if="resource.configuration && resource.draft">
      <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-config-title">
        <div class="agent-inspector-section-heading"><p id="agent-inspector-config-title">Configuration</p><span>Saved revision {{ resource.configuration.configRevision }}</span></div>
        <p class="agent-inspector-settings-note" :data-tone="runtimeLag ? 'warning' : 'status'">
          <template v-if="runtimeLag">Saved revision {{ resource.configuration.configRevision }} is pending runtime application; the running provider has applied revision {{ resource.configuration.runtimeConfigurationRevision }}.</template>
          <template v-else>Runtime has applied saved revision {{ resource.configuration.runtimeConfigurationRevision }}.</template>
        </p>
        <label class="agent-inspector-field"><span>Provider</span><input :value="resource.configuration.provider" readonly aria-readonly="true" /><small>Provider is fixed when this agent is created.</small></label>
        <label class="agent-inspector-field"><span>Model</span><input :value="resource.draft.model || ''" :disabled="busy || !settingsEditable || !canEditModel" placeholder="Provider default" @input="patch({ model: ($event.target as HTMLInputElement).value.trim() || null })" /><small v-if="!canEditModel">{{ provider ? 'This provider does not expose a managed model control.' : 'Provider capabilities are unavailable.' }}</small></label>
        <label v-if="canEditEffort" class="agent-inspector-field"><span>Reasoning effort</span><select :value="resource.draft.reasoningEffort || ''" :disabled="busy || !settingsEditable" @change="patch({ reasoningEffort: (($event.target as HTMLSelectElement).value || null) as any })"><option v-for="option in inspectorEffortOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
        <label class="agent-inspector-field"><span>Initial message</span><textarea :value="resource.draft.charter" rows="4" readonly aria-readonly="true"></textarea><small>For newly created agents, this is queued once at creation. It is never injected into later room messages.</small></label>
        <fieldset v-if="resource.configuration.supervisedPermissionProfiles.length" class="agent-inspector-permissions" :disabled="busy || !settingsEditable" :aria-describedby="'agent-inspector-permission-detail'">
          <legend>Permissions</legend>
          <p id="agent-inspector-permission-detail" class="agent-inspector-settings-note">Choose the access level for future provider starts. LetAgents applies the matching native policy when you save.</p>
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
              <small v-if="profile.status !== 'available'">{{ profile.detail || (profile.status === 'gated' ? 'Unavailable until its provider requirement is met.' : 'Unavailable for this provider.') }}</small>
            </span>
          </label>
        </fieldset>
        <p v-if="resource.status === 'error'" class="agent-inspector-settings-error" role="alert">{{ resource.error }}</p>
        <div v-if="conflict" class="agent-inspector-conflict" role="alert"><strong>Saved configuration changed elsewhere.</strong><p>Your draft is preserved. Reload replaces it with revision {{ resource.configuration.configRevision }}; Overwrite saves your draft against that revision.</p><button type="button" :disabled="busy" @click="emit('reload')">Reload</button><button type="button" class="primary" :disabled="busy || !settingsEditable || !validDraft" @click="emit('save', true)">Overwrite</button></div>
        <div v-else class="agent-inspector-settings-actions"><button type="button" :disabled="busy || !settingsEditable || !validDraft" @click="emit('save', false)">{{ busy ? 'Saving…' : 'Save changes' }}</button><button type="button" :disabled="busy" @click="emit('reload')">Reload</button></div>
      </section>

      <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-move-title">
        <div class="agent-inspector-section-heading"><p id="agent-inspector-move-title">Move room</p></div>
        <p v-if="!moveAvailable || move.status === 'unavailable'" class="agent-inspector-settings-note">{{ move.error || AGENT_INSPECTOR_ROOM_MOVE_UNAVAILABLE }}</p>
        <template v-else>
          <p class="agent-inspector-settings-note">Moves are journaled before room membership changes. Any nonterminal move is rediscovered and resumed when Settings reopens.</p>
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
        <p>Retire stops this saved agent while retaining its history and worktree. Purge removes durable agent records but never deletes its worktree.</p>
        <template v-if="!retired">
          <button v-if="!confirmRetire" type="button" class="danger" :disabled="busy" @click="confirmRetire = true">Retire agent</button>
          <div v-else class="agent-inspector-retire-confirmation" role="alert">
            <p>{{ AGENT_INSPECTOR_RETIRE_CONFIRMATION }}</p>
            <button type="button" :disabled="busy" @click="confirmRetireAgent">Confirm retire agent</button>
            <button type="button" :disabled="busy" @click="confirmRetire = false">Cancel</button>
          </div>
        </template>
        <div v-if="retired" class="agent-inspector-purge">
          <label class="agent-inspector-field"><span>Type <code>PURGE {{ entryId }}</code> to remove durable records</span><input v-model="purgeConfirmation" autocomplete="off" :disabled="busy" /></label>
          <p v-if="workspacePath">Worktree preserved: <code>{{ workspacePath }}</code></p>
          <button type="button" class="danger" :disabled="busy || purgeConfirmation !== `PURGE ${entryId}`" @click="emit('purge')">Purge agent records</button>
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
const props = defineProps<{ entryId: string; workspacePath: string | null; retired: boolean; resource: AgentInspectorConfigurationResource; move: AgentInspectorRoomMoveResource; moveAvailable: boolean; providers: readonly DesktopAgentProvider[]; destinations: readonly DesktopFocusRoomInfo[]; busy: boolean; conflict: boolean }>();
const emit = defineEmits<{ patch: [patch: Partial<AgentInspectorConfigurationDraft>]; save: [overwrite: boolean]; reload: []; "prepare-move": [destination: string]; "commit-move": []; retire: []; purge: [] }>();
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
