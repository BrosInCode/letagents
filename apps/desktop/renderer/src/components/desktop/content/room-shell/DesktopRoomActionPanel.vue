<template>
  <div class="room-settings" data-testid="desktop-room-action-panel">
    <header class="room-settings-header">
      <div>
        <h2 id="desktop-room-settings-title">Room settings</h2>
        <p>
          <strong>{{ room.displayName }}</strong>
          <span class="room-settings-pill">{{ room.role }}</span>
        </p>
      </div>
      <button
        class="room-settings-button room-settings-close"
        type="button"
        aria-label="Close room settings"
        @click="$emit('close')"
      >
        <X aria-hidden="true" />
      </button>
    </header>

    <nav class="room-settings-rail" aria-label="Room settings sections">
      <div class="room-settings-nav">
        <span
          class="room-settings-nav-indicator"
          aria-hidden="true"
          :data-ready="indicatorReady"
          :style="{ transform: `translateY(${activeSectionIndex * 42}px)` }"
        />
        <button
          v-for="section in sections"
          :key="section.id"
          class="room-settings-nav-item"
          type="button"
          :data-testid="`desktop-room-settings-nav-${section.id}`"
          :aria-current="activeSection === section.id ? 'true' : undefined"
          @click="goToSection(section.id)"
        >
          <component :is="section.icon" aria-hidden="true" />
          <span>{{ section.title }}</span>
          <span v-if="section.dot" class="room-settings-nav-value">
            <span class="room-settings-dot" :data-state="section.dot" aria-hidden="true" />
            <span class="sr-only">{{ section.summary }}</span>
          </span>
          <span v-else-if="section.summary" class="room-settings-nav-value">{{ section.summary }}</span>
        </button>
      </div>
    </nav>

    <div ref="contentElement" class="room-settings-content" @scroll.passive="syncActiveSection" @wheel.passive="releaseSectionLock">
      <section class="room-settings-section" data-section="general" aria-labelledby="room-settings-heading-general">
        <h3 id="room-settings-heading-general">General</h3>
        <div class="room-settings-list">
          <form class="room-settings-row" data-testid="desktop-room-rename-card" @submit.prevent="submitRename">
            <div class="room-settings-row-copy">
              <label class="room-settings-row-title" for="room-settings-name">Name</label>
              <p
                id="room-settings-name-description"
                class="room-settings-row-description"
                :data-tone="renameError ? 'error' : undefined"
                :role="renameError ? 'alert' : undefined"
              >{{ renameError || "Shown in the sidebar and room list." }}</p>
            </div>
            <div class="room-settings-row-action room-settings-name">
              <input
                id="room-settings-name"
                v-model="renameDraft"
                class="room-settings-input"
                type="text"
                autocomplete="off"
                spellcheck="false"
                placeholder="Name this room"
                aria-describedby="room-settings-name-description"
                :readonly="renameBusy"
                @keydown.esc="discardRenameOnEscape"
              >
              <button
                class="room-settings-button room-settings-save"
                type="submit"
                :data-variant="renameDirty ? 'primary' : undefined"
                :aria-disabled="renameBusy || !renameDirty"
              >{{ renameLabel }}</button>
            </div>
          </form>

          <div class="room-settings-row" data-inline="true" data-testid="desktop-room-share-card">
            <div class="room-settings-row-copy">
              <p class="room-settings-row-title">Room link</p>
              <p class="room-settings-mono" :title="roomUrl">{{ shortRoomUrl }}</p>
            </div>
            <div class="room-settings-row-action">
              <button class="room-settings-button room-settings-copy" type="button" :data-copied="copied" @click="$emit('copy-room-link')">
                <span class="room-settings-copy-icons" aria-hidden="true"><Copy /><Check /></span>
                {{ copied ? "Copied" : "Copy link" }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section
        v-if="cloudRoom"
        class="room-settings-section"
        data-section="conversation"
        aria-labelledby="room-settings-heading-conversation"
      >
        <h3 id="room-settings-heading-conversation">Conversation</h3>
        <div class="room-settings-list">
          <RoomConversationRouting :room-identifier="room.identifier" @summary="routingSummary = $event" />
        </div>
      </section>

      <section class="room-settings-section" data-section="guidelines" aria-labelledby="room-settings-heading-guidelines">
        <h3 id="room-settings-heading-guidelines">Guidelines</h3>
        <div class="room-settings-list">
          <div class="room-settings-row" data-inline="true" data-testid="desktop-room-rules-card">
            <div class="room-settings-row-copy">
              <p class="room-settings-row-title">Room contract</p>
              <p class="room-settings-row-description">How work moves in every LetAgents room. Built in, the same for everyone.</p>
            </div>
            <div class="room-settings-row-action">
              <button class="room-settings-button" type="button" @click="$emit('open-rules')">Open</button>
            </div>
          </div>
          <RoomAgentGuidelines v-if="cloudRoom" :room-identifier="room.identifier" @summary="guidelinesSummary = $event" />
        </div>
      </section>

      <section class="room-settings-section" data-section="data" aria-labelledby="room-settings-heading-data">
        <h3 id="room-settings-heading-data">Data</h3>
        <div class="room-settings-list">
          <SmoothHeight>
            <div
              class="room-settings-row"
              :aria-busy="storageBusy"
              data-testid="desktop-room-storage-card"
            >
              <div class="room-settings-row-copy">
                <p id="room-settings-storage-title" class="room-settings-row-title">Storage</p>
                <Transition name="room-settings-text" mode="out-in">
                  <p :key="storageDescription" class="room-settings-row-description">{{ storageDescription }}</p>
                </Transition>
                <p class="sr-only" role="status">{{ storageBusy ? "Changing room storage…" : "" }}</p>
              </div>
              <div class="room-settings-row-action">
                <div
                  class="room-settings-segmented"
                  role="radiogroup"
                  aria-labelledby="room-settings-storage-title"
                  @keydown="moveStorageSelection"
                >
                  <span
                    class="room-settings-segmented-thumb"
                    aria-hidden="true"
                    :style="{ transform: `translateX(${storageOptions.findIndex((option) => option.active) * 100}%)` }"
                  />
                  <span
                    v-for="option in storageOptions"
                    :key="option.mode"
                    class="room-settings-segment"
                    :class="{ 'is-unavailable': option.unavailableReason }"
                    :title="option.unavailableReason || undefined"
                  >
                    <!-- Not `disabled`: a choice that cannot be made stays reachable,
                         so its reason is read out, and focus is never dropped mid-change. -->
                    <button
                      type="button"
                      role="radio"
                      :data-testid="`desktop-room-storage-${option.mode}`"
                      :data-mode="option.mode"
                      :aria-checked="option.active"
                      :aria-disabled="storageBusy || Boolean(option.unavailableReason)"
                      :aria-describedby="option.unavailableReason ? `room-settings-storage-${option.mode}-reason` : undefined"
                      :tabindex="option.active ? 0 : -1"
                      @click="selectStorage(option.mode)"
                    >{{ option.label }}</button>
                    <span
                      v-if="option.unavailableReason"
                      :id="`room-settings-storage-${option.mode}-reason`"
                      class="sr-only"
                    >{{ option.unavailableReason }}</span>
                  </span>
                </div>
              </div>
              <Transition name="room-settings-reveal">
                <div v-if="storage.effectiveMode === 'local'" class="room-settings-storage-local">
                  <p class="room-settings-mono" :title="storage.databasePath">{{ storage.databasePath }}</p>
                  <button
                    v-if="canPublishLocalRoom"
                    class="room-settings-button room-settings-publish"
                    type="button"
                    data-variant="primary"
                    :aria-disabled="storageBusy"
                    @click="publishLocalRoom"
                  >{{ publishing ? "Publishing…" : "Publish to cloud" }}</button>
                </div>
              </Transition>
              <Transition name="room-settings-progress">
                <span v-if="storageBusy" class="room-settings-progress" aria-hidden="true" />
              </Transition>
            </div>
          </SmoothHeight>

          <div class="room-settings-row" data-inline="true" data-testid="desktop-room-export-card">
            <div class="room-settings-row-copy">
              <p class="room-settings-row-title">Export chat</p>
              <p class="room-settings-row-description">Download the visible chat history as plain text.</p>
            </div>
            <div class="room-settings-row-action">
              <button class="room-settings-button" type="button" @click="$emit('export-chat')">
                <Download aria-hidden="true" />
                Export
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="room-settings-section" data-section="alerts" aria-labelledby="room-settings-heading-alerts">
        <h3 id="room-settings-heading-alerts">Alerts</h3>
        <div class="room-settings-list">
          <div class="room-settings-row" data-inline="true" data-testid="desktop-room-sounds-card">
            <div class="room-settings-row-copy">
              <p id="room-settings-sound-title" class="room-settings-row-title">Sound effects</p>
              <Transition name="room-settings-text" mode="out-in">
                <p id="room-settings-sound-description" :key="String(soundEnabled)" class="room-settings-row-description">
                  {{ soundEnabled ? "Message and send sounds are on." : "Room sounds are muted." }}
                </p>
              </Transition>
            </div>
            <div class="room-settings-row-action">
              <button
                class="room-settings-switch"
                type="button"
                role="switch"
                aria-labelledby="room-settings-sound-title"
                aria-describedby="room-settings-sound-description"
                :aria-checked="soundEnabled"
                @click="$emit('toggle-sound')"
              >
                <span class="room-settings-switch-track"><span class="room-settings-switch-knob" /></span>
              </button>
            </div>
          </div>

          <div class="room-settings-row" data-inline="true" data-testid="desktop-room-notifications-card">
            <div class="room-settings-row-copy">
              <p id="room-settings-notifications-title" class="room-settings-row-title">
                Desktop notifications
                <span
                  v-if="notificationShortLabel !== 'On' && notificationShortLabel !== 'Off'"
                  class="room-settings-pill"
                  data-tone="amber"
                >{{ notificationShortLabel }}</span>
              </p>
              <Transition name="room-settings-text" mode="out-in">
                <p
                  id="room-settings-notifications-description"
                  :key="notificationDescription"
                  class="room-settings-row-description"
                >{{ notificationDescription }}</p>
              </Transition>
            </div>
            <div class="room-settings-row-action">
              <button
                class="room-settings-switch"
                type="button"
                role="switch"
                aria-labelledby="room-settings-notifications-title"
                aria-describedby="room-settings-notifications-description"
                :aria-checked="notificationsEnabled"
                :disabled="notificationPermission === 'unsupported'"
                @click="$emit('toggle-notifications')"
              >
                <span class="room-settings-switch-track"><span class="room-settings-switch-knob" /></span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <section
        v-if="githubIntegrationAvailable || githubEventsAvailable"
        class="room-settings-section"
        data-section="github"
        aria-labelledby="room-settings-heading-github"
      >
        <h3 id="room-settings-heading-github">GitHub</h3>
        <div class="room-settings-list">
          <div
            v-if="githubIntegrationAvailable"
            class="room-settings-row"
            data-inline="true"
            :data-state="githubDotState"
            data-testid="desktop-room-github-card"
          >
            <div class="room-settings-row-copy">
              <p class="room-settings-row-title">
                <span class="room-settings-dot" :data-state="githubDotState" aria-hidden="true" />
                <span>{{ githubTitle }}</span>
              </p>
              <p class="room-settings-row-description">{{ githubDescription }}</p>
              <p
                v-if="githubStatus?.connected"
                class="room-settings-row-description"
                data-testid="desktop-room-github-reviews"
                :title="githubReviewDetails"
              >{{ githubReviewDescription }}</p>
            </div>
            <div class="room-settings-row-action">
              <button
                v-if="githubStatus && !githubStatus.connected && githubStatus.installUrlAvailable"
                class="room-settings-button"
                type="button"
                data-variant="primary"
                :aria-disabled="githubBusy"
                @click="!githubBusy && $emit('install-github')"
              >{{ githubBusy ? "Opening…" : "Install" }}</button>
              <button v-else class="room-settings-button" type="button" :aria-disabled="githubBusy" @click="!githubBusy && $emit('refresh-github')">
                {{ githubLoading ? "Checking…" : "Check connection" }}
              </button>
            </div>
            <p v-if="githubFriendlyError" class="room-settings-error" role="alert">{{ githubFriendlyError }}</p>
          </div>

          <RoomGitHubEventFilter v-if="githubIntegrationAvailable && cloudRoom" :room-identifier="room.identifier" />

          <div
            v-if="githubEventsAvailable"
            class="room-settings-row"
            data-inline="true"
            data-testid="desktop-room-github-events-card"
          >
            <div class="room-settings-row-copy">
              <p id="room-settings-events-title" class="room-settings-row-title">Show GitHub events in my chat</p>
              <Transition name="room-settings-text" mode="out-in">
                <p id="room-settings-events-description" :key="String(githubEventsVisible)" class="room-settings-row-description">
                  {{ githubEventsVisible
                    ? "Posted events appear in your Chat. This only changes your view."
                    : "Posted events stay in the Events tab for you. This only changes your view." }}
                </p>
              </Transition>
            </div>
            <div class="room-settings-row-action">
              <button
                class="room-settings-switch"
                type="button"
                role="switch"
                aria-labelledby="room-settings-events-title"
                aria-describedby="room-settings-events-description"
                :aria-checked="githubEventsVisible"
                @click="$emit('toggle-github-events-visible')"
              >
                <span class="room-settings-switch-track"><span class="room-settings-switch-knob" /></span>
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Bell, Check, Copy, Database, Download, FileText, GitBranch, MessageSquare, SlidersHorizontal, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, watch, type Component } from "vue";
import RoomAgentGuidelines from "./RoomAgentGuidelines.vue";
import RoomConversationRouting from "./RoomConversationRouting.vue";
import RoomGitHubEventFilter from "./RoomGitHubEventFilter.vue";
import SmoothHeight from "./SmoothHeight.vue";
import { useSectionScrollSpy } from "./useSectionScrollSpy";
import type {
  DesktopGitHubIntegrationStatus,
  DesktopRoomInfo,
  DesktopRoomStorageOverrideMode,
  DesktopRoomStorageState,
} from "../../../../../../electron/ipc-types";
import {
  isLocalGitRoom,
  roomSupportsGitHubIntegration,
} from "../../../../domain/git-rooms";

