<template>
  <div class="room-message-viewport" data-testid="room-chat-viewport">
    <div class="room-message-scroll">
    <div ref="messagesElement" class="room-message-list" data-testid="room-chat-list" @wheel.passive="cancelInitialRestore" @touchstart.passive="cancelInitialRestore" @pointerdown="cancelInitialRestore" @keydown="handleListKeydown" @scroll="handleScroll" @scrollend="finishMessageReveal">
      <p v-if="olderMessagesError" role="status" class="room-load-older-error">{{ olderMessagesError }}</p>
      <button
        v-if="(threadMessages.length || hasFilteredRoomActivity) && hasOlderMessages && windowBounds.start === 0"
        class="room-load-older"
        type="button"
        :disabled="loadingOlderMessages"
        data-testid="desktop-load-older-messages"
        @click="$emit('load-older')"
      >
        {{ loadingOlderMessages ? "Loading earlier messages..." : olderMessagesError ? "Retry loading earlier messages" : "Load earlier messages" }}
      </button>

      <template v-for="entry in mountedEntries" :key="`${messageNamespace}:${entry.type === 'message' ? entry.message.clientMessageId || entry.id : entry.id}`">
        <div
          v-if="entry.type === 'date'"
          class="room-date-separator"
          :datetime="entry.dateTime"
          data-testid="room-date-separator"
        >
          <span>{{ entry.label }}</span>
        </div>

        <RoomFirstMessage v-else-if="entry.type === 'first-message'" :agent="entry.agent" />
        <template v-else-if="entry.type === 'agent-startup'">
          <RoomAgentStartupEntry
            :entry-id="entry.entryId"
            :view-for="startupViewFor"
            @retry="startupAction(retryStartup, $event, 'Could not start the agent again.')"
            @cancel="startupAction(cancelStartup, $event, 'Could not cancel the agent.')"
            @setup="emit('open-add-agent')"
          />
        </template>
        <p
          v-else-if="entry.type === 'presence'"
          class="room-presence-line"
          :data-kind="entry.line.kind"
          data-testid="room-presence-line"
        ><span aria-hidden="true"></span>{{ entry.line.text }}</p>
        <RoomContribution v-else-if="entry.type === 'contribution'" :work="entry.work" :participants="participants ?? []" :status="roomAgentWorkStatus ?? 'idle'" @open-workspace="emit('open-workspace', $event)" />
        <component :is="entry.type === 'github-group' ? RoomGitHubUpdates : PlainTimelineRow" v-else lazy-history :row-limit="githubGroupRowLimit" :anchor-id="entry.type === 'github-group' ? entry.anchorId : undefined" :messages="entry.type === 'github-group' ? entry.messages : singleMessageList(entry.message)" :grouped="entry.type === 'github-group'" :parse-event="parseGitHubEvent" @layout-start="preserveScrollAnchorOnNextLayout(260)" @layout-settled="updateScrollState">
        <template #default="{ message, history }">
        <div v-if="message.id === unreadTimeline.dividerId.value && !hiddenPinnedIds.has(message.id)" class="room-explicit-unread" role="separator">New messages</div>
        <DesktopChatMessage
          :class="{ 'room-window-pinned-hidden': hiddenPinnedIds.has(message.id) }"
          :message="message"
          :github-history="history"
          :compact-with-previous="entry.type === 'message' && entry.compactWithPrevious"
          :thread-summary="threadIndicatorSummary(message)"
          :active-thread-root="message.id === activeThreadParentId"
          :highlight-query="highlightQuery"
          :room-identifier="roomIdentifier"
          :message-reference-ids="messageReferenceIds"
          :task-reference-ids="taskReferenceIds"
          :search-active="message.id === activeSearchMessageId"
          :animate-arrival="arrivingMessageIds.has(message.id)"
          :delivery-receipts="deliveryReceiptsByMessage[message.id] || noDeliveryReceipts"
          :delivery-recovery-available="deliveryRecoveryAvailable"
          :continuation-repair-available="continuationRepairAvailable"
          :room-delivery-skip-available="roomDeliverySkipAvailable"
          :delivery-retry-keys="deliveryRetryKeys"
          :continuation-repair-keys="continuationRepairKeys"
          :room-delivery-skip-keys="roomDeliverySkipKeys"
          :provider-label="resolveProviderLabel(message)"
          @quote-reply="$emit('quote-reply', $event)"
          @message-info="(messageId, context) => $emit('message-info', messageId, context)"
          @quote-selection="(messageId, text) => $emit('quote-selection', messageId, text)"
          @open-thread="$emit('open-thread', $event)"
          @scroll-to-message="revealOrScrollToMessage"
          @open-image="$emit('open-image', $event)"
          @open-agent="$emit('open-agent', $event)"
          @open-person="(target, position) => $emit('open-person', target, position)"
          @open-github-event="$emit('open-github-event', $event)"
          @open-task="$emit('open-task', $event)"
          @retry-delivery="(agentId, sourceMessageId) => $emit('retry-delivery', agentId, sourceMessageId)"
          @restore-conversation="(agentId, sourceMessageId) => $emit('restore-conversation', agentId, sourceMessageId)"
          @skip-delivery="(agentId, sourceMessageId) => $emit('skip-delivery', agentId, sourceMessageId)"
        />
        </template>
        </component>
      </template>
      <!-- Newer loaded rows below a detached window mount when this gap nears the view. -->
      <div
        v-if="!windowReachesLatest"
        ref="windowGapElement"
        class="room-message-window-gap"
        data-testid="room-message-window-gap"
        aria-hidden="true"
        :style="{ height: `${windowGapHeight}px` }"
      ></div>

      <div v-if="roomLoading" class="room-loading-state" data-testid="room-chat-loading" aria-label="Loading room messages">
        <div
          v-for="index in 4"
          :key="index"
          class="room-loading-message"
          :data-size="index"
          aria-hidden="true"
        >
          <span class="room-loading-avatar"></span>
          <span class="room-loading-lines">
            <span></span>
            <span></span>
          </span>
        </div>
      </div>

      <article v-else-if="!messages.length && !displayedAgentWork.length" class="room-empty-card" data-testid="room-chat-empty">
        <h3>{{ emptyStateTitle }}</h3>
        <p>{{ emptyStateDescription }}</p>
      </article>
    </div>
    <div
      v-if="threadActivityNotice && !roomLoading"
      class="room-thread-activity-pill"
      data-testid="room-thread-activity-pill"
    >
      <button class="room-thread-activity-open" type="button" @click="openThreadActivityNotice">
        <span>Thread reply</span>
        <strong>{{ threadActivityNotice.title }}</strong>
        <small>{{ threadActivityNotice.preview }}</small>
      </button>
      <button
        class="room-thread-activity-dismiss"
        type="button"
        aria-label="Dismiss thread activity"
        @click="dismissThreadActivityNotice()"
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4.25 4.25 7.5 7.5M11.75 4.25l-7.5 7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
    </div>
    <button
      v-if="unreadCount > 0 || isScrolledFarUp"
      class="room-new-messages-pill"
      type="button"
      data-testid="desktop-new-messages-pill"
      @click="unreadTimeline.jumpToLatest()"
    >
      {{ unreadCount > 0 ? `↓ ${unreadCount} new message${unreadCount === 1 ? "" : "s"}` : "↓ Scroll to latest" }}
    </button>
    </div>
    <!-- Live strip: one floating activity line, outside the scrolling list, so it
         stays in view while the reader is in older history and never moves the
         input. Replies fly out of its work anchors (useRoomMessageMotion). -->
    <div ref="liveStripElement" class="room-live-strip" data-testid="room-live-strip">
      <RoomActivityLine
        :notice="roomLoading ? null : activityNotice ?? null"
        :steer="steerOffer ?? null"
        :steer-disabled="steerDisabled"
        :work="roomLoading ? [] : displayedAgentWork"
        :typing-names="roomLoading ? [] : typingNames ?? []"
        @hold="$emit('activity-hold', $event)"
        @steer="$emit('steer')"
        @open-agent="$emit('open-agent', workIndicatorAgentTarget($event))"
        @open-event-preview="$emit('open-event-preview', $event)"
        @post-agent-answer-now="(agentId, sourceMessageId) => $emit('post-agent-answer-now', agentId, sourceMessageId)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ChatScrollPosition } from "../../../../domain/chat-scroll";
