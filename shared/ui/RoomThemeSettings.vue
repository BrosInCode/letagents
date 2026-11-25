<template>
  <section v-if="appearance" class="theme-settings" aria-labelledby="room-theme-heading" :style="appearance.css.value">
    <h2 id="room-theme-heading">Room theme</h2>
    <p v-if="company">{{ company.name }}’s default is {{ companyThemeName }}.</p>
    <RoomThemePicker
      label="Your room theme"
      :model-value="appearance.personal.value"
      :inherited="company?.theme"
      :company="company?.name"
      @update:model-value="appearance.choose"
    />
    <p v-if="!appearance.storageAvailable.value" role="status">Your theme is active for this session. It couldn’t be saved on this device.</p>
    <details v-if="company && saveCompanyTheme" class="company-theme-settings">
      <summary>Set company theme</summary>
      <p>Everyone using the company theme will see this color.</p>
      <RoomThemePicker v-model="draft" label="Default company theme" inherit-label="Clear company theme" />
      <button class="save-company-theme" type="button" :disabled="saving || draft === company.theme" @click="save">
        {{ saving ? 'Saving…' : 'Save company theme' }}
      </button>
      <p v-if="error" role="alert">{{ error }}</p>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { roomThemePreset, type RoomThemeId } from "../room-themes.mjs";
import { useRoomTheme } from "./room-theme";
import RoomThemePicker from "./RoomThemePicker.vue";

const props = defineProps<{ saveCompanyTheme?: (companyId: string, theme: RoomThemeId | null) => Promise<void> }>();
const appearance = useRoomTheme();
const company = computed(() => appearance?.company.value);
const companyThemeName = computed(() => roomThemePreset(company.value?.theme)?.label ?? "LetAgents default");
const draft = ref<RoomThemeId | null>(null);
const error = ref("");
const saving = ref(false);
watch([() => company.value?.id, () => company.value?.theme], ([, theme]) => {
  draft.value = theme ?? null;
  error.value = "";
}, { immediate: true });

async function save() {
  const id = company.value?.id;
  if (!id || !props.saveCompanyTheme || saving.value) return;
  saving.value = true;
  error.value = "";
  try { await props.saveCompanyTheme(id, draft.value); }
  catch {
    if (company.value?.id === id) error.value = "Couldn’t save the company theme. Try again.";
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.theme-settings { max-width: 760px; margin-block-end: 26px; padding-block-end: 22px; border-bottom: 1px solid var(--border, var(--line)); }
.theme-settings h2 { margin: 0; font-size: 17px; font-weight: 600; }
.theme-settings p { margin: 8px 0 15px; color: var(--text-secondary); font-size: 13px; line-height: 1.45; }
.theme-settings h2 + .room-theme-picker { margin-block-start: 12px; }
.company-theme-settings { margin-top: 12px; font-size: 13px; }
.company-theme-settings summary { width: fit-content; cursor: pointer; }
.save-company-theme { min-height: 36px; padding: 6px 12px; margin-block-start: 9px; border: 1px solid var(--workspace-border, var(--border)); border-radius: 8px; background: var(--workspace-composer, var(--bg-card)); color: inherit; font: inherit; cursor: pointer; }
.save-company-theme:disabled { opacity: .55; cursor: default; }
</style>
