<template>
  <!-- One quiet line above the composer, one pill at a time. It floats over the
    messages, so nothing it shows ever moves the input. -->
  <div
    ref="root"
    class="room-activity-line"
    tabindex="-1"
    data-testid="room-activity-line"
    @pointerenter="hold(true)"
    @pointerleave="hold(false)"
    @focusin="hold(true)"
    @focusout="onFocusOut"
    @keydown.esc="expanded = false"
  >
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ announcement }}</span>
    <div
      v-if="listOpen"
      class="room-activity-list"
      data-testid="room-activity-list"
    >
      <div
        v-for="work in listWork"
        :key="work.id"
        class="room-activity-row"
        :data-motion-work="work.awaitingRoomTurn ? undefined : ''"
        :data-motion-session="work.agentSessionId"
        :data-motion-agent="work.agentKey"
        :data-motion-after="work.sourceMessageId"
        :data-waiting="work.waiting || undefined"
        :data-remote="work.remote || undefined"
        role="group"
        :aria-label="`${work.displayName}: ${work.summary}`"
        data-testid="room-local-agent-work"
      >
        <!-- The reply's flight reads these class names (room-message-motion.ts captureWork). -->
        <span class="room-activity-pulse"><ActivityOrb :state="orbStateForWork(work)" /></span>
        <span class="room-activity-row-copy room-activity-copy"><strong>{{ work.displayName }}</strong><span data-testid="room-local-agent-work-echo">{{ work.summary }}</span></span>
        <!-- A row that waits to try again carries its due time, not a start: it shows no elapsed time. -->
        <span class="room-activity-row-time">{{ work.waiting ? "" : elapsedLabel(work.startedAt, now) }}</span>
        <span class="room-activity-row-actions">
          <button
            v-if="work.waitsForBackgroundWork"
            type="button"
            class="room-activity-row-button"
            title="Post the answer that the agent has now. A command in the background keeps running. A sub-agent that still runs is stopped. No later result is posted."
            data-testid="room-local-agent-work-post-now"
            @click="emit('post-agent-answer-now', work.id, work.sourceMessageId ?? null)"
          >Post answer now</button>
          <!-- Another member's agent, known from room presence only: this desktop has no live stream to open. -->
          <button
            v-if="!work.remote"
            type="button"
            class="room-activity-row-button"
            :aria-label="`Open live activity for ${work.displayName}`"
            data-testid="room-local-agent-work-open"
            @click="openWork(work)"
          >Open</button>
        </span>
      </div>
    </div>
    <!-- Each pill is keyed: a new one mounts and slides in; the same one updates in place. -->
      <div
        v-if="pill?.kind === 'steer'"
        :key="`steer:${pill.offer.entryId}`"
        class="room-activity-pill"
        data-kind="steer"
        data-testid="room-activity-steer"
      >
        <ActivityOrb state="breathing" />
        <span class="room-activity-text"><strong>{{ pill.offer.displayName }}</strong> is mid-turn · your message waits</span>
        <button
          type="button"
          class="room-activity-action"
          :disabled="steerDisabled"
          data-testid="desktop-composer-steer"
          @click="emit('steer')"
        >Steer</button>
      </div>
      <div
        v-else-if="pill?.kind === 'notice' && pill.notice.kind === 'join'"
        :key="pill.notice.id"
        class="room-activity-pill"
        data-kind="join"
        data-testid="room-activity-notice"
      >
        <span class="room-activity-badges">
          <template v-for="agent in pill.notice.agents.slice(0, 3)" :key="agent.key">
            <ProviderBadge v-if="agent.ideLabel" :label="agent.ideLabel" :agent-key="agent.agentKey" />
            <span v-else class="room-activity-dot" aria-hidden="true"></span>
          </template>
        </span>
        <span class="room-activity-text"><strong>{{ joinedNames(pill.notice.agents) }}</strong> joined</span>
        <span v-if="pill.notice.agents.length === 1 && pill.notice.agents[0]!.ideLabel" class="room-activity-meta">{{ pill.notice.agents[0]!.ideLabel }}</span>
      </div>
      <div
        v-else-if="pill?.kind === 'notice' && pill.notice.kind === 'leave'"
        :key="pill.notice.id"
        class="room-activity-pill"
        data-kind="leave"
        data-tone="muted"
        data-testid="room-activity-notice"
      >
        <ProviderBadge v-if="pill.notice.agent.ideLabel" :label="pill.notice.agent.ideLabel" :agent-key="pill.notice.agent.agentKey" />
        <span v-else class="room-activity-dot" aria-hidden="true"></span>
        <span class="room-activity-text"><strong>{{ pill.notice.agent.displayName }}</strong> left</span>
      </div>
      <div
        v-else-if="pill?.kind === 'notice' && pill.notice.kind === 'github'"
        :key="pill.notice.id"
        class="room-activity-pill"
        data-kind="github"
        :data-tone="pill.notice.preview.tone"
        data-testid="room-activity-notice"
      >
        <span v-if="pill.notice.preview.kind === 'check'" class="room-activity-status" :data-tone="pill.notice.preview.tone" aria-hidden="true"></span>
        <span v-else class="room-activity-icon" aria-hidden="true">
          <GitPullRequest v-if="pill.notice.preview.kind === 'pull-request'" :size="14" />
          <MessageSquare v-else-if="pill.notice.preview.kind === 'review' || pill.notice.preview.kind === 'comment'" :size="14" />
          <GitBranch v-else :size="14" />
        </span>
        <span class="room-activity-text" :title="pill.notice.preview.headline"><strong>{{ pill.notice.preview.headline }}</strong></span>
        <span v-if="pill.notice.preview.stats" class="room-activity-meta" aria-label="Code changes">
          <span class="room-activity-added">+{{ pill.notice.preview.stats.additions }}</span>
          <span class="room-activity-deleted">−{{ pill.notice.preview.stats.deletions }}</span>
        </span>
        <button type="button" class="room-activity-action" data-testid="room-activity-notice-open"
          @click="emit('open-event-preview', pill.notice.preview)">{{ pill.notice.preview.kind === 'check' ? 'Details' : 'View' }}</button>
      </div>
      <div
        v-else-if="pill?.kind === 'notice' && pill.notice.kind === 'steered'"
        :key="pill.notice.id"
        class="room-activity-pill"
        data-kind="steered"
        data-tone="muted"
        data-testid="room-activity-notice"
      >
        <span class="room-activity-icon" aria-hidden="true"><Check :size="14" /></span>
        <span class="room-activity-text">Steering <strong>{{ pill.notice.displayName }}</strong>'s current turn</span>
      </div>
      <button
        v-else-if="pill?.kind === 'live'"
        key="live"
        type="button"
        class="room-activity-pill"
        data-kind="live"
        :aria-expanded="expanded"
        :aria-label="liveLabel"
        :data-motion-work="single && !single.awaitingRoomTurn && !listOpen ? '' : undefined"
        :data-motion-session="single?.agentSessionId"
        :data-motion-agent="single?.agentKey"
        :data-motion-after="single?.sourceMessageId"
        :data-waiting="single?.waiting || undefined"
        data-testid="room-activity-live"
        @click="expanded = !expanded"
      >
        <span class="room-activity-pulse"><ActivityOrb :state="single ? orbStateForWork(single) : 'working'" /></span>
        <span v-if="single" class="room-activity-text room-activity-copy">
          <strong>{{ single.displayName }}</strong> <span class="room-activity-shimmer" data-testid="room-activity-live-echo">{{ single.summary }}</span>
        </span>
        <span v-else class="room-activity-text">
          <strong>{{ pill.work.length }} agents</strong> <span class="room-activity-shimmer">are working</span>
        </span>
        <ChevronUp class="room-activity-caret" :size="13" aria-hidden="true" />
        <!-- Each agent's reply flies out of the line, so every agent has an anchor here, even when they are counted. -->
        <!-- While the list is open, its rows are the anchors: one per agent, so the flight finds it. -->
        <template v-if="!single && !listOpen">
          <span
            v-for="work in pill.work"
            :key="work.id"
            class="room-activity-anchor"
            :data-motion-work="work.awaitingRoomTurn ? undefined : ''"
            :data-motion-session="work.agentSessionId"
            :data-motion-agent="work.agentKey"
            :data-motion-after="work.sourceMessageId"
            aria-hidden="true"
          ><span class="room-activity-pulse"></span><strong></strong><span class="room-activity-copy"><span></span></span></span>
        </template>
      </button>
      <div
        v-else-if="pill?.kind === 'typing'"
        key="typing"
        class="room-activity-pill"
        data-kind="typing"
        data-tone="muted"
        data-testid="room-activity-typing"
      >
        <span class="room-activity-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="room-activity-text">
          <template v-for="(part, index) in typingSentence(pill.names)" :key="index">
            <strong v-if="part.name">{{ part.text }}</strong>
            <template v-else>{{ part.text }}</template>
          </template>
          <template v-if="!typingSentence(pill.names).length">{{ typingLabel(pill.names) }}</template>
        </span>
      </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Check, ChevronUp, GitBranch, GitPullRequest, MessageSquare } from "@lucide/vue";
