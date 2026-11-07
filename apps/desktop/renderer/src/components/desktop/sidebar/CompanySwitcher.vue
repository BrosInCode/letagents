<template>
  <div class="company-switcher" :aria-busy="busy">
    <label for="company-scope">Workspace</label>
    <div class="company-switcher-row">
      <select id="company-scope" :value="selectedId || ''" :disabled="busy" @change="choose">
        <option value="">Personal &amp; shared</option>
        <option v-for="org in organizations" :key="org.github_org_id" :value="org.github_org_id"
          :disabled="!org.setup && org.role !== 'owner'">
          {{ org.login }}{{ org.joined ? '' : org.setup ? ' — Join' : org.role === 'owner' ? ' — Set up' : ' — Owner setup needed' }}
        </option>
      </select>
      <button type="button" :disabled="busy" aria-label="Refresh companies and rooms" title="Refresh companies and rooms" @click="$emit('refresh')">↻</button>
    </div>
    <p v-if="busy" role="status">Checking GitHub…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <button v-if="selectedId" type="button" class="company-personal" @click="$emit('choose', null)">Personal &amp; shared rooms</button>
  </div>
</template>
<script setup lang="ts">
import type { DesktopOrganization } from "../../../../../electron/ipc-types/organizations.js";
defineProps<{ organizations: DesktopOrganization[]; selectedId: string | null; busy: boolean; error: string | null }>();
const emit = defineEmits<{ choose: [id: string | null]; refresh: [] }>();
function choose(event: Event) { emit("choose", (event.target as HTMLSelectElement).value || null); }
</script>
<style scoped>
.company-switcher { padding: 4px 14px 14px; font-size: 12px; }
.company-switcher label { display: block; margin-bottom: 6px; opacity: .65; }
.company-switcher-row { display: flex; gap: 4px; }
.company-switcher select { flex: 1; min-width: 0; }
.company-switcher select, .company-switcher button { color: inherit; background: transparent; border: 1px solid var(--border-subtle, #ddd); border-radius: 7px; padding: 7px; font: inherit; }
.company-switcher button { cursor: pointer; }
.company-switcher :disabled { opacity: .5; }
.company-switcher :focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.company-switcher p { margin: 8px 0 0; }
.company-switcher .company-personal { border: 0; padding: 8px 0 0; }
</style>
