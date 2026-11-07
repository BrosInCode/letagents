<template>
  <section class="company-choices" aria-label="Choose a company" :aria-busy="busy">
    <p v-if="busy" role="status">Verifying your GitHub organizations…</p>
    <div v-if="error" role="alert" class="company-feedback">
      <p>{{ error }}</p>
      <button class="ghost-button" :disabled="busy" @click="$emit('retry')">Retry</button>
    </div>
    <p v-if="!busy && !error && !organizations.length">No GitHub organizations found. You can work in your own or shared repo rooms.</p>
    <button v-for="org in organizations" :key="org.github_org_id" class="company-choice" type="button"
      :disabled="busy || (!org.setup && org.role !== 'owner')" @click="$emit('choose', org.github_org_id)">
      <span><strong>{{ org.login }}</strong><small>{{ org.role === 'owner' ? 'Organization owner' : 'Organization member' }}</small></span>
      <span>{{ org.joined ? 'Open' : org.setup ? 'Join' : org.role === 'owner' ? 'Set up company' : 'Waiting for an owner' }}</span>
    </button>
    <button class="ghost-button company-personal" type="button" @click="$emit('choose', null)">Continue with personal rooms</button>
    <p class="company-note">Personal rooms include your repositories and repos shared with you.</p>
  </section>
</template>

<script setup lang="ts">
import type { DesktopOrganization } from "../../../../../electron/ipc-types/organizations.js";
defineProps<{ organizations: DesktopOrganization[]; busy: boolean; error: string | null }>();
defineEmits<{ choose: [id: string | null]; retry: [] }>();
</script>

<style scoped>
.company-choices { display: grid; gap: 12px; }
.company-choice { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; padding: 16px; border: 1px solid var(--border-subtle, #deded9); border-radius: 12px; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
.company-choice small { display: block; margin-top: 4px; opacity: .65; }
.company-choice:disabled { opacity: .55; cursor: default; }
.company-choice:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
@media (hover: hover) and (pointer: fine) { .company-choice:not(:disabled):hover { background: var(--surface-hover, #f1f1ee); } }
.company-personal { justify-self: start; }
.company-note { font-size: 13px; opacity: .65; margin: 0; }
.company-feedback p { margin-top: 0; }
</style>
