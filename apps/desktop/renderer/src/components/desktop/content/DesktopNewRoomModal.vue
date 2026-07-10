<template>
  <div
    class="desktop-modal-backdrop"
    data-testid="new-room-modal"
    @click.self="requestClose"
  >
    <section
      ref="dialogElement"
      class="desktop-new-room-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-room-title"
      :aria-describedby="descriptionId"
      :aria-busy="busy ? 'true' : 'false'"
      tabindex="-1"
      @keydown.esc.prevent="requestClose"
      @keydown.tab="handleDialogTab"
    >
      <header class="desktop-new-room-header">
        <div class="desktop-new-room-heading">
          <p class="desktop-new-room-kicker">New room</p>
          <h2 id="new-room-title">{{ title }}</h2>
          <p :id="descriptionId">{{ description }}</p>
        </div>
        <div class="desktop-new-room-header-actions">
          <button
            v-if="showBack"
            class="desktop-new-room-back"
            type="button"
            :disabled="busy"
            data-testid="new-room-back"
            @click="emit('back')"
          >
            Back
          </button>
          <button
            class="desktop-modal-close"
            type="button"
            aria-label="Close new room dialog"
            :disabled="busy"
            @click="requestClose"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      <div class="desktop-new-room-body" :data-step="step">
        <!-- Chooser -->
        <div v-if="step === 'chooser'" class="desktop-new-room-chooser" data-testid="new-room-chooser">
          <button
            v-for="intent in intents"
            :key="intent.id"
            class="desktop-new-room-choice"
            type="button"
            :data-primary="intent.primary ? 'true' : 'false'"
            :data-testid="intent.testId"
            :disabled="busy"
            @click="handleIntent(intent.event)"
          >
            <span class="desktop-new-room-icon">
              <component :is="intent.icon" aria-hidden="true" />
            </span>
            <span class="desktop-new-room-copy">
              <strong>{{ intent.title }}</strong>
              <small>{{ intent.description }}</small>
            </span>
            <span v-if="intent.primary" class="desktop-new-room-choice-cta">Continue</span>
          </button>
        </div>

        <!-- Project -->
        <div v-else-if="step === 'project'" class="desktop-new-room-step" data-testid="new-room-project-step">
          <button
            class="desktop-new-room-action-button primary desktop-new-room-full-button"
            type="button"
            :disabled="busy"
            data-testid="new-room-open-project"
            @click="emit('openProject')"
          >
            {{ projectSelection ? "Change folder" : "Choose project folder" }}
          </button>

          <div
            v-if="projectSelection"
            class="desktop-new-room-project-preview"
            data-testid="new-room-project-preview"
          >
            <dl>
              <div>
                <dt>Project folder</dt>
                <dd :title="projectSelection.folderLabel">{{ projectSelection.folderLabel }}</dd>
              </div>
              <div>
                <dt>Room source</dt>
                <dd>{{ projectSelection.sourceLabel }}</dd>
              </div>
              <div>
                <dt>Room</dt>
                <dd :title="projectSelection.roomName">{{ projectSelection.roomName }}</dd>
              </div>
              <div>
                <dt>Identifier</dt>
                <dd :title="projectSelection.roomIdentifier">{{ projectSelection.roomIdentifier }}</dd>
              </div>
              <div v-if="projectSelection.repoStatus?.branch">
                <dt>Branch</dt>
                <dd>{{ projectSelection.repoStatus.branch }}</dd>
              </div>
            </dl>
            <p v-if="projectSelection.warning" class="desktop-new-room-warning">
              {{ projectSelection.warning }}
            </p>
            <button
              class="desktop-new-room-action-button primary desktop-new-room-full-button"
              type="button"
              :disabled="busy"
              data-testid="new-room-confirm-project"
              @click="emit('confirmProject')"
            >
              Open project room
            </button>
          </div>
        </div>

        <!-- Standalone -->
        <form
          v-else-if="step === 'standalone'"
          class="desktop-new-room-step"
          data-testid="new-room-standalone-step"
          @submit.prevent="emit('createStandalone')"
        >
          <label class="desktop-new-room-field">
            <span>Room name</span>
            <input
              v-model="roomName"
              type="text"
              maxlength="80"
              placeholder="Team sync"
              autocomplete="off"
              spellcheck="false"
              :disabled="busy"
              data-testid="new-room-name-input"
            />
          </label>

          <fieldset class="desktop-new-room-storage" :disabled="busy">
            <legend>Storage</legend>
            <label class="desktop-new-room-storage-option" data-testid="new-room-storage-cloud">
              <input v-model="storage" type="radio" value="cloud" />
              <span>
                <strong>Cloud / shared</strong>
                <small>Creates an invite code teammates can use.</small>
              </span>
            </label>
            <label class="desktop-new-room-storage-option" data-testid="new-room-storage-local">
              <input v-model="storage" type="radio" value="local" />
              <span>
                <strong>Local / private</strong>
                <small>Stays on this device until you publish it.</small>
              </span>
            </label>
          </fieldset>

          <button
            class="desktop-new-room-action-button primary desktop-new-room-full-button"
            type="submit"
            :disabled="busy || !canSubmitStandalone"
            data-testid="new-room-create-standalone"
            :aria-busy="activeAction === 'create_standalone' ? 'true' : 'false'"
          >
            {{ storage === "local" ? "Create local room" : "Create shared room" }}
          </button>
        </form>

        <!-- Join -->
        <form
          v-else-if="step === 'join'"
          class="desktop-new-room-step"
          data-testid="new-room-join-step"
          @submit.prevent="emit('join')"
        >
          <label class="desktop-new-room-field">
            <span>Invite code or room URL</span>
            <input
              ref="joinInputElement"
              v-model="joinCode"
              type="text"
              placeholder="ABCD-1234 or https://letagents.chat/in/…"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              :disabled="busy"
              :aria-invalid="joinError ? 'true' : 'false'"
              :aria-describedby="joinError ? 'new-room-join-error' : 'new-room-join-hint'"
              data-testid="new-room-join-input"
            />
            <small id="new-room-join-hint" class="desktop-new-room-hint">
              Paste a code or LetAgents room link. Spaces and case are normalized.
            </small>
            <small
              v-if="joinError"
              id="new-room-join-error"
              class="desktop-new-room-field-error"
              role="alert"
            >
              {{ joinError }}
            </small>
          </label>
          <button
            class="desktop-new-room-action-button primary desktop-new-room-full-button"
            type="submit"
            :disabled="busy || !canSubmitJoin"
            data-testid="new-room-join-submit"
            :aria-busy="activeAction === 'join' ? 'true' : 'false'"
          >
            Join room
          </button>
        </form>

        <!-- Working -->
        <div
          v-else-if="step === 'working'"
          class="desktop-new-room-step desktop-new-room-working"
          data-testid="new-room-working-step"
          role="status"
          aria-live="polite"
        >
          <div class="desktop-new-room-spinner" aria-hidden="true" />
          <p>{{ statusMessage || "Working…" }}</p>
        </div>

        <!-- Success -->
        <div
          v-else-if="step === 'success' && success"
          class="desktop-new-room-step desktop-new-room-success"
          data-testid="new-room-success-step"
        >
          <p class="desktop-new-room-success-kicker" role="status" aria-live="polite">
            Room ready
          </p>
          <h3>{{ success.roomName }}</h3>
          <p class="desktop-new-room-success-meta">{{ success.storageLabel }}</p>

          <div
            v-if="success.inviteCode"
            class="desktop-new-room-invite"
            data-testid="new-room-invite-code"
          >
            <code>{{ success.inviteCode }}</code>
            <button
              class="desktop-new-room-action-button"
              type="button"
              data-testid="new-room-copy-code"
              @click="emit('copyCode')"
            >
              Copy code
            </button>
          </div>

          <div class="desktop-new-room-success-actions">
            <button
              class="desktop-new-room-action-button primary"
              type="button"
              data-testid="new-room-open-success"
              @click="emit('openSuccess')"
            >
              Open room
            </button>
            <button
              class="desktop-new-room-action-button"
              type="button"
              data-testid="new-room-done"
              @click="emit('dismissSuccess')"
            >
              Done
            </button>
          </div>
        </div>

        <!-- Error -->
        <div
          v-else-if="step === 'error'"
          class="desktop-new-room-step desktop-new-room-error-step"
          data-testid="new-room-error-step"
        >
          <p
            ref="errorElement"
            class="desktop-new-room-feedback"
            data-state="error"
            role="alert"
            aria-live="assertive"
            tabindex="-1"
          >
            {{ feedback || "Something went wrong." }}
          </p>
          <div class="desktop-new-room-success-actions">
            <button
              class="desktop-new-room-action-button primary"
              type="button"
              data-testid="new-room-retry"
              :disabled="busy"
              @click="emit('retry')"
            >
              Retry
            </button>
            <button
              class="desktop-new-room-action-button"
              type="button"
              data-testid="new-room-error-back"
              :disabled="busy"
              @click="emit('back')"
            >
              Back
            </button>
          </div>
        </div>
      </div>

      <p
        v-if="feedback && step !== 'error'"
        class="desktop-new-room-feedback"
        :data-state="feedbackState"
        :role="feedbackState === 'error' ? 'alert' : 'status'"
        :aria-live="feedbackState === 'error' ? 'assertive' : 'polite'"
      >
        {{ feedback }}
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { Component } from "vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { FolderOpen, Hash, KeyRound, X } from "@lucide/vue";
import type {
  NewRoomActiveAction,
  NewRoomStep,
  NewRoomStorageChoice,
  NewRoomSuccessState,
  PendingProjectRoomSelection,
} from "../../../composables/useDesktopNewRoomModal";
import {
  currentFocusableElement,
  restoreFocus,
  trapFocusInDialog,
} from "./modal-focus";

