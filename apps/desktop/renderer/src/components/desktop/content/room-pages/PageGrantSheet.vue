<template>
  <DesktopDialogShell
    :open="Boolean(sheet)"
    aria-labelledby="room-page-grant-title"
    backdrop-class="desktop-task-modal-backdrop"
    panel-class="desktop-task-modal room-page-grant"
    :show-close="false"
    :close-disabled="busy"
    initial-focus="[data-page-grant-cancel]"
    :focus-key="sheet ? `${sheet.pageId}:${sheet.version}` : null"
    test-id="room-page-grant"
    @close="emit('cancel')"
  >
    <template v-if="sheet">
      <p class="room-page-grant-source"><bdi>{{ revealHiddenCharacters(sheet.title) }}</bdi> · version {{ sheet.version }}</p>
      <h3 id="room-page-grant-title">{{ sheet.mode === "pin" ? "Pin this page to the room?" : "Approve this version?" }}</h3>
      <p v-if="rows.length === 0" class="room-page-grant-none">This page reads nothing from the room and acts for nobody.</p>
      <template v-else>
        <p class="room-page-grant-intro">It asks to do these things for each person who opens it. Untick what it should not do.</p>
        <ul class="room-page-grant-list" data-testid="room-page-grant-list">
          <li v-for="row in rows" :key="row.name">
            <label>
              <input
                type="checkbox"
                :checked="chosen.has(row.name)"
                :disabled="!row.grantable || busy"
                :data-testid="`room-page-grant-${row.name}`"
                @change="toggle(row.name)"
              />
              <span>
                {{ row.label }}
                <small v-if="row.note || !row.grantable">{{ row.grantable ? row.note : row.note ?? "A page cannot have this" }}</small>
              </span>
            </label>
          </li>
        </ul>
      </template>
      <p v-if="error" class="room-page-grant-error" role="alert">{{ error }}</p>
      <div class="room-page-grant-actions">
        <button class="ghost-button" type="button" data-page-grant-cancel :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button class="primary-button" type="button" :disabled="busy" data-testid="room-page-grant-approve" @click="emit('approve', [...chosen])">
          {{ busy ? "Working…" : sheet.mode === "pin" ? "Approve and pin" : "Approve" }}
        </button>
      </div>
    </template>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import DesktopDialogShell from "../DesktopDialogShell.vue";
import { pageGrantRows, type PageGrantSheetState } from "./room-page-admin";
import { revealHiddenCharacters } from "./room-pages";

/**
 * The grant sheet a room admin sees before a page version goes live: what
 * its manifest asks for, in the registry's plain words. The admin may grant
 * fewer; the page then gets `not_granted` for the rest.
 */
const props = defineProps<{
  sheet: PageGrantSheetState | null;
  busy: boolean;
  error: string;
}>();

const emit = defineEmits<{
  approve: [capabilities: string[]];
  cancel: [];
}>();

const rows = computed(() => pageGrantRows(props.sheet?.capabilities ?? []));
const chosen = ref(new Set<string>());

watch(() => props.sheet, (sheet) => {
  chosen.value = new Set(pageGrantRows(sheet?.capabilities ?? []).filter((row) => row.grantable).map((row) => row.name));
}, { immediate: true });

function toggle(name: string): void {
  const next = new Set(chosen.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  chosen.value = next;
}
</script>

<style>
/* The dialog shell draws the panel, so these rules are not scoped to this component; every class is this sheet's own. */
.room-page-grant {
  display: grid;
  gap: 12px;
  width: min(480px, calc(100vw - 48px));
  padding: 24px;
}

.room-page-grant h3 {
  margin: 0;
  font-size: 1.05rem;
}

.room-page-grant-source {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.room-page-grant-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.room-page-grant-actions button {
  min-height: 36px;
}

.room-page-grant-intro,
.room-page-grant-none {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.84rem;
}

.room-page-grant-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.room-page-grant-list label {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 0.86rem;
}

.room-page-grant-list input {
  margin-top: 3px;
}

.room-page-grant-list small {
  display: block;
  color: var(--text-tertiary);
  font-size: 0.76rem;
}

.room-page-grant-error {
  margin: 0;
  color: var(--red-text);
  font-size: 0.82rem;
}
</style>
