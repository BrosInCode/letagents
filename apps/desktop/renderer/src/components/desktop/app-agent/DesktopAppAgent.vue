<template>
  <div
    class="app-agent"
    :data-open="open"
    :style="positionStyle"
    data-testid="desktop-app-agent"
  >
    <button
      v-if="!open"
      class="app-agent-launcher"
      type="button"
      title="App Agent"
      aria-label="Open App Agent"
      data-testid="app-agent-launcher"
      @click="openFromLauncher"
      @pointerdown="startDrag"
    >
      <Bot aria-hidden="true" />
    </button>

    <section v-else class="app-agent-panel" data-testid="app-agent-panel">
      <header class="app-agent-header" @pointerdown="startDrag">
        <GripVertical aria-hidden="true" />
        <div>
          <p>App Agent</p>
          <span>{{ statusLabel }}</span>
        </div>
        <button
          class="app-agent-icon-button"
          type="button"
          title="Close"
          aria-label="Close App Agent"
          @pointerdown.stop
          @click="open = false"
        >
          <X aria-hidden="true" />
        </button>
      </header>

      <form class="app-agent-form" @submit.prevent="submitPrompt">
        <textarea
          v-model="prompt"
          :disabled="busy"
          rows="3"
          placeholder="Pin the LetAgents room."
          data-testid="app-agent-prompt"
        ></textarea>
        <div class="app-agent-actions">
          <button
            class="ghost-button app-agent-command-button"
            type="button"
            title="App Agent settings"
            @click="$emit('open-settings')"
          >
            <Settings aria-hidden="true" />
          </button>
          <button
            class="primary-button app-agent-command-button"
            type="submit"
            :disabled="busy || !prompt.trim()"
            data-testid="app-agent-submit"
          >
            <Send aria-hidden="true" />
            <span>{{ busy ? "Running" : "Run" }}</span>
          </button>
        </div>
      </form>

      <p
        v-if="result?.message"
        class="app-agent-message"
        :data-state="result.state"
        data-testid="app-agent-message"
      >
        {{ result.message }}
      </p>

      <div
        v-if="choices.length"
        class="app-agent-choices"
        data-testid="app-agent-choices"
      >
        <button
          v-for="choice in choices"
          :key="choice.roomIdentifier"
          class="app-agent-choice"
          type="button"
          :disabled="busy"
          @click="selectChoice(choice)"
        >
          <Pin aria-hidden="true" />
          <span>{{ choice.displayName }}</span>
          <small>{{ choice.reason }}</small>
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { Bot, GripVertical, Pin, Send, Settings, X } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  DesktopAppAgentRoomChoice,
  DesktopAppAgentRunResult,
  DesktopAppAgentSettingsStatus,
} from "../../../../../electron/ipc-types";
import {
  appAgentStatusLabel,
  buildAppAgentRunInput,
  visibleAppAgentChoices,
} from "../../../domain/app-agent";

const props = defineProps<{
  activeRoomIdentifier: string | null;
  busy: boolean;
  result: DesktopAppAgentRunResult | null;
  settingsStatus: DesktopAppAgentSettingsStatus | null;
}>();

const emit = defineEmits<{
  run: [input: NonNullable<ReturnType<typeof buildAppAgentRunInput>>];
  "open-settings": [];
}>();

const storageKey = "letagents-desktop:app-agent-position";
const open = ref(false);
const prompt = ref("");
const lastPrompt = ref("");
const position = ref({ x: 0, y: 0 });
const dragMoved = ref(false);
const suppressLauncherClick = ref(false);

const positionStyle = computed(() => ({
  left: `${position.value.x}px`,
  top: `${position.value.y}px`,
}));

const statusLabel = computed(() =>
  appAgentStatusLabel(props.settingsStatus, props.busy),
);
const choices = computed(() => visibleAppAgentChoices(props.result));

watch(open, () => {
  clampPosition();
});

function openFromLauncher(): void {
  if (suppressLauncherClick.value) {
    suppressLauncherClick.value = false;
    return;
  }
  open.value = true;
}

function submitPrompt(): void {
  const nextPrompt = prompt.value.trim();
  if (!nextPrompt || props.busy) return;
  const runInput = buildAppAgentRunInput({
    prompt: nextPrompt,
    activeRoomIdentifier: props.activeRoomIdentifier,
  });
  if (!runInput) return;
  lastPrompt.value = nextPrompt;
  emit("run", runInput);
}

function selectChoice(choice: DesktopAppAgentRoomChoice): void {
  if (props.busy) return;
  const runInput = buildAppAgentRunInput({
    prompt: lastPrompt.value || prompt.value.trim(),
    activeRoomIdentifier: props.activeRoomIdentifier,
    selectedRoomIdentifier: choice.roomIdentifier,
    selectedPinned: choice.desiredPinned,
  });
  if (runInput) emit("run", runInput);
}

function startDrag(event: PointerEvent): void {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const startY = event.clientY;
  const initial = { ...position.value };
  dragMoved.value = false;
  const pointerId = event.pointerId;
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture?.(pointerId);

  function handlePointerMove(moveEvent: PointerEvent): void {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      dragMoved.value = true;
    }
    position.value = {
      x: initial.x + dx,
      y: initial.y + dy,
    };
    clampPosition();
  }

  function handlePointerUp(): void {
    target.releasePointerCapture?.(pointerId);
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
    if (dragMoved.value) {
      suppressLauncherClick.value = true;
    }
    rememberPosition();
  }

  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerUp);
}

function restorePosition(): void {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || "null") as
      | { x?: number; y?: number }
      | null;
    if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
      position.value = { x: Number(parsed?.x), y: Number(parsed?.y) };
      clampPosition();
      return;
    }
  } catch {
    // Position persistence is optional.
  }
  position.value = {
    x: Math.max(16, window.innerWidth - 88),
    y: Math.max(84, window.innerHeight - 116),
  };
}

function rememberPosition(): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(position.value));
  } catch {
    // Position persistence is optional.
  }
}

function clampPosition(): void {
  const width = open.value ? 380 : 58;
  const height = open.value ? 430 : 58;
  position.value = {
    x: Math.min(Math.max(12, position.value.x), Math.max(12, window.innerWidth - width - 12)),
    y: Math.min(Math.max(72, position.value.y), Math.max(72, window.innerHeight - height - 12)),
  };
}

onMounted(() => {
  restorePosition();
  window.addEventListener("resize", clampPosition);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", clampPosition);
});
</script>
