<template>
  <div
    ref="surfaceElement"
    class="app-agent"
    :data-open="open"
    :style="positionStyle"
    data-testid="desktop-app-agent"
  >
    <Transition name="app-agent-launcher-transition">
      <AppAgentLauncher
        v-if="!open"
        :surface-state="surfaceState"
        @drag-start="startDrag"
        @open="openFromLauncher"
      />
    </Transition>

    <Transition name="app-agent-panel-transition" @after-leave="clearResultAfterClose">
      <AppAgentPanelShell
        v-if="open"
        :kicker="surfaceKicker"
        :status-label="statusLabel"
        :surface-state="surfaceState"
        @close="closePanel"
        @drag-start="startDrag"
      >
        <AppAgentComposer
          v-model:prompt="prompt"
          :busy="busy"
          @open-settings="$emit('open-settings')"
          @submit="submitPrompt"
        />
        <AppAgentResultTrace :busy="busy" :result="result" />
        <AppAgentChoicesConfirmation
          :busy="busy"
          :result="result"
          @cancel="$emit('clear-result')"
          @confirm-action="confirmAction"
          @confirm-plan="confirmPlan"
          @select-action="selectAction"
        />
      </AppAgentPanelShell>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type {
  DesktopAppAgentActionPlan,
  DesktopAppAgentActionReference,
  DesktopAppAgentRunResult,
  DesktopAppAgentSettingsStatus,
} from "../../../../../electron/ipc-types";
import {
  appAgentSurfaceKicker,
  appAgentSurfaceState,
  appAgentStatusLabel,
  buildAppAgentRunInput,
} from "../../../domain/app-agent";
import AppAgentChoicesConfirmation from "./AppAgentChoicesConfirmation.vue";
import AppAgentComposer from "./AppAgentComposer.vue";
import AppAgentLauncher from "./AppAgentLauncher.vue";
import AppAgentPanelShell from "./AppAgentPanelShell.vue";
import AppAgentResultTrace from "./AppAgentResultTrace.vue";
import { useAppAgentPosition } from "./useAppAgentPosition";

const props = defineProps<{
  activeRoomDisplayName: string | null;
  activeRoomIdentifier: string | null;
  activeRoomPinned: boolean;
  busy: boolean;
  result: DesktopAppAgentRunResult | null;
  settingsStatus: DesktopAppAgentSettingsStatus | null;
}>();

const emit = defineEmits<{
  run: [input: NonNullable<ReturnType<typeof buildAppAgentRunInput>>];
  "open-settings": [];
  "clear-result": [];
}>();

const open = ref(false);
const surfaceElement = ref<HTMLElement | null>(null);
const prompt = ref("");
const lastPrompt = ref("");
const clearResultOnClose = ref(false);
const successVisualSettled = ref(false);
let successVisualResetTimer: number | null = null;
const {
  consumeSuppressedClick,
  placeLauncherFromPanelOrb,
  placePanelFromLauncher,
  positionStyle,
  startDrag,
} = useAppAgentPosition(open, surfaceElement);

const statusLabel = computed(() =>
  appAgentStatusLabel(props.settingsStatus, props.busy),
);
const surfaceState = computed(() =>
  appAgentSurfaceState({
    busy: props.busy,
    result: successVisualSettled.value ? null : props.result,
    settingsStatus: props.settingsStatus,
  }),
);
const surfaceKicker = computed(() => appAgentSurfaceKicker(surfaceState.value));

watch(open, () => {
  if (open.value) {
    window.requestAnimationFrame(() => {
      const promptInput = document.querySelector<HTMLTextAreaElement>("[data-testid='app-agent-prompt']");
      promptInput?.focus();
    });
  }
});

watch(prompt, (nextPrompt, previousPrompt) => {
  if (props.busy || !props.result || nextPrompt === previousPrompt) return;
  emit("clear-result");
});

watch(() => props.result, (result) => {
  clearSuccessVisualResetTimer();
  successVisualSettled.value = false;
  if (result?.state !== "success") return;
  successVisualResetTimer = window.setTimeout(() => {
    successVisualSettled.value = true;
  }, 1800);
});

onBeforeUnmount(() => {
  clearSuccessVisualResetTimer();
});

function openFromLauncher(): void {
  if (consumeSuppressedClick()) return;
  placePanelFromLauncher();
  open.value = true;
}

function closePanel(): void {
  placeLauncherFromPanelOrb();
  open.value = false;
  if (!props.busy && props.result) {
    clearResultOnClose.value = true;
  }
}

function clearResultAfterClose(): void {
  if (!clearResultOnClose.value) return;
  clearResultOnClose.value = false;
  successVisualSettled.value = false;
  clearSuccessVisualResetTimer();
  prompt.value = "";
  lastPrompt.value = "";
  emit("clear-result");
}

function clearSuccessVisualResetTimer(): void {
  if (successVisualResetTimer === null) return;
  window.clearTimeout(successVisualResetTimer);
  successVisualResetTimer = null;
}

function submitPrompt(): void {
  const nextPrompt = prompt.value.trim();
  if (!nextPrompt || props.busy) return;
  const runInput = buildAppAgentRunInput({
    prompt: nextPrompt,
    activeRoomDisplayName: props.activeRoomDisplayName,
    activeRoomIdentifier: props.activeRoomIdentifier,
    activeRoomPinned: props.activeRoomPinned,
  });
  if (!runInput) return;
  lastPrompt.value = nextPrompt;
  emit("run", runInput);
}

function selectAction(action: DesktopAppAgentActionReference): void {
  if (props.busy) return;
  const runInput = buildAppAgentRunInput({
    prompt: lastPrompt.value || prompt.value.trim(),
    activeRoomDisplayName: props.activeRoomDisplayName,
    activeRoomIdentifier: props.activeRoomIdentifier,
    activeRoomPinned: props.activeRoomPinned,
    selectedAction: action,
  });
  if (runInput) emit("run", runInput);
}

function confirmAction(action: DesktopAppAgentActionReference): void {
  if (props.busy) return;
  const runInput = buildAppAgentRunInput({
    prompt: lastPrompt.value || prompt.value.trim(),
    activeRoomDisplayName: props.activeRoomDisplayName,
    activeRoomIdentifier: props.activeRoomIdentifier,
    activeRoomPinned: props.activeRoomPinned,
    confirmedAction: action,
  });
  if (runInput) emit("run", runInput);
}

function confirmPlan(plan: DesktopAppAgentActionPlan): void {
  if (props.busy) return;
  const runInput = buildAppAgentRunInput({
    prompt: lastPrompt.value || prompt.value.trim(),
    activeRoomDisplayName: props.activeRoomDisplayName,
    activeRoomIdentifier: props.activeRoomIdentifier,
    activeRoomPinned: props.activeRoomPinned,
    confirmedPlan: plan,
  });
  if (runInput) emit("run", runInput);
}
</script>