import RoomGitHubUpdates from "../../../../../../../../shared/ui/RoomGitHubUpdates.vue";
import { createGitHubTimeline } from "../../../../../../../../shared/grouped-github-updates";
import { parseGitHubEvent } from "../desktop-chat-message/github-event";
import { useRoomMessageMotion, useRoomWorkHandoff } from "../../../../../../../../shared/ui/useRoomMessageMotion";
import { provide } from "vue";
import RoomActivityLine from "./RoomActivityLine.vue";
import type { ActivityNotice, ActivitySteerOffer, PresenceTimelineLine } from "./room-activity";
import type { ComposerEventPreview } from "./composer-event-preview";
import { roomUnread, unreadRevealKey } from "../../../../composables/roomUnread";
import { unreadMenuKey, useUnreadTimeline } from "../../../../../../../../shared/room-unread-client";
import { computed, inject, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, onUpdated, ref, shallowRef, useSlots, watch, type FunctionalComponent } from "vue";
import { injectRoomMessageLinkPreviews } from "../../../../composables/useRoomMessageLinkPreviews";
import { injectRoomMessageReactions } from "../../../../composables/useRoomMessageReactions";
import { attentionResponseAgentNamesKey } from "../../../../domain/attention-response";
import type {
  DesktopAgentPresence,
  DesktopRoomAgentDeliveryAttention,
  DesktopRoomAgentWork,
  DesktopParticipantSummary,
  DesktopRoomMessage,
  DesktopSupervisorManifestEntry,
} from "../../../../../../electron/ipc-types";
import {
  WORK_INDICATOR_ECHO_MIN_INTERVAL_MS,
  coalesceWorkIndicatorEchoes,
  workIndicatorSupersededByAgentMessage,
  type ManagedAgentWorkIndicator,
  type WorkIndicatorEchoState,
} from "../../../../domain/managed-agents";
import { workIndicatorAgentTarget } from "../../../../domain/agent-inspector-identity";
import RoomAgentStartupEntry from "./RoomAgentStartupEntry.vue";
import RoomContribution from "./RoomContribution.vue";
import { useAgentStartupRows } from "./useAgentStartupRows";
import { useDesktopActionToasts } from "../../../../composables/useDesktopActionToasts";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";
import DesktopChatMessage from "../DesktopChatMessage.vue";
import { inlineThreadKey } from "../desktop-chat-message/inline-thread";
import { parseSenderIdentity } from "../desktop-chat-message/identity";
import { truncate } from "../desktop-chat-message/message-rendering";
import type { AgentModalTarget } from "../desktop-chat-message/types";
import type { PersonTarget } from "../../../../domain/person-target";
import type { PersonMenuPosition } from "../../../../domain/person-context-menu";
import { compareRoomMessages } from "../room-shell/messages";
import { createMessageProviderLabelResolver } from "../../../../domain/agent-provider";
import { useStableIdSet } from "../../../../composables/useStableIdSet";
import { getAppendedMessageIds } from "./message-arrival";
import { buildThreadIndicatorSummary, buildThreadSummaries, createThreadIndicatorMemo, threadParentId, threadQuotePreview } from "./thread-utils";
import { buildMessageTimelineEntries, firstMessageAgents, type MessageTimelineEntry } from "./timeline";
import RoomFirstMessage from "./RoomFirstMessage.vue";
import {
  anchoredScrollTop,
  firstMessageIdFrom,
  githubGroupRowLimit,
  grownDownwardState,
  grownUpwardState,
  indexEntriesByMessageId,
  pinnedOutside,
  resolveWindowBounds,
  windowStateFor,
  windowStateIncluding,
  type MessageWindowState,
  type WindowEntry,
} from "./message-window";

interface ThreadActivityNotice {
  parentId: string;
  title: string;
  preview: string;
}

interface ScrollAnchor {
  messageId: string;
  offsetTop: number;
}

const maxAutoViewportBackfillPages = 5;
const viewportFillSlack = 32;

const props = defineProps<{
  roomAgentWork?: DesktopRoomAgentWork[];
  roomAgentWorkStatus?: string;
  active: boolean;
  activeSearchMessageId: string | null;
  activeThreadParentId: string | null;
  readingThreadParentId?: string | null;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  olderMessagesError?: string | null;
  messages: DesktopRoomMessage[];
  threadMessages: DesktopRoomMessage[];
  messageNamespace: string;
  localAgentWork: ManagedAgentWorkIndicator[];
  /** People typing in this room now; the lowest-priority pill on the activity line. */
  typingNames?: readonly string[];
  /** The short notice on the activity line now (a join, a leave, a GitHub update). */
  activityNotice?: ActivityNotice | null;
  /** A draft that names an agent mid-turn: the line offers Steer. */
  steerOffer?: ActivitySteerOffer | null;
  steerDisabled?: boolean;
  /** Quiet join and leave lines in the timeline. */
  presenceLines?: readonly PresenceTimelineLine[];
  participants?: DesktopParticipantSummary[];
  presence?: DesktopAgentPresence[];
  supervisorEntries?: DesktopSupervisorManifestEntry[];
  deliveryReceiptsByMessage: Record<string, Array<{ agentId: string; agentName: string; state: string; blockedByMessageId: string | null; error: string | null; failureCode: string | null; terminalReason: string | null; attemptCount: number; providerTurnId: string | null; retry?: DesktopRoomAgentDeliveryAttention["retry"] | null }> >;
  deliveryRecoveryAvailable?: boolean;
  continuationRepairAvailable?: boolean;
  roomDeliverySkipAvailable?: boolean;
  deliveryRetryKeys?: ReadonlySet<string>;
  continuationRepairKeys?: ReadonlySet<string>;
  roomDeliverySkipKeys?: ReadonlySet<string>;
  hasFilteredRoomActivity: boolean;
  roomIdentifier: string | null;
  githubActivityAvailable: boolean;
  roomLoading: boolean;
  searchQuery: string;
  taskReferenceIds: ReadonlySet<string>;
  initialScrollPosition?: ChatScrollPosition | null;
}>();

const attentionResponseAgentNames = inject(attentionResponseAgentNamesKey, null);
const emit = defineEmits<{
  "load-older": [];
  "open-workspace": [work: DesktopRoomAgentWork];
  "open-agent": [target: AgentModalTarget];
  "open-person": [target: PersonTarget, position: PersonMenuPosition];
  "post-agent-answer-now": [agentId: string, sourceMessageId: string | null];
  "activity-hold": [held: boolean];
  steer: [];
  "open-event-preview": [preview: ComposerEventPreview];
  "open-image": [imageId: string];
  "open-thread": [messageId: string];
  "reveal-thread": [messageId: string];
  "quote-reply": [messageId: string];
  "message-info": [messageId: string, context: "timeline" | "thread-root" | "thread-reply"];
  "retry-delivery": [agentId: string, sourceMessageId: string];
  "restore-conversation": [agentId: string, sourceMessageId: string];
  "skip-delivery": [agentId: string, sourceMessageId: string];
  "reveal-message": [messageId: string];
  "quote-selection": [messageId: string, text: string];
  "scroll-position": [position: ChatScrollPosition];
  "open-github-event": [url: string];
  "open-task": [taskId: string];
  /** An agent's runtime needs sign-in or installing: the Add agent setup shows how. */
  "open-add-agent": [];
}>();

const emptyStateTitle = computed(() => {
  if (!props.roomIdentifier) return "Open a room to begin";
  return props.hasFilteredRoomActivity ? "No chat messages visible" : "No messages yet";
});

const emptyStateDescription = computed(() => {
  if (!props.roomIdentifier) {
    return props.githubActivityAvailable
      ? "Messages from humans, agents, and GitHub will appear here as the room comes alive."
      : "Messages from humans and agents will appear here as the room comes alive.";
  }
  return props.hasFilteredRoomActivity
    ? "The loaded history contains activity that is hidden from Chat."
    : props.githubActivityAvailable
      ? "Messages from humans, agents, and GitHub will appear here."
      : "Messages from humans and agents will appear here.";
});

