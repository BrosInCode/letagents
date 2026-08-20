<template>
  <section
    v-if="hasSupervisedRuntime(provider)"
    class="desktop-add-agent-delivery"
    aria-label="Agent lifecycle"
    data-testid="desktop-add-agent-lifecycle"
  >
    <span>Lifecycle</span>
    <div v-if="hasDesktopManagedRuntime(provider)" class="desktop-add-agent-segmented">
      <button type="button" :data-selected="launchMode === 'legacy'" :aria-pressed="launchMode === 'legacy'" data-testid="desktop-add-agent-lifecycle-legacy" @click="emit('update:launchMode', 'legacy')">This app</button>
      <button type="button" :data-selected="launchMode === 'supervised'" :aria-pressed="launchMode === 'supervised'" data-testid="desktop-add-agent-lifecycle-supervised" @click="emit('update:launchMode', 'supervised')">Supervised</button>
    </div>
    <p>{{ lifecycleDescription }}</p>
    <label v-if="launchMode === 'supervised'" class="desktop-add-agent-model-custom-input">
      <small>Initial message</small>
      <textarea
        :value="charter"
        rows="3"
        required
        :aria-invalid="!charter.trim()"
        aria-describedby="desktop-add-agent-supervised-charter-error"
        data-testid="desktop-add-agent-supervised-charter"
        @input="emit('update:charter', ($event.target as HTMLTextAreaElement).value)"
      />
      <small
        v-if="!charter.trim()"
        id="desktop-add-agent-supervised-charter-error"
        class="desktop-add-agent-field-error"
      >Add the first message the agent should handle after it joins. It is sent once.</small>
    </label>
  </section>

  <section v-if="showDelivery && launchMode === 'legacy'" class="desktop-add-agent-delivery" aria-label="Agent delivery mode">
    <span>Delivery</span>
    <div class="desktop-add-agent-segmented">
      <button type="button" :data-selected="deliveryMode === 'mcp_polling'" :aria-pressed="deliveryMode === 'mcp_polling'" @click="emit('update:deliveryMode', 'mcp_polling')">From the agent app</button>
      <button type="button" :data-selected="deliveryMode === 'desktop_events'" :aria-pressed="deliveryMode === 'desktop_events'" @click="emit('update:deliveryMode', 'desktop_events')">From this desktop app</button>
    </div>
    <p>{{ deliveryDescription }}</p>
  </section>

  <section
    v-if="(hasDesktopManagedRuntime(provider) || hasSupervisedRuntime(provider)) && permissionProfiles.length"
    class="desktop-add-agent-permissions"
    aria-label="Agent permissions"
  >
    <span>Permissions</span>
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
  </section>

  <section v-if="showCursorPolicy" class="desktop-add-agent-delivery" aria-label="Cursor MCP tools">
    <span>MCP tools</span>
    <div class="desktop-add-agent-segmented">
      <button
        v-for="option in cursorMcpPolicyOptions"
        :key="option.id"
        type="button"
        :data-selected="cursorPolicy === option.id"
        :aria-pressed="cursorPolicy === option.id"
        :data-testid="`desktop-add-agent-cursor-mcp-${option.id}`"
        @click="emit('update:cursorPolicy', option.id)"
      >{{ option.label }}</button>
    </div>
    <p>{{ cursorPolicyDescription }}</p>
  </section>

  <section v-if="externalPrompt" class="desktop-add-agent-external-prompt" data-testid="desktop-add-agent-external-prompt" aria-label="External agent join prompt">
    <div class="desktop-add-agent-external-prompt-intro">
      <div>
        <span>External agent setup</span>
        <p>Copy these instructions into {{ provider?.name || "the provider" }} so it can join the correct room, use a readable agent name, and keep listening for work.</p>
      </div>
      <button type="button" :disabled="copyingExternalPrompt" @click="emit('copy-external-prompt')">
        {{ copyingExternalPrompt ? "Copying..." : "Copy agent instructions" }}
      </button>
    </div>
    <details class="desktop-add-agent-external-prompt-details">
      <summary>Show full instructions</summary><pre><code>{{ externalPrompt }}</code></pre>
    </details>
  </section>
</template>

<script setup lang="ts">
import type {
  DesktopAgentProvider,
  DesktopCursorMcpPolicy,
  DesktopManagedAgentDeliveryMode,
  DesktopManagedAgentPermissionProfile,
} from "../../../../../../electron/ipc-types";
import {
  cursorMcpPolicyOptions,
  hasDesktopManagedRuntime,
  hasSupervisedRuntime,
  managedAgentPermissionProfileStatusLabel,
  managedAgentPermissionProfileSummary,
} from "../../../../domain/managed-agents";

defineProps<{
  provider: DesktopAgentProvider | null;
  launchMode: "legacy" | "supervised";
  lifecycleDescription: string;
  charter: string;
  showDelivery: boolean;
  deliveryMode: DesktopManagedAgentDeliveryMode;
  deliveryDescription: string;
  permissionProfiles: DesktopManagedAgentPermissionProfile[];
  selectedPermissionProfile: DesktopManagedAgentPermissionProfile | null;
  showCursorPolicy: boolean;
  cursorPolicy: DesktopCursorMcpPolicy;
  cursorPolicyDescription: string;
  externalPrompt: string | null;
  copyingExternalPrompt: boolean;
}>();
const emit = defineEmits<{
  "update:launchMode": [value: "legacy" | "supervised"];
  "update:charter": [value: string];
  "update:deliveryMode": [value: DesktopManagedAgentDeliveryMode];
  "select-permission": [profile: DesktopManagedAgentPermissionProfile];
  "update:cursorPolicy": [value: DesktopCursorMcpPolicy];
  "copy-external-prompt": [];
}>();

function permissionOptionSummary(profile: DesktopManagedAgentPermissionProfile): string {
  return profile.status === "available"
    ? profile.description
    : `${managedAgentPermissionProfileStatusLabel(profile.status)} - ${profile.detail || profile.description}`;
}
</script>
<style scoped src="./AddAgentFormField.css"></style>
<style scoped src="./AddAgentRuntimeSettings.css"></style>
