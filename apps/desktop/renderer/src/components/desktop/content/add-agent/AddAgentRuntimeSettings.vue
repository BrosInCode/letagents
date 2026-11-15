<template>
  <section
    v-if="showFirstMessage && hasSupervisedRuntime(provider)"
    class="desktop-add-agent-delivery"
    aria-label="Where the agent works"
    data-testid="desktop-add-agent-execution"
  >
    <AddAgentFirstMessage :model-value="charter" @update:model-value="emit('update:charter', $event)" />
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
    <AgentAccessControl :model-value="selectedPermissionProfile?.id || ''" :options="permissionProfiles" @update:model-value="selectAccess" />
    <p v-if="selectedPermissionProfile && supervisedPermissionProfileLimits(provider?.id, selectedPermissionProfile)" class="desktop-add-agent-permission-limits" data-testid="desktop-add-agent-permission-limits">{{ supervisedPermissionProfileLimits(provider?.id, selectedPermissionProfile) }}</p>

  </details>

</template>

<script setup lang="ts">
import AddAgentFirstMessage from "./AddAgentFirstMessage.vue";
import AgentAccessControl from "../../../../../../../../shared/ui/agent-identity/AgentAccessControl.vue";
import type {
  DesktopAgentProvider,
  DesktopManagedAgentPermissionProfile,
} from "../../../../../../electron/ipc-types";
import {
  hasSupervisedRuntime,
  supervisedPermissionProfileLimits,
} from "../../../../domain/managed-agents";

const props = withDefaults(defineProps<{
  showFirstMessage?: boolean;
  provider: DesktopAgentProvider | null;
  executionDescription: string;
  charter: string;
  permissionProfiles: DesktopManagedAgentPermissionProfile[];
  selectedPermissionProfile: DesktopManagedAgentPermissionProfile | null;
}>(), { showFirstMessage: true });
const emit = defineEmits<{
  "update:charter": [value: string];
  "select-permission": [profile: DesktopManagedAgentPermissionProfile];
}>();

function selectAccess(id: string): void {
  const profile = props.permissionProfiles.find(option => option.id === id);
  if (profile?.status === 'available') emit('select-permission', profile);
}
</script>
<style scoped src="./AddAgentFormField.css"></style>
<style scoped src="./AddAgentRuntimeSettings.css"></style>