const messagesElement = ref<HTMLElement | null>(null);
const liveStripElement = ref<HTMLElement | null>(null);
const unreadRoom = computed(() => props.roomIdentifier);
provide(unreadMenuKey, { client: roomUnread, room: unreadRoom });
const revealUnreadMessage = inject(unreadRevealKey, null);
const unreadTimeline = useUnreadTimeline({
  client: roomUnread, room: unreadRoom,
  active: computed(() => props.active && roomUnread.visit.value.room === (props.roomIdentifier ?? "").toLowerCase()),
  ready: computed(() => !props.roomLoading && !props.loadingOlderMessages),
  element: messagesElement,
  reveal: async (id) => {
    if (!revealUnreadMessage || !await revealUnreadMessage(id)) return false;
    await nextTick();
    return scrollToMessage(id, "instant");
  },
  bottom: (reading) => scrollToBottom(reading ? "smooth" : "auto"),
});
const unreadCount = ref(0);
const isScrolledFarUp = ref(false);
const threadActivityNotice = ref<ThreadActivityNotice | null>(null);
const autoViewportBackfillCount = ref(0);
const arrivingMessageIds = ref<ReadonlySet<string>>(new Set());
const arrivalTimers = new Map<string, number>();
let isScrolledToBottom = false;
let scrollRevision = 0;
let revealingMessage = false;
let revealFrame: number | null = null;
let revealTimer: number | null = null;
let bottomFollowQueued = false;

function followLatestAfterLayout(): void {
  if (!isScrolledToBottom || !props.active || shouldRestoreInitialScroll || bottomFollowQueued) return;
  const revision = scrollRevision;
  const top = messagesElement.value?.scrollTop;
  bottomFollowQueued = true;
  void nextTick(() => {
    bottomFollowQueued = false;
    if (revision === scrollRevision && props.active && messagesElement.value?.scrollTop === top) jumpToBottom();
  });
}
let restoreRequestPending = false;
let restorePagesRequested = 0;
let hasAppliedInitialScroll = false;
let shouldRestoreInitialScroll = hasInitialScrollPosition();
let shouldJumpToLatestOnActivate = false;
let shouldRestoreKeepAliveScroll = false;
let lastKnownScrollAnchor: ScrollAnchor | null = null;
let lastKnownScrollTop: number | null = null;
let anchorElements: HTMLElement[] | null = null;
let anchorElementsById = new Map<string, HTMLElement>();

// The timeline is vertically ordered. Cache its nodes between renders, but read
// current geometry so image loads, resizing and thread-panel reflow stay correct.
onUpdated(() => { anchorElements = null; rememberRenderedWindow(); });
onMounted(rememberRenderedWindow);

function getAnchorElements(): HTMLElement[] {
  if (!anchorElements) {
    anchorElements = Array.from(messagesElement.value?.querySelectorAll<HTMLElement>(".room-message-list > [data-message-id]:not(.room-window-pinned-hidden), .room-message-list > [data-scroll-anchor-id]") ?? []);
    anchorElementsById = new Map(anchorElements.map(element => [(element.dataset.messageId || element.dataset.scrollAnchorId)!, element]));
  }
  return anchorElements;
}
let autoViewportBackfillFrame: number | null = null;
let layoutAnchorRestoreFrame: number | null = null;
let layoutRestoreRevision = 0;
let layoutRestoredScrollTop: number | null = null;
let threadActivityNamespace = props.messageNamespace;
let suppressNextThreadActivityNotice = false;

const threadSummaries = computed(() => buildThreadSummaries(props.threadMessages));
const resolveProviderLabel = computed(() => createMessageProviderLabelResolver(
  props.participants, props.presence, props.supervisorEntries,
));
const buildGroupedTimeline = createGitHubTimeline<MessageTimelineEntry, DesktopRoomMessage>();
// The open thread reaches its root row by injection, not a per-row slot.
const slots = useSlots();
provide(inlineThreadKey, () => slots.thread?.());
/*
 * A plain message row: the message itself, through the same slot a GitHub
 * group uses. It is stateless, so a list redraw does not run a group's
 * computed rows and watchers once per message.
 */
const PlainTimelineRow: FunctionalComponent<{ messages: readonly DesktopRoomMessage[] }> = (rowProps, { slots }) =>
  slots.default?.({ message: rowProps.messages[0], history: false });
PlainTimelineRow.props = ["messages", "grouped", "lazyHistory", "rowLimit", "anchorId", "parseEvent"];
PlainTimelineRow.emits = ["layoutStart", "layoutSettled"];
// A plain row gets its message as a one-item list. The same message keeps the
// same list, so a timeline rebuild leaves the row's props unchanged.
const singleMessageLists = new WeakMap<DesktopRoomMessage, readonly DesktopRoomMessage[]>();
function singleMessageList(message: DesktopRoomMessage): readonly DesktopRoomMessage[] {
  let list = singleMessageLists.get(message);
  if (!list) singleMessageLists.set(message, list = [message]);
  return list;
}
const {
  viewFor: startupViewFor,
  timelineStartups,
  retry: retryStartup,
  cancel: cancelStartup,
} = useAgentStartupRows({ roomIdentifier: () => props.roomIdentifier ?? "", entries: () => props.supervisorEntries });
const { pushActionToast } = useDesktopActionToasts();
function startupAction(action: (entryId: string) => Promise<void>, entryId: string, failed: string): void {
  action(entryId).catch((error: unknown) => pushActionToast(`${failed} ${safeUserVisibleErrorDetail(error, "Try again.")}`, "error"));
}
// The same list while its rows show the same text, so a start-up progress
// update of an entry does not rebuild the timeline.
const firstMessages = computed<DesktopSupervisorManifestEntry[]>((previous) => {
  const next = firstMessageAgents(props.supervisorEntries ?? [], props.messages, props.hasOlderMessages);
  const same = previous?.length === next.length && next.every((agent, index) => {
    const before = previous[index]!;
    return agent.id === before.id && agent.createdAt === before.createdAt
      && agent.charter === before.charter && agent.displayName === before.displayName;
  });
  return same ? previous! : next;
});
const timelineEntries = computed(() => buildGroupedTimeline(buildMessageTimelineEntries(props.messages, props.roomAgentWork, props.presenceLines, timelineStartups.value,
  firstMessages.value),
  entry => entry.type === 'message' ? entry.message : null, message => message.source === 'github' ? parseGitHubEvent(message) : null, props.messageNamespace));
// Bounded mount window (see message-window.ts): only a contiguous range of
// the timeline is mounted.
const windowState = shallowRef<MessageWindowState>({ kind: "latest" });
const windowEntries = () => timelineEntries.value as readonly WindowEntry[];
const entryIndexByMessageId = computed(() => indexEntriesByMessageId(windowEntries()));
const windowBounds = computed(() => resolveWindowBounds(
  windowEntries(), windowState.value, entryIndexByMessageId.value, [props.activeThreadParentId],
));
// The open thread root stays mounted wherever the window is, so its inline
// thread keeps its state (draft, GIF choice, scroll). Outside the window it is
// hidden; it is the same keyed row, so it is not remounted when it returns.
const hiddenPinnedIndexes = computed(() => pinnedOutside(windowBounds.value, entryIndexByMessageId.value, [props.activeThreadParentId])
  .filter(index => timelineEntries.value[index]?.type === "message"));
const hiddenPinnedIds = computed(() => new Set(hiddenPinnedIndexes.value.map(index => {
  const entry = timelineEntries.value[index]!;
  return entry.type === "message" ? entry.message.id : "";
})));
const mountedEntries = computed(() => {
  const { start, end } = windowBounds.value;
  const entries = timelineEntries.value;
  const window = start === 0 && end === entries.length ? entries : entries.slice(start, end);
  if (!hiddenPinnedIndexes.value.length) return window;
  const before = hiddenPinnedIndexes.value.filter(index => index < start).map(index => entries[index]!);
  const after = hiddenPinnedIndexes.value.filter(index => index >= end).map(index => entries[index]!);
  return [...before, ...window, ...after];
});
const windowReachesLatest = computed(() => windowBounds.value.end >= timelineEntries.value.length);
/** Rough height for the rows below a detached window, so the reader can scroll into them. */
const windowGapHeight = computed(() => Math.min(4000, Math.max(800, (timelineEntries.value.length - windowBounds.value.end) * 72)));
const windowGapElement = ref<HTMLElement | null>(null);
// First message of the rendered window, read before the next render so a
// sliding "latest" window can be fixed where the reader sees it.
let renderedWindowStartId: string | null = null;
let windowGrowthPending = false;
let windowJumpRequest = 0;

