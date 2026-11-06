<template>
  <DesktopDialogShell
    :open="open"
    panel-tag="form"
    backdrop-class="board-pane-backdrop"
    panel-class="board-pane board-create-pane"
    close-class="board-pane-close"
    aria-labelledby="desktop-create-task-title"
    close-label="Close task creation"
    :close-disabled="busyAction !== null"
    initial-focus="#desktop-create-task-title-input"
    @close="emit('close')"
    @submit="submit"
  >
    <header class="board-create-header">
      <h2 id="desktop-create-task-title">Create a task</h2>
    </header>

    <div class="board-create-body">
      <label class="board-create-field" for="desktop-create-task-title-input">
        <span>Title</span>
        <input
          id="desktop-create-task-title-input"
          v-model="title"
          type="text"
          placeholder="What needs to be done?"
          required
          maxlength="500"
          :disabled="busyAction !== null"
        />
      </label>
      <component :is="markdownEditor" id="desktop-create-task-description" v-model="description" label="Description (optional)" :disabled="busyAction !== null" />
      <div v-if="planningSnapshot?.canEdit" class="board-create-planning">
        <div class="board-create-field"><span>Sprint</span><FilterDropdown :disabled="busyAction !== null" v-model="sprintId" label="Sprint" :options="sprintOptions" searchable search-placeholder="Find a sprint…"><template #option="{ option }"><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown></div>
        <label class="board-create-field"><span>Story points</span><input v-model="estimate" type="number" min="0" max="1000" step="any" placeholder="Unestimated" :disabled="busyAction !== null" /></label>
        <div class="board-create-field"><span>Type</span><FilterDropdown :disabled="busyAction !== null" v-model="taskType" label="Task type" :options="typeOptions"><template #option="{ option }"><BoardIcon :name="option.id" /><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown></div>
        <div class="board-create-field"><span>Priority</span><FilterDropdown :disabled="busyAction !== null" v-model="priority" label="Priority" :options="priorityOptions"><template #option="{ option }"><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown></div>
      </div>
    </div>

    <p v-if="error" class="board-create-error" role="alert">{{ error }}</p>

    <footer class="board-create-actions">
      <button
        type="button"
        class="board-create-cancel"
        :disabled="busyAction !== null"
        @click="emit('close')"
      >
        Cancel
      </button>
      <button
        class="board-create-submit"
        type="submit"
        :disabled="!canCreate || busyAction !== null"
      >
        {{ busyAction === "add" ? "Creating..." : "Create task" }}
      </button>
    </footer>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { computed, ref, watch, type Component } from "vue";
import DesktopDialogShell from "../../../apps/desktop/renderer/src/components/desktop/content/DesktopDialogShell.vue";
import FilterDropdown from "../FilterDropdown.vue";
import BoardIcon from "./BoardIcon.vue";
import type { BoardPlanningSnapshot, BoardTaskPlanning } from "../../board-planning.mjs";

const props = defineProps<{
  open: boolean;
  markdownEditor: Component;
  busyAction: string | null;
  error: string | null;
  planningSnapshot?: BoardPlanningSnapshot | null;
  selectedSprintId?: string | null;
}>();

const emit = defineEmits<{
  close: [];
  create: [input: { title: string; description: string | null; planning?: BoardTaskPlanning }];
}>();

const title = ref("");
const description = ref("");
const sprintId = ref("");
const estimate = ref<string | number>("");
const taskType = ref("task");
const priority = ref("medium");
const typeOptions = [{ id: "task", label: "Task" }, { id: "bug", label: "Bug" }, { id: "feature", label: "Feature" }];
const priorityOptions = ["low", "medium", "high", "urgent"].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
const sprintOptions = computed(() => [{ id: "", label: "No sprint" }, ...[...(props.planningSnapshot?.document.sprints || []), ...(props.planningSnapshot?.imported.sprints || [])].filter(sprint => sprint.state !== "closed").map(sprint => ({ id: sprint.id, label: sprint.name }))]);
const canCreate = computed(() => Boolean(title.value.trim()) && (estimate.value === "" || (Number.isFinite(Number(estimate.value)) && Number(estimate.value) >= 0 && Number(estimate.value) <= 1000)));

watch(() => props.open, (open) => {
  if (open) {
    sprintId.value = sprintOptions.value.some(option => option.id === props.selectedSprintId) ? props.selectedSprintId || "" : "";
    estimate.value = "";
    taskType.value = "task";
    priority.value = "medium";
  } else {
    title.value = "";
    description.value = "";
  }
});

function submit(): void {
  if (!canCreate.value || props.busyAction !== null) return;
  const nextDescription = description.value.trim();
  emit("create", {
    title: title.value.trim(),
    description: nextDescription || null,
    ...(props.planningSnapshot?.canEdit ? { planning: {
      sprintId: sprintId.value || null,
      estimate: estimate.value === "" ? null : Number(estimate.value),
      type: taskType.value as BoardTaskPlanning["type"],
      priority: priority.value as BoardTaskPlanning["priority"],
    } } : {}),
  });
}
</script>

