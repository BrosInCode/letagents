<template>
  <DesktopDialogShell
    :open="open"
    panel-tag="form"
    panel-class="desktop-task-modal agent-ask-dialog"
    aria-labelledby="agent-ask-title"
    close-label="Close"
    :close-disabled="busy"
    initial-focus="#agent-ask-room"
    test-id="agent-ask-dialog"
    @close="emit('close')"
    @submit="submit"
  >
    <header class="agent-ask-header">
      <h3 id="agent-ask-title">{{ created ? "Link ready" : "Ask for an agent" }}</h3>
    </header>

    <template v-if="!created">
      <label class="agent-ask-field" for="agent-ask-room">
        <span>Room</span>
        <select id="agent-ask-room" v-model="roomChoice" :disabled="busy" data-testid="agent-ask-room">
          <option value="__new__">+ New room</option>
          <option v-for="option in roomOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <label v-if="roomChoice === '__new__'" class="agent-ask-field" for="agent-ask-new-room">
        <span>New room name</span>
        <input id="agent-ask-new-room" v-model="newRoomName" type="text" maxlength="80" placeholder="Brainstorm" :disabled="busy" />
      </label>

      <label class="agent-ask-field" for="agent-ask-model">
        <span>Model</span>
        <select id="agent-ask-model" v-model="modelChoice" :disabled="busy || !models.length" data-testid="agent-ask-model">
          <option v-for="(model, index) in models" :key="model.label" :value="String(index)">{{ model.label }}</option>
        </select>
      </label>

      <fieldset class="agent-ask-field agent-ask-amount">
        <legend>How much do you need? <small>optional</small></legend>
        <div class="agent-ask-chips">
          <button type="button" :aria-pressed="amount === null && !customOpen" :disabled="busy" @click="pickAmount(null)">Any</button>
          <button v-for="choice in AMOUNT_CHOICES" :key="choice" type="button" :aria-pressed="amount === choice && !customOpen"
            :disabled="busy" @click="pickAmount(choice)">{{ choice }}%</button>
          <button type="button" :aria-pressed="customOpen" :disabled="busy" @click="customOpen = true">Custom</button>
        </div>
        <input v-if="customOpen" v-model="customText" class="agent-ask-custom" type="text" inputmode="numeric"
          placeholder="15" aria-label="Custom amount in percent" :disabled="busy" />
        <small class="agent-ask-hint">Of the giver's main usage limit.</small>
      </fieldset>

      <label class="agent-ask-field" for="agent-ask-note">
        <span>Note <small>optional</small></span>
        <textarea id="agent-ask-note" v-model="note" rows="2" maxlength="500" placeholder="My quota ran out. Finish the auth fix." :disabled="busy" />
      </label>

      <p v-if="error" class="desktop-task-dialog-error" role="alert">{{ error }}</p>

      <footer class="desktop-task-create-actions">
        <button type="button" class="desktop-task-detail-button" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="desktop-board-primary-action" type="submit" :disabled="busy || !models.length" data-testid="agent-ask-create">
          {{ busy ? "Creating..." : "Create link" }}
        </button>
      </footer>
    </template>

    <template v-else>
      <p class="agent-ask-ready-copy">Works for one person and expires in 24 hours. The first person to add the agent uses it.</p>
      <div class="agent-ask-link-row">
        <code data-testid="agent-ask-link">{{ created.link }}</code>
        <button type="button" class="desktop-board-primary-action" @click="copy">{{ copied ? "Copied" : "Copy" }}</button>
      </div>
      <footer class="desktop-task-create-actions">
        <button type="button" class="desktop-task-detail-button" @click="emit('close')">Done</button>
      </footer>
    </template>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DesktopAccountRoomEntry } from "../../../../../../electron/ipc-types/room";
import type { DesktopAgentAskModel } from "../../../../../../electron/ipc-types/asks";
import { desktopIpc, desktopBridgeUpgradeMessage } from "../../../../ipc/index.js";
import DesktopDialogShell from "../DesktopDialogShell.vue";
import { AMOUNT_CHOICES, parseCustomAmount, rememberAskLink } from "./ask-links";

const props = defineProps<{
  open: boolean;
  roomIdentifier: string | null;
  rooms: DesktopAccountRoomEntry[];
  /** The model that just ran out, when opened from the usage-limit notice (S15). */
  presetModelLabel?: string | null;
}>();
const emit = defineEmits<{ close: []; created: [roomIdentifier: string] }>();

const models = ref<DesktopAgentAskModel[]>([]);
const modelChoice = ref("0");
const roomChoice = ref("");
const newRoomName = ref("");
const amount = ref<number | null>(null);
const customOpen = ref(false);
const customText = ref("");
const note = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const created = ref<{ link: string } | null>(null);
const copied = ref(false);

/** Rooms with their focus rooms nested underneath (D20). */
const roomOptions = computed(() => props.rooms.filter(room => !room.archived).flatMap(room => [
  { value: room.roomIdentifier, label: room.displayName || room.name },
  ...(room.focusRooms ?? []).map(focus => ({ value: focus.roomIdentifier, label: `    ${focus.displayName || focus.name}` })),
]));

function pickAmount(value: number | null) { amount.value = value; customOpen.value = false; }

watch(() => props.open, async open => {
  if (!open) return;
  created.value = null; error.value = null; note.value = ""; amount.value = null; customOpen.value = false;
  customText.value = ""; newRoomName.value = ""; copied.value = false;
  roomChoice.value = props.roomIdentifier ?? roomOptions.value[0]?.value ?? "__new__";
  const result = await desktopIpc.asks?.listModels();
  if (!result) { error.value = desktopBridgeUpgradeMessage(); return; }
  if (!result.ok) { error.value = result.error; return; }
  models.value = result.value;
  const preset = props.presetModelLabel ? result.value.findIndex(model => model.label === props.presetModelLabel) : -1;
  modelChoice.value = String(Math.max(0, preset));
}, { immediate: true });

async function submit() {
  if (busy.value) return;
  const model = models.value[Number(modelChoice.value)];
  const chosenAmount = customOpen.value ? parseCustomAmount(customText.value) : amount.value;
  if (!model) { error.value = "Choose a model."; return; }
  if (customOpen.value && chosenAmount === null) { error.value = "Enter a whole number from 1 to 100."; return; }
  busy.value = true; error.value = null;
  try {
    let roomId = roomChoice.value;
    if (roomId === "__new__") {
      const room = await desktopIpc.room.createInviteRoom();
      roomId = room.roomIdentifier;
      if (newRoomName.value.trim()) await desktopIpc.room.rename?.(roomId, newRoomName.value.trim()).catch(() => undefined);
    }
    const result = await desktopIpc.asks?.create({ roomId, providerId: model.providerId, model: model.model, amountPercent: chosenAmount, note: note.value });
    if (!result) { error.value = desktopBridgeUpgradeMessage(); return; }
    if (!result.ok) { error.value = result.error; return; }
    rememberAskLink(result.value.ask.id, result.value.link);
    created.value = { link: result.value.link };
    emit("created", roomId);
  } catch {
    error.value = "Couldn't create the link. Try again.";
  } finally {
    busy.value = false;
  }
}

async function copy() {
  if (!created.value) return;
  try { await navigator.clipboard.writeText(created.value.link); copied.value = true; } catch { copied.value = false; }
}
</script>
