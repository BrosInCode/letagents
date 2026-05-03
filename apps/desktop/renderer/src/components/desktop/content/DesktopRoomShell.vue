<template>
  <section class="desktop-room-shell" data-testid="desktop-room-shell">
    <header class="desktop-room-header" data-testid="desktop-room-header">
      <div class="desktop-room-heading">
        <h3>{{ room.displayName }}</h3>
        <p class="desktop-room-subtitle">
          {{ room.kind === "focus" ? "A focused thread linked back to the main room." : "The main place for conversation, tasks, and coordination." }}
        </p>
      </div>

      <div class="desktop-room-header-actions">
        <div class="desktop-room-tools" data-testid="desktop-room-tools">
          <button
            class="desktop-room-tool"
            type="button"
            :data-active="searchOpen"
            data-testid="desktop-room-search-toggle"
            @click="toggleSearch"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="m11 11 3 3M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            </svg>
            Find
          </button>
          <button
            class="desktop-room-tool"
            type="button"
            :data-active="actionPanelOpen"
            data-testid="desktop-room-actions-toggle"
            @click="actionPanelOpen = !actionPanelOpen"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 5h10M3 11h10M6 3v4M10 9v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            </svg>
            Details
          </button>
        </div>

        <nav class="desktop-room-tabs" role="tablist" aria-label="Room navigation" data-testid="desktop-room-tabs">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="desktop-room-tab"
            :data-active="activeTab === tab.id"
            :data-testid="`desktop-room-tab-${tab.id}`"
            role="tab"
            :aria-selected="activeTab === tab.id"
            type="button"
            @click="selectTab(tab.id)"
          >
            <span>{{ tab.label }}</span>
            <small v-if="tab.count !== null">{{ tab.count }}</small>
          </button>
        </nav>

        <div class="desktop-room-badges">
          <span v-if="room.code" class="desktop-room-badge" data-testid="desktop-room-code">{{ room.code }}</span>
          <span class="desktop-room-badge" data-testid="desktop-room-role">{{ room.role }}</span>
        </div>
      </div>
    </header>

    <div v-if="actionPanelOpen || searchOpen" class="desktop-room-control-rail" data-testid="desktop-room-control-rail">
      <DesktopRoomActionPanel
        :open="actionPanelOpen"
        :room="room"
        :room-url="roomUrl"
        :copied="roomLinkCopied"
        :sound-enabled="soundEnabled"
        :notifications-enabled="notificationsEnabled"
        :notification-permission="notificationPermission"
        :rename-busy="renameBusy"
        :rename-error="renameError"
        :github-status="githubStatus"
        :github-loading="githubLoading"
        :github-busy="githubBusy"
        :github-error="githubError"
        @copy-room-link="copyRoomLink"
        @open-rules="openRules"
        @toggle-sound="toggleSound"
        @toggle-notifications="toggleNotifications"
        @rename-room="renameRoom"
        @refresh-github="refreshGitHubIntegration"
        @install-github="installGitHubIntegration"
        @export-chat="exportChat"
      />

      <div v-if="searchOpen" class="desktop-room-search-strip" data-testid="desktop-room-search-strip">
        <label>
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m11 11 3 3M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          <input
            ref="searchInputElement"
            v-model="searchQuery"
            type="search"
            placeholder="Search messages"
            data-testid="desktop-room-search-input"
            @keydown.enter.prevent="moveSearch(1)"
            @keydown.escape.prevent="closeSearch"
          >
        </label>
        <span>{{ searchSummary }}</span>
        <div>
          <button type="button" :disabled="!searchResults.length" @click="moveSearch(-1)">Previous</button>
          <button type="button" :disabled="!searchResults.length" @click="moveSearch(1)">Next</button>
          <button type="button" @click="closeSearch">Close</button>
        </div>
      </div>
    </div>

    <Transition name="room-panel" mode="out-in">
      <RoomChatView
        v-if="activeTab === 'chat'"
        key="chat"
        :messages="visibleMessages"
        :room-identifier="room.identifier"
        :sending="sendingMessage"
        :send-error="sendError"
        :has-older-messages="hasOlderMessages"
        :loading-older-messages="loadingOlderMessages"
        :participants="participants"
        :search-query="searchQuery"
        :active-search-message-id="activeSearchMessageId"
        @send-message="sendRoomMessage"
        @discard-attachment="discardAttachment"
        @load-older="loadOlderMessages"
      />

      <RoomBoardView
        v-else-if="activeTab === 'board'"
        key="board"
        :tasks="tasks"
      />

      <RoomActivityTabView
        v-else-if="activeTab === 'activity'"
        key="activity"
        :recent-activity="recentActivity"
        :participants="participants"
      />

      <RoomDetailsView
        v-else
        key="rooms"
        :focus-rooms="focusRooms"
        :tasks="tasks"
      />
    </Transition>

    <DesktopRoomRulesModal
      :open="rulesOpen"
      @close="rulesOpen = false"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type {
  DesktopActivityEntry,
  DesktopFocusRoomInfo,
  DesktopGitHubIntegrationStatus,
  DesktopParticipantSummary,
  DesktopRoomInfo,
  DesktopRoomMessage,
  DesktopTaskSummary,
} from "../../../../../electron/ipc-types";
import DesktopRoomActionPanel from "./DesktopRoomActionPanel.vue";
import DesktopRoomRulesModal from "./DesktopRoomRulesModal.vue";
import RoomActivityTabView from "./RoomActivityTabView.vue";
import RoomBoardView from "./RoomBoardView.vue";
import RoomChatView from "./RoomChatView.vue";
import RoomDetailsView from "./RoomDetailsView.vue";

