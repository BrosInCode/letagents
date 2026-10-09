<template>
  <form class="desktop-composer" data-testid="desktop-composer" @submit.prevent="submitMessage">
    <button v-if="unanswerableApprovalCount" type="button" class="desktop-host-approval-history"
      :aria-expanded="showApprovalHistory" @click="showApprovalHistory = !showApprovalHistory">
      {{ hostApprovalHistoryLabel(unanswerableApprovalCount, showApprovalHistory) }}
    </button>
    <RoomPresenceChips :chips="presenceChips ?? []" />
    <RoomComposerEventChips
      :event-previews="visibleEventPreviews"
      @open-event-preview="openEventPreview"
      @dismiss-event-preview="emit('dismiss-event-preview', $event)"
    />
    <!-- The live region exists before the offer does, so the offer is announced.
      It sits above the approval tray, so the offer never moves the tray's buttons. -->
    <div class="desktop-composer-correction-live" aria-live="polite" data-testid="desktop-composer-correction-live">
      <div
        v-if="correctionOffer"
        class="desktop-composer-correction-offer"
        data-testid="desktop-composer-correction-offer"
      >
        <span>
          <strong>{{ correctionOffer.target.displayName }}</strong> is in the middle of a turn. A room message waits until it ends.
        </span>
        <button
          type="button"
          :disabled="sending"
          data-testid="desktop-composer-send-as-correction"
          @click="sendAsCorrection"
        >
          Send as correction…
        </button>
      </div>
    </div>
    <!-- One request at a time. Arrivals join its queue or appear above it, so
      they never move the buttons; details open over the messages on demand. -->
    <section v-if="currentHostApproval" :key="hostApprovalIdentity(currentHostApproval)"
      class="desktop-composer-permission-tray desktop-host-approval" data-testid="desktop-host-approval" aria-live="polite">
      <div class="desktop-composer-permission-main">
        <span class="desktop-composer-permission-dot" aria-hidden="true"></span>
        <div class="desktop-composer-permission-copy">
          <strong :title="hostApprovalHeading(currentHostApproval)">{{ hostApprovalHeading(currentHostApproval) }}</strong>
          <span :title="hostApprovalSummary(currentHostApproval.presentation)">{{ hostApprovalSummary(currentHostApproval.presentation) }}</span>
        </div>
      </div>
      <div class="desktop-host-approval-queue">
        <template v-if="trayApprovals.length > 1">
          <button type="button" class="desktop-host-approval-step" aria-label="Previous approval"
            :disabled="currentApprovalIndex <= 0" @click="showApprovalAt(currentApprovalIndex - 1)">
            <ChevronLeft :size="14" aria-hidden="true" />
          </button>
          <span data-testid="desktop-host-approval-position">{{ currentApprovalIndex + 1 }} of {{ trayApprovals.length }}</span>
          <button type="button" class="desktop-host-approval-step" aria-label="Next approval"
            :disabled="currentApprovalIndex >= trayApprovals.length - 1" @click="showApprovalAt(currentApprovalIndex + 1)">
            <ChevronRight :size="14" aria-hidden="true" />
          </button>
        </template>
        <button type="button" class="desktop-host-approval-dismiss" :disabled="!decisionsArmed"
          :aria-label="`Dismiss approval from ${currentHostApproval.presentation.displayName}`"
          @click="dismissHostApproval(currentHostApproval.id)">
          <X :size="15" aria-hidden="true" />
        </button>
      </div>
      <!-- Notes about the request go here, above the footer, so they never move its buttons. -->
      <p v-if="currentHostApproval.status === 'pending' && currentHostApproval.presentation.denyScope === 'session_pending'"
        class="desktop-host-approval-note">Deny applies to all pending permissions for this agent.</p>
      <p v-else-if="approvalBlocksTurn(currentHostApproval)" class="desktop-host-approval-note">{{ currentHostApproval.presentation.displayName }} is waiting on this request, which can't be answered here. Stopping the turn cancels it.</p>
      <div class="desktop-host-approval-footer">
        <details class="desktop-host-approval-details">
          <summary>Details</summary>
          <div class="desktop-host-approval-details-panel">
            <dl>
              <template v-for="(field, index) in hostApprovalFields(currentHostApproval.presentation)" :key="index">
                <dt>{{ field.label }}</dt>
                <dd><pre>{{ field.value }}</pre></dd>
              </template>
            </dl>
            <p v-if="currentHostApproval.detail">{{ currentHostApproval.detail }}</p>
            <p v-if="currentHostApproval.status === 'uncertain'">Confirmation unavailable. Your decision will not be sent again.</p>
          </div>
        </details>
        <!-- One action group per state, each in this chain, then Always allow.
          Every action here, destructive ones included, is disabled by
          hostApprovalDecisionsDisabled so it waits out the arming hold. The
          row runs right to left: the chain's group sits at the right edge, and
          Always allow takes its own line above when it would not fit beside it. -->
        <div class="desktop-host-approval-decisions">
          <div v-if="currentHostApproval.status === 'pending'" class="desktop-composer-permission-actions">
            <button type="button" class="desktop-composer-permission-deny desktop-host-approval-deny" :disabled="hostApprovalDecisionsDisabled"
              @click="decideRoomHostApproval(currentHostApproval, 'deny')">Deny</button>
            <button type="button" class="desktop-composer-permission-allow desktop-host-approval-allow" :disabled="hostApprovalDecisionsDisabled"
              :title="hostApprovalAllowLabel(currentHostApproval.presentation)"
              @click="decideRoomHostApproval(currentHostApproval, 'allow_once')">{{ hostApprovalBusy === currentHostApproval.id
                ? 'Recording…' : hostApprovalAllowLabel(currentHostApproval.presentation) }}</button>
          </div>
          <div v-else-if="currentHostApproval.status === 'decision_recorded' && currentHostApproval.retryDecision" class="desktop-composer-permission-actions">
            <button type="button" class="desktop-composer-permission-detail" :disabled="hostApprovalDecisionsDisabled"
              @click="decideRoomHostApproval(currentHostApproval, currentHostApproval.retryDecision)">Retry recorded {{ currentHostApproval.retryDecision === 'deny' ? 'denial' : 'approval' }}</button>
          </div>
          <!-- Stop turn sits in Deny's place, never where Allow once is, so a
            habitual click on Allow cannot stop an agent's turn. -->
          <div v-else-if="approvalBlocksTurn(currentHostApproval)" class="desktop-composer-permission-actions desktop-host-approval-stop">
            <button type="button" class="desktop-composer-permission-deny" :disabled="hostApprovalDecisionsDisabled"
              @click="stopAgentTurnFor(currentHostApproval)">Stop turn</button>
          </div>
          <!-- A permanent rule is never left unlabeled, however narrow the tray. -->
          <button v-if="currentHostApproval.status === 'pending' && currentHostApproval.presentation.alwaysAllow" type="button"
            class="desktop-composer-permission-allow desktop-host-approval-always" :disabled="hostApprovalDecisionsDisabled"
            :aria-label="hostApprovalAlwaysAllowLabel(currentHostApproval.presentation) ?? undefined"
            :title="`${hostApprovalAlwaysAllowLabel(currentHostApproval.presentation)}. ${HOST_APPROVAL_ALWAYS_ALLOW_HINT}`"
            @click="decideRoomHostApproval(currentHostApproval, 'allow_always')">{{ hostApprovalAlwaysAllowLabel(currentHostApproval.presentation) }}</button>
        </div>
      </div>
    </section>
    <p v-if="hostApprovalError" class="desktop-composer-permission-error" role="status">
      {{ hostApprovalError }} <button type="button" :disabled="hostApprovalLoading" @click="refreshRoomHostApprovals">Refresh approvals</button>
    </p>
    <div
      v-if="primaryPermissionApproval"
      class="desktop-composer-permission-tray"
      data-testid="desktop-composer-permission-tray"
      aria-live="polite"
    >
      <div class="desktop-composer-permission-main">
        <span class="desktop-composer-permission-dot" aria-hidden="true"></span>
        <div class="desktop-composer-permission-copy">
          <strong>{{ primaryPermissionApproval.displayName }} needs approval</strong>
          <span>
            {{ primaryPermissionApproval.title }}
            <template v-if="permissionOverflowCount > 0">
              / {{ permissionOverflowCount }} more waiting
            </template>
          </span>
        </div>
      </div>
      <p>
        <span>{{ primaryPermissionApproval.providerLabel }}</span>
        <span>{{ primaryPermissionApproval.toolName }}</span>
        <span v-if="primaryPermissionApproval.targetLabel">{{ primaryPermissionApproval.targetLabel }}</span>
      </p>
      <div class="desktop-composer-permission-actions">
        <button
          type="button"
          class="desktop-composer-permission-detail"
          @click="$emit('open-permission-detail', primaryPermissionApproval)"
        >
          Details
        </button>
        <button
          type="button"
          class="desktop-composer-permission-deny"
          :disabled="Boolean(resolvingPermissionIds[primaryPermissionApproval.id])"
          @click="$emit('resolve-permission', primaryPermissionApproval, 'deny')"
        >
          {{ resolvingPermissionIds[primaryPermissionApproval.id] === 'deny' ? "Denying..." : "Deny" }}
        </button>
        <button
          type="button"
          class="desktop-composer-permission-allow"
          :disabled="Boolean(resolvingPermissionIds[primaryPermissionApproval.id])"
          @click="$emit('resolve-permission', primaryPermissionApproval, 'allow')"
        >
          {{ resolvingPermissionIds[primaryPermissionApproval.id] === 'allow' ? "Allowing..." : "Allow" }}
        </button>
      </div>
    </div>
    <div v-if="permissionError" class="desktop-composer-permission-error" role="alert">
      {{ permissionError }}
    </div>
    <div v-if="replyTo" class="desktop-composer-reply" data-testid="desktop-composer-reply">
      <div>
        <strong>{{ replyHeading }}</strong>
        <span>{{ replyPreview(replyTo.isSelection ? replyTo.text : roomMessageVisibleText(replyTo, attentionResponseAgentNames)) }}</span>
      </div>
      <button type="button" @click="$emit('clear-reply')">Cancel</button>
    </div>
    <div class="desktop-composer-input-row">
      <TypingIndicator :label="typing.label.value" />
      <button
        class="desktop-composer-add-agent"
        type="button"
        :disabled="roomLoading || !roomIdentifier"
        :title="roomIdentifier ? 'Add agent to room' : 'Choose a room before adding an agent'"
        :aria-label="roomIdentifier ? 'Add agent to room' : 'Choose a room before adding an agent'"
        data-testid="desktop-composer-add-agent"
        @click="$emit('open-add-agent')"
      >
        <Plus :size="18" aria-hidden="true" />
      </button>
      <textarea
        ref="textareaElement"
        v-model="draft"
        class="desktop-composer-input"
        rows="1"
        :aria-label="composerInputLabel"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="suggestionsOpen"
        aria-controls="desktop-mention-listbox"
        :aria-activedescendant="suggestionsOpen ? `desktop-mention-option-${suggestions[suggestionIndex]?.key}` : undefined"
        :disabled="roomLoading || !roomIdentifier"
        data-testid="desktop-composer-input"
        @input="handleDraftInput"
        @keydown="handleComposerKey"
      />
      <button
        class="desktop-composer-attach"
        type="button"
        :disabled="roomLoading || sending || !roomIdentifier || attaching"
        :title="attaching ? 'Attaching' : 'Attach files'"
        :aria-label="attaching ? 'Attaching files' : 'Attach files'"
        data-testid="desktop-composer-attach"
        @click="$emit('pick-attachments')"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l8.8-8.8a4 4 0 1 1 5.7 5.7l-8.9 8.9a2 2 0 0 1-2.8-2.8l8.1-8.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="sr-only">{{ attaching ? "Attaching files" : "Attach files" }}</span>
      </button>
      <button
        class="desktop-composer-send"
        type="submit"
        :aria-label="sending ? 'Sending message' : 'Send message'"
        :title="sending ? 'Sending message' : 'Send message'"
        :disabled="roomLoading || sending || slash.busy.value || !canSend"
        data-testid="desktop-composer-send"
      >
        <LoaderCircle v-if="sending" :size="16" aria-hidden="true" />
        <ArrowUp v-else :size="17" aria-hidden="true" />
      </button>
    </div>
    <DesktopAttachmentDrafts
      :attachments="attachmentDrafts"
      :pending-attachments="pendingAttachmentDrafts"
      @remove="$emit('remove-attachment', $event)"
    />
    <div
      v-if="suggestionsOpen"
      id="desktop-mention-listbox"
      class="desktop-mention-panel"
      role="listbox"
      :aria-label="slash.open.value ? 'Command suggestions' : 'Mention suggestions'"
      data-testid="desktop-mention-panel"
    >
      <button
        v-for="(candidate, index) in suggestions"
        :key="candidate.key"
        class="desktop-mention-option"
        :id="`desktop-mention-option-${candidate.key}`"
        role="option"
        tabindex="-1"
        :aria-selected="index === suggestionIndex"
        :data-active="index === suggestionIndex"
        :data-testid="`desktop-mention-option-${candidate.key}`"
        type="button"
        @pointerdown.prevent
        @click="selectSuggestion(index)"
      >
        <span>{{ candidate.label }}</span>
        <small>{{ candidate.meta }}</small>
      </button>
      <p v-if="slash.hint.value" role="status">{{ slash.hint.value }}</p>
    </div>
    <div v-if="sendError || attachmentError" class="desktop-composer-footer">
      <p class="desktop-composer-error" data-testid="desktop-composer-error">
        {{ sendError || attachmentError }}
      </p>
    </div>
  </form>
