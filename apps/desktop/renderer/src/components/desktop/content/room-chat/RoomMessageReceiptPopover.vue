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
        <h3 id="room-receipt-title" :key="summary.title" class="room-receipt-title" :class="{ 'is-changed': titleChanged }">
          <CircleAlert v-if="summary.tone === 'nobody'" :size="15" :stroke-width="2" aria-hidden="true" />
          <span>{{ summary.title }}</span>
        </h3>
        <time class="room-receipt-sent" :datetime="receipt.sentAt">Sent {{ clock(receipt.sentAt) }}</time>
      </header>

      <template v-if="summary.tone === 'nobody'">
        <p class="room-receipt-why">{{ noWakeSentence(receipt.noWake) }}</p>
        <template v-if="askable.length">
          <p class="room-receipt-eyebrow">Ask one now</p>
          <ul class="room-receipt-list" aria-label="Agents you can ask">
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
      </template>

      <template v-else>
        <div class="room-receipt-meter" aria-hidden="true">
          <i v-for="agent in agents" :key="agent.agentKey" :data-kind="receiptRowKind(agent.state)" />
        </div>
        <ul class="room-receipt-list" aria-label="Agents this message woke">
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
      </template>

      <footer class="room-receipt-foot">
        <button
          type="button"
          class="room-receipt-readers"
          :disabled="!receipt.readers.length"
          :aria-expanded="readersOpen"
          aria-controls="room-receipt-readers"
          @click="readersOpen = !readersOpen; queuePlace()"
        >
          <span v-if="receipt.readers.length" class="room-receipt-people" aria-hidden="true">
            <ChatPersonAvatar v-for="reader in receipt.readers.slice(0, 3)" :key="reader.name" :name="reader.name" :avatar-url="reader.avatarUrl" />
            <i v-if="receipt.readers.length > 3" class="room-receipt-more">+{{ receipt.readers.length - 3 }}</i>
          </span>
          <span class="room-receipt-readers-label">{{ readersLabel(receipt) }}</span>
          <ChevronRight v-if="receipt.readers.length" class="room-receipt-chevron" :size="13" :stroke-width="2" aria-hidden="true" />
        </button>
        <button type="button" class="room-receipt-copy" @click="copyLink">{{ copied ? "Copied" : "Copy link" }}</button>
      </footer>
      <div id="room-receipt-readers" class="room-receipt-readers-list" :class="{ 'is-open': readersOpen }">
        <div>
          <ul aria-label="People who read this message">
            <li v-for="reader in receipt.readers" :key="reader.name">
              <ChatPersonAvatar :name="reader.name" :avatar-url="reader.avatarUrl" />
              <span>{{ reader.name }}</span>
              <time :datetime="reader.readAt">{{ clock(reader.readAt) }}</time>
            </li>
          </ul>
          <p v-if="receipt.notRead?.length" class="room-receipt-unread">Not read yet: {{ receipt.notRead.map((person) => person.name).join(", ") }}</p>
        </div>
      </div>
    </section>
  </Teleport>
</template>

<script setup lang="ts">
import { Bot, Check, ChevronRight, CircleAlert, Clock3, Minus } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

import type { DesktopMessageReceipt, DesktopParticipantSummary, DesktopSupervisorManifestEntry } from "../../../../../../electron/ipc-types";
import { useMessageViewer } from "../../../../composables/useRoomMessageReactions";
import { injectRoomMessageReceipts } from "../../../../composables/useRoomMessageReceipts";
import { formatDate } from "../../../../domain/formatters";
import { messageOutcomeTarget } from "../../../../domain/message-outcome";
import {
  noWakeSentence, orderReceiptAgents, readersLabel, receiptRowDetail, receiptRowKind, receiptRowLabel, summarizeReceipt,
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
  ask: [messageId: string, target: ReceiptAskTarget, done: (sent: boolean) => void];
}>();

const receipts = injectRoomMessageReceipts();
const opened = computed(() => receipts?.opened.value ?? null);
const receipt = computed(() => opened.value ? receipts?.receiptFor(opened.value.messageId) ?? null : null);
const summary = computed(() => summarizeReceipt(receipt.value ?? { agents: [], noWake: null }));
const agents = computed(() => orderReceiptAgents(receipt.value?.agents ?? []));

const surface = ref<HTMLElement | null>(null);
const shown = ref(false);
const readersOpen = ref(false);
const copied = ref(false);
const asking = ref<string | null>(null);
const titleChanged = ref(false);
const position = shallowRef<Record<string, string>>({});
const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;

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
  const messageId = opened.value?.messageId;
  if (!messageId || asking.value) return;
  asking.value = agent.agentKey;
  emit("ask", messageId, { agentKey: agent.agentKey, displayName: agent.displayName, mention: props.mentionFor(agent.agentKey, agent.displayName) }, (sent) => {
    asking.value = null;
    if (sent) close(false);
  });
}

async function copyLink(): Promise<void> {
  const messageId = opened.value?.messageId;
  const link = messageId ? props.messageLink(messageId) ?? messageId : null;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    copied.value = true;
    window.setTimeout(() => { copied.value = false; }, 1200);
  } catch {
    // The clipboard can be unavailable; nothing else changes.
  }
}

function anchor(): HTMLElement | null {
  const request = opened.value;
  if (!request) return null;
  if (request.anchor.isConnected) return request.anchor;
  // A re-rendered message replaces its mark; find the one for the same message.
  return document.querySelector<HTMLElement>(`[data-receipt-mark="${CSS.escape(request.messageId)}"]`);
}

/** Below the mark when it fits, above it when it does not; it grows out of the mark either way. */
function place(): void {
  const mark = anchor();
  const element = surface.value;
  if (!mark || !element) return;
  const rect = mark.getBoundingClientRect();
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const below = rect.bottom + 8 + height <= window.innerHeight - 8;
  const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
  const top = below ? rect.bottom + 8 : Math.max(8, rect.top - 8 - height);
  position.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    transformOrigin: `${Math.round(rect.left + rect.width / 2 - left)}px ${below ? "0" : "100%"}`,
  };
}

let placeFrame = 0;
function queuePlace(): void {
  cancelAnimationFrame(placeFrame);
  placeFrame = requestAnimationFrame(() => {
    place();
    // A list that opens grows over 200 ms; place again once it has its height.
    window.setTimeout(place, 220);
  });
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
  readersOpen.value = false;
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

// Only a real change animates: the title of an open receipt, never its first paint.
watch(() => summary.value.title, (title, before) => {
  if (!opened.value || !before || title === before) return;
  titleChanged.value = true;
  window.setTimeout(() => { titleChanged.value = false; }, 220);
  queuePlace();
});

watch(() => receipt.value, (next) => {
  if (opened.value && next === null) receipts?.close();
  else if (next) queuePlace();
});

// The working timer is the only thing that ticks, and only while one shows.
watch(() => agents.value.some((agent) => ["working", "waiting"].includes(receiptRowKind(agent.state))) && Boolean(opened.value), (ticking) => {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  if (ticking) clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
}, { immediate: true });

onMounted(() => {
  document.addEventListener("pointerdown", handlePointerDown, true);
  window.addEventListener("resize", queuePlace);
  document.addEventListener("scroll", queuePlace, { capture: true, passive: true });
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", handlePointerDown, true);
  window.removeEventListener("resize", queuePlace);
  document.removeEventListener("scroll", queuePlace, { capture: true });
  if (clockTimer) clearInterval(clockTimer);
  cancelAnimationFrame(placeFrame);
});
</script>
