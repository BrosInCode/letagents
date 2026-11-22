<template>
  <Teleport to="body">
    <section
      v-if="opened && receipt"
      ref="surface"
      class="room-receipt-popover"
      :class="{ 'is-shown': shown }"
      role="dialog"
      aria-labelledby="room-receipt-title"
      tabindex="-1"
      data-testid="room-receipt-popover"
      :style="position"
      @keydown.esc.stop.prevent="close(true)"
    >
      <header class="room-receipt-head">
        <h3 id="room-receipt-title" class="room-receipt-title">Message info</h3>
        <button type="button" class="room-receipt-copy" aria-label="Copy message link" :title="copied ? 'Link copied' : 'Copy message link'" @click="copyLink">
          <Check v-if="copied" :size="15" class="room-receipt-copied" aria-hidden="true" />
          <Link2 v-else :size="15" aria-hidden="true" />
        </button>
        <span class="sr-only" role="status">{{ copied ? "Link copied" : "" }}</span>
      </header>

      <div class="room-receipt-reading">
        <button
          v-if="receipt.readers.length"
          type="button"
          class="room-receipt-readers"
          :aria-expanded="readersOpen"
          aria-controls="room-receipt-readers"
          @click="readersOpen = !readersOpen; queuePlace()"
        >
          <span class="room-receipt-people" aria-hidden="true">
            <ChatPersonAvatar v-for="(reader, index) in receipt.readers.slice(0, 3)" :key="index" :name="reader.name" :avatar-url="reader.avatarUrl" />
            <i v-if="receipt.readers.length > 3" class="room-receipt-more">+{{ receipt.readers.length - 3 }}</i>
          </span>
          <span class="room-receipt-readers-label">{{ readersLabel(receipt) }}</span>
          <ChevronDown class="room-receipt-chevron" :size="13" aria-hidden="true" />
        </button>
        <p v-else class="room-receipt-no-reads">
          <Eye :size="16" aria-hidden="true" />
          {{ readersLabel(receipt) }}
        </p>
        <div v-show="readersOpen && receipt.readers.length" id="room-receipt-readers" class="room-receipt-readers-list">
          <ul aria-label="People who read this message">
            <li v-for="(reader, index) in receipt.readers" :key="index">
              <ChatPersonAvatar :name="reader.name" :avatar-url="reader.avatarUrl" aria-hidden="true" />
              <span>{{ reader.name }}</span>
              <time :datetime="reader.readAt">{{ clock(reader.readAt) }}</time>
            </li>
          </ul>
          <p v-if="receipt.notRead?.length" class="room-receipt-unread">Not read yet · {{ receipt.notRead.map((person) => person.name).join(", ") }}</p>
        </div>
      </div>

      <div class="room-receipt-activity">
        <h4 class="room-receipt-eyebrow">Agent activity</h4>
        <template v-if="!agents.length">
          <p class="room-receipt-why">{{ noWakeSentence(receipt.noWake) }}</p>
          <ul v-if="askable.length" class="room-receipt-list" aria-label="Agents you can ask">
            <li v-for="agent in askable" :key="agent.agentKey" class="room-receipt-row">
              <span class="room-receipt-tile" aria-hidden="true">
                <img v-if="agent.icon" :src="agent.icon" alt="" draggable="false" />
                <Bot v-else :size="16" />
              </span>
              <span class="room-receipt-who">
                <strong>{{ agent.displayName }}</strong>
                <span>{{ agent.detail }}</span>
              </span>
              <button
                type="button"
                class="room-receipt-ask"
                :disabled="asking !== null"
                :aria-label="`Ask ${agent.displayName} in a reply to this message`"
                @click="ask(agent)"
              >{{ asking === agent.agentKey ? "Asking…" : "Ask" }}</button>
            </li>
          </ul>
        </template>
        <ul v-else class="room-receipt-list" aria-label="Agents this message reached">
          <li v-for="agent in agents" :key="agent.agentKey" class="room-receipt-row">
            <button
              v-if="rowAction(agent)"
              type="button"
              class="room-receipt-hit"
              :aria-label="`${agent.displayName}, ${receiptRowLabel(agent.state)}. ${rowAction(agent) === 'reply' ? 'Show the reply' : 'Show activity'}`"
              @click="activate(agent)"
            />
            <span class="room-receipt-tile" aria-hidden="true">
              <img v-if="iconFor(agent)" :src="iconFor(agent)!" alt="" draggable="false" />
              <Bot v-else :size="16" />
            </span>
            <span class="room-receipt-who">
              <strong>{{ agent.displayName }}</strong>
              <span>{{ receiptRowDetail(agent, receipt.sentAt, now) }}</span>
            </span>
            <span class="room-receipt-state" :data-kind="receiptRowKind(agent.state)">
              <span v-if="receiptRowKind(agent.state) === 'working'" class="room-receipt-dots" aria-hidden="true"><i /><i /><i /></span>
              <Check v-else-if="receiptRowKind(agent.state) === 'replied'" :size="13" :stroke-width="2.4" aria-hidden="true" />
              <CircleAlert v-else-if="receiptRowKind(agent.state) === 'attention'" :size="13" :stroke-width="2" aria-hidden="true" />
              <Clock3 v-else-if="receiptRowKind(agent.state) === 'waiting'" :size="13" :stroke-width="2" aria-hidden="true" />
              <Minus v-else :size="13" :stroke-width="2.2" aria-hidden="true" />
              {{ receiptRowLabel(agent.state) }}
              <ChevronRight v-if="rowAction(agent)" class="room-receipt-go" :size="13" :stroke-width="2" aria-hidden="true" />
            </span>
          </li>
        </ul>
      </div>
    </section>
  </Teleport>