// False until a window has rendered, so the first message load cannot fix it.
let renderedWindowAtTop = false;

function rememberRenderedWindow(): void {
  renderedWindowStartId = firstMessageIdFrom(windowEntries(), windowBounds.value.start);
  renderedWindowAtTop = windowBounds.value.start === 0 && timelineEntries.value.length > 0;
}

/**
 * Stops a "latest" window from sliding while the reader is above the bottom.
 * `rendered` uses the window on screen (before a pending render), otherwise
 * the current one. A window at the top of history stays open upward, so
 * older pages mount as they arrive.
 */
function freezeWindow(rendered = true): void {
  if (windowState.value.kind !== "latest") return;
  if (rendered ? renderedWindowAtTop : windowBounds.value.start === 0) {
    windowState.value = { kind: "range", start: null, end: null };
    return;
  }
  const startId = rendered ? renderedWindowStartId : firstMessageIdFrom(windowEntries(), windowBounds.value.start);
  if (!startId) return;
  const index = entryIndexByMessageId.value.get(startId);
  if (index === undefined) return;
  windowState.value = windowStateFor(windowEntries(), index, timelineEntries.value.length);
}

/** True when a reset to the newest entries would mount the same rows. */
function windowMatchesLatest(): boolean {
  const latest = resolveWindowBounds(windowEntries(), { kind: "latest" }, entryIndexByMessageId.value, [props.activeThreadParentId]);
  return latest.start === windowBounds.value.start && latest.end === windowBounds.value.end;
}

function resetWindowToLatest(): void {
  windowGrowthPending = false;
  windowJumpRequest++;
  if (windowState.value.kind !== "latest") windowState.value = { kind: "latest" };
}

/**
 * At the bottom the window returns to the newest entries. Rows leave only
 * above the reader, and the visible row is put back in place after the render.
 */
function trimWindowWhileFollowing(): void {
  if (windowState.value.kind === "latest" || !isScrolledToBottom) return;
  const anchor = captureScrollAnchor();
  const revision = scrollRevision;
  resetWindowToLatest();
  void nextTick(() => {
    if (revision !== scrollRevision || !messagesElement.value) return;
    if (!restoreScrollAnchor(anchor)) jumpToBottom();
  });
}

/** Mounts one more chunk above the window and keeps the visible row in place. */
function growWindowUpward(): boolean {
  if (windowGrowthPending) return windowBounds.value.start > 0;
  const element = messagesElement.value;
  const next = grownUpwardState(windowEntries(), windowBounds.value);
  if (!element || !next) return false;
  windowGrowthPending = true;
  const anchor = captureScrollAnchor();
  const previousScrollHeight = element.scrollHeight;
  const namespace = props.messageNamespace;
  windowState.value = next;
  void nextTick(() => {
    windowGrowthPending = false;
    const currentElement = messagesElement.value;
    if (namespace !== props.messageNamespace || !currentElement) return;
    if (!restoreScrollAnchor(anchor)) {
      setInstantScrollTop(currentElement, currentElement.scrollTop + currentElement.scrollHeight - previousScrollHeight);
      updateScrollState();
      emitScrollPosition();
    }
  });
  return true;
}

/**
 * Mounts one more chunk below a detached window when its gap comes near the
 * view. Rows are added below the reader, so nothing on screen moves.
 */
function growWindowDownwardWhenNear(element: HTMLElement): void {
  const gap = windowGapElement.value;
  // A jump is moving the view to its target; its scroll events are not the reader's.
  if (!gap || windowGrowthPending || revealingMessage) return;
  const gapTop = gap.getBoundingClientRect().top;
  const view = element.getBoundingClientRect();
  // A jump into the gap (scrollbar drag, End): no rows are near, so go to the
  // newest messages instead of mounting chunk after chunk.
  if (gapTop <= view.top || element.scrollHeight - element.scrollTop - element.clientHeight < 80) {
    scrollToBottom("auto");
    return;
  }
  if (gapTop > view.bottom + 600) return;
  const next = grownDownwardState(windowEntries(), windowBounds.value);
  if (!next) return;
  const startBefore = windowBounds.value.start;
  const anchor = captureScrollAnchor();
  windowState.value = next;
  if (windowBounds.value.start === startBefore) return;
  // Rows left above the reader: put the visible row back in place.
  windowGrowthPending = true;
  const namespace = props.messageNamespace;
  void nextTick(() => {
    windowGrowthPending = false;
    if (namespace === props.messageNamespace) restoreScrollAnchor(anchor);
  });
}

function handleListKeydown(event: KeyboardEvent): void {
  cancelInitialRestore();
  if (event.key === "End" && !windowReachesLatest.value && !isEditableTarget(event.target)) {
    event.preventDefault();
    scrollToBottom("auto");
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName ?? "")));
}

/**
 * Mounts a loaded message outside the window. Returns false when the message
 * is not loaded or already mounted, so callers keep today's fallbacks.
 */
function includeMessageInWindow(messageId: string): boolean {
  const next = windowStateIncluding(windowEntries(), windowBounds.value, entryIndexByMessageId.value, messageId);
  if (!next) return false;
  windowGrowthPending = false;
  windowState.value = next;
  return true;
}

// Opening a thread far from the window (search, links) mounts its root.
watch(() => props.activeThreadParentId, (parentId) => { if (parentId) includeMessageInWindow(parentId); }, { flush: "sync" });
// One set, edited in place: a new Set per update re-rendered every message.
const threadIndicatorMemo = createThreadIndicatorMemo();
// Highlighting re-scans every mounted message, so typing waits for a short
// pause. Clearing the query applies at once.
const highlightQuery = ref(props.searchQuery);
let highlightQueryTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => props.searchQuery, (query) => {
  if (highlightQueryTimer !== null) clearTimeout(highlightQueryTimer);
  highlightQueryTimer = null;
  if (!query.trim()) { highlightQuery.value = query; return; }
  highlightQueryTimer = setTimeout(() => { highlightQueryTimer = null; highlightQuery.value = query; }, 120);
});
onBeforeUnmount(() => { if (highlightQueryTimer !== null) clearTimeout(highlightQueryTimer); });
watch(() => props.messages, (messages) => threadIndicatorMemo.retain(messages));
const messageReferenceIds = useStableIdSet(() => props.messages.map((message) => message.id));

