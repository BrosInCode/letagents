<template>
  <div class="agent-inspector-settings">
    <p v-if="resource.status === 'unavailable'" class="agent-inspector-settings-note" role="status">{{ resource.error || 'Agent settings are unavailable. Update LetAgents and try again.' }}</p>
    <p v-else-if="(resource.status === 'idle' || resource.status === 'loading') && !resource.configuration" class="agent-inspector-settings-note" role="status">Loading settings…</p>
    <section v-else-if="resource.status === 'error' && !resource.configuration" class="agent-inspector-settings-load-error" role="alert">
      <strong>Couldn’t load settings.</strong>
      <p>{{ resource.error || "Try loading this agent’s settings again." }}</p>
      <button type="button" :disabled="busy" @click="reloadSettings">Retry</button>
    </section>
    <template v-else-if="resource.configuration && resource.draft">
      <section class="agent-inspector-settings-section" aria-labelledby="agent-inspector-config-title">
        <div class="agent-inspector-settings-heading">
          <h3 id="agent-inspector-config-title">Model &amp; effort</h3>
          <div class="agent-inspector-settings-heading-tools">
            <span>{{ provider?.name || resource.configuration.provider }}</span>
            <button class="agent-inspector-settings-refresh" type="button" aria-label="Reload settings" title="Reload settings" :disabled="busy || applyPending || unsavedEdits || conflict" @click="reloadSettings">
              <RefreshCw :size="15" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div class="agent-inspector-model-fields">
          <DesktopModelPicker
            id="agent-inspector-model"
            class="agent-inspector-picker"
            test-id="agent-inspector-model-picker"
            select-only
            :model-value="modelChoice"
            :options="modelChoices"
            :disabled="busy || !settingsEditable || !canEditModel"
            @update:model-value="chooseModel"
          />
          <DesktopModelPicker
            v-if="canEditEffort && effortChoices.length > 1"
            id="agent-inspector-effort"
            class="agent-inspector-picker"
            label="Reasoning effort"
            select-only
            :model-value="resource.draft.reasoningEffort || ''"
            :options="effortChoices"
            :disabled="busy || !settingsEditable"
            @update:model-value="chooseEffort"
          />
        </div>
        <label v-if="customModel" class="agent-inspector-field">
          <span>Custom model ID</span>
          <input :value="resource.draft.model || ''" :disabled="busy || !settingsEditable || !canEditModel" placeholder="Model ID" @input="patch({ model: ($event.target as HTMLInputElement).value.trim() || null })" />
        </label>
        <p v-if="modelLoading" class="agent-inspector-settings-note" role="status">Loading available models…</p>
        <p v-else-if="modelCatalogUnavailable && canEditModel" class="agent-inspector-settings-note" role="status">Model list unavailable. <button type="button" class="agent-inspector-settings-inline" @click="loadModels">Try again</button></p>
        <p v-else-if="!canEditModel" class="agent-inspector-settings-note">{{ provider ? 'The model cannot be changed for this agent.' : 'Available models could not be checked.' }}</p>
        <p v-if="runtimeLag || draftNeedsRestart" class="agent-inspector-settings-note">Changes that need a restart apply the next time the agent starts.</p>
      </section>

      <section v-if="resource.configuration.supervisedPermissionProfiles.length" class="agent-inspector-settings-section" aria-labelledby="agent-inspector-access-title">
        <div class="agent-inspector-settings-heading"><h3 id="agent-inspector-access-title">Permissions</h3></div>
        <p id="agent-inspector-permission-detail" class="agent-inspector-settings-note" :data-tone="permissionPending ? 'warning' : undefined" data-testid="agent-inspector-permission-timing">{{ permissionTimingNote(deliveryMode, permissionPending) }}</p>
        <fieldset class="agent-inspector-permissions" :disabled="busy || !settingsEditable" aria-describedby="agent-inspector-permission-detail">
          <legend class="sr-only">Permissions</legend>
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
              <small>{{ profile.description }}</small>
              <small v-if="profile.status !== 'available'">{{ profile.detail || 'Unavailable for this agent.' }}</small>
            </span>
          </label>
        </fieldset>
        <details v-if="selectedPermission && (selectedPermission.detail || profileLimits(selectedPermission))" class="agent-inspector-settings-disclosure">
          <summary><span>Details for {{ selectedPermission.label }}</span><ChevronRight :size="15" aria-hidden="true" /></summary>
          <div class="agent-inspector-disclosure-copy">
            <p v-if="selectedPermission.detail">{{ selectedPermission.detail }}</p>
            <p v-if="profileLimits(selectedPermission)">{{ profileLimits(selectedPermission) }}</p>
          </div>
        </details>
      </section>

      <section v-if="resource.draft.imageInput !== undefined || showHomeHarness || showLiveSharing" class="agent-inspector-settings-section" aria-labelledby="agent-inspector-capabilities-title">
        <div class="agent-inspector-settings-heading"><h3 id="agent-inspector-capabilities-title">Setup and sharing</h3></div>
        <section v-if="resource.draft.imageInput !== undefined" class="agent-inspector-settings-switch-row" aria-labelledby="agent-inspector-image-input-title">
          <div class="agent-inspector-home-harness-row">
            <strong id="agent-inspector-image-input-title">{{ IMAGE_INPUT_TITLE }}</strong>
            <DesktopSwitch
              labelledby="agent-inspector-image-input-title"
              describedby="agent-inspector-image-input-description"
              test-id="agent-inspector-image-input"
              :checked="resource.draft.imageInput === true"
              :disabled="busy || !settingsEditable"
              @toggle="patch({ imageInput: resource.draft.imageInput !== true })"
            />
          </div>
          <p id="agent-inspector-image-input-description" class="agent-inspector-settings-note">{{ IMAGE_INPUT_DESCRIPTION }}</p>
        </section>
        <AgentInspectorHomeHarness
          v-if="showHomeHarness && resource.configuration.homeHarness"
          :configuration="resource.configuration"
          :state="resource.configuration.homeHarness"
          :disabled="busy || !settingsEditable || retired"
          :unsaved-edits="unsavedEdits"
          :saved-rules="toolRules.length"
          @changed="reloadSettings"
        />
        <AgentInspectorLiveSharing
          v-if="showLiveSharing && resource.configuration.liveSharing"
          :configuration="resource.configuration"
          :state="resource.configuration.liveSharing"
          :disabled="busy || !settingsEditable || retired"
          :unsaved-edits="unsavedEdits"
          @changed="reloadSettings"
        />
      </section>

      <section v-if="desktopIpc.supervisor?.listHostToolRules" class="agent-inspector-settings-section" aria-labelledby="agent-inspector-rules-title">
        <div class="agent-inspector-settings-heading"><h3 id="agent-inspector-rules-title" ref="toolRulesHeading" tabindex="-1">Always allowed tools</h3></div>
        <p v-if="toolRulesLoading && !toolRules.length" class="agent-inspector-settings-note" role="status">Loading saved permissions…</p>
        <div v-if="toolRulesError" class="agent-inspector-settings-error" role="alert">
          {{ toolRulesError }}
          <button class="agent-inspector-settings-inline" type="button" :disabled="revokingRule !== null" @click="loadToolRules">Retry</button>
        </div>
        <p v-else-if="!toolRulesLoading && !toolRules.length" class="agent-inspector-settings-note">No saved tool permissions.</p>
        <ul v-if="toolRules.length" class="agent-inspector-tool-rules" aria-label="Saved tool permissions">
          <li v-for="rule in toolRules" :key="rule.id" class="agent-inspector-settings-row">
            <div class="agent-inspector-rule-copy">
              <strong>{{ rule.scope.toolLabel }}</strong>
              <small :id="`agent-inspector-rule-scope-${rule.id}`" :title='"kind" in rule.scope ? `${rule.scope.workAttemptId} · ${rule.scope.canonicalWorkspacePath}` : undefined'>{{ "kind" in rule.scope ? `Room ${rule.scope.roomId} · Workspace ${rule.scope.workAttemptId.slice(0, 8)}` : rule.scope.projectName }}</small>
            </div>
            <button class="agent-inspector-settings-inline agent-inspector-revoke" type="button" :aria-label="`Revoke permission for ${rule.scope.toolLabel}`" :aria-describedby="`agent-inspector-rule-scope-${rule.id}`" :disabled="revokingRule !== null" @click="revokeToolRule(rule, $event)">{{ revokingRule === rule.id ? 'Revoking…' : 'Revoke' }}</button>
          </li>
        </ul>
        <p v-if="toolRulesNotice" class="agent-inspector-settings-note" role="status">{{ toolRulesNotice }}</p>
      </section>

      <section class="agent-inspector-settings-section" aria-labelledby="agent-inspector-details-title">
        <div class="agent-inspector-settings-heading"><h3 id="agent-inspector-details-title">Initial message</h3></div>
        <details v-if="initialMessageIsLong" class="agent-inspector-settings-disclosure agent-inspector-message-disclosure">
          <summary><span>Read initial message</span><ChevronRight :size="15" aria-hidden="true" /></summary>
          <blockquote class="agent-inspector-initial-message">{{ initialMessage }}</blockquote>
        </details>
        <blockquote v-else-if="initialMessage" class="agent-inspector-initial-message">{{ initialMessage }}</blockquote>
        <p v-else class="agent-inspector-settings-note">No initial message was set.</p>
      </section>

      <section class="agent-inspector-settings-section" aria-labelledby="agent-inspector-move-title">
        <div class="agent-inspector-settings-heading"><h3 id="agent-inspector-move-title">Move room</h3></div>
        <p v-if="!moveAvailable || move.status === 'unavailable'" class="agent-inspector-settings-note">{{ move.error || AGENT_INSPECTOR_ROOM_MOVE_UNAVAILABLE }}</p>
        <template v-else>
          <p v-if="resource.configuration.homeHarness?.enabled" class="agent-inspector-settings-note" data-tone="warning" role="alert" data-testid="agent-inspector-move-own-setup">{{ homeHarnessMoveNote(resource.configuration.provider) }}</p>
          <p class="agent-inspector-settings-note">If a move is interrupted, reopen these settings to resume it.</p>
          <p v-if="move.status === 'loading' && !move.move" class="agent-inspector-settings-note" role="status">Checking for a saved room move…</p>
          <div class="agent-inspector-move-field">
            <DesktopModelPicker
              id="agent-inspector-destination"
              v-model="destination"
              label="Destination room"
              placeholder="Choose a room"
              select-only
              :options="destinationChoices"
              :disabled="busy || move.status === 'loading' || Boolean(move.move && !moveTerminal)"
            />
            <div class="agent-inspector-settings-actions">
              <button v-if="!move.move || moveTerminal" type="button" :disabled="busy || move.status === 'loading' || !destination" @click="emit('prepare-move', destination)">Prepare move</button>
              <button v-else-if="move.move.phase === 'prepared'" type="button" :disabled="busy" @click="emit('commit-move')">Continue move</button>
            </div>
          </div>
          <div v-if="move.move" class="agent-inspector-move-status" :data-phase="move.move.phase" role="status"><strong>{{ movePresentation?.label }}</strong><span>{{ movePresentation?.detail }}</span></div>
          <p v-if="move.error" class="agent-inspector-settings-error" role="alert">{{ move.error }}</p>
          <p v-if="move.move && !moveTerminal && move.move.phase !== 'prepared'" class="agent-inspector-settings-note">Recovery continues automatically.</p>
        </template>
      </section>

      <section class="agent-inspector-danger" aria-labelledby="agent-inspector-danger-title">
        <div class="agent-inspector-settings-row">
          <div>
            <div class="agent-inspector-settings-heading"><h3 id="agent-inspector-danger-title">Retirement</h3></div>
            <p class="agent-inspector-settings-note">{{ retired ? 'This agent is retired. Its saved history and project files are still available.' : 'Stop this agent and keep its history and project files.' }}</p>
          </div>
          <button v-if="!retired && !confirmRetire" type="button" class="danger" :disabled="busy" @click="confirmRetire = true">Retire agent</button>
        </div>
        <div v-if="!retired && confirmRetire" class="agent-inspector-retire-confirmation">
          <p role="alert">{{ AGENT_INSPECTOR_RETIRE_CONFIRMATION }}</p>
          <div class="agent-inspector-settings-actions">
            <button type="button" :disabled="busy" @click="confirmRetire = false">Cancel</button>
            <button type="button" class="danger" :disabled="busy" @click="confirmRetireAgent">Confirm retire agent</button>
          </div>
        </div>
        <div v-if="retired" class="agent-inspector-purge">
          <label class="agent-inspector-field"><span>Type <code>{{ displayName }}</code> to permanently delete this agent’s history and settings</span><input v-model="purgeConfirmation" autocomplete="off" :disabled="busy" /></label>
          <p v-if="workspacePath">Project files kept: <code>{{ workspacePath }}</code></p>
          <button type="button" class="danger" :disabled="busy || purgeConfirmation !== displayName" @click="emit('purge')">Delete history and settings</button>
        </div>
      </section>
      <div v-if="showFooter" class="agent-inspector-settings-footer">
        <p v-if="resource.status === 'error'" class="agent-inspector-settings-error" role="alert">{{ resource.error }}</p>
        <div v-if="conflict" class="agent-inspector-conflict" role="alert">
          <strong>These settings were changed elsewhere.</strong>
          <p>Your edits are still here. Reload to use the latest saved settings, or Overwrite to replace them with your edits.</p>
          <div class="agent-inspector-settings-actions">
            <button type="button" :disabled="busy" @click="reloadSettings">Reload</button>
            <button type="button" class="primary" :disabled="busy || !settingsEditable || !validDraft" @click="emit('save', true)">Overwrite</button>
          </div>
        </div>
        <div v-else class="agent-inspector-settings-actions">
          <span v-if="unsavedEdits || restartNeeded" class="agent-inspector-settings-status" role="status">{{ applyPending ? 'Applying changes…' : unsavedEdits ? 'Unsaved changes' : 'Restart needed' }}</span>
          <button v-if="unsavedEdits || resource.status === 'error'" type="button" class="agent-inspector-settings-inline" :disabled="busy || applyPending" @click="reloadSettings">{{ unsavedEdits ? 'Discard' : 'Reload' }}</button>
          <button v-if="unsavedEdits" type="button" :class="{ primary: !draftNeedsRestart }" :disabled="busy || applyPending || !settingsEditable || !validDraft" @click="emit('save', false)">Save changes</button>
          <button v-if="unsavedEdits && draftNeedsRestart && !retired" type="button" class="primary" :disabled="busy || applyPending || !settingsEditable || !validDraft" @click="emit('save', false, true)">Save &amp; restart</button>
          <button v-else-if="restartNeeded && !unsavedEdits" type="button" class="primary" :disabled="busy || applyPending || !settingsEditable" @click="emit('apply')">{{ applyPending ? 'Restarting…' : 'Restart to apply changes' }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ChevronRight, RefreshCw } from "@lucide/vue";