import { typingLabel, typingSentence } from "../../../../../../../../shared/room-typing.mjs";
import type { ManagedAgentWorkIndicator } from "../../../../domain/managed-agents";
import ProviderBadge from "../desktop-chat-message/ProviderBadge.vue";
import ActivityOrb from "./ActivityOrb.vue";
import { orbStateForWork } from "../../../../domain/activity-orb-state";
import type { ComposerEventPreview } from "./composer-event-preview";
import { elapsedLabel, joinedNames, pickActivityPill, type ActivityNotice, type ActivitySteerOffer } from "./room-activity";

const props = defineProps<{
  notice: ActivityNotice | null;
  steer: ActivitySteerOffer | null;
  steerDisabled?: boolean;
  work: readonly ManagedAgentWorkIndicator[];
  typingNames: readonly string[];
}>();

const emit = defineEmits<{
  steer: [];
  hold: [held: boolean];
  "open-agent": [work: ManagedAgentWorkIndicator];
  "open-event-preview": [preview: ComposerEventPreview];
  "post-agent-answer-now": [agentId: string, sourceMessageId: string | null];
}>();

const root = ref<HTMLElement | null>(null);
const expanded = ref(false);
const pill = computed(() => pickActivityPill({ steer: props.steer, notice: props.notice, work: props.work, typing: props.typingNames }));
const single = computed(() => pill.value?.kind === "live" && pill.value.work.length === 1 ? pill.value.work[0]! : null);
const listOpen = computed(() => expanded.value && pill.value?.kind === "live");
const listWork = computed(() => listOpen.value && pill.value?.kind === "live" ? pill.value.work : []);
const liveLabel = computed(() => {
  if (pill.value?.kind !== "live") return "";
  const head = single.value ? `${single.value.displayName}: ${single.value.summary}` : `${pill.value.work.length} agents are working`;
  return `${head}. ${expanded.value ? "Hide" : "Show"} who is working`;
});