type RoomTabId = "chat" | "board" | "activity" | "rooms";

const props = defineProps<{
  room: DesktopRoomInfo;
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
  participants: DesktopParticipantSummary[];
  recentActivity: DesktopActivityEntry[];
  messages: DesktopRoomMessage[];
}>();

const activeTab = ref<RoomTabId>("chat");
const sendingMessage = ref(false);
const sendError = ref<string | null>(null);
const olderMessages = ref<DesktopRoomMessage[]>([]);
const localMessages = ref<DesktopRoomMessage[]>([]);
const hasOlderMessages = ref(true);
const loadingOlderMessages = ref(false);
const actionPanelOpen = ref(false);
const rulesOpen = ref(false);
const searchOpen = ref(false);
const searchQuery = ref("");
const activeSearchIndex = ref(0);
const searchInputElement = ref<HTMLInputElement | null>(null);
const roomLinkCopied = ref(false);
const renameBusy = ref(false);
const renameError = ref<string | null>(null);
const githubStatus = ref<DesktopGitHubIntegrationStatus | null>(null);
const githubLoading = ref(false);
const githubBusy = ref(false);
const githubError = ref<string | null>(null);
const soundEnabled = ref(readSoundEnabled());
const notificationsEnabled = ref(readNotificationsEnabled());
const notificationPermission = ref<NotificationPermission | "unsupported">(readNotificationPermission());
const messageHistoryPageSize = 150;
let refreshInterval: number | null = null;
let audioContext: AudioContext | null = null;
let observedLatestMessageId: string | null = null;
const ownMessageIds = new Set<string>();

const emit = defineEmits<{
  "message-sent": [message: DesktopRoomMessage];
  "room-renamed": [room: DesktopRoomInfo];
  "refresh-room": [];
}>();