</template>

<script setup lang="ts">
import { injectRoomMessageMotion } from "../../../../../../../../shared/ui/useRoomMessageMotion";
import TypingIndicator from "../../../../../../../../shared/ui/TypingIndicator.vue";
import { useComposerSlashCommands } from "../../../../../../../../shared/ui/useComposerSlashCommands";
import { roomSearchCommandKey } from "../room-shell/useDesktopRoomSearch";
import { desktopIpc } from "../../../../ipc/index.js";
import { useDesktopActionToasts } from "../../../../composables/useDesktopActionToasts";
import { useRoomTyping } from "../../../../composables/useRoomTyping";
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowUp, ChevronLeft, ChevronRight, LoaderCircle, Plus, X } from "@lucide/vue";
import type {
  DesktopManagedAgentPermissionDecisionBehavior,
  DesktopParticipantSummary,
  DesktopStagedAttachment,
} from "../../../../../../electron/ipc-types";
import type { ManagedAgentPermissionApproval } from "../../../../domain/managed-agents";
import type { DesktopHostApproval, HostApprovalSelection } from "../../../../../../shared/host-approvals";
import { HOST_APPROVAL_ALWAYS_ALLOW_HINT, HOST_APPROVAL_ARM_MS, hostApprovalAllowLabel, hostApprovalAlwaysAllowLabel, hostApprovalBlocksTurn, hostApprovalDecisionsArmed, hostApprovalFields, hostApprovalHeading, hostApprovalHistoryCount, hostApprovalHistoryLabel, hostApprovalSummary, hostApprovalTrayOrder } from "./host-approval-presentation";
import { readHostApprovalDismissals, rememberHostApprovalDismissal } from "./host-approval-dismissals";
import { decideHostApproval, hostApprovalIdentity, hostApprovalRoom, refreshHostApprovals } from "./host-approvals";
import { roomMentionCandidates } from "../../../../domain/participants";
import { useDesktopMessageDraft } from "../../../../domain/desktop-message-drafts";
import DesktopAttachmentDrafts, { type PendingAttachmentDraft } from "../DesktopAttachmentDrafts.vue";
import RoomComposerEventChips, { type ComposerEventPreview } from "./RoomComposerEventChips.vue";
import RoomPresenceChips from "./RoomPresenceChips.vue";
import type { PresenceChip } from "../../../../domain/presence-chips";
import { applySelectedTextQuoteToDraft, displaySender, replyPreview } from "./message-format";
import { visibleComposerEventPreviews } from "./composer-event-preview";
import { attentionResponseAgentNamesKey, roomMessageVisibleText } from "../../../../domain/attention-response";
import {
  mentionedCorrectionTarget,
  type AgentCorrectionTarget,
  type ComposerCorrectionHandoff,
} from "../../../../domain/agent-inspector";