import type { DesktopAgentProvider, DesktopAgentProviderModelsResult, DesktopFocusRoomInfo, DesktopManagedAgentPermissionProfileId } from "../../../../../../electron/ipc-types";
import {
  AGENT_INSPECTOR_RETIRE_CONFIRMATION,
  AGENT_INSPECTOR_ROOM_MOVE_UNAVAILABLE,
  agentInspectorProviderSupportsEffort,
  configurationDraft,
  configurationHasRuntimeLag,
  IMAGE_INPUT_DESCRIPTION,
  IMAGE_INPUT_TITLE,
  inspectorEffortChoices,
  permissionTimingNote,
  roomMovePresentation,
  type AgentInspectorConfigurationDraft,
  type AgentInspectorConfigurationResource,
  type AgentInspectorRoomMoveResource,
} from "../../../../domain/agent-inspector-settings";
import { homeHarnessMoveNote } from "../../../../domain/agent-home-harness";
import { savedModelLabel } from "../../../../domain/claude-model-labels";
import { supervisedPermissionProfileLimits } from "../../../../domain/managed-agents";
import { desktopIpc } from "../../../../ipc";
import type { HostToolRule } from "../../../../../../shared/host-tool-rules";
import AgentInspectorHomeHarness from "./AgentInspectorHomeHarness.vue";
import DesktopModelPicker from "../../controls/DesktopModelPicker.vue";
import DesktopSwitch from "../../controls/DesktopSwitch.vue";
import AgentInspectorLiveSharing from "./AgentInspectorLiveSharing.vue";
const props = defineProps<{ entryId: string; displayName: string; workspacePath: string | null; retired: boolean; resource: AgentInspectorConfigurationResource; move: AgentInspectorRoomMoveResource; moveAvailable: boolean; providers: readonly DesktopAgentProvider[]; destinations: readonly DesktopFocusRoomInfo[]; busy: boolean; applyPending: boolean; conflict: boolean; deliveryMode?: string; permissionPending?: boolean }>();
const emit = defineEmits<{ patch: [patch: Partial<AgentInspectorConfigurationDraft>]; save: [overwrite: boolean, restart?: boolean]; apply: []; reload: []; "prepare-move": [destination: string]; "commit-move": []; retire: []; purge: [] }>();
const destination = ref(""); const purgeConfirmation = ref(""); const confirmRetire = ref(false);
const provider = computed(() => props.providers.find((item) => item.id === props.resource.configuration?.provider) ?? null);
const canEditModel = computed(() => Boolean(provider.value?.capabilities.includes("supervised_runtime")));
const customModel = ref(false);
const modelCatalog = ref<DesktopAgentProviderModelsResult | null>(null);
const modelLoading = ref(false);
const modelCatalogUnavailable = ref(false);
let modelRequest = 0;
const modelOptions = computed(() => modelCatalog.value?.status === "ready" ? modelCatalog.value.models : []);
const savedModelOption = computed(() => {
  const model = props.resource.draft?.model;
  return model && !modelOptions.value.some(option => option.id === model) ? model : null;
});
const modelChoices = computed(() => [
  { value: "", label: "Provider default" },
  ...modelOptions.value.map((option) => ({ value: "model:" + option.id, label: option.label })),
  ...(savedModelOption.value ? [{
    value: "model:" + savedModelOption.value,
    label: savedModelLabel(props.resource.configuration?.provider ?? "", savedModelOption.value),
  }] : []),
  { value: "custom", label: "Enter a model ID…" },
]);
const destinationChoices = computed(() => [
  { value: "", label: "Choose a room" },
  ...props.destinations.map((room) => ({ value: room.identifier, label: room.displayName })),
]);
const modelChoice = computed(() => customModel.value ? "custom" : props.resource.draft?.model ? "model:" + props.resource.draft.model : "");
const draftNeedsRestart = computed(() => {
  const { draft, configuration } = props.resource;
  return Boolean(draft && configuration && (draft.model !== configuration.model || draft.reasoningEffort !== configuration.reasoningEffort));
});
const selectedPermission = computed(() => props.resource.configuration?.supervisedPermissionProfiles.find(profile =>
  profile.id === props.resource.draft?.permissionProfileId));

