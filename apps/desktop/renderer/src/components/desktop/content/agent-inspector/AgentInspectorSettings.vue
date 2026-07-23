<template>
  <div class="agent-inspector-settings">
    <p v-if="resource.status === 'unavailable'" class="agent-inspector-settings-note" role="status">{{ resource.error || 'Inspector settings are unavailable in this desktop supervisor.' }}</p>
    <p v-else-if="resource.status === 'loading' && !resource.configuration" class="agent-inspector-settings-note" role="status">Loading saved configuration…</p>
    <template v-else-if="resource.configuration && resource.draft">
      <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-config-title">
        <div class="agent-inspector-section-heading"><p id="agent-inspector-config-title">Configuration</p><span>Saved revision {{ resource.configuration.configRevision }}</span></div>
        <p class="agent-inspector-settings-note" :data-tone="runtimeLag ? 'warning' : 'status'">
          <template v-if="runtimeLag">Saved revision {{ resource.configuration.configRevision }} is pending runtime application; the running provider has applied revision {{ resource.configuration.runtimeConfigurationRevision }}.</template>
          <template v-else>Runtime has applied saved revision {{ resource.configuration.runtimeConfigurationRevision }}.</template>
        </p>
        <label class="agent-inspector-field"><span>Provider</span><input :value="resource.configuration.provider" readonly aria-readonly="true" /><small>Provider is fixed when this agent is created.</small></label>
        <label class="agent-inspector-field"><span>Model</span><input :value="resource.draft.model || ''" :disabled="!canEditModel" placeholder="Provider default" @input="patch({ model: ($event.target as HTMLInputElement).value.trim() || null })" /><small v-if="!canEditModel">{{ provider ? 'This provider does not expose a managed model control.' : 'Provider capabilities are unavailable.' }}</small></label>
        <label v-if="canEditEffort" class="agent-inspector-field"><span>Reasoning effort</span><select :value="resource.draft.reasoningEffort || ''" @change="patch({ reasoningEffort: (($event.target as HTMLSelectElement).value || null) as any })"><option v-for="option in inspectorEffortOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
        <label class="agent-inspector-field"><span>Charter</span><textarea :value="resource.draft.charter" rows="4" @input="patch({ charter: ($event.target as HTMLTextAreaElement).value })"></textarea></label>
        <fieldset v-if="provider?.permissionProfiles.length" class="agent-inspector-permissions"><legend>Permissions</legend><button v-for="profile in provider.permissionProfiles" :key="profile.id" type="button" :aria-pressed="resource.draft.permissionProfileId === profile.id" :disabled="profile.status !== 'available'" :data-selected="resource.draft.permissionProfileId === profile.id" @click="patch({ permissionProfileId: profile.id })"><strong>{{ profile.label }}</strong><small>{{ profile.status === 'available' ? profile.description : `${profile.status}: ${profile.detail || profile.description}` }}</small></button></fieldset>
        <p v-if="resource.status === 'error'" class="agent-inspector-settings-error" role="alert">{{ resource.error }}</p>
        <div v-if="conflict" class="agent-inspector-conflict" role="alert"><strong>Saved configuration changed elsewhere.</strong><p>Your draft is preserved. Reload replaces it with revision {{ resource.configuration.configRevision }}; Overwrite saves your draft against that revision.</p><button type="button" @click="emit('reload')">Reload</button><button type="button" class="primary" :disabled="busy || !validDraft" @click="emit('save', true)">Overwrite</button></div>
        <div v-else class="agent-inspector-settings-actions"><button type="button" :disabled="busy || !validDraft" @click="emit('save', false)">{{ busy ? 'Saving…' : 'Save changes' }}</button><button type="button" :disabled="busy" @click="emit('reload')">Reload</button></div>
      </section>

      <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-move-title">
        <div class="agent-inspector-section-heading"><p id="agent-inspector-move-title">Move room</p></div>
        <p class="agent-inspector-settings-note">A room move is journaled before it runs. This inspector will not change rooms until the daemon reports a completed move.</p>
        <label class="agent-inspector-field"><span>Destination room</span><select v-model="destination" :disabled="busy || Boolean(move?.move && !moveTerminal)"><option value="">Choose a room</option><option v-for="room in destinations" :key="room.identifier" :value="room.identifier">{{ room.displayName }}</option></select></label>
        <div v-if="move?.move" class="agent-inspector-move-status" :data-phase="move.move.phase" role="status"><strong>{{ movePresentation?.label }}</strong><span>{{ movePresentation?.detail }}</span></div>
        <p v-if="move?.error" class="agent-inspector-settings-error" role="alert">{{ move.error }}</p>
        <div class="agent-inspector-settings-actions"><button v-if="!move?.move || moveTerminal" type="button" :disabled="busy || !destination" @click="emit('prepare-move', destination)">Prepare move</button><button v-else type="button" :disabled="busy" @click="emit('commit-move')">{{ move?.status === 'recovering' ? 'Check recovery' : 'Continue move' }}</button></div>
      </section>

      <section class="agent-inspector-danger" aria-labelledby="agent-inspector-danger-title"><div class="agent-inspector-section-heading"><p id="agent-inspector-danger-title">Danger zone</p></div><p>Retire stops this saved agent while retaining its history and worktree. Purge removes durable agent records but never deletes its worktree.</p><button type="button" :disabled="busy || retired" @click="emit('retire')">Retire agent</button><div v-if="retired" class="agent-inspector-purge"><label class="agent-inspector-field"><span>Type <code>PURGE {{ entryId }}</code> to remove durable records</span><input v-model="purgeConfirmation" autocomplete="off" /></label><p v-if="workspacePath">Worktree preserved: <code>{{ workspacePath }}</code></p><button type="button" class="danger" :disabled="busy || purgeConfirmation !== `PURGE ${entryId}`" @click="emit('purge')">Purge agent records</button></div></section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { DesktopAgentProvider, DesktopFocusRoomInfo } from "../../../../../../electron/ipc-types";
import { configurationHasRuntimeLag, inspectorEffortOptions, roomMovePresentation, type AgentInspectorConfigurationDraft, type AgentInspectorConfigurationResource, type AgentInspectorRoomMoveResource } from "../../../../domain/agent-inspector-settings";
const props = defineProps<{ entryId: string; workspacePath: string | null; retired: boolean; resource: AgentInspectorConfigurationResource; move: AgentInspectorRoomMoveResource; providers: readonly DesktopAgentProvider[]; destinations: readonly DesktopFocusRoomInfo[]; busy: boolean; conflict: boolean }>();
const emit = defineEmits<{ patch: [patch: Partial<AgentInspectorConfigurationDraft>]; save: [overwrite: boolean]; reload: []; 'prepare-move': [destination: string]; 'commit-move': []; retire: []; purge: [] }>();
const destination = ref(""); const purgeConfirmation = ref("");
const provider = computed(() => props.providers.find((item) => item.id === props.resource.configuration?.provider) ?? null);
const canEditModel = computed(() => Boolean(provider.value?.capabilities.includes("desktop_managed_runtime")));
const canEditEffort = computed(() => provider.value?.id === "codex" || provider.value?.id === "claude-code");
const runtimeLag = computed(() => configurationHasRuntimeLag(props.resource.configuration));
const validDraft = computed(() => Boolean(props.resource.draft?.charter.trim()));
const movePresentation = computed(() => props.move.move ? roomMovePresentation(props.move.move) : null);
const moveTerminal = computed(() => Boolean(movePresentation.value?.terminal));
function patch(value: Partial<AgentInspectorConfigurationDraft>) { emit("patch", value); }
</script>
