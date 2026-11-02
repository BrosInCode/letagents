<template>
  <DesktopContextMenu
    v-if="personMenu"
    :item-groups="personMenuItemGroups"
    :position="personMenu.position"
    :title="personMenu.target.displayName"
    testid="person-context-menu"
    @select="handlePersonMenuSelect"
    @close="personMenu = null"
  />
  <Teleport to="body">
    <Transition name="person-work" appear :css="animatePanel" @before-leave="disableLeavingPanel">
      <PersonWorkPanel
        v-if="personWorkTarget"
        :target="personWorkTarget"
        :room-id="roomIdentifier"
        :viewer-login="viewerLogin ?? null"
        :tasks="tasks"
        :tasks-unavailable="tasksUnavailable"
        :services="workServices"
        @open-task="closeWork(); emit('open-task', $event)"
        @close="closeWork"
      />
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import DesktopContextMenu, { type DesktopContextMenuItem } from "../controls/DesktopContextMenu.vue";
import PersonWorkPanel from "./PersonWorkPanel.vue";
import { buildPersonContextMenuItems, type PersonMenuAction, type PersonMenuPosition } from "../../../domain/person-context-menu";
import type { PersonTarget } from "../../../domain/person-target";
import type { DesktopTaskSummary } from "../../../../../electron/ipc-types";
import type { PersonWorkServices } from "../../../domain/person-work-services";
import { desktopIpc } from "../../../ipc/index.js";

const workServices: PersonWorkServices = {
  getEvents: (roomId, options) => desktopIpc.room.getGitHubEvents(roomId, options),
  getTicket: (roomId, taskId) => desktopIpc.room.getTaskTicket(roomId, taskId),
  openExternalUrl: (url) => desktopIpc.app.openExternalUrl(url),
};

/** Menu and Work panel for a clicked person. The room shell mounts this once and calls open(). */
const props = defineProps<{
  viewerLogin?: string | null;
  roomIdentifier: string;
  tasks?: DesktopTaskSummary[];
  tasksUnavailable?: boolean;
}>();

const emit = defineEmits<{
  "open-messages-with": [target: PersonTarget];
  /** The Work panel opened. The room shell closes the agent inspector. */
  "work-open": [];
  "open-task": [taskId: string];
}>();

const personMenu = ref<{ target: PersonTarget; position: PersonMenuPosition } | null>(null);
const personWorkTarget = ref<PersonTarget | null>(null);
const animatePanel = ref(true);
let keyboardInput = true;
function recordClick(event: MouseEvent): void { keyboardInput = event.detail === 0; }
function recordKey(): void { keyboardInput = true; }
function listenForInput(): void {
  document.addEventListener("click", recordClick, true);
  document.addEventListener("keydown", recordKey, true);
}
function stopListeningForInput(): void {
  document.removeEventListener("click", recordClick, true);
  document.removeEventListener("keydown", recordKey, true);
}
onMounted(listenForInput);
onActivated(listenForInput);
onBeforeUnmount(stopListeningForInput);
function closeWork(instant = keyboardInput): void {
  animatePanel.value = !instant;
  personWorkTarget.value = null;
}
// Focus is restored as the dialog closes; its fading copy must not be tabbable.
function disableLeavingPanel(element: Element): void {
  (element as HTMLElement).inert = true;
}
const personMenuItemGroups = computed<DesktopContextMenuItem[][]>(() => personMenu.value
  ? buildPersonContextMenuItems({ target: personMenu.value.target, viewerLogin: props.viewerLogin ?? null })
  : []);

/** "menu" shows the choices. "work" opens the Work panel at once. */
function open(target: PersonTarget, position: PersonMenuPosition, action: PersonMenuAction = "menu"): void {
  if (action === "work") {
    animatePanel.value = !keyboardInput;
    personMenu.value = null;
    personWorkTarget.value = target;
    return;
  }
  personMenu.value = { target, position };
}

function handlePersonMenuSelect(item: DesktopContextMenuItem): void {
  const menu = personMenu.value;
  personMenu.value = null;
  if (!menu) return;
  if (item.id === "message") emit("open-messages-with", menu.target);
  if (item.id === "work") {
    animatePanel.value = !keyboardInput;
    personWorkTarget.value = menu.target;
  }
}

watch(personWorkTarget, (target) => {
  if (target) emit("work-open");
});

/** Close the menu and the Work panel. The room shell calls this when an agent inspector opens. */
function close(): void {
  personMenu.value = null;
  closeWork(true);
}

// Leaving a kept-alive room view must close the teleported panel and its key listener.
onDeactivated(() => {
  stopListeningForInput();
  close();
});

defineExpose({ open, close });
</script>
