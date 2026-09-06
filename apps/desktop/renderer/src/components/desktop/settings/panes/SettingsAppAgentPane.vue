<template>
  <section class="settings-panel" data-testid="settings-app-agent-panel">
    <div class="settings-control-list">
      <SettingsRow
        title="App Agent"
        :description="appAgentStatusDescription"
        :badge="appAgentStatusLabel"
        :badge-state="appAgentBadgeState"
      />

      <SettingsRow
        title="Show App Agent"
        description="Show the floating assistant in the app. Off by default."
      >
        <template #action>
          <button
            class="secondary-button settings-action-button"
            type="button"
            role="switch"
            aria-label="Show App Agent"
            :aria-checked="appAgentSettings?.enabled === true"
            :disabled="appAgentBusy || !appAgentSettings"
            data-testid="settings-app-agent-enabled"
            @click="toggleAppAgent"
          >
            {{ appAgentSettings?.enabled === true ? "Disable" : "Enable" }}
          </button>
        </template>
      </SettingsRow>

      <SettingsRow
        title="Planner model"
        description="The model interprets intent and selects typed App Agent actions. Side effects still run through the app registry."
      >
        <label class="settings-field">
          <span>Model slug</span>
          <input
            v-model="appAgentModelDraft"
            type="text"
            placeholder="anthropic/claude-3.5-sonnet"
            autocomplete="off"
            data-testid="settings-app-agent-model"
          />
        </label>
      </SettingsRow>

      <SettingsRow
        title="Model provider key"
        :description="appAgentKeyDescription"
        :badge="appAgentSettings?.hasApiKey ? 'stored' : 'missing'"
        :badge-state="appAgentSettings?.hasApiKey ? 'connected' : 'offline'"
      >
        <label class="settings-field">
          <span>API key</span>
          <input
            v-model="appAgentApiKeyDraft"
            type="password"
            :placeholder="appAgentSettings?.hasApiKey ? 'Leave blank to keep saved key' : 'Provider API key'"
            autocomplete="off"
            data-testid="settings-app-agent-api-key"
          />
        </label>
      </SettingsRow>

      <SettingsRow
        title="Settings file"
        description="The key is encrypted before it is written when Electron secure storage is available."
      >
        <code>{{ appAgentSettings?.settingsPath || "Settings path unavailable" }}</code>
        <template #action>
          <button
            class="primary-button settings-action-button"
            type="button"
            :disabled="appAgentBusy"
            data-testid="settings-app-agent-save"
            @click="saveAppAgentSettings"
          >
            <Save aria-hidden="true" />
            <span>{{ appAgentBusy ? "Saving" : "Save" }}</span>
          </button>
        </template>
      </SettingsRow>
    </div>

    <div class="app-agent-registry-panel" data-testid="settings-app-agent-actions">
      <header class="app-agent-registry-header">
        <div>
          <p class="settings-section-kicker">Capabilities</p>
          <h3>What App Agent can do</h3>
          <p>
            Read-only view of the app actions this assistant can review and
            run for you.
          </p>
        </div>
        <span class="state-pill" data-state="installed">{{ appAgentActionCountLabel }}</span>
      </header>

      <div class="app-agent-action-list">
        <article
          v-for="action in sortedAppAgentActions"
          :key="action.id"
          class="app-agent-action-row"
          :data-risk="action.risk"
          :data-testid="`settings-app-agent-action-${slugify(action.id)}`"
        >
          <div class="app-agent-action-main">
            <div class="app-agent-action-title-line">
              <div class="app-agent-action-title-copy">
                <strong>{{ actionDisplayName(action) }}</strong>
                <span>{{ actionCapabilityName(action) }} · {{ actionCategoryLabel(action.category) }}</span>
              </div>
              <div class="app-agent-action-policies">
                <span class="state-pill" :data-state="actionRiskState(action.risk)">
                  {{ actionRiskLabel(action.risk) }}
                </span>
                <span class="state-pill" :data-state="action.requiresConfirmation ? 'starting' : 'connected'">
                  {{ action.requiresConfirmation ? "Asks first" : "Runs directly" }}
                </span>
              </div>
            </div>
            <p>{{ actionDisplayDescription(action) }}</p>
            <div class="app-agent-action-footer">
              <span>{{ actionRefreshTargetsLabel(action) }}</span>
            </div>
          </div>
        </article>

        <article v-if="!sortedAppAgentActions.length" class="surface-row single-line">
          <p class="surface-title">No App Agent actions are registered.</p>
        </article>
      </div>
    </div>

    <p
      v-if="appAgentFeedback"
      class="settings-feedback"
      :data-state="appAgentFeedback.state"
      data-testid="settings-app-agent-feedback"
    >
      {{ appAgentFeedback.message }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { Save } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import type {
  DesktopAppAgentActionMetadata,
  DesktopAppAgentSaveSettingsInput,
  DesktopAppAgentSettingsStatus,
} from "../../../../../../electron/ipc-types";
import {
  actionCapabilityName,
  actionCategoryLabel,
  actionDisplayDescription,
  actionDisplayName,
  actionRefreshTargetsLabel,
  actionRiskLabel,
  actionRiskState,
  slugify,
} from "../presentation";
import SettingsRow from "../SettingsRow.vue";
import type { SettingsFeedback } from "../types";

const props = defineProps<{
  appAgentActions: DesktopAppAgentActionMetadata[];
  appAgentBusy: boolean;
  appAgentFeedback: SettingsFeedback | null;
  appAgentSettings: DesktopAppAgentSettingsStatus | null;
}>();

const emit = defineEmits<{
  "save-app-agent-settings": [input: DesktopAppAgentSaveSettingsInput];
}>();

const appAgentModelDraft = ref("");
const appAgentApiKeyDraft = ref("");

watch(
  () => props.appAgentSettings?.model,
  (model) => {
    appAgentModelDraft.value = model || "";
    appAgentApiKeyDraft.value = "";
  },
  { immediate: true },
);

const appAgentStatusLabel = computed(() =>
  props.appAgentSettings?.configured ? "configured" : "setup needed",
);

const appAgentBadgeState = computed(() =>
  props.appAgentSettings?.configured ? "connected" : "offline",
);

const appAgentStatusDescription = computed(() => {
  if (props.appAgentSettings?.error) return props.appAgentSettings.error;
  if (props.appAgentSettings?.configured) {
    return `Ready to control the app with ${props.appAgentSettings.model}.`;
  }
  return "Add a tool-capable planner model before running app actions.";
});

const sortedAppAgentActions = computed(() =>
  [...props.appAgentActions].sort((left, right) =>
    `${left.category}:${actionDisplayName(left)}`.localeCompare(`${right.category}:${actionDisplayName(right)}`),
  ),
);

const appAgentActionCountLabel = computed(() =>
  `${props.appAgentActions.length} ${props.appAgentActions.length === 1 ? "action" : "actions"}`,
);

const appAgentSavedLabel = computed(() => {
  if (!props.appAgentSettings?.savedAt) return "never";
  const timestamp = new Date(props.appAgentSettings.savedAt);
  if (Number.isNaN(timestamp.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
});

const appAgentKeyDescription = computed(() => {
  if (!props.appAgentSettings?.savedAt) return "No provider key has been saved yet.";
  return `Last saved ${appAgentSavedLabel.value}.`;
});

function toggleAppAgent(): void {
  if (!props.appAgentSettings || props.appAgentBusy) return;
  emit("save-app-agent-settings", {
    model: props.appAgentSettings.model,
    enabled: props.appAgentSettings.enabled !== true,
  });
}

function saveAppAgentSettings(): void {
  emit("save-app-agent-settings", {
    model: appAgentModelDraft.value,
    openRouterApiKey: appAgentApiKeyDraft.value.trim() || undefined,
  });
}
</script>