</template>

<script setup lang="ts">
import { Bot, Check, ChevronDown, ChevronRight, CircleAlert, Clock3, Eye, Link2, Minus } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";

import type { DesktopMessageReceipt, DesktopParticipantSummary, DesktopSupervisorManifestEntry } from "../../../../../../electron/ipc-types";
import { useMessageViewer } from "../../../../composables/useRoomMessageReactions";
import { injectRoomMessageReceipts } from "../../../../composables/useRoomMessageReceipts";
import { formatDate } from "../../../../domain/formatters";
import { messageOutcomeTarget } from "../../../../domain/message-outcome";
import {
  noWakeSentence, orderReceiptAgents, readersLabel, receiptRowDetail, receiptRowKind, receiptRowLabel, visibleReceipt,
} from "../../../../domain/message-receipt-view";
import type { AgentModalTarget } from "../desktop-chat-message/types";
import ChatPersonAvatar from "./RoomReceiptPersonAvatar.vue";
import { providerIconForLabel } from "./provider-icon";

type ReceiptAgent = DesktopMessageReceipt["agents"][number];
export interface ReceiptAskTarget { agentKey: string; displayName: string; mention: string }

const props = defineProps<{
  roomIdentifier: string;
  participants: readonly DesktopParticipantSummary[];
  supervisorEntries: readonly DesktopSupervisorManifestEntry[];
  /** The exact @mention that reaches one agent, given its key and name. */
  mentionFor: (agentKey: string, displayName: string) => string;
  messageLink: (messageId: string) => string | null;
}>();

const emit = defineEmits<{
  "scroll-to-message": [messageId: string];
  "inspect-agent": [target: AgentModalTarget];
  ask: [messageId: string, threadRootId: string | null, target: ReceiptAskTarget, done: (sent: boolean) => void];
}>();

const receipts = injectRoomMessageReceipts();
const opened = computed(() => receipts?.opened.value ?? null);
const receipt = computed(() => opened.value ? visibleReceipt(receipts?.receiptFor(opened.value.messageId)) : null);
const agents = computed(() => orderReceiptAgents(receipt.value?.agents ?? []));

const surface = ref<HTMLElement | null>(null);
const shown = ref(false);
const readersOpen = ref(false);
const copied = ref(false);
const asking = ref<string | null>(null);
const position = shallowRef<Record<string, string>>({});
const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;
let copyTimer: ReturnType<typeof setTimeout> | null = null;

const viewer = useMessageViewer();
const mySupervisedKeys = computed(() => new Set(props.supervisorEntries
  .filter((entry) => entry.roomId === props.roomIdentifier && entry.agentKey)
  .map((entry) => entry.agentKey!)));

/** Agents in the room now: your own first. Someone who left cannot be asked. */
const askable = computed(() => props.participants
  .filter((participant) => participant.kind === "agent" && participant.agentKey && !participant.hiddenAt)
  .map((participant) => {
    const owner = participant.ownerLabel?.trim().toLowerCase() ?? "";
    const mine = mySupervisedKeys.value.has(participant.agentKey!) || owner === "you"
      || (Boolean(owner) && (owner === viewer.value?.login.toLowerCase() || owner === viewer.value?.name.toLowerCase()));
    const displayName = participant.displayName.split("|")[0]!.trim() || participant.displayName;
    const ownerText = !mine && participant.ownerLabel ? `${participant.ownerLabel}’s agent` : null;
    return {
      agentKey: participant.agentKey!,
      displayName,
      mine,
      icon: providerIconForLabel(participant.ideLabel, participant.agentKey),
      detail: [ownerText, participant.ideLabel].filter(Boolean).join(" · ") || "Agent",
    };
  })
  .sort((a, b) => Number(b.mine) - Number(a.mine) || a.displayName.localeCompare(b.displayName)));

function iconFor(agent: ReceiptAgent): string | null {
  return providerIconForLabel(agent.provider, agent.agentKey);
}

function clock(timestamp: string): string {
  return formatDate("clockTime", timestamp);
}

function activityTarget(agent: ReceiptAgent): AgentModalTarget | null {
  if (!agent.mine || !opened.value) return null;
  return messageOutcomeTarget({ agentKey: agent.agentKey, actorLabel: agent.displayName },
    opened.value.messageId, props.roomIdentifier, props.supervisorEntries);
}