watch(
  () => props.messages,
  async (newMessages, oldMessages) => {
    const appendedIds = getAppendedMessageIds(
      (oldMessages || []).map((message) => message.id),
      newMessages.map((message) => message.id),
    );
    markMessagesArriving(appendedIds);
    const previousScrollHeight = messagesElement.value?.scrollHeight || 0;
    const oldFirstId = oldMessages?.[0]?.id;
    const oldLastId = oldMessages?.[oldMessages.length - 1]?.id;
    const oldLastMessage = oldMessages?.[oldMessages.length - 1] || null;
    const newLastMessage = newMessages[newMessages.length - 1] || null;
    const newLastId = newMessages[newMessages.length - 1]?.id;
    const isAcknowledgement = Boolean(oldLastMessage?.clientMessageId
      && oldLastMessage.clientMessageId === newLastMessage?.clientMessageId);
    const oldFirstIndexInNew = oldFirstId
      ? newMessages.findIndex((message) => message.id === oldFirstId)
      : -1;
    const isPrepend = oldFirstIndexInNew > 0;
    const isNewLatestMessage = Boolean(
      oldLastMessage &&
      newLastMessage &&
      newLastMessage.id !== oldLastMessage.id &&
      compareRoomMessages(newLastMessage, oldLastMessage) > 0
    );
    const prependAnchor = isPrepend ? captureScrollAnchor() : null;
    const revision = scrollRevision;
    // A reader above the bottom keeps the rows they see: the window stops sliding.
    if (!isScrolledToBottom) freezeWindow();
    const windowStartBefore = renderedWindowStartId;
    let followsWindowSlide = false;
    if (!isPrepend && oldLastId && newLastId !== oldLastId && !isAcknowledgement) {
      // A follower jumps to the bottom after this render, so the window can drop
      // the rows far above it.
      if (isScrolledToBottom && props.active && !shouldRestoreInitialScroll) {
        resetWindowToLatest();
        followsWindowSlide = true;
      }
      followLatestAfterLayout();
    }

    await nextTick();
    if (revision !== scrollRevision) return;
    // Rows that left the top of a sliding window move scrollTop, which the
    // follow check above reads as a reader scroll. The reader was following.
    if (followsWindowSlide && props.active && renderedWindowStartId !== windowStartBefore) jumpToBottom();

    if (!props.active) {
      if (isNewLatestMessage && isScrolledToBottom) {
        shouldJumpToLatestOnActivate = true;
      }
      return;
    }
    if (shouldRestoreInitialScroll && restoreInitialScrollPosition()) return;
    if (isPrepend && messagesElement.value) {
      if (!restoreScrollAnchor(prependAnchor)) {
        setInstantScrollTop(
          messagesElement.value,
          messagesElement.value.scrollTop + messagesElement.value.scrollHeight - previousScrollHeight,
        );
        updateScrollState();
        emitScrollPosition();
      }
      return;
    }
    if (!oldLastId) {
      if (newMessages.length) {
        if (restoreInitialScrollPosition()) {
          return;
        }
        scrollToBottom("auto");
        return;
      }
      updateScrollState();
      return;
    }
    if (newLastId === oldLastId || isAcknowledgement) {
      if (!bottomFollowQueued) updateScrollState();
      return;
    }
    if (isScrolledToBottom) return;
    if (newLastId) {
      unreadCount.value += Math.max(1, newMessages.length - (oldMessages?.length || 0));
    }
  },
  { immediate: true },
);

const toMotionMessage = (message: DesktopRoomMessage) => ({
  id: message.id, stableId: message.clientMessageId || message.id, text: message.text,
  outgoing: message.outgoing?.status === 'pending',
  session: message.agentIdentity?.agentSessionId, key: message.agentIdentity?.agentKey,
});
const motionMessages = () => props.messages.map(toMotionMessage);

const messageMotion = useRoomMessageMotion({
  element: messagesElement,
  work: liveStripElement,
  scope: () => props.messageNamespace,
  // Loading older history must not disable navigation for a new own send.
  // The motion watcher independently excludes prepended/historical messages.
  ready: () => props.active && !props.roomLoading && !shouldRestoreInitialScroll,
  onOwnSend: () => { if (props.active && !props.roomLoading) cancelInitialRestore(); },
  following: () => isScrolledToBottom,
  scrollToLatest: () => scrollToBottom("auto"),
  messages: motionMessages,
  onInterrupt: () => workHandoff.clear(),
});

// A join or leave line is added at the bottom: a reader there stays with the latest.
watch(() => props.presenceLines?.length ?? 0, (count, previous) => {
  if (count > previous && isScrolledToBottom && !shouldRestoreInitialScroll) followLatestAfterLayout();
});

// A no-reply turn can add a contribution without adding a chat message.
watch(() => timelineEntries.value.filter(entry => entry.type === 'contribution').map(entry => entry.id).join('|'), async () => {
  if (shouldRestoreInitialScroll) return;
  const following = isScrolledToBottom;
  const anchor = captureScrollAnchor();
  const revision = scrollRevision;
  if (following) followLatestAfterLayout();
  await nextTick();
  if (revision !== scrollRevision) return;
  if (!props.active) { if (following) shouldJumpToLatestOnActivate = true; return; }
  if (!following) { restoreScrollAnchor(anchor); updateScrollState(); }
});

// Rate-limit the live echo text: an entry's summary changes at most once per
// WORK_INDICATOR_ECHO_MIN_INTERVAL_MS. State persists across polls; a trailing
// timer flushes any summary held back inside the window so the latest value
// still surfaces if native updates stop arriving.
let echoState: WorkIndicatorEchoState = {};
let echoFlushTimer: number | null = null;
const displayedAgentWork = ref<ManagedAgentWorkIndicator[]>([]);
// Room and thread messages in room order, sorted once for both readers below.
const sortedVisibleMessages = computed(() => [...props.messages, ...props.threadMessages].sort(compareRoomMessages));
const currentLocalAgentWork = computed(() => {
  if (!props.localAgentWork.length) return [];
  // Public room order is the causal clock here. Provider activity timestamps
  // come from the local host while message timestamps come from the server, so
  // comparing them can suppress a genuinely new turn when the clocks differ.
  return props.localAgentWork.filter((work) => !workIndicatorSupersededByAgentMessage(work, sortedVisibleMessages.value));
});

const workHandoff = useRoomWorkHandoff({
  work: () => currentLocalAgentWork.value,
  identity: work => ({ session: work.agentSessionId, key: work.agentKey }),
  after: work => work.awaitingRoomTurn ? null : work.sourceMessageId,
  // A thread reply retires its source work just like a main-timeline reply.
  // Keep the animation watcher above restricted to rows rendered in this list.
  messages: () => sortedVisibleMessages.value.map(toMotionMessage),
  scope: () => props.messageNamespace,
  enabled: () => props.active && !props.roomLoading && !shouldRestoreInitialScroll && isScrolledToBottom,
});

function applyEchoCoalescing(): void {
  const { state, indicators, hasPending } = coalesceWorkIndicatorEchoes(
    echoState,
    workHandoff.work.value,
    Date.now(),
    WORK_INDICATOR_ECHO_MIN_INTERVAL_MS,
  );
  echoState = state;
  displayedAgentWork.value = indicators;
  if (echoFlushTimer !== null) {
    window.clearTimeout(echoFlushTimer);
    echoFlushTimer = null;
  }
  if (hasPending) {
    echoFlushTimer = window.setTimeout(applyEchoCoalescing, WORK_INDICATOR_ECHO_MIN_INTERVAL_MS);
  }
}

// The handoff always assigns a new list (and itself watches the work deeply),
// so a shallow watch sees every change.
watch(
  workHandoff.work,
  () => applyEchoCoalescing(),
  { immediate: true },
);

watch(
  // Key off the rate-limited displayed set (not raw props) so scroll effects
  // share the coalesced echo cadence instead of firing on every native event.
  () => displayedAgentWork.value.map((work) => `${work.id}:${work.summary}`).join("|"),
  (nextKey, previousKey) => {
    if (nextKey !== previousKey) followLatestAfterLayout();
  },
);

watch(
  () => props.messageNamespace,
  (namespace, previousNamespace) => {
    if (namespace === previousNamespace) return;
    resetWindowToLatest();
    threadActivityNamespace = namespace;
    suppressNextThreadActivityNotice = true;
    threadActivityNotice.value = null;
  },
);

watch(
  () => props.threadMessages,
  (newMessages, oldMessages = []) => {
    if (
      suppressNextThreadActivityNotice ||
      threadActivityNamespace !== props.messageNamespace
    ) {
      suppressNextThreadActivityNotice = false;
      threadActivityNamespace = props.messageNamespace;
      threadActivityNotice.value = null;
      return;
    }
    if (!oldMessages.length) return;

    const previousNewestMessage = newestMessage(oldMessages);
    const oldReplyIds = new Set(
      oldMessages
        .filter((message) => threadParentId(message))
        .map((message) => message.id),
    );
    const newThreadReplies = newMessages.filter((message) =>
      threadParentId(message) &&
      !oldReplyIds.has(message.id) &&
      (!previousNewestMessage || compareRoomMessages(message, previousNewestMessage) > 0)
    );
    const latestReply = newestMessage(newThreadReplies);
    const parentId = latestReply ? threadParentId(latestReply) : null;
    if (!latestReply || !parentId || parentId === props.readingThreadParentId) return;

    threadActivityNotice.value = buildThreadActivityNotice(latestReply, parentId);
  },
);