const tabs = computed<Array<{ id: RoomTabId; label: string; count: number | null }>>(() => [
  { id: "chat", label: "Chat", count: props.messages.length },
  { id: "board", label: "Board", count: props.tasks.length },
  { id: "activity", label: "Activity", count: props.participants.length },
  { id: "rooms", label: "Rooms", count: props.focusRooms.length },
]);
const visibleMessages = computed(() => {
  return mergeRoomMessages([...olderMessages.value, ...props.messages], localMessages.value);
});
const roomUrl = computed(() => `https://letagents.chat/in/${encodeRoomPathIdentifier(props.room.identifier)}`);
const normalizedSearchQuery = computed(() => searchQuery.value.trim().toLowerCase());
const searchResults = computed(() => {
  const query = normalizedSearchQuery.value;
  if (!query) return [];
  return visibleMessages.value.filter((message) => {
    const haystack = [
      message.sender,
      message.text,
      message.replyTo?.text || "",
      ...message.attachments.map((attachment) => attachment.fileName || attachment.name || ""),
    ].join("\n").toLowerCase();
    return haystack.includes(query);
  });
});
const activeSearchMessageId = computed(() => searchResults.value[activeSearchIndex.value]?.id || null);
const searchSummary = computed(() => {
  if (!normalizedSearchQuery.value) return "Type to search this room.";
  if (!searchResults.value.length) return "No messages found.";
  return `${activeSearchIndex.value + 1} of ${searchResults.value.length}`;
});

watch(
  () => props.messages.map((message) => message.id).join("|"),
  () => {
    const serverIds = new Set(props.messages.map((message) => message.id));
    localMessages.value = localMessages.value.filter((message) => !serverIds.has(message.id));
  }
);

watch(
  () => props.messages.at(-1)?.id || null,
  (messageId) => {
    if (!messageId) return;
    if (!observedLatestMessageId) {
      observedLatestMessageId = messageId;
      return;
    }
    if (messageId === observedLatestMessageId) return;
    observedLatestMessageId = messageId;
    const message = props.messages.find((entry) => entry.id === messageId);
    if (!message || ownMessageIds.has(message.id)) return;
    playRoomSound("notification");
    showRoomNotification(message);
  }
);

watch(searchResults, (results) => {
  if (activeSearchIndex.value >= results.length) {
    activeSearchIndex.value = Math.max(0, results.length - 1);
  }
});

watch(
  () => props.room.identifier,
  () => {
    void refreshGitHubIntegration();
  },
  { immediate: true },
);

function selectTab(tabId: RoomTabId): void {
  activeTab.value = tabId;
  emit("refresh-room");
}

onMounted(() => {
  refreshInterval = window.setInterval(() => {
    emit("refresh-room");
  }, 10_000);
});

onUnmounted(() => {
  if (refreshInterval) {
    window.clearInterval(refreshInterval);
    refreshInterval = null;
  }
});

