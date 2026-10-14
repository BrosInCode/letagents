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
  <PersonWorkPanel
    v-if="personWorkTarget"
    :target="personWorkTarget"
    :room-id="roomIdentifier"
    :viewer-login="viewerLogin ?? null"
    @close="personWorkTarget = null"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import DesktopContextMenu, { type DesktopContextMenuItem } from "../controls/DesktopContextMenu.vue";
import PersonWorkPanel from "./PersonWorkPanel.vue";
import { buildPersonContextMenuItems, type PersonMenuAction, type PersonMenuPosition } from "../../../domain/person-context-menu";
import type { PersonTarget } from "../../../domain/person-target";

/** Menu and Work panel for a clicked person. The room shell mounts this once and calls open(). */
const props = defineProps<{
  viewerLogin?: string | null;
  roomIdentifier: string;
}>();

const emit = defineEmits<{
  "open-messages-with": [target: PersonTarget];
  /** The Work panel opened. The room shell closes the agent inspector. */
  "work-open": [];
}>();

const personMenu = ref<{ target: PersonTarget; position: PersonMenuPosition } | null>(null);
const personWorkTarget = ref<PersonTarget | null>(null);
const personMenuItemGroups = computed<DesktopContextMenuItem[][]>(() => personMenu.value
  ? buildPersonContextMenuItems({ target: personMenu.value.target, viewerLogin: props.viewerLogin ?? null })
  : []);

/** "menu" shows the choices. "work" opens the Work panel at once. */
function open(target: PersonTarget, position: PersonMenuPosition, action: PersonMenuAction = "menu"): void {
  if (action === "work") {
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
  if (item.id === "work") personWorkTarget.value = menu.target;
}

watch(personWorkTarget, (target) => {
  if (target) emit("work-open");
});

/** Close the menu and the Work panel. The room shell calls this when an agent inspector opens. */
function close(): void {
  personMenu.value = null;
  personWorkTarget.value = null;
}

defineExpose({ open, close });
</script>
