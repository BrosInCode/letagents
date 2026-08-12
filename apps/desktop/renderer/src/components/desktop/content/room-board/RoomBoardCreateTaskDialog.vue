<template>
  <DesktopDialogShell
    :open="open"
    panel-tag="form"
    panel-class="desktop-task-modal desktop-task-create-modal"
    aria-labelledby="desktop-create-task-title"
    close-label="Close task creation"
    :close-disabled="busyAction !== null"
    initial-focus="#desktop-create-task-description"
    @close="emit('close')"
    @submit="submit"
  >
    <header class="desktop-task-create-header">
      <span>New task</span>
      <h3 id="desktop-create-task-title">Describe the work</h3>
      <p>Give the next person or agent the outcome, context, and done condition.</p>
    </header>

    <label class="desktop-task-create-field" for="desktop-create-task-description">
      <span>Description</span>
      <textarea
        id="desktop-create-task-description"
        v-model="description"
        rows="7"
        placeholder="What should happen, and how will we know it is done?"
        :disabled="busyAction !== null"
      ></textarea>
    </label>

    <label class="desktop-task-create-field" for="desktop-create-task-title-input">
      <span>Short title <small>optional</small></span>
      <input
        id="desktop-create-task-title-input"
        v-model="title"
        type="text"
        placeholder="Use the first line if left blank"
        :disabled="busyAction !== null"
      />
    </label>

    <p v-if="error" class="desktop-task-dialog-error" role="alert">{{ error }}</p>

    <footer class="desktop-task-create-actions">
      <button
        type="button"
        class="desktop-task-detail-button"
        :disabled="busyAction !== null"
        @click="emit('close')"
      >
        Cancel
      </button>
      <button
        class="desktop-board-primary-action"
        type="submit"
        :disabled="!canCreate || busyAction !== null"
      >
        {{ busyAction === "add" ? "Creating..." : "Create task" }}
      </button>
    </footer>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DesktopTaskCreateInput } from "../../../../../../electron/ipc-types";
import DesktopDialogShell from "../DesktopDialogShell.vue";
import { deriveTaskTitle } from "./board-presentation";

const props = defineProps<{
  open: boolean;
  busyAction: string | null;
  error: string | null;
}>();

const emit = defineEmits<{
  close: [];
  create: [input: DesktopTaskCreateInput];
}>();

const title = ref("");
const description = ref("");
const canCreate = computed(() => Boolean(title.value.trim() || description.value.trim()));

watch(() => props.open, (open) => {
  if (!open) {
    title.value = "";
    description.value = "";
  }
});

function submit(): void {
  if (!canCreate.value || props.busyAction !== null) return;
  const nextDescription = description.value.trim();
  emit("create", {
    title: deriveTaskTitle(title.value, nextDescription),
    description: nextDescription || null,
  });
}
</script>