const props = defineProps<{
  room: DesktopRoomInfo;
  storage: DesktopRoomStorageState;
  roomUrl: string;
  copied: boolean;
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  notificationPermission: NotificationPermission | "unsupported";
  renameBusy: boolean;
  renameError: string | null;
  githubStatus: DesktopGitHubIntegrationStatus | null;
  githubLoading: boolean;
  githubBusy: boolean;
  githubError: string | null;
  githubEventsAvailable: boolean;
  githubEventsVisible: boolean;
  storageBusy: boolean;
}>();

const emit = defineEmits<{
  "copy-room-link": [];
  "open-rules": [];
  "toggle-sound": [];
  "toggle-notifications": [];
  "toggle-github-events-visible": [];
  "set-room-storage-mode": [mode: DesktopRoomStorageOverrideMode];
  "fork-room-to-local": [mode: "local"];
  "publish-local-room": [];
  "rename-room": [displayName: string];
  "refresh-github": [];
  "install-github": [];
  "export-chat": [];
  close: [];
}>();

const renameDraft = ref(props.room.displayName);
const renameSaved = ref(false);
const routingSummary = ref<string | null>(null);
const guidelinesSummary = ref<string | null>(null);
const contentElement = ref<HTMLElement | null>(null);

type SectionId = "general" | "conversation" | "guidelines" | "data" | "alerts" | "github";
type StorageChoice = "inherit" | "cloud" | "local";
interface SectionLink {
  id: SectionId;
  title: string;
  icon: Component;
  /** What the section is set to, readable from the rail without opening it. */
  summary: string | null;
  dot?: string;
}