export interface RoomComposerReplyTarget {
  id: string;
  sender: string;
  text: string;
  displayText?: string | null;
  source?: string | null;
  isSelection?: boolean;
  sourceMessageId?: string | null;
}

const props = defineProps<{
  attaching: boolean;
  attachmentDrafts: DesktopStagedAttachment[];
  attachmentError: string | null;
  eventPreviews: ComposerEventPreview[];
  messageNamespace?: string;
  participants: DesktopParticipantSummary[];
  presenceChips?: PresenceChip[];
  pendingAttachmentDrafts: PendingAttachmentDraft[];
  permissionApprovals: ManagedAgentPermissionApproval[];
  permissionError: string | null;
  replyTo: RoomComposerReplyTarget | null;
  resolvingPermissionIds: Record<string, DesktopManagedAgentPermissionDecisionBehavior>;
  roomIdentifier: string | null;
  roomLoading: boolean;
  sendError: string | null;
  sending: boolean;
  correctableAgents?: readonly AgentCorrectionTarget[];
}>();

const emit = defineEmits<{
  "clear-reply": [];
  "pick-attachments": [];
  "open-add-agent": [];
  "open-permission-detail": [approval: ManagedAgentPermissionApproval];
  "remove-attachment": [uploadId: string];
  "resolve-permission": [
    approval: ManagedAgentPermissionApproval,
    behavior: DesktopManagedAgentPermissionDecisionBehavior,
  ];
  "send-message": [text: string, replyTo: string | null, attachments: Array<{ upload_id: string }>, complete: (sent: boolean) => void];
  "open-event-preview": [event: ComposerEventPreview];
  "dismiss-event-preview": [messageId: string];
  "stop-agent-turn": [agentId: string, approvalId: string];
  "open-agent-correction": [handoff: ComposerCorrectionHandoff, opened: (opened: boolean) => void];
}>();

