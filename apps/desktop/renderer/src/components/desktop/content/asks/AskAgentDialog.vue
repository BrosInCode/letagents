<template>
  <DesktopDialogShell
    :open="open"
    panel-class="ask-agent-dialog"
    backdrop-class="desktop-task-modal-backdrop ask-agent-backdrop"
    aria-labelledby="agent-ask-title"
    :show-close="false"
    :close-disabled="busy"
    initial-focus="#agent-ask-title"
    test-id="agent-ask-dialog"
    @close="close"
  >
    <AskAgentPanel v-if="open" :models="models" :rooms="roomOptions" :initial-room="roomIdentifier"
      :preset-model-label="presetModelLabel" :loading="loading" :busy="busy" :error="error"
      :created-link="created?.link" :copied="copied" heading-id="agent-ask-title"
      @create="submit" @retry="loadModels" @copy="copy" @close="close">
      <template #close>
        <button type="button" class="give-close" aria-label="Close request" :disabled="busy" @click="close">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
        </button>
      </template>
    </AskAgentPanel>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { DesktopAccountRoomEntry } from "../../../../../../electron/ipc-types/room";
import type { DesktopAgentAskModel } from "../../../../../../electron/ipc-types/asks";
import { desktopIpc, desktopBridgeUpgradeMessage } from "../../../../ipc/index.js";
import DesktopDialogShell from "../DesktopDialogShell.vue";
import AskAgentPanel from "../../../../../../../../shared/ui/ask-agent/AskAgentPanel.vue";
import type { AskAgentInput } from "../../../../../../../../shared/ui/ask-agent/types";
import { rememberAskLink } from "./ask-links";

const props = defineProps<{
  open: boolean;
  roomIdentifier: string | null;
  roomLabel?: string;
  rooms: DesktopAccountRoomEntry[];
  presetModelLabel?: string | null;
}>();
const emit = defineEmits<{ close: []; created: [roomIdentifier: string] }>();
const models = ref<DesktopAgentAskModel[]>([]);
const loading = ref(false), busy = ref(false), copied = ref(false);
const error = ref<string | null>(null);
const created = ref<{ link: string } | null>(null);
/** Reuse a room if creating its request fails. */
const createdRoomId = ref<string | null>(null);
let generation = 0;
onBeforeUnmount(() => { generation++; });

const roomOptions = computed(() => {
  const rooms = props.rooms.filter(room => !room.archived).flatMap(room => [
    { id: room.roomIdentifier, label: room.displayName || room.name },
    ...(room.focusRooms ?? []).map(focus => ({ id: focus.roomIdentifier, label: `${room.displayName || room.name} / ${focus.displayName || focus.name}` })),
  ]);
  if (props.roomIdentifier && !rooms.some(room => room.id === props.roomIdentifier)) {
    rooms.unshift({ id: props.roomIdentifier, label: props.roomLabel || props.roomIdentifier });
  }
  return rooms;
});

watch(() => props.open, open => {
  generation++;
  models.value = []; created.value = null; error.value = null; copied.value = false;
  createdRoomId.value = null; busy.value = false; loading.value = false;
  if (open) void loadModels();
}, { immediate: true });

async function loadModels() {
  if (!props.open || loading.value || busy.value) return;
  const version = generation;
  loading.value = true; error.value = null;
  try {
    const result = await desktopIpc.asks?.listModels();
    if (version !== generation) return;
    if (!result) { error.value = desktopBridgeUpgradeMessage(); return; }
    if (!result.ok) { error.value = result.error; return; }
    models.value = result.value;
  } catch {
    if (version === generation) error.value = "Couldn't load agents. Check your connection and try again.";
  } finally { if (version === generation) loading.value = false; }
}

async function submit(input: AskAgentInput) {
  if (!props.open || busy.value || loading.value || created.value) return;
  if (!models.value.some(model => model.providerId === input.providerId && model.model === input.model)) return;
  const version = generation;
  busy.value = true; error.value = null;
  try {
    let roomId = input.roomId;
    if (roomId === "__new__") {
      if (!createdRoomId.value) {
        const room = await desktopIpc.room.createInviteRoom();
        if (version !== generation) return;
        createdRoomId.value = room.roomIdentifier;
        if (input.newRoomName) await desktopIpc.room.rename?.(room.roomIdentifier, input.newRoomName).catch(() => undefined);
      }
      roomId = createdRoomId.value;
    }
    if (version !== generation) return;
    const result = await desktopIpc.asks?.create({ roomId, providerId: input.providerId, model: input.model, amountPercent: input.amountPercent, note: input.note });
    if (version !== generation) return;
    if (!result) { error.value = desktopBridgeUpgradeMessage(); return; }
    if (!result.ok) { error.value = result.error; return; }
    rememberAskLink(result.value.ask.id, result.value.link);
    created.value = { link: result.value.link };
    emit("created", roomId);
  } catch {
    if (version === generation) error.value = "Couldn't create the link. Try again.";
  } finally { if (version === generation) busy.value = false; }
}

async function copy() {
  if (!created.value) return;
  const version = generation;
  try {
    await navigator.clipboard.writeText(created.value.link);
    if (version === generation) { copied.value = true; error.value = null; }
  } catch {
    if (version === generation) { copied.value = false; error.value = "Couldn't copy. Select the link and copy it manually."; }
  }
}
function close() { if (!busy.value) emit("close"); }
</script>

<style>
.desktop-task-modal-backdrop.ask-agent-backdrop { grid-template-columns: minmax(0, 1fr); padding: 24px 16px; place-items: center; }
.ask-agent-dialog { width: min(600px, 100%); max-height: calc(100dvh - 48px); display: flex; min-width: 0; min-height: 0; outline: none; box-shadow: 0 32px 100px #0006; border-radius: 17px; }
@media (max-width:480px) {
  .desktop-task-modal-backdrop.ask-agent-backdrop { padding: 16px; }
  .ask-agent-dialog { max-height: calc(100dvh - 32px); }
}
</style>