/** Notices and the Steer offer are announced; live work changes too often to read out. */
const announcement = computed(() => {
  const current = pill.value;
  if (current?.kind === "steer") return `${current.offer.displayName} is mid-turn. Your message waits. Steer is available.`;
  if (current?.kind !== "notice") return current?.kind === "typing" ? typingLabel(current.names) : "";
  const notice = current.notice;
  if (notice.kind === "join") return `${joinedNames(notice.agents)} joined`;
  if (notice.kind === "leave") return `${notice.agent.displayName} left`;
  if (notice.kind === "github") return notice.preview.headline;
  return `Steering ${notice.displayName}'s current turn`;
});

// Elapsed times move only while the list is open.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
watch(listOpen, (open) => {
  if (ticker) clearInterval(ticker);
  ticker = null;
  if (!open) return;
  now.value = Date.now();
  ticker = setInterval(() => { now.value = Date.now(); }, 1_000);
});
watch(() => pill.value?.kind, (kind) => { if (kind !== "live") expanded.value = false; });

// A focused control that leaves with its pill fires no focusout: let the queue run again,
// and keep the keyboard on the line instead of dropping it to the page.
const pillKey = computed(() => {
  const current = pill.value;
  if (!current) return "";
  return current.kind === "notice" ? current.notice.id : current.kind === "steer" ? `steer:${current.offer.entryId}` : current.kind;
});
watch(pillKey, () => {
  void nextTick(() => {
    if (!held || typeof document === "undefined" || !root.value) return;
    const active = document.activeElement;
    if (active && root.value.contains(active)) return;
    if (!active || active === document.body) root.value.focus({ preventScroll: true });
    hold(false);
  });
});

// The open list closes on a click anywhere else.
function onDocumentPointerDown(event: PointerEvent): void {
  if (root.value && event.target instanceof Node && !root.value.contains(event.target)) expanded.value = false;
}
watch(listOpen, (open) => {
  if (typeof document === "undefined") return;
  if (open) document.addEventListener("pointerdown", onDocumentPointerDown, true);
  else document.removeEventListener("pointerdown", onDocumentPointerDown, true);
});

let held = false;
function hold(next: boolean): void {
  if (held === next) return;
  held = next;
  emit("hold", next);
}
function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (!(next instanceof Node) || !root.value?.contains(next)) hold(false);
}

function openWork(work: ManagedAgentWorkIndicator): void {
  expanded.value = false;
  emit("open-agent", work);
}

onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker);
  if (typeof document !== "undefined") document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  if (held) emit("hold", false);
});
</script>