const maxComposerInputHeight = 156;
const { text: draft, captureSubmittedDraft } = useDesktopMessageDraft(() => props.messageNamespace || props.roomIdentifier);
const typing = useRoomTyping(computed(() => props.roomIdentifier ?? ""));
watch(draft, value => { if (!value) typing.stop(); });
const textareaElement = ref<HTMLTextAreaElement | null>(null);
const attentionResponseAgentNames = inject(attentionResponseAgentNamesKey, null);
const visibleEventPreviews = computed(() => [...visibleComposerEventPreviews(props.eventPreviews, {
  draft: draft.value,
  attachmentCount: props.attachmentDrafts.length + props.pendingAttachmentDrafts.length,
  replying: Boolean(props.replyTo),
})]);
const mentionQuery = ref<string | null>(null);
const activeMentionIndex = ref(0);
// Approvals are shared with the Inbox; card visibility stays local to this composer.
const approvalRoom = computed(() => hostApprovalRoom(props.roomIdentifier));
const hostApprovals = computed(() => approvalRoom.value.approvals);
const hostApprovalError = computed(() => approvalRoom.value.error);
const hostApprovalBusy = computed(() => approvalRoom.value.busy);
const hostApprovalLoading = computed(() => approvalRoom.value.loading);
const dismissedHostApprovalIds = ref(new Set<string>());
const rememberedHostApprovalDismissals = ref(readHostApprovalDismissals());
const showApprovalHistory = ref(false);
let approvalTimer: ReturnType<typeof setInterval> | null = null;
// Moves with the approval refresh, so a request's grace can end without new data.
const approvalNowMs = ref(Date.now());