watch(
  () => props.readingThreadParentId,
  (parentId) => {
    if (parentId && threadActivityNotice.value?.parentId === parentId) {
      threadActivityNotice.value = null;
    }
  },
);

watch(
  () => props.activeSearchMessageId,
  (messageId) => {
    if (!props.active) return;
    if (messageId) {
      void nextTick(() => scrollToMessage(messageId));
    }
  },
);

watch(
  () => props.active,
  async (active) => {
    if (!active) {
      emitScrollPosition();
      return;
    }
    await nextTick();
    if (shouldJumpToLatestOnActivate) {
      shouldJumpToLatestOnActivate = false;
      shouldRestoreKeepAliveScroll = false;
      scrollToBottom("auto");
      return;
    }
    if (shouldRestoreKeepAliveScroll && restoreKnownScrollPosition()) {
      shouldRestoreKeepAliveScroll = false;
      return;
    }
    if (!restoreInitialScrollPosition()) {
      updateScrollState();
    }
  },
);

watch(
  [
    () => props.active,
    () => props.roomLoading,
    () => props.hasOlderMessages,
    () => props.loadingOlderMessages,
    () => props.olderMessagesError,
    () => props.messages.length,
    () => props.threadMessages.length,
    () => props.hasFilteredRoomActivity,
    () => props.roomIdentifier,
  ],
  () => scheduleAutoFillViewport(),
  { immediate: true, flush: "post" },
);

watch(
  () => props.roomIdentifier,
  () => {
    scrollRevision++;
    resetWindowToLatest();
    cancelMessageReveal();
    clearMessageArrivals();
    unreadCount.value = 0;
    threadActivityNotice.value = null;
    isScrolledFarUp.value = false;
    isScrolledToBottom = false;
    hasAppliedInitialScroll = false;
    restorePagesRequested = 0;
    restoreRequestPending = false;
    shouldRestoreInitialScroll = hasInitialScrollPosition();
    shouldJumpToLatestOnActivate = false;
    shouldRestoreKeepAliveScroll = false;
    autoViewportBackfillCount.value = 0;
    cancelAutoFillViewport();
    void nextTick(() => {
      if (!hasAppliedInitialScroll && !restoreInitialScrollPosition()) {
        scrollToBottom("auto");
      }
    });
  },
);

watch(
  () => props.initialScrollPosition,
  () => {
    if (hasAppliedInitialScroll) return;
    shouldRestoreInitialScroll = hasInitialScrollPosition();
  },
);

watch(() => props.loadingOlderMessages, (loading, previous) => {
  if (previous && !loading) restoreRequestPending = false;
}, { flush: "sync" });
watch(() => [props.roomLoading, props.loadingOlderMessages, props.olderMessagesError, props.messages.length],
  () => { if (shouldRestoreInitialScroll) void nextTick(restoreInitialScrollPosition); }, { flush: "post" });

// Reactions or previews appearing under a message make the list taller without a
// new message. A reader at the newest message stays there.
const messageReactions = injectRoomMessageReactions();
const messageLinkPreviews = injectRoomMessageLinkPreviews();
watch(
  () => [messageReactions?.revision.value, messageLinkPreviews?.revision.value],
  followLatestAfterLayout,
);

// The composer below can grow (an approval, a reply, a longer draft). A reader
// at the newest message stays there instead of having it covered.
let viewportResizeObserver: ResizeObserver | null = null;
let observedViewportHeight = 0;
function keepLatestInViewOnResize(): void {
  const element = messagesElement.value;
  if (!element || element.clientHeight === observedViewportHeight) return;
  // Judge "at the newest message" by the height before this change: a scroll
  // event measured after it can already read the shrunken list as scrolled up.
  const wasAtLatest = windowReachesLatest.value
    && (isScrolledToBottom || element.scrollHeight - element.scrollTop - observedViewportHeight < 80);
  observedViewportHeight = element.clientHeight;
  if (props.active && wasAtLatest && !revealingMessage && !shouldRestoreInitialScroll) jumpToBottom();
}

onMounted(() => {
  void nextTick(() => {
    if (!hasAppliedInitialScroll && !restoreInitialScrollPosition()) {
      if (props.messages.length && !props.roomLoading) scrollToBottom("auto");
      else updateScrollState();
    }
    scheduleAutoFillViewport();
  });
  if (typeof ResizeObserver !== "undefined" && messagesElement.value) {
    observedViewportHeight = messagesElement.value.clientHeight;
    viewportResizeObserver = new ResizeObserver(keepLatestInViewOnResize);
    viewportResizeObserver.observe(messagesElement.value);
  }
});

onDeactivated(() => {
  rememberScrollAnchor();
  shouldRestoreKeepAliveScroll = true;
  emitScrollPosition();
});

onActivated(() => {
  void nextTick(() => {
    if (!props.active) return;
    if (restoreKnownScrollPosition()) {
      shouldRestoreKeepAliveScroll = false;
    }
  });
});

onBeforeUnmount(() => {
  scrollRevision++;
  cancelMessageReveal();
  viewportResizeObserver?.disconnect();
  clearMessageArrivals();
  cancelAutoFillViewport();
  cancelLayoutAnchorRestore();
  rememberScrollAnchor();
  emitScrollPosition();
  if (echoFlushTimer !== null) {
    window.clearTimeout(echoFlushTimer);
    echoFlushTimer = null;
  }
});

function markMessagesArriving(messageIds: readonly string[]): void {
  if (!messageIds.length) return;
  const nextIds = new Set(arrivingMessageIds.value);
  for (const messageId of messageIds) {
    nextIds.add(messageId);
    const existingTimer = arrivalTimers.get(messageId);
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    arrivalTimers.set(messageId, window.setTimeout(() => {
      arrivalTimers.delete(messageId);
      const remainingIds = new Set(arrivingMessageIds.value);
      remainingIds.delete(messageId);
      arrivingMessageIds.value = remainingIds;
    }, 320));
  }
  arrivingMessageIds.value = nextIds;
}

function clearMessageArrivals(): void {
  for (const timer of arrivalTimers.values()) window.clearTimeout(timer);
  arrivalTimers.clear();
  arrivingMessageIds.value = new Set();
}

function scheduleAutoFillViewport(): void {
  cancelAutoFillViewport();
  if (!canAutoFillViewport()) return;
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    void nextTick(() => maybeAutoFillViewport());
    return;
  }
  autoViewportBackfillFrame = window.requestAnimationFrame(() => {
    autoViewportBackfillFrame = null;
    void nextTick(() => maybeAutoFillViewport());
  });
}

function cancelAutoFillViewport(): void {
  if (autoViewportBackfillFrame === null) return;
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(autoViewportBackfillFrame);
  }
  autoViewportBackfillFrame = null;
}

function cancelLayoutAnchorRestore(): void {
  layoutRestoreRevision++;
  layoutRestoredScrollTop = null;
  if (layoutAnchorRestoreFrame === null) return;
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(layoutAnchorRestoreFrame);
  }
  layoutAnchorRestoreFrame = null;
}

function canAutoFillViewport(): boolean {
  return Boolean(
    props.active
    && props.roomIdentifier
    && !props.roomLoading
    && props.hasOlderMessages
    && !props.loadingOlderMessages
    && !props.olderMessagesError
    && autoViewportBackfillCount.value < maxAutoViewportBackfillPages
  );
}

function maybeAutoFillViewport(): void {
  if (!canAutoFillViewport()) return;
  const element = messagesElement.value;
  if (!element || !isMeasurableScrollViewport(element)) return;
  const hasLoadedTimelineActivity = props.messages.length > 0
    || props.threadMessages.length > 0
    || props.hasFilteredRoomActivity;
  if (!hasLoadedTimelineActivity) return;
  if (element.scrollHeight > element.clientHeight + viewportFillSlack) return;
  // Loaded rows above the mount window fill the viewport before a network page does.
  if (growWindowUpward()) { void nextTick(scheduleAutoFillViewport); return; }

  autoViewportBackfillCount.value += 1;
  emit("load-older");
}

