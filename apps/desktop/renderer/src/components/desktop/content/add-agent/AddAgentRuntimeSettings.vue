<template>
  <section
    v-if="hasSupervisedRuntime(provider)"
    class="desktop-add-agent-delivery"
    aria-label="Where the agent works"
    data-testid="desktop-add-agent-execution"
  >
    <label class="desktop-add-agent-model-custom-input">
      <small>First task</small>
      <textarea
        :value="charter"
        rows="3"
        placeholder="What should this agent work on?"
        required
        :aria-invalid="!charter.trim()"
        :aria-describedby="!charter.trim() ? 'desktop-add-agent-supervised-charter-error' : undefined"
        data-testid="desktop-add-agent-supervised-charter"
        @input="emit('update:charter', ($event.target as HTMLTextAreaElement).value)"
      />
      <small
        v-if="!charter.trim()"
        id="desktop-add-agent-supervised-charter-error"
        class="desktop-add-agent-field-error"
      >Add the first message the agent should handle after it joins. It is sent once.</small>
    </label>
    <p>{{ executionDescription }}</p>
  </section>

  <details
    v-if="hasSupervisedRuntime(provider) && permissionProfiles.length"
    class="desktop-add-agent-permissions"
    :open="!selectedPermissionProfile || selectedPermissionProfile.status !== 'available'"
    aria-label="Agent permissions"
  >
    <summary tabindex="0">
      <span>Access</span>
      <span class="desktop-add-agent-access-selection">
        {{ selectedPermissionProfile?.label || 'Choose permissions' }}
        <em v-if="selectedPermissionProfile?.risk === 'high'">High risk</em>
      </span>
    </summary>
    <div class="desktop-add-agent-permission-options">
      <button
        v-for="profile in permissionProfiles"
        :key="profile.id"
        type="button"
        :data-selected="profile.id === selectedPermissionProfile?.id"
        :aria-pressed="profile.id === selectedPermissionProfile?.id"
        :data-state="profile.status"
        :disabled="profile.status !== 'available'"
        @click="emit('select-permission', profile)"
      >
        <span class="desktop-add-agent-permission-option-title">
          <strong>{{ profile.label }}</strong><em :data-risk="profile.risk">{{ profile.risk }}</em>
        </span>
        <small>{{ permissionOptionSummary(profile) }}</small>
      </button>
    </div>
    <p v-if="selectedPermissionProfile">{{ managedAgentPermissionProfileSummary(selectedPermissionProfile) }}</p>
  </details>

</template>

<script setup lang="ts">
import type {
  DesktopAgentProvider,
  DesktopManagedAgentPermissionProfile,
} from "../../../../../../electron/ipc-types";
import {
  hasSupervisedRuntime,
  managedAgentPermissionProfileStatusLabel,
  managedAgentPermissionProfileSummary,
} from "../../../../domain/managed-agents";

defineProps<{
  provider: DesktopAgentProvider | null;
  executionDescription: string;
  charter: string;
  permissionProfiles: DesktopManagedAgentPermissionProfile[];
  selectedPermissionProfile: DesktopManagedAgentPermissionProfile | null;
}>();
const emit = defineEmits<{
  "update:charter": [value: string];
  "select-permission": [profile: DesktopManagedAgentPermissionProfile];
}>();

function permissionOptionSummary(profile: DesktopManagedAgentPermissionProfile): string {
  return profile.status === "available"
    ? profile.description
    : `${managedAgentPermissionProfileStatusLabel(profile.status)} - ${profile.detail || profile.description}`;
}
</script>
<style scoped src="./AddAgentFormField.css"></style>
<style scoped src="./AddAgentRuntimeSettings.css"></style>