const unresolvedHostApprovals = computed(() => hostApprovals.value.filter(approval =>
  (approval.status === "pending" || approval.status === "decision_recorded"
    || approval.status === "unavailable" || approval.status === "uncertain")
  && !dismissedHostApprovalIds.value.has(approval.id)
  && !(approval.dismissKey && rememberedHostApprovalDismissals.value.has(approval.dismissKey))));
const unanswerableApprovalCount = computed(() => hostApprovalHistoryCount(unresolvedHostApprovals.value));
function approvalBlocksTurn(approval: DesktopHostApproval): boolean {
  return hostApprovalBlocksTurn(approval, approvalRoom.value.firstSeenAt[hostApprovalIdentity(approval)], approvalNowMs.value);
}
// A request its agent is still waiting on stays in view, even when it cannot be decided here.
const visibleHostApprovals = computed(() => unresolvedHostApprovals.value.filter(approval =>
  showApprovalHistory.value || approval.status === "pending" || approval.status === "decision_recorded"
  || approvalBlocksTurn(approval)));

// An undecidable record stays dismissed across restarts until its status
// changes. A live request is dismissed only for this session.
function dismissHostApproval(id: string): void {
  if (!decisionsArmed.value) return;
  const dismissKey = hostApprovals.value.find(approval => approval.id === id)?.dismissKey;
  if (dismissKey) {
    rememberedHostApprovalDismissals.value = rememberHostApprovalDismissal(rememberedHostApprovalDismissals.value, dismissKey);
  } else {
    dismissedHostApprovalIds.value = new Set([...dismissedHostApprovalIds.value, id]);
  }
}

function refreshRoomHostApprovals(): Promise<void> {
  return props.roomIdentifier ? refreshHostApprovals(props.roomIdentifier) : Promise.resolve();
}