function scrollToBottom(behavior: ScrollBehavior = "smooth"): void {
  unreadTimeline.programmaticScroll();
  if (!messagesElement.value) return;
  // Choosing latest settles initial navigation too. The parent feeds our live
  // scroll reports back as initialScrollPosition; they must not re-arm restoration.
  hasAppliedInitialScroll = true;
  shouldRestoreInitialScroll = false;
  cancelMessageReveal();
  if (windowState.value.kind !== "latest" && !windowMatchesLatest()) {
    // The mounted rows change in the next render. A smooth scroll would aim at
    // the old list height, so go there at once and settle again after the render.
    resetWindowToLatest();
    behavior = "auto";
    const revision = scrollRevision;
    void nextTick(() => {
      if (revision !== scrollRevision || !isScrolledToBottom) return;
      jumpToBottom();
      // The browser's own scroll anchoring can still move the view a little
      // on the next frame, after the rows changed. Settle once more there.
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => { if (isScrolledToBottom && windowReachesLatest.value && props.active) jumpToBottom(); });
      }
    });
  }
  if (behavior === "auto") {
    jumpToBottom();
    return;
  }
  messagesElement.value.scrollTo({
    top: messagesElement.value.scrollHeight,
    behavior,
  });
  isScrolledToBottom = true;
  unreadCount.value = 0;
  isScrolledFarUp.value = false;
  emitScrollPosition();
}

function jumpToBottom(): void {
  unreadTimeline.programmaticScroll();
  cancelMessageReveal();
  if (!messagesElement.value) return;
  if (!windowReachesLatest.value) {
    // The newest messages are not mounted: mount them, then go there.
    resetWindowToLatest();
    const revision = scrollRevision;
    void nextTick(() => { if (revision === scrollRevision && windowReachesLatest.value) jumpToBottom(); });
    return;
  }
  const element = messagesElement.value;
  const previousScrollBehavior = element.style.scrollBehavior;
  element.style.scrollBehavior = "auto";
  element.scrollTop = element.scrollHeight;
  element.style.scrollBehavior = previousScrollBehavior;
  isScrolledToBottom = true;
  unreadCount.value = 0;
  isScrolledFarUp.value = false;
  emitScrollPosition();
}

function cancelInitialRestore(): void {
  if (!shouldRestoreInitialScroll) return;
  shouldRestoreInitialScroll = false;
  hasAppliedInitialScroll = true;
}

function handleScroll(): void {
  if (shouldRestoreInitialScroll) return;
  scrollRevision++;
  cancelMessageRevealFrame();
  if (messagesElement.value?.scrollTop !== layoutRestoredScrollTop) cancelLayoutAnchorRestore();
  if (!messagesElement.value) return;
  if (!props.active) return;
  shouldRestoreInitialScroll = false;
  const element = messagesElement.value;
  updateScrollState();
  if (isScrolledToBottom) {
    unreadCount.value = 0;
    trimWindowWhileFollowing();
  } else {
    freezeWindow(false);
    if (!windowReachesLatest.value) growWindowDownwardWhenNear(element);
  }
  emitScrollPosition();
  if (element.scrollTop < 180) {
    // Mount loaded rows above the window first; ask for older history only at its top.
    if (growWindowUpward()) return;
    if (props.hasOlderMessages && !props.loadingOlderMessages && !props.olderMessagesError) emit("load-older");
  }
}

function cancelMessageRevealFrame(): void {
  if (revealFrame !== null) window.cancelAnimationFrame(revealFrame);
  revealFrame = null;
}

function cancelMessageReveal(): void {
  cancelMessageRevealFrame();
  if (revealTimer !== null) window.clearTimeout(revealTimer);
  revealFrame = revealTimer = null;
  revealingMessage = false;
}

function beginMessageReveal(): void {
  cancelMessageReveal();
  const element = messagesElement.value;
  if (!element) return;
  const top = element.scrollTop;
  revealingMessage = true;
  // Smooth scrolling may start after the first frame. Any scroll event cancels this probe.
  revealFrame = window.requestAnimationFrame(() => {
    revealFrame = window.requestAnimationFrame(() => {
      revealFrame = null;
      if (messagesElement.value === element && element.scrollTop === top) finishMessageReveal();
    });
  });
  revealTimer = window.setTimeout(finishMessageReveal, 800);
}

function finishMessageReveal(): void {
  cancelMessageReveal();
  updateScrollState();
  // Scroll events during the jump were ignored; act on where it ended.
  const element = messagesElement.value;
  if (element && props.active && !windowReachesLatest.value) growWindowDownwardWhenNear(element);
}

function updateScrollState(): void {
  const element = messagesElement.value;
  if (!element) return;
  const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
  // A detached window does not hold the newest messages: its end is not "latest".
  isScrolledToBottom = !revealingMessage && distanceToBottom < 80 && windowReachesLatest.value;
  isScrolledFarUp.value = distanceToBottom > 900 || !windowReachesLatest.value;
}

function restoreInitialScrollPosition(): boolean {
  if (hasAppliedInitialScroll || !shouldRestoreInitialScroll || !messagesElement.value) return false;
  const position = props.initialScrollPosition;
  if (position === null || position === undefined) return false;
  const element = messagesElement.value;
  // Loading/hidden viewports must not consume the saved position or publish 0.
  if (props.roomLoading || !props.messages.length || !isMeasurableScrollViewport(element)) return true;
  const bookmark = position;
  if (!bookmark.latest && bookmark.anchor && !findScrollAnchor(bookmark.anchor.messageId)
    && includeMessageInWindow(bookmark.anchor.messageId)) {
    // The saved row is loaded but outside the mount window: mount it, then retry.
    void nextTick(restoreInitialScrollPosition);
    return true;
  }
  if (!bookmark.latest && bookmark.anchor && !findScrollAnchor(bookmark.anchor.messageId)
    && props.hasOlderMessages && !props.olderMessagesError && restorePagesRequested < 20) {
    if (!props.loadingOlderMessages && !restoreRequestPending) {
      restoreRequestPending = true; restorePagesRequested++; emit("load-older");
    }
    return true;
  }
  hasAppliedInitialScroll = true;
  shouldRestoreInitialScroll = false;
  if (bookmark.latest) { jumpToBottom(); return true; }
  if (bookmark.anchor && restoreScrollAnchor(bookmark.anchor)) return true;
  const max = Math.max(0, element.scrollHeight - element.clientHeight);
  // A remembered offset can exceed a fresh bounded page; never strand at top.
  setInstantScrollTop(element, Math.max(0, Math.min(bookmark.top, max)));
  updateScrollState();
  emitScrollPosition();
  return true;
}

function hasInitialScrollPosition(): boolean {
  const position = props.initialScrollPosition;
  return Boolean(position);
}

function emitScrollPosition(): void {
  const element = messagesElement.value;
  if (!element || !isMeasurableScrollViewport(element) || props.roomLoading || shouldRestoreInitialScroll) return;
  lastKnownScrollTop = element.scrollTop;
  lastKnownScrollAnchor = captureScrollAnchor();
  emit("scroll-position", { top: element.scrollTop, latest: isScrolledToBottom, anchor: lastKnownScrollAnchor });
}

function rememberScrollAnchor(): void {
  const element = messagesElement.value;
  if (!element || !isMeasurableScrollViewport(element)) return;
  const nextAnchor = captureScrollAnchor();
  if (nextAnchor) {
    lastKnownScrollAnchor = nextAnchor;
  }
  lastKnownScrollTop = element.scrollTop;
}

function restoreKnownScrollPosition(): boolean {
  const element = messagesElement.value;
  if (!element || !isMeasurableScrollViewport(element)) return false;
  if (restoreScrollAnchor(lastKnownScrollAnchor)) {
    return true;
  }
  if (lastKnownScrollTop === null) return false;
  setInstantScrollTop(element, lastKnownScrollTop);
  updateScrollState();
  emitScrollPosition();
  return true;
}