async function sendRoomMessage(text: string, replyTo: string | null = null, attachments: Array<{ upload_id: string }> = []): Promise<void> {
  const trimmedText = text.trim();
  if (!trimmedText && attachments.length === 0) return;

  const pendingId = `desktop-pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const replyMessage = visibleMessages.value.find((message) => message.id === replyTo) || null;
  const pendingMessage: DesktopRoomMessage = {
    id: pendingId,
    sender: "LetAgents Desktop",
    text: trimmedText,
    attachments: [],
    agentPromptKind: null,
    source: "browser",
    timestamp: new Date().toISOString(),
    actorLabel: null,
    agentIdentity: null,
    replyTo: replyMessage
      ? {
          id: replyMessage.id,
          sender: replyMessage.sender,
          text: replyMessage.text,
          source: replyMessage.source,
          timestamp: replyMessage.timestamp,
        }
      : null,
  };
  localMessages.value = mergeRoomMessages(localMessages.value, [pendingMessage]);
  sendingMessage.value = true;
  sendError.value = null;
  try {
    const result = await window.letagentsDesktop.room.sendMessage(props.room.identifier, trimmedText, replyTo, attachments);
    ownMessageIds.add(result.message.id);
    localMessages.value = mergeRoomMessages(
      localMessages.value.filter((message) => message.id !== pendingId),
      [result.message]
    );
    playRoomSound("send");
    emit("message-sent", result.message);
  } catch (error) {
    localMessages.value = localMessages.value.filter((message) => message.id !== pendingId);
    sendError.value = error instanceof Error ? error.message : "Message could not be sent.";
  } finally {
    sendingMessage.value = false;
  }
}

function toggleSearch(): void {
  searchOpen.value = !searchOpen.value;
  if (searchOpen.value) {
    void nextTick(() => searchInputElement.value?.focus());
  }
}

function closeSearch(): void {
  searchOpen.value = false;
  searchQuery.value = "";
  activeSearchIndex.value = 0;
}

function moveSearch(delta: 1 | -1): void {
  const count = searchResults.value.length;
  if (!count) return;
  activeSearchIndex.value = (activeSearchIndex.value + delta + count) % count;
}

function openRules(): void {
  rulesOpen.value = true;
  actionPanelOpen.value = false;
}

async function copyRoomLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(roomUrl.value);
    roomLinkCopied.value = true;
    window.setTimeout(() => {
      roomLinkCopied.value = false;
    }, 1400);
  } catch {
    roomLinkCopied.value = false;
  }
}

async function renameRoom(displayName: string): Promise<void> {
  renameBusy.value = true;
  renameError.value = null;
  try {
    const roomBridge = getRoomBridge();
    if (typeof roomBridge?.rename !== "function") {
      renameError.value = desktopBridgeUpgradeMessage();
      return;
    }
    const updated = await roomBridge.rename(props.room.identifier, displayName);
    emit("room-renamed", updated);
    emit("refresh-room");
  } catch (error) {
    renameError.value = error instanceof Error ? error.message : "Room could not be renamed.";
  } finally {
    renameBusy.value = false;
  }
}

async function refreshGitHubIntegration(): Promise<void> {
  githubLoading.value = true;
  githubError.value = null;
  try {
    const roomBridge = getRoomBridge();
    if (typeof roomBridge?.getGitHubIntegrationStatus !== "function") {
      githubStatus.value = null;
      githubError.value = desktopBridgeUpgradeMessage();
      return;
    }
    githubStatus.value = await roomBridge.getGitHubIntegrationStatus(props.room.identifier);
  } catch (error) {
    githubStatus.value = null;
    githubError.value = error instanceof Error ? error.message : "GitHub status could not be checked.";
  } finally {
    githubLoading.value = false;
  }
}

async function installGitHubIntegration(): Promise<void> {
  githubBusy.value = true;
  githubError.value = null;
  try {
    const roomBridge = getRoomBridge();
    if (typeof roomBridge?.openGitHubInstall !== "function") {
      githubError.value = desktopBridgeUpgradeMessage();
      return;
    }
    const result = await roomBridge.openGitHubInstall(props.room.identifier);
    if (!result.opened) githubError.value = result.message;
  } catch (error) {
    githubError.value = error instanceof Error ? error.message : "GitHub could not be opened.";
  } finally {
    githubBusy.value = false;
  }
}

function toggleSound(): void {
  soundEnabled.value = !soundEnabled.value;
  window.localStorage.setItem("letagents-desktop:sound", soundEnabled.value ? "on" : "off");
  if (soundEnabled.value) playRoomSound("send");
}

async function toggleNotifications(): Promise<void> {
  if (typeof Notification === "undefined") {
    notificationPermission.value = "unsupported";
    return;
  }
  if (!notificationsEnabled.value && Notification.permission === "default") {
    notificationPermission.value = await Notification.requestPermission();
  } else {
    notificationPermission.value = Notification.permission;
  }
  notificationsEnabled.value = !notificationsEnabled.value && notificationPermission.value === "granted";
  window.localStorage.setItem("letagents-desktop:notifications", notificationsEnabled.value ? "on" : "off");
}

function exportChat(): void {
  if (!visibleMessages.value.length) return;
  const lines = visibleMessages.value.map((message) =>
    `[${new Date(message.timestamp).toLocaleString()}] ${message.sender}: ${message.text}`
  );
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `letagents-${props.room.displayName.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}-${Date.now()}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function getRoomBridge(): Partial<typeof window.letagentsDesktop.room> | undefined {
  return window.letagentsDesktop?.room as Partial<typeof window.letagentsDesktop.room> | undefined;
}

function desktopBridgeUpgradeMessage(): string {
  return "Restart LetAgents Desktop to load the latest room tools.";
}

function mergeRoomMessages(current: readonly DesktopRoomMessage[], incoming: readonly DesktopRoomMessage[]): DesktopRoomMessage[] {
  const byId = new Map<string, DesktopRoomMessage>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(compareRoomMessages);
}

function compareRoomMessages(left: DesktopRoomMessage, right: DesktopRoomMessage): number {
  const leftNumber = messageNumber(left.id);
  const rightNumber = messageNumber(right.id);
  if (leftNumber && rightNumber && leftNumber !== rightNumber) return leftNumber - rightNumber;
  const leftTime = Date.parse(left.timestamp || "");
  const rightTime = Date.parse(right.timestamp || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  if (leftNumber && !rightNumber) return -1;
  if (!leftNumber && rightNumber) return 1;
  return left.id.localeCompare(right.id);
}

function messageNumber(messageId: string): number {
  return Number(/^msg_(\d+)$/.exec(messageId)?.[1] || 0);
}

async function discardAttachment(uploadId: string): Promise<void> {
  await window.letagentsDesktop.room.discardAttachment(props.room.identifier, uploadId);
}

async function loadOlderMessages(): Promise<void> {
  if (loadingOlderMessages.value || !hasOlderMessages.value) return;
  const firstMessageId = visibleMessages.value[0]?.id;
  if (!firstMessageId) {
    hasOlderMessages.value = false;
    return;
  }

  loadingOlderMessages.value = true;
  try {
    const page = await window.letagentsDesktop.room.getMessagesBefore(props.room.identifier, firstMessageId, messageHistoryPageSize);
    olderMessages.value = [...page.messages, ...olderMessages.value];
    hasOlderMessages.value = page.hasOlder;
  } catch {
    hasOlderMessages.value = false;
  } finally {
    loadingOlderMessages.value = false;
  }
}

function encodeRoomPathIdentifier(identifier: string): string {
  return String(identifier)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function readSoundEnabled(): boolean {
  try {
    return window.localStorage.getItem("letagents-desktop:sound") !== "off";
  } catch {
    return true;
  }
}

function readNotificationsEnabled(): boolean {
  try {
    return window.localStorage.getItem("letagents-desktop:notifications") === "on";
  } catch {
    return false;
  }
}

function readNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

function playRoomSound(kind: "send" | "notification"): void {
  if (!soundEnabled.value) return;
  try {
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    if (!audioContext) audioContext = new AudioContextCtor();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    const now = audioContext.currentTime;
    const startFrequency = kind === "send" ? 740 : 880;
    const endFrequency = kind === "send" ? 980 : 660;
    oscillator.frequency.setValueAtTime(startFrequency, now);
    oscillator.frequency.setValueAtTime(endFrequency, now + 0.07);
    gain.gain.setValueAtTime(0.09, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    oscillator.start(now);
    oscillator.stop(now + 0.2);
  } catch {
    // Audio can be unavailable before a user gesture; the toggle will retry later.
  }
}

function showRoomNotification(message: DesktopRoomMessage): void {
  if (!notificationsEnabled.value || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  const sender = message.sender.split("|")[0]?.trim() || "LetAgents";
  const body = message.text.trim() || `${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`;
  new Notification(`${sender} in ${props.room.displayName}`, {
    body,
    silent: true,
  });
}
</script>