async function loadModels(): Promise<void> {
  const request = ++modelRequest;
  const providerId = props.resource.configuration?.provider;
  const read = desktopIpc.workers?.listAgentProviderModels;
  modelCatalog.value = null;
  modelCatalogUnavailable.value = false;
  modelLoading.value = Boolean(providerId && read);
  if (!providerId || !read) {
    modelCatalogUnavailable.value = true;
    return;
  }
  try {
    const catalog = await read(providerId, props.workspacePath ? { repoRootPath: props.workspacePath } : undefined);
    if (request !== modelRequest) return;
    modelCatalog.value = catalog;
    modelCatalogUnavailable.value = catalog.status !== "ready";
  } catch {
    if (request === modelRequest) modelCatalogUnavailable.value = true;
  } finally {
    if (request === modelRequest) modelLoading.value = false;
  }
}
function chooseModel(value: string): void {
  customModel.value = value === "custom";
  if (customModel.value) {
    // A typed Antigravity id names its own thinking level, and no effort picker shows for it: a saved level would be hidden.
    if (props.resource.configuration?.provider === "antigravity" && props.resource.draft?.reasoningEffort) patch({ reasoningEffort: null });
    return;
  }
  const model = value ? value.slice("model:".length) : null;
  // An Antigravity model offers its own thinking levels: a saved level it lacks goes back to its default.
  const effort = props.resource.draft?.reasoningEffort ?? null;
  const supported = modelOptions.value.find((option) => option.id === model)?.supportedEfforts;
  const keepEffort = props.resource.configuration?.provider !== "antigravity" || !effort || Boolean(supported?.includes(effort));
  patch(keepEffort ? { model } : { model, reasoningEffort: null });
}