const cloudRoom = computed(() => props.storage.effectiveMode === "cloud");
const { activeSection, indicatorReady, syncActiveSection, releaseSectionLock, goToSection } =
  useSectionScrollSpy<SectionId>(contentElement, "general");

const shortRoomUrl = computed(() => {
  try {
    const url = new URL(props.roomUrl);
    return decodeURIComponent(url.pathname.replace(/^\/in\//, "")) || props.roomUrl;
  } catch {
    return props.roomUrl;
  }
});

const notificationShortLabel = computed(() => {
  if (props.notificationPermission === "unsupported") return "Unavailable";
  if (props.notificationsEnabled) return "On";
  if (props.notificationPermission === "denied") return "Blocked";
  return "Off";
});

const localGitRoom = computed(() => isLocalGitRoom(props.room));
const cloudStorageUnavailableReason = computed(() =>
  localGitRoom.value
    ? "No Git provider is attached to this room. Add an origin remote, then reopen the repository to use Cloud."
    : null,
);

const storageDescription = computed(() => {
  if (props.storage.effectiveMode === "local") {
    if (localGitRoom.value) {
      return "Connect this project to a repository hosted online before sharing its room.";
    }
    const target = props.storage.localRoom?.cloudRoomIdentifier;
    return target
      ? `Messages and tasks stay local until published to ${target}.`
      : "Messages and tasks stay on this device until you publish.";
  }
  if (props.storage.overrideMode === "cloud") {
    return "This room always uses cloud storage.";
  }
  return `Using app default: ${props.storage.defaultMode}.`;
});

function selectLocalStorage(): void {
  if (props.storage.localRoom) {
    emit("set-room-storage-mode", "local");
    return;
  }
  emit("fork-room-to-local", "local");
}

// Exactly one choice is selected: following the app default wins over where
// that default currently puts the room.
const storageChoice = computed<StorageChoice>(() => {
  if (props.storage.overrideMode === "inherit") return "inherit";
  return props.storage.effectiveMode === "local" ? "local" : "cloud";
});

// The choice just made is shown at once; the room's real state replaces it
// when the change finishes, so a failed change slides back.
const pendingStorageChoice = ref<StorageChoice | null>(null);
const publishing = ref(false);

watch(() => props.storageBusy, (busy) => {
  if (busy) return;
  pendingStorageChoice.value = null;
  publishing.value = false;
});

function publishLocalRoom(): void {
  if (props.storageBusy) return;
  publishing.value = true;
  emit("publish-local-room");
  void nextTick(() => { if (!props.storageBusy) publishing.value = false; });
}

const storageOptions = computed(() => [
  { mode: "inherit" as const, label: "App default", unavailableReason: null },
  { mode: "cloud" as const, label: "Cloud", unavailableReason: cloudStorageUnavailableReason.value },
  { mode: "local" as const, label: "Local", unavailableReason: null },
].map((option) => ({ ...option, active: option.mode === (pendingStorageChoice.value ?? storageChoice.value) })));

function selectStorage(mode: StorageChoice): void {
  if (props.storageBusy || mode === storageChoice.value) return;
  if (storageOptions.value.find((option) => option.mode === mode)?.unavailableReason) return;
  if (mode === "local") selectLocalStorage();
  else emit("set-room-storage-mode", mode);
  // The change may be declined (moving a room to this device asks first), so
  // the choice is shown only once the change is under way.
  void nextTick(() => { if (props.storageBusy) pendingStorageChoice.value = mode; });
}

function moveStorageSelection(event: KeyboardEvent): void {
  const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
  if (!step || props.storageBusy) return;
  event.preventDefault();
  const available = storageOptions.value.filter((option) => !option.unavailableReason);
  const current = available.findIndex((option) => option.active);
  const next = available[(current + step + available.length) % available.length];
  if (!next) return;
  selectStorage(next.mode);
  const group = event.currentTarget as HTMLElement;
  void nextTick(() => group.querySelector<HTMLElement>(`button[data-mode="${next.mode}"]`)?.focus());
}

const notificationDescription = computed(() => {
  if (props.notificationPermission === "unsupported") return "Desktop alerts are unavailable in this environment.";
  if (props.notificationsEnabled) return "Desktop alerts are enabled for every joined room.";
  if (props.notificationPermission === "denied") return "Notifications are blocked by the system permission.";
  return "Turn on desktop alerts for all joined rooms.";
});

const githubDotState = computed(() => {
  if (props.githubLoading) return "loading";
  if (githubBridgeUpgradeNeeded.value) return "off";
  if (props.githubError) return "error";
  if (props.githubStatus?.connected) return "connected";
  if (props.githubStatus?.installUrlAvailable) return "ready";
  return "off";
});

const githubTitle = computed(() => {
  if (props.githubLoading) return "Checking GitHub";
  if (githubBridgeUpgradeNeeded.value) return "Restart the app";
  if (props.githubError) return "GitHub integration unavailable";
  if (props.githubStatus?.connected) return "Connected";
  if (props.githubStatus?.installUrlAvailable) return "Ready to install";
  if (props.githubStatus?.configured === false) return "Not configured";
  return "Not connected";
});

const githubDescription = computed(() => {
  if (githubBridgeUpgradeNeeded.value) {
    return "Restart the app.";
  }
  if (props.githubStatus?.connected && props.githubStatus.repository?.fullName) {
    return props.githubStatus.repository.fullName;
  }
  if (props.githubStatus?.installUrlAvailable) {
    return "Install the GitHub app to bring PRs, checks, and repo events into the room.";
  }
  if (props.githubStatus?.configured === false) {
    return "GitHub app setup is not available for this server yet.";
  }
  return "Check whether this room is connected to GitHub.";
});

const githubStatusLabel = computed(() => {
  if (props.githubLoading) return "Checking";
  if (githubBridgeUpgradeNeeded.value) return "Restart";
  if (props.githubError) return "Error";
  if (props.githubStatus?.connected) return "Connected";
  if (props.githubStatus?.installUrlAvailable) return "Ready";
  if (props.githubStatus?.configured === false) return "Setup needed";
  return "Offline";
});

const githubReviewDescription = computed(() => {
  if (props.githubStatus?.reviewSubmission?.permission === "write") {
    return "Reviews: write permission recorded";
  }
  if (props.githubStatus?.reviewSubmission?.permission === "missing") {
    return "Reviews: Pull requests (write) permission missing";
  }
  return "Reviews: permission unknown";
});

const githubReviewDetails = computed(() => {
  const recordedAt = props.githubStatus?.reviewSubmission?.recordedAt;
  const detail = props.githubStatus?.reviewSubmission?.permission === "write"
    ? "GitHub confirms authorization when a review is published."
    : "Ask the repository owner to check the GitHub App's Pull requests (write) permission.";
  return recordedAt ? `${detail} Installation metadata recorded at ${recordedAt}.` : detail;
});

const githubFriendlyError = computed(() => {
  if (!props.githubError) return null;
  if (githubBridgeUpgradeNeeded.value) return null;
  return props.githubError;
});

const canPublishLocalRoom = computed(() =>
  props.storage.effectiveMode === "local" && !localGitRoom.value
);
const githubIntegrationAvailable = computed(() => roomSupportsGitHubIntegration(props.room));

const githubBridgeUpgradeNeeded = computed(() => {
  return Boolean(
    props.githubError?.includes("No handler registered")
    || props.githubError?.includes("desktop:room:get-github-integration-status")
    || props.githubError === "Restart LetAgents Desktop to load the latest room tools."
  );
});

const sections = computed<SectionLink[]>(() => {
  const soundsOn = Number(props.soundEnabled) + Number(props.notificationsEnabled);
  const all: Array<SectionLink | null> = [
    { id: "general", title: "General", icon: SlidersHorizontal, summary: null },
    cloudRoom.value
      ? { id: "conversation", title: "Conversation", icon: MessageSquare, summary: routingSummary.value }
      : null,
    { id: "guidelines", title: "Guidelines", icon: FileText, summary: cloudRoom.value ? guidelinesSummary.value : null },
    {
      id: "data",
      title: "Data",
      icon: Database,
      summary: storageChoice.value === "inherit" ? "Default" : storageChoice.value === "local" ? "Local" : "Cloud",
    },
    { id: "alerts", title: "Alerts", icon: Bell, summary: soundsOn ? `${soundsOn} on` : "Off" },
    githubIntegrationAvailable.value || props.githubEventsAvailable
      ? {
          id: "github",
          title: "GitHub",
          icon: GitBranch,
          summary: githubIntegrationAvailable.value ? githubStatusLabel.value : null,
          dot: githubIntegrationAvailable.value ? githubDotState.value : undefined,
        }
      : null,
  ];
  return all.filter((section): section is SectionLink => section !== null);
});

const activeSectionIndex = computed(() =>
  Math.max(0, sections.value.findIndex((section) => section.id === activeSection.value))
);

let renameSavedTimer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(renameSavedTimer));

watch(sections, () => {
  if (!sections.value.some((section) => section.id === activeSection.value)) activeSection.value = "general";
});

const renameDirty = computed(() => {
  const draft = renameDraft.value.trim();
  return Boolean(draft) && draft !== props.room.displayName;
});

const renameLabel = computed(() => {
  if (props.renameBusy) return "Saving…";
  return renameSaved.value && !renameDirty.value ? "Saved" : "Save";
});

watch(
  () => props.room.displayName,
  (displayName) => {
    renameDraft.value = displayName;
  }
);

watch(
  () => props.renameBusy,
  (busy, wasBusy) => {
    if (busy || !wasBusy || props.renameError || renameDirty.value) return;
    renameSaved.value = true;
    clearTimeout(renameSavedTimer);
    renameSavedTimer = setTimeout(() => { renameSaved.value = false; }, 1400);
  }
);

function submitRename(): void {
  const nextName = renameDraft.value.trim();
  if (!renameDirty.value || props.renameBusy) return;
  emit("rename-room", nextName);
}

// The first Escape discards an unsaved name; the dialog stays open.
function discardRenameOnEscape(event: KeyboardEvent): void {
  // Escape while composing text belongs to the input method.
  if (!renameDirty.value || event.isComposing) return;
  event.stopPropagation();
  event.preventDefault();
  renameDraft.value = props.room.displayName;
}
</script>