const props = defineProps<{
  step: NewRoomStep;
  busy: boolean;
  activeAction: NewRoomActiveAction;
  feedback: string | null;
  feedbackState: "info" | "error" | "success";
  projectSelection: PendingProjectRoomSelection | null;
  success: NewRoomSuccessState | null;
  statusMessage: string | null;
  joinError: string | null;
  canSubmitJoin: boolean;
  canSubmitStandalone: boolean;
}>();

const joinCode = defineModel<string>("joinCode", { required: true });
const roomName = defineModel<string>("roomName", { required: true });
const storage = defineModel<NewRoomStorageChoice>("storage", { required: true });

const emit = defineEmits<{
  back: [];
  chooseJoin: [];
  chooseProject: [];
  chooseStandalone: [];
  close: [];
  confirmProject: [];
  copyCode: [];
  createStandalone: [];
  dismissSuccess: [];
  join: [];
  openProject: [];
  openSuccess: [];
  retry: [];
}>();

const dialogElement = ref<HTMLElement | null>(null);
const joinInputElement = ref<HTMLInputElement | null>(null);
const errorElement = ref<HTMLElement | null>(null);
const previousFocusElement = ref<HTMLElement | null>(null);
const descriptionId = "new-room-description";

type IntentEvent = "chooseProject" | "chooseStandalone" | "chooseJoin";