const effortChoices = computed(() => inspectorEffortChoices(
  props.resource.configuration?.provider,
  modelOptions.value.find((option) => option.id === props.resource.draft?.model) ?? null,
  props.resource.draft?.reasoningEffort,
));
function chooseEffort(value: string): void {
  const effort = effortChoices.value.find((option) => option.value === value);
  if (effort) patch({ reasoningEffort: effort.value || null });
}
watch(() => [props.entryId, props.resource.configuration?.provider, props.workspacePath] as const, () => {
  customModel.value = false;
  void loadModels();
}, { immediate: true });
onBeforeUnmount(() => { modelRequest++; });
const canEditEffort = computed(() => agentInspectorProviderSupportsEffort(provider.value?.id));
const runtimeLag = computed(() => configurationHasRuntimeLag(props.resource.configuration));
const restartNeeded = computed(() => runtimeLag.value && !props.retired);
const settingsEditable = computed(() => props.resource.status === "ready");
const showHomeHarness = computed(() => Boolean(props.resource.configuration?.homeHarness && desktopIpc.supervisor?.setAgentHomeHarness));
const showLiveSharing = computed(() => Boolean(props.resource.configuration?.liveSharing && desktopIpc.supervisor?.setAgentLiveSharing));
const initialMessage = computed(() => props.resource.draft?.charter.trim() ?? "");
const initialMessageIsLong = computed(() => initialMessage.value.length > 420 || initialMessage.value.split("\n").length > 6);
const validDraft = computed(() => Boolean(props.resource.draft));
const unsavedEdits = computed(() => {
  const { configuration, draft } = props.resource;
  if (!configuration || !draft) return false;
  const saved = configurationDraft(configuration);
  return (Object.keys(saved) as Array<keyof AgentInspectorConfigurationDraft>).some((key) => saved[key] !== draft[key]);
});
const showFooter = computed(() => props.conflict || props.resource.status === "error" || unsavedEdits.value || restartNeeded.value);
const movePresentation = computed(() => props.move.move ? roomMovePresentation(props.move.move) : null);
const moveTerminal = computed(() => Boolean(movePresentation.value?.terminal));
function patch(value: Partial<AgentInspectorConfigurationDraft>) { emit("patch", value); }
/** What an access level withholds, for this agent: its owner's own setup, when on, is outside those limits. */
function profileLimits(profile: { id: DesktopManagedAgentPermissionProfileId; status: "available" | "gated" | "unsupported" }): string | null {
  const configuration = props.resource.configuration;
  return configuration ? supervisedPermissionProfileLimits(configuration.provider, profile, configuration.homeHarness?.enabled === true) : null;
}
function confirmRetireAgent(): void { confirmRetire.value = false; emit("retire"); }
watch(() => props.entryId, () => { destination.value = ""; purgeConfirmation.value = ""; confirmRetire.value = false; });
const toolRules = ref<HostToolRule[]>([]);
const toolRulesLoading = ref(false);
const toolRulesError = ref<string | null>(null);
const toolRulesNotice = ref("");
const toolRulesHeading = ref<HTMLElement | null>(null);
const revokingRule = ref<string | null>(null);
let toolRulesEpoch = 0;
function reloadSettings(): void {
  customModel.value = false;
  emit("reload");
  void loadToolRules();
}
async function loadToolRules(): Promise<void> {
  if (revokingRule.value) return;
  const epoch = ++toolRulesEpoch;
  const read = desktopIpc.supervisor?.listHostToolRules;
  if (!read) return;
  toolRulesLoading.value = true;
  toolRulesError.value = null;
  try {
    const rules = await read(props.entryId);
    if (epoch === toolRulesEpoch) toolRules.value = rules;
  } catch {
    if (epoch === toolRulesEpoch) toolRulesError.value = "Couldn’t load saved permissions.";
  } finally { if (epoch === toolRulesEpoch) toolRulesLoading.value = false; }
}
async function revokeToolRule(rule: HostToolRule, event: MouseEvent): Promise<void> {
  const revoke = desktopIpc.supervisor?.revokeHostToolRule;
  if (!revoke || revokingRule.value) return;
  const button = event.currentTarget as HTMLButtonElement;
  const restoreFocus = document.activeElement === button;
  const entryId = props.entryId;
  const epoch = toolRulesEpoch;
  revokingRule.value = rule.id;
  toolRulesError.value = null;
  toolRulesNotice.value = "";
  try {
    await revoke({ agentId: props.entryId, ruleId: rule.id, revision: rule.revision });
    if (epoch !== toolRulesEpoch) return;
    revokingRule.value = null;
    toolRulesNotice.value = `Permission revoked for ${rule.scope.toolLabel}.`;
    await loadToolRules();
    await nextTick();
    if (restoreFocus && props.entryId === entryId && !button.isConnected && document.activeElement === document.body) {
      toolRulesHeading.value?.focus({ preventScroll: true });
    }
  } catch {
    if (epoch === toolRulesEpoch) toolRulesError.value = "Couldn’t revoke permission. Retry to check its state.";
  } finally { if (epoch === toolRulesEpoch) revokingRule.value = null; }
}
watch(() => props.entryId, () => {
  toolRules.value = [];
  revokingRule.value = null;
  toolRulesNotice.value = "";
  void loadToolRules();
}, { immediate: true });
onBeforeUnmount(() => { toolRulesEpoch++; });
</script>
