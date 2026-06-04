<template>
  <div
    class="desktop-modal-backdrop"
    data-testid="new-room-modal"
    @click.self="emit('close')"
  >
    <section class="desktop-new-room-modal" role="dialog" aria-modal="true" aria-labelledby="new-room-title">
      <header class="desktop-new-room-header">
        <div class="desktop-new-room-heading">
          <p class="desktop-new-room-kicker">New room</p>
          <h2 id="new-room-title">Open a room</h2>
          <p>Choose a project folder, join a shared room, or start a temporary room.</p>
        </div>
        <button class="desktop-modal-close" type="button" aria-label="Close new room dialog" @click="emit('close')">
          <X aria-hidden="true" />
        </button>
      </header>

      <div class="desktop-new-room-actions">
        <article
          v-for="action in primaryRoomActions"
          :key="action.id"
          class="desktop-new-room-action"
          :data-primary="action.primary ? 'true' : 'false'"
        >
          <span class="desktop-new-room-icon">
            <component :is="action.icon" aria-hidden="true" />
          </span>
          <div class="desktop-new-room-copy">
            <strong>{{ action.title }}</strong>
            <small>{{ action.description }}</small>
          </div>
          <button
            class="desktop-new-room-action-button"
            :class="{ primary: action.primary }"
            type="button"
            :disabled="busy"
            :data-testid="action.testId"
            @click="handleAction(action.event)"
          >
            {{ projectSelection ? "Change..." : action.buttonLabel }}
          </button>
          <div v-if="projectSelection" class="desktop-new-room-project-preview" data-testid="new-room-project-preview">
            <dl>
              <div>
                <dt>Project folder</dt>
                <dd>{{ projectSelection.folderLabel }}</dd>
              </div>
              <div>
                <dt>Room source</dt>
                <dd>{{ projectSelection.sourceLabel }}</dd>
              </div>
              <div>
                <dt>Room</dt>
                <dd>{{ projectSelection.roomName }}</dd>
              </div>
              <div>
                <dt>Identifier</dt>
                <dd>{{ projectSelection.roomIdentifier }}</dd>
              </div>
            </dl>
            <button
              class="desktop-new-room-action-button primary"
              type="button"
              :disabled="busy"
              data-testid="new-room-confirm-project"
              @click="emit('confirmProject')"
            >
              Open room
            </button>
          </div>
        </article>

        <form class="desktop-new-room-action desktop-new-room-join" @submit.prevent="emit('join')">
          <span class="desktop-new-room-icon">
            <KeyRound aria-hidden="true" />
          </span>
          <div class="desktop-new-room-copy">
            <strong>Join shared room</strong>
            <small>Use an invite code from a teammate.</small>
          </div>
          <div class="desktop-new-room-code">
            <input
              v-model="joinCode"
              type="text"
              placeholder="ABCD-1234"
              :disabled="busy"
              aria-label="Invite code"
            />
            <button type="submit" :disabled="busy || !joinCode.trim()">Join</button>
          </div>
        </form>

        <article
          v-for="action in secondaryRoomActions"
          :key="action.id"
          class="desktop-new-room-action"
          :data-primary="action.primary ? 'true' : 'false'"
        >
          <span class="desktop-new-room-icon">
            <component :is="action.icon" aria-hidden="true" />
          </span>
          <div class="desktop-new-room-copy">
            <strong>{{ action.title }}</strong>
            <small>{{ action.description }}</small>
          </div>
          <button
            class="desktop-new-room-action-button"
            :class="{ primary: action.primary }"
            type="button"
            :disabled="busy"
            :data-testid="action.testId"
            @click="handleAction(action.event)"
          >
            {{ action.buttonLabel }}
          </button>
        </article>
      </div>

      <p v-if="feedback" class="desktop-new-room-feedback" :data-state="feedbackState">
        {{ feedback }}
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { Component } from "vue";
import { FolderOpen, Hash, KeyRound, X } from "@lucide/vue";
import type { PendingProjectRoomSelection } from "../../../composables/useDesktopNewRoomModal";

defineProps<{
  busy: boolean;
  feedback: string | null;
  feedbackState: "info" | "error" | "success";
  projectSelection: PendingProjectRoomSelection | null;
}>();

const joinCode = defineModel<string>("joinCode", { required: true });

const emit = defineEmits<{
  close: [];
  confirmProject: [];
  createInvite: [];
  openProject: [];
  join: [];
}>();

type RoomActionEvent = "createInvite" | "openProject";

type RoomAction = {
  id: string;
  title: string;
  description: string;
  buttonLabel: string;
  event: RoomActionEvent;
  icon: Component;
  primary?: boolean;
  testId: string;
};

const primaryRoomActions: RoomAction[] = [
  {
    id: "project-folder",
    title: "Open project room",
    description: "Choose a local project and confirm the room LetAgents resolves.",
    buttonLabel: "Choose...",
    event: "openProject",
    icon: FolderOpen,
    primary: true,
    testId: "new-room-open-project",
  },
];

const secondaryRoomActions: RoomAction[] = [
  {
    id: "invite-room",
    title: "Start temporary room",
    description: "Create an ad-hoc room with a shareable code.",
    buttonLabel: "Start",
    event: "createInvite",
    icon: Hash,
    testId: "new-room-create-invite",
  },
];

function handleAction(event: RoomActionEvent): void {
  if (event === "openProject") {
    emit("openProject");
    return;
  }

  emit("createInvite");
}
</script>