// The tray shows one request. Requests keep the order this composer first
// listed them, and a new one joins the end, so an arrival never replaces or
// moves the request being decided. A re-presented request keeps its place.
// Requests that can still be answered lead; unavailable ones follow.
const trayOrder = ref<string[]>([]);
const currentApprovalKey = ref<string | null>(null);
// When the visible card appeared, and the clock its decisions arm on. The clock
// moves to the arm time itself, so a timer that fires a millisecond early still arms.
const cardShownAtMs = ref(0);
const decisionClockMs = ref(0);
let decisionTimer: ReturnType<typeof setTimeout> | null = null;
const decisionsArmed = computed(() => hostApprovalDecisionsArmed(cardShownAtMs.value, decisionClockMs.value));
const trayApprovals = computed(() => {
  const byKey = new Map<string, DesktopHostApproval>();
  for (const approval of visibleHostApprovals.value) {
    const key = hostApprovalIdentity(approval);
    if (!byKey.has(key)) byKey.set(key, approval);
  }
  return trayOrder.value.flatMap(key => byKey.get(key) ?? []);
});
const currentHostApproval = computed(() => trayApprovals.value.find(approval =>
  hostApprovalIdentity(approval) === currentApprovalKey.value) ?? trayApprovals.value[0] ?? null);
const currentApprovalIndex = computed(() => currentHostApproval.value ? trayApprovals.value.indexOf(currentHostApproval.value) : -1);
const hostApprovalDecisionsDisabled = computed(() => hostApprovalBusy.value !== null || hostApprovalError.value !== null || !decisionsArmed.value);

watch(visibleHostApprovals, (approvals) => {
  const keys = [...new Set(approvals.map(hostApprovalIdentity))];
  const previous = trayOrder.value;
  const listed = [...previous.filter(key => keys.includes(key)), ...keys.filter(key => !previous.includes(key))];
  // The stored order is the order shown, so "takes its place" below follows the stack.
  const order = hostApprovalTrayOrder(listed.map(key => approvals.find(approval => hostApprovalIdentity(approval) === key)!))
    .map(hostApprovalIdentity);
  const current = currentApprovalKey.value;
  if (!current || !order.includes(current)) {
    // The request on screen was decided, withdrawn or hidden, or the tray just
    // appeared: show the one that takes its place, under a pointer aimed at
    // the old one. The watch below holds its decisions until they arm.
    const index = current ? previous.indexOf(current) : -1;
    const position = index < 0 ? 0 : previous.slice(0, index).filter(key => order.includes(key)).length;
    currentApprovalKey.value = order[position] ?? order[position - 1] ?? null;
  }
  trayOrder.value = order;
}, { immediate: true });

function showApprovalAt(index: number): void {
  const approval = trayApprovals.value[index];
  if (approval) currentApprovalKey.value = hostApprovalIdentity(approval);
}

/** Start the hold for the card now on screen. Its decisions arm when the hold ends. */
function holdCardDecisions(): void {
  const shownAtMs = Date.now();
  cardShownAtMs.value = shownAtMs;
  decisionClockMs.value = shownAtMs;
  if (decisionTimer) clearTimeout(decisionTimer);
  decisionTimer = setTimeout(() => {
    decisionTimer = null;
    decisionClockMs.value = shownAtMs + HOST_APPROVAL_ARM_MS;
  }, HOST_APPROVAL_ARM_MS);
}

// Every request that becomes the visible card holds first: when it mounts, and
// when Previous, Next, a decision or a withdrawal shows a different request.
watch(() => currentHostApproval.value ? hostApprovalIdentity(currentHostApproval.value) : null, (key) => {
  if (key) holdCardDecisions();
}, { immediate: true });

/** The room checks the request again before it stops anything. */
function stopAgentTurnFor(approval: DesktopHostApproval): void {
  if (!decisionsArmed.value) return;
  emit("stop-agent-turn", approval.presentation.agentId, approval.id);
}

function decideRoomHostApproval(approval: DesktopHostApproval, decision: HostApprovalSelection): Promise<void> {
  if (!props.roomIdentifier || !decisionsArmed.value) return Promise.resolve();
  return decideHostApproval(props.roomIdentifier, approval.id, decision);
}

watch(hostApprovals, (approvals) => {
  const present = new Set(approvals.map(approval => approval.id));
  dismissedHostApprovalIds.value = new Set([...dismissedHostApprovalIds.value].filter(id => present.has(id)));
});