function preserveScrollAnchorOnNextLayout(durationMs = 0): void {
  const element = messagesElement.value;
  if (!element || !isMeasurableScrollViewport(element)) return;
  const anchor = captureScrollAnchor();
  const scrollTop = element.scrollTop;
  cancelLayoutAnchorRestore();
  scrollRevision++;
  const revision = layoutRestoreRevision;
  void nextTick(() => {
    if (revision !== layoutRestoreRevision) return;
    const startedAt = currentTimeMs();
    const restore = (): void => {
      const currentElement = messagesElement.value;
      if (revision !== layoutRestoreRevision || !currentElement || !isMeasurableScrollViewport(currentElement)) {
        layoutAnchorRestoreFrame = null;
        return;
      }
      if (!restoreScrollAnchor(anchor)) {
        setInstantScrollTop(currentElement, scrollTop);
        updateScrollState();
        emitScrollPosition();
      }
      layoutRestoredScrollTop = currentElement.scrollTop;
      if (
        durationMs <= 0 ||
        currentTimeMs() - startedAt >= durationMs ||
        typeof window === "undefined" ||
        typeof window.requestAnimationFrame !== "function"
      ) {
        layoutAnchorRestoreFrame = null;
        return;
      }
      layoutAnchorRestoreFrame = window.requestAnimationFrame(restore);
    };
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      layoutAnchorRestoreFrame = window.requestAnimationFrame(restore);
      return;
    }
    restore();
  });
}

function currentTimeMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function captureScrollAnchor(): ScrollAnchor | null {
  const element = messagesElement.value;
  if (!element || !isMeasurableScrollViewport(element)) return null;
  const viewportTop = element.getBoundingClientRect().top;
  const messageElements = getAnchorElements();
  let low = 0;
  let high = messageElements.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (messageElements[middle].getBoundingClientRect().bottom > viewportTop) high = middle;
    else low = middle + 1;
  }
  const anchorElement = messageElements[low];
  const messageId = anchorElement?.dataset.messageId || anchorElement?.dataset.scrollAnchorId;
  if (!anchorElement || !messageId) return null;
  return {
    messageId,
    offsetTop: anchorElement.getBoundingClientRect().top - viewportTop,
  };
}

function findScrollAnchor(messageId: string): HTMLElement | null {
  getAnchorElements();
  // Prepending a page can place this original inside a group whose stable anchor
  // belongs to the newer page. Restore the containing group, not its hidden row.
  return anchorElementsById.get(messageId)
    || messagesElement.value?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)?.closest<HTMLElement>('.room-github-updates') || null;
}

function restoreScrollAnchor(anchor: ScrollAnchor | null): boolean {
  const element = messagesElement.value;
  if (!element || !anchor || !isMeasurableScrollViewport(element)) return false;
  const anchorElement = findScrollAnchor(anchor.messageId);
  if (!anchorElement) return false;
  const viewportTop = element.getBoundingClientRect().top;
  const nextOffsetTop = anchorElement.getBoundingClientRect().top - viewportTop;
  setInstantScrollTop(element, anchoredScrollTop(element.scrollTop, anchor.offsetTop, nextOffsetTop));
  updateScrollState();
  emitScrollPosition();
  return true;
}

function isMeasurableScrollViewport(element: HTMLElement): boolean {
  return element.isConnected && element.clientHeight > 0 && element.getClientRects().length > 0;
}

function setInstantScrollTop(element: HTMLElement, scrollTop: number): void {
  const previousScrollBehavior = element.style.scrollBehavior;
  element.style.scrollBehavior = "auto";
  unreadTimeline.programmaticScroll();
  element.scrollTop = scrollTop;
  element.style.scrollBehavior = previousScrollBehavior;
}

const noDeliveryReceipts: never[] = [];
function threadIndicatorSummary(message: DesktopRoomMessage) {
  return threadIndicatorMemo.stable(
    message.id,
    buildThreadIndicatorSummary(message, threadSummaries.value.get(message.id) || null, attentionResponseAgentNames?.value),
  );
}

defineExpose({
  preserveScrollAnchorOnNextLayout,
  scrollToMessage,
});

function openThreadActivityNotice(): void {
  const notice = threadActivityNotice.value;
  if (!notice) return;
  threadActivityNotice.value = null;
  emit("reveal-thread", notice.parentId);
}

function revealOrScrollToMessage(messageId: string | null): void {
  if (!messageId) return;
  if (!scrollToMessage(messageId)) emit("reveal-message", messageId);
}

function scrollToMessage(messageId: string | null, behavior: ScrollBehavior = "smooth", historyReady = false): boolean {
  cancelInitialRestore();
  messageMotion.cancel();
  unreadTimeline.programmaticScroll();
  if (!messageId || !messagesElement.value) return false;
  const found = messagesElement.value.querySelector(`[data-testid="room-message-${messageId}"]`) as HTMLElement | null;
  const target = hiddenPinnedIds.value.has(messageId) ? null : found;
  if (!target) {
    // A row in a closed GitHub group is not mounted: the group opens it first.
    const groupElement = !historyReady ? githubGroupElementFor(messageId) : null;
    if (groupElement) {
      const namespace = props.messageNamespace, revision = scrollRevision;
      groupElement.dispatchEvent(new CustomEvent('reveal-github-message', { detail: { id: messageId, ready: () => { if (namespace === props.messageNamespace && revision === scrollRevision) scrollToMessage(messageId, behavior, true); } } }));
      return true;
    }
    // A loaded message outside the mount window: mount it first, then scroll.
    if (!includeMessageInWindow(messageId)) return false;
    const namespace = props.messageNamespace, request = ++windowJumpRequest;
    void nextTick(() => {
      if (namespace === props.messageNamespace && request === windowJumpRequest) scrollToMessage(messageId, behavior, historyReady);
    });
    return true;
  }
  const group = target.closest('.room-github-updates');
  if (group && !historyReady) {
    const namespace = props.messageNamespace, revision = scrollRevision;
    group.dispatchEvent(new CustomEvent('reveal-github-message', { detail: { id: messageId, ready: () => { if (namespace === props.messageNamespace && revision === scrollRevision) scrollToMessage(messageId, behavior, true); } } }));
    return true;
  }
  scrollRevision++;
  cancelLayoutAnchorRestore();
  isScrolledToBottom = false;
  if (behavior === "instant") cancelMessageReveal();
  else beginMessageReveal();
  shouldJumpToLatestOnActivate = false;
  target.scrollIntoView({ behavior, block: "center" });
  target.classList.add("jump-target");
  window.setTimeout(() => target.classList.remove("jump-target"), 1500);
  return true;
}

/** The mounted GitHub group element that holds `messageId`, if any. */
function githubGroupElementFor(messageId: string): HTMLElement | null {
  const index = entryIndexByMessageId.value.get(messageId);
  if (index === undefined || index < windowBounds.value.start || index >= windowBounds.value.end) return null;
  const entry = timelineEntries.value[index];
  if (entry?.type !== "github-group") return null;
  return messagesElement.value?.querySelector<HTMLElement>(`[data-scroll-anchor-id="${CSS.escape(entry.anchorId)}"]`) ?? null;
}

function dismissThreadActivityNotice(): void {
  threadActivityNotice.value = null;
}

function buildThreadActivityNotice(reply: DesktopRoomMessage, parentId: string): ThreadActivityNotice {
  const senderName = parseSenderIdentity(reply).displayName;
  const replyCount = threadSummaries.value.get(parentId)?.count || 1;
  return {
    parentId,
    title: `${senderName} replied`,
    preview: `${replyCount} ${replyCount === 1 ? "reply" : "replies"} · ${truncate(threadQuotePreview(reply, attentionResponseAgentNames?.value), 92)}`,
  };
}

function newestMessage(messages: readonly DesktopRoomMessage[]): DesktopRoomMessage | null {
  return messages.reduce<DesktopRoomMessage | null>((latest, message) => {
    if (!latest) return message;
    return compareRoomMessages(message, latest) >= 0 ? message : latest;
  }, null);
}

</script>

<style scoped>
.room-explicit-unread { display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--text-secondary); margin: 12px 0; }
.room-explicit-unread::before, .room-explicit-unread::after { content: ""; flex: 1; border-top: 1px solid var(--border-strong); }
/* The open thread root, kept mounted while it is outside the window. */
.room-window-pinned-hidden { display: none !important; }
/* Never a scroll anchor: rows inserted above it must not move the reader. */
.room-message-window-gap { flex: none; overflow-anchor: none; }
</style>