type Intent = {
  id: string;
  title: string;
  description: string;
  event: IntentEvent;
  icon: Component;
  primary?: boolean;
  testId: string;
};

const intents: Intent[] = [
  {
    id: "project",
    title: "Work on a project",
    description: "Open a folder so LetAgents can route you to the matching repository room.",
    event: "chooseProject",
    icon: FolderOpen,
    primary: true,
    testId: "new-room-intent-project",
  },
  {
    id: "standalone",
    title: "Start a standalone room",
    description: "Create a named room and choose Cloud/shared or Local/private storage.",
    event: "chooseStandalone",
    icon: Hash,
    testId: "new-room-intent-standalone",
  },
  {
    id: "join",
    title: "Join with a code",
    description: "Paste an invite code or LetAgents room URL.",
    event: "chooseJoin",
    icon: KeyRound,
    testId: "new-room-intent-join",
  },
];

const title = computed(() => {
  switch (props.step) {
    case "project":
      return "Work on a project";
    case "standalone":
      return "Start a standalone room";
    case "join":
      return "Join with a code";
    case "working":
      return "Working";
    case "success":
      return "Room ready";
    case "error":
      return "Couldn’t finish";
    default:
      return "Create or join a room";
  }
});

const description = computed(() => {
  switch (props.step) {
    case "project":
      return "Choose a folder, confirm the detected room, then open it.";
    case "standalone":
      return "Name the room and pick how it should be stored.";
    case "join":
      return "Enter an invite code or paste a room link.";
    case "working":
      return props.statusMessage || "Please wait while LetAgents finishes this step.";
    case "success":
      return props.success?.inviteCode
        ? "Share the invite code, then open the room when you’re ready."
        : "Open the room when you’re ready.";
    case "error":
      return "Your inputs are still here. Retry or go back.";
    default:
      return "Pick one path. Project is recommended for repository work.";
  }
});

const showBack = computed(() =>
  props.step === "project" ||
  props.step === "standalone" ||
  props.step === "join" ||
  props.step === "error"
);

function handleIntent(event: IntentEvent): void {
  if (event === "chooseProject") {
    emit("chooseProject");
    return;
  }
  if (event === "chooseStandalone") {
    emit("chooseStandalone");
    return;
  }
  emit("chooseJoin");
}

function requestClose(): void {
  if (props.busy) return;
  emit("close");
}

function handleDialogTab(event: KeyboardEvent): void {
  trapFocusInDialog(event, dialogElement.value);
}

onMounted(async () => {
  previousFocusElement.value = currentFocusableElement();
  await nextTick();
  focusInitialControl();
});

onBeforeUnmount(() => {
  restoreFocus(previousFocusElement.value);
});

watch(
  () => props.step,
  async (step) => {
    await nextTick();
    if (step === "join") {
      joinInputElement.value?.focus({ preventScroll: true });
      return;
    }
    if (step === "error") {
      errorElement.value?.focus({ preventScroll: true });
      return;
    }
    focusInitialControl();
  },
);

function focusInitialControl(): void {
  const dialog = dialogElement.value;
  if (!dialog) return;
  const preferred = dialog.querySelector<HTMLElement>(
    "[data-primary='true'], input:not([disabled]), button.primary:not([disabled]), button:not([disabled])",
  );
  (preferred || dialog).focus({ preventScroll: true });
}
</script>