const canSend = computed(() =>
  Boolean(!props.roomLoading && props.roomIdentifier && (draft.value.trim() || props.attachmentDrafts.length > 0))
);
// A correction is plain text for one agent's private session, so a reply,
// a quote or attachments keep the message a room message.
const correctionOffer = computed(() =>
  props.correctableAgents?.length && !props.replyTo
    && props.attachmentDrafts.length === 0 && props.pendingAttachmentDrafts.length === 0
    ? mentionedCorrectionTarget(draft.value, props.correctableAgents)
    : null);
const primaryPermissionApproval = computed(() => props.permissionApprovals[0] ?? null);
const permissionOverflowCount = computed(() => Math.max(0, props.permissionApprovals.length - 1));
const composerInputLabel = computed(() => {
  if (props.roomLoading) return "Room messages are loading";
  return props.roomIdentifier ? "Message room" : "Choose a room before writing";
});
const replyHeading = computed(() => {
  const target = props.replyTo;
  if (!target) return "";
  const sender = displaySender(target.sender);
  return target.isSelection ? `Quoting selection from ${sender}` : `Replying to ${sender}`;
});
const mentionOpen = computed({
  get: () => mentionQuery.value !== null && mentionCandidates.value.length > 0,
  set: (value: boolean) => {
    if (!value) mentionQuery.value = null;
  },
});
const mentionCandidates = computed(() => {
  return roomMentionCandidates(props.participants, mentionQuery.value);
});

const openRoomSearch = inject(roomSearchCommandKey, null);
const { pushActionToast } = useDesktopActionToasts();
const slash = useComposerSlashCommands({
  text: draft,
  platform: "desktop",
  scope: () => props.messageNamespace || props.roomIdentifier,
  hasAttachments: () => props.attaching || props.attachmentDrafts.length > 0 || props.pendingAttachmentDrafts.length > 0,
  isReply: () => Boolean(props.replyTo),
  focus: () => { void nextTick(() => textareaElement.value?.focus()); },
  onError: () => pushActionToast("Command could not be completed. Your draft is still here.", "error"),
  run: async (command, argument) => {
    if (!props.roomIdentifier) return false;
    if (command.name === "task") {
      await desktopIpc.room.addTask(props.roomIdentifier, { title: argument, description: null });
      pushActionToast("Task created", "success");
    } else if (command.name === "search") {
      if (!openRoomSearch) throw new Error("Room search is unavailable");
      openRoomSearch(argument);
    } else {
      emit("open-add-agent");
    }
    return true;
  },
});
const suggestionsOpen = computed(() => slash.open.value || mentionOpen.value);
const suggestions = computed(() => slash.open.value ? slash.candidates.value : mentionCandidates.value.map(candidate => ({
  key: candidate.participantKey, label: candidate.displayName, meta: candidate.label,
})));
const suggestionIndex = computed(() => slash.open.value ? slash.activeIndex.value : activeMentionIndex.value);
function selectSuggestion(index: number): void {
  if (slash.open.value) slash.complete(index);
  else {
    const candidate = mentionCandidates.value[index];
    if (candidate) insertMention(candidate.insertText);
  }
}

watch(
  () => props.roomIdentifier,
  () => {
    dismissedHostApprovalIds.value = new Set();
    showApprovalHistory.value = false;
    void refreshRoomHostApprovals();
    mentionQuery.value = null;
    void nextTick(syncTextareaHeight);
  },
);

watch(
  () => props.replyTo,
  (message) => {
    if (message) {
      void nextTick(() => textareaElement.value?.focus());
    }
  },
);

watch(
  draft,
  () => {
    void nextTick(syncTextareaHeight);
  },
  { flush: "post" },
);

onMounted(() => {
  void refreshRoomHostApprovals();
  approvalTimer = setInterval(() => { approvalNowMs.value = Date.now(); void refreshRoomHostApprovals(); }, 3_000);
  void nextTick(syncTextareaHeight);
});

onBeforeUnmount(() => {
  if (approvalTimer) clearInterval(approvalTimer);
  if (decisionTimer) clearTimeout(decisionTimer);
});

async function submitMessage(): Promise<void> {
  if (!canSend.value || props.sending) return;
  await slash.submit(sendRoomMessage);
}

const messageMotion = injectRoomMessageMotion();