<style>
.board-pane-backdrop { position: fixed; z-index: 200; inset: 0; display: flex; justify-content: flex-end; padding: 12px; background: rgb(0 0 0 / 36%); }
.board-pane { position: relative; display: flex; flex-direction: column; width: min(760px, 100%); min-width: 0; max-height: 100%; overflow: hidden; margin: 0; padding: 0; border: 1px solid var(--border-strong); border-radius: 16px; background: var(--bg); color: var(--text); font: inherit; box-shadow: 0 24px 72px rgb(0 0 0 / 24%); outline: none; }
.board-pane-close { position: absolute; top: 22px; right: 24px; display: grid; place-items: center; width: 36px; height: 36px; padding: 8px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; }
.board-pane-close svg { width: 20px; height: 20px; }
.board-create-header { padding: 36px 36px 28px; }
.board-create-header h2 { margin: 0; padding-right: 40px; font-size: 28px; font-weight: 600; letter-spacing: -0.8px; line-height: 1.3; }
.board-create-body { display: grid; gap: 28px; min-height: 0; padding: 0 36px 36px; overflow: auto; overscroll-behavior: contain; }
.board-create-field { display: grid; gap: 10px; color: var(--text-secondary); font-size: 13px; font-weight: 500; }
.board-create-field input { width: 100%; min-width: 0; min-height: 48px; padding: 12px 14px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-subtle); color: var(--text); font: inherit; font-size: 16px; }
.board-create-body .task-markdown > label { font-size: 13px; font-weight: 500; }
.board-create-body .task-markdown-surface { border-radius: 8px; }
.board-create-body .task-markdown-tabs { order: -1; margin-left: 0; margin-right: auto; }
.board-create-body .task-markdown textarea { min-height: 260px; }
.board-create-planning { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 24px; }
.board-create-planning .work-filter-trigger { width: 100%; min-height: 44px; }
.board-create-actions { display: flex; justify-content: flex-end; flex: 0 0 auto; gap: 12px; margin-top: auto; padding: 20px 36px; border-top: 1px solid var(--border); background: var(--bg); }
.board-create-actions button { min-height: 40px; padding: 0 18px; border-radius: 8px; font: inherit; font-size: 14px; font-weight: 550; cursor: pointer; }
.board-create-cancel { border: 1px solid var(--border-strong); background: var(--bg-subtle); color: var(--text); }
.board-create-submit { border: 1px solid transparent; background: var(--text); color: var(--bg); }
.board-create-actions button:disabled { opacity: .45; cursor: default; }
.board-create-error { margin: 0 36px 20px; color: var(--red-text); font-size: 13px; }
.board-pane :is(button, input, textarea, a):focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.board-pane .task-markdown textarea:focus-visible { outline: none; }
.board-pane-backdrop.desktop-dialog-enter-active, .board-pane-backdrop.desktop-dialog-leave-active { transition: opacity 180ms ease; }
.board-pane-backdrop.desktop-dialog-enter-active > .board-pane { transition: opacity 220ms ease, transform 260ms cubic-bezier(.22,1,.36,1); }
.board-pane-backdrop.desktop-dialog-leave-active > .board-pane { transition: opacity 140ms ease, transform 160ms ease; }
.board-pane-backdrop.desktop-dialog-enter-from, .board-pane-backdrop.desktop-dialog-leave-to { opacity: 0; }
.board-pane-backdrop.desktop-dialog-enter-from > .board-pane, .board-pane-backdrop.desktop-dialog-leave-to > .board-pane { opacity: 0; transform: translateX(24px); }
@media (hover: hover) and (pointer: fine) { .board-pane-close:hover, .board-create-cancel:hover { background: var(--accent-hover); color: var(--text); } .board-create-submit:hover:not(:disabled) { opacity: .9; } }
@media (max-width: 600px) { .board-pane-backdrop { padding: 0; } .board-pane { border-radius: 0; border-width: 0; width: 100%; } .board-create-header { padding: 28px 20px; } .board-create-header h2 { font-size: 24px; } .board-pane-close { right: 16px; top: 22px; } .board-create-body { padding: 0 20px 24px; gap: 24px; } .board-create-actions { padding: 16px 20px max(16px, env(safe-area-inset-bottom)); } .board-create-actions button { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .board-pane-backdrop.desktop-dialog-enter-active, .board-pane-backdrop.desktop-dialog-leave-active, .board-pane-backdrop.desktop-dialog-enter-active > .board-pane, .board-pane-backdrop.desktop-dialog-leave-active > .board-pane { transition: opacity 80ms linear; } .board-pane-backdrop.desktop-dialog-enter-from > .board-pane, .board-pane-backdrop.desktop-dialog-leave-to > .board-pane { transform: none; } }
</style>