/** A reply opens wherever it is. Activity is on this computer only for your own agents. */
function rowAction(agent: ReceiptAgent): "reply" | "activity" | null {
  if (agent.replyMessageId) return "reply";
  return activityTarget(agent) ? "activity" : null;
}

function activate(agent: ReceiptAgent): void {
  if (agent.replyMessageId) {
    close(false);
    emit("scroll-to-message", agent.replyMessageId);
    return;
  }
  const target = activityTarget(agent);
  if (target) { close(false); emit("inspect-agent", target); }
}

function ask(agent: { agentKey: string; displayName: string }): void {
  const request = opened.value;
  if (!request || asking.value) return;
  asking.value = agent.agentKey;
  emit("ask", request.messageId, request.threadRootId, { agentKey: agent.agentKey, displayName: agent.displayName, mention: props.mentionFor(agent.agentKey, agent.displayName) }, (sent) => {
    asking.value = null;
    if (sent) close(false);
  });
}

async function copyLink(): Promise<void> {
  const request = opened.value;
  if (!request) return;
  const link = props.messageLink(request.messageId) ?? request.messageId;
  try {
    await navigator.clipboard.writeText(link);
    if (opened.value !== request) return;
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = false; }, 1200);
  } catch {
    // The clipboard can be unavailable; nothing else changes.
  }
}

function anchor(): HTMLElement | null {
  const request = opened.value;
  if (!request) return null;
  if (request.anchor.isConnected) return request.anchor;
  // A re-rendered message replaces its mark; find the one for the same message
  // in the same rendering (a thread root has a mark in the timeline and in the thread panel).
  const id = CSS.escape(request.messageId);
  return document.querySelector<HTMLElement>(`[data-receipt-mark="${id}"][data-receipt-context="${CSS.escape(request.context)}"]`)
    ?? document.querySelector<HTMLElement>(`[data-receipt-mark="${id}"]`);
}

/** Below the mark when it fits, above it when it does not; it grows out of the mark either way. */
function place(): void {
  const mark = anchor();
  const element = surface.value;
  if (!mark || !element) return;
  const rect = mark.getBoundingClientRect();
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const belowSpace = window.innerHeight - rect.bottom - 16;
  const aboveSpace = rect.top - 16;
  const below = height <= belowSpace || belowSpace >= aboveSpace;
  const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
  const desiredTop = below ? rect.bottom + 8 : rect.top - 8 - height;
  const top = Math.max(8, Math.min(desiredTop, window.innerHeight - 8 - height));
  position.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    transformOrigin: `${Math.round(rect.left + rect.width / 2 - left)}px ${below ? "0" : "100%"}`,
  };
}

let placeFrame = 0;
function queuePlace(): void {
  if (!opened.value) return;
  cancelAnimationFrame(placeFrame);
  placeFrame = requestAnimationFrame(place);
}

/** Scroll and resize move the popover only while it is open. */
function listen(on: boolean): void {
  if (on) {
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("resize", queuePlace);
    document.addEventListener("scroll", queuePlace, { capture: true, passive: true });
  } else {
    document.removeEventListener("pointerdown", handlePointerDown, true);
    window.removeEventListener("resize", queuePlace);
    document.removeEventListener("scroll", queuePlace, { capture: true });
    cancelAnimationFrame(placeFrame);
  }
}

function close(restoreFocus: boolean): void {
  const mark = anchor();
  receipts?.close();
  if (restoreFocus) mark?.focus({ preventScroll: true });
}

function handlePointerDown(event: PointerEvent): void {
  if (!opened.value || event.button !== 0) return;
  const target = event.target as Node | null;
  if (target && (surface.value?.contains(target) || anchor()?.contains(target))) return;
  close(false);
}

watch(() => opened.value?.messageId, async (messageId, previous) => {
  listen(Boolean(messageId));
  readersOpen.value = false;
  if (copyTimer) clearTimeout(copyTimer);
  copied.value = false;
  asking.value = null;
  if (!messageId) { shown.value = false; return; }
  if (messageId !== previous) shown.value = false;
  await nextTick();
  place();
  requestAnimationFrame(() => {
    shown.value = true;
    surface.value?.focus({ preventScroll: true });
  });
});

watch(() => receipt.value, (next) => {
  if (opened.value && next === null) receipts?.close();
  else if (next) queuePlace();
});

// The working timer is the only thing that ticks, and only while one shows.
watch(() => agents.value.some((agent) => ["working", "waiting"].includes(receiptRowKind(agent.state))) && Boolean(opened.value), (ticking) => {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  if (ticking) {
    now.value = Date.now();
    clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
  }
}, { immediate: true });

onBeforeUnmount(() => {
  listen(false);
  if (clockTimer) clearInterval(clockTimer);
  if (copyTimer) clearTimeout(copyTimer);
});
</script>