function sendRoomMessage(): void {
  const text = draft.value.trim();
  if ((!text && props.attachmentDrafts.length === 0) || props.sending) return;
  const replyTarget = props.replyTo;
  const messageText = replyTarget?.isSelection
    ? applySelectedTextQuoteToDraft(text, replyTarget.text, replyTarget.sourceMessageId)
    : text;
  const clearSubmittedText = captureSubmittedDraft();
  const finishMotion = messageMotion?.capture(messageText, textareaElement.value);
  emit(
    "send-message",
    messageText,
    replyTarget?.isSelection ? null : replyTarget?.id || null,
    props.attachmentDrafts.map((attachment) => ({ upload_id: attachment.uploadId })),
    (sent) => {
      void nextTick(() => finishMotion?.());
      if (!sent) return;
      typing.stop();
      clearSubmittedText();
      void nextTick(() => textareaElement.value?.focus());
    },
  );
}

/** Hand the draft to the Inspector's correction box; it leaves the composer only once that opened. */
function sendAsCorrection(): void {
  const offer = correctionOffer.value;
  if (!offer || props.sending) return;
  const handedOver = draft.value;
  const handoff = {
    entryId: offer.target.entryId,
    text: offer.text,
    draft: handedOver,
    draftNamespace: props.messageNamespace || props.roomIdentifier,
  };
  emit("open-agent-correction", handoff, (opened) => {
    // Opening may have restored an earlier, abandoned hand-over; keep that.
    if (opened) draft.value = draft.value.replace(handedOver, "").trim();
  });
}

function insertNewlineAtCursor(): void {
  const input = textareaElement.value;
  if (!input) {
    draft.value = `${draft.value}\n`;
    return;
  }
  const start = input.selectionStart ?? draft.value.length;
  const end = input.selectionEnd ?? draft.value.length;
  draft.value = `${draft.value.slice(0, start)}\n${draft.value.slice(end)}`;
  void nextTick(() => {
    input.selectionStart = start + 1;
    input.selectionEnd = start + 1;
  });
}

function handleComposerKey(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (slash.handleKey(event)) {
    mentionOpen.value = false;
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    moveMentionSelection(event, event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Tab" || event.key === "Escape") {
    mentionOpen.value = false;
  } else if (event.key === "Enter") handleEnterKey(event);
}

function handleEnterKey(event: KeyboardEvent): void {
  if (event.isComposing) return;
  event.preventDefault();
  if (!slash.open.value && mentionOpen.value) {
    const candidate = mentionCandidates.value[activeMentionIndex.value];
    if (candidate) insertMention(candidate.insertText);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey) {
    insertNewlineAtCursor();
    return;
  }
  submitMessage();
}

function syncMentionQuery(): void {
  const match = /(^|\s)@([A-Za-z0-9._:-]*(?:\/[A-Za-z0-9._-]*)*)$/.exec(draft.value);
  mentionQuery.value = match ? match[2] : null;
  activeMentionIndex.value = 0;
}

function handleDraftInput(): void {
  typing.input(Boolean(draft.value.trim()) && !slash.open.value);
  if (slash.open.value) mentionQuery.value = null;
  else syncMentionQuery();
}

function moveMentionSelection(event: KeyboardEvent, delta: number): void {
  if (!mentionOpen.value) return;
  event.preventDefault();
  const count = mentionCandidates.value.length;
  if (!count) return;
  activeMentionIndex.value = (activeMentionIndex.value + delta + count) % count;
}

function insertMention(mentionText: string): void {
  draft.value = draft.value.replace(/(^|\s)@([A-Za-z0-9._:-]*(?:\/[A-Za-z0-9._-]*)*)$/, `$1@${mentionText} `);
  mentionQuery.value = null;
  void nextTick(() => textareaElement.value?.focus());
}

/** Canonical entry point for non-composer surfaces such as the Agent Inspector. */
function focusWithMention(mentionText: string): void {
  const separator = draft.value && !/\s$/.test(draft.value) ? " " : "";
  draft.value = `${draft.value}${separator}@${mentionText} `;
  mentionQuery.value = null;
  void nextTick(() => {
    syncTextareaHeight();
    const input = textareaElement.value;
    input?.focus();
    input?.setSelectionRange(draft.value.length, draft.value.length);
  });
}

function syncTextareaHeight(): void {
  const input = textareaElement.value;
  if (!input) return;
  input.style.height = "auto";
  const nextHeight = Math.min(input.scrollHeight, maxComposerInputHeight);
  input.style.height = `${Math.max(nextHeight, 34)}px`;
  input.style.overflowY = input.scrollHeight > maxComposerInputHeight ? "auto" : "hidden";
}

function openEventPreview(event: ComposerEventPreview): void {
  emit("open-event-preview", event);
}

defineExpose({ focusWithMention });
</script>
