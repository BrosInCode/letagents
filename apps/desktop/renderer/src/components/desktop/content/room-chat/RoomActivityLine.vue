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
      ref="listElement"
      class="room-activity-list"
      :data-commands="listCommandCount > 0 || undefined"
      data-testid="room-activity-list"
    >
      <template v-for="work in listWork" :key="work.id">
      <div
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
      <!-- Commands this agent runs in the background, under its own row. -->
      <RoomActivityCommandRow
        v-for="command in commandsOf(work.id)"
        :key="`${work.id}:${command.taskId}`"
        :command="command" :agent-name="null" nested :row-key="commandKey(work.id, command.taskId)"
        :open="openCommands.has(commandKey(work.id, command.taskId))"
        :output="backgroundOutput.output(work.id, command.taskId)"
        :stop-state="stopStates.get(commandKey(work.id, command.taskId)) ?? 'idle'"
        :now="now"
        @toggle="toggleCommand(work.id, command.taskId)"
        @stop="stopCommand(work.id, command)"
        @open="openCommand(work.id, command.taskId)"
      />
      </template>
      <!-- Commands of agents that are not working now: the agent has replied, and its server still runs. -->
      <template v-for="agent in restingBackground" :key="`background:${agent.entryId}`">
        <RoomActivityCommandRow
          v-for="command in agent.commands"
          :key="`${agent.entryId}:${command.taskId}`"
          :command="command" :agent-name="agent.displayName" :nested="false" :row-key="commandKey(agent.entryId, command.taskId)"
          :open="openCommands.has(commandKey(agent.entryId, command.taskId))"
          :output="backgroundOutput.output(agent.entryId, command.taskId)"
          :stop-state="stopStates.get(commandKey(agent.entryId, command.taskId)) ?? 'idle'"
          :now="now"
          @toggle="toggleCommand(agent.entryId, command.taskId)"
          @stop="stopCommand(agent.entryId, command)"
          @open="openCommand(agent.entryId, command.taskId)"
        />
      </template>
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
      <div
        v-else-if="pill?.kind === 'notice' && pill.notice.kind === 'calm'"
        :key="pill.notice.id"
        class="room-activity-pill"
        data-kind="calm"
        :data-tone="pill.notice.action ? undefined : 'muted'"
        data-testid="room-activity-calm"
      >
        <span class="room-activity-icon" aria-hidden="true">
          <Paperclip v-if="pill.notice.icon === 'attach'" :size="14" />
          <Check v-else :size="14" />
        </span>
        <span class="room-activity-text" :title="calmNoticeText(pill.notice)">{{ pill.notice.lead }}<strong v-if="pill.notice.name">{{ pill.notice.name }}</strong>{{ pill.notice.tail ?? "" }}</span>
        <button
          v-if="pill.notice.action"
          type="button"
          class="room-activity-action"
          data-testid="room-activity-calm-action"
          @click="emit('calm-action', pill.notice.action.key)"
        >{{ pill.notice.action.label }}</button>
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
        <span v-if="backgroundCount" class="room-activity-meta" data-testid="room-activity-live-background">· {{ backgroundCount }} in the background</span>
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
      <!-- No agent works, but a command one of them started still runs: a quiet pill until it ends. -->
      <button
        v-else-if="pill?.kind === 'background'"
        key="background"
        type="button"
        class="room-activity-pill"
        data-kind="background"
        data-tone="muted"
        :aria-expanded="expanded"
        :aria-label="backgroundLabel"
        data-testid="room-activity-background"
        @click="expanded = !expanded"
      >
        <span class="room-activity-icon room-activity-command-icon" aria-hidden="true"><SquareTerminal :size="14" :stroke-width="1.6" /></span>
        <span v-if="pill.agents.length === 1 && pill.agents[0]!.commands.length === 1" class="room-activity-text">
          <strong>{{ pill.agents[0]!.displayName }}</strong> <code>{{ pill.agents[0]!.commands[0]!.command }}</code> runs in the background
        </span>
        <span v-else-if="pill.agents.length === 1" class="room-activity-text">
          <strong>{{ pill.agents[0]!.displayName }}</strong> runs {{ pill.agents[0]!.commands.length }} commands in the background
        </span>
        <span v-else class="room-activity-text"><strong>{{ backgroundCount }} commands</strong> run in the background</span>
        <ChevronUp class="room-activity-caret" :size="13" aria-hidden="true" />
      </button>
      <div
        v-else-if="pill?.kind === 'stopped'"
        :key="`stopped:${pill.at}`"
        class="room-activity-pill"
        data-kind="calm"
        data-tone="muted"
        data-testid="room-activity-background-stopped"
      >
        <span class="room-activity-icon" aria-hidden="true"><Check :size="14" /></span>
        <span class="room-activity-text">Stopped <code>{{ pill.command }}</code> for <strong>{{ pill.agent }}</strong></span>
      </div>
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
import { Check, ChevronUp, GitBranch, GitPullRequest, MessageSquare, Paperclip, SquareTerminal } from "@lucide/vue";
import type { DesktopBackgroundCommand } from "../../../../../../electron/ipc-types";
import RoomActivityCommandRow from "./RoomActivityCommandRow.vue";
import { closeCommandOutput, openCommandOutput, settleCommandMotion } from "./room-activity-motion";
import { useBackgroundCommandOutput, useBackgroundCommands, type RoomBackgroundAgent } from "../../../../composables/useBackgroundCommands";
import { typingLabel, typingSentence } from "../../../../../../../../shared/room-typing.mjs";
import type { ManagedAgentWorkIndicator } from "../../../../domain/managed-agents";
import ActivityOrb from "../../../../../../../../shared/ui/ActivityOrb.vue";
import { orbStateForWork } from "../../../../domain/activity-orb-state";
import type { ComposerEventPreview } from "./composer-event-preview";
import { calmNoticeText, elapsedLabel, pickActivityPill, type ActivityNotice, type ActivitySteerOffer, type CalmNoticeActionKey } from "./room-activity";

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
  "calm-action": [key: CalmNoticeActionKey];
}>();

const root = ref<HTMLElement | null>(null);
const expanded = ref(false);
const backgroundCommands = useBackgroundCommands();
const backgroundAgents = computed<readonly RoomBackgroundAgent[]>(() => backgroundCommands?.agents.value ?? []);
const backgroundCount = computed(() => backgroundAgents.value.reduce((count, agent) => count + agent.commands.length, 0));
/** One quiet line after the owner stopped a command, when nothing else is shown and no other command runs. */
const stoppedNotice = ref<{ command: string; agent: string; at: number } | null>(null);
type LinePill = ReturnType<typeof pickActivityPill<ManagedAgentWorkIndicator>>
  | { kind: "background"; agents: readonly RoomBackgroundAgent[] }
  | { kind: "stopped"; command: string; agent: string; at: number };
// Background commands rank last: a running server is the quietest thing an agent does. The line says that a
// command was stopped only when no other command is left to show.
const pill = computed<LinePill>(() => {
  const base = pickActivityPill({ steer: props.steer, notice: props.notice, work: props.work, typing: props.typingNames });
  const background = backgroundAgents.value.length ? { kind: "background" as const, agents: backgroundAgents.value } : null;
  // An open list of commands stays open while someone types: the owner may be reading a command's output.
  if (background && expanded.value && (!base || base.kind === "typing")) return background;
  return base ?? background ?? (stoppedNotice.value ? { kind: "stopped", ...stoppedNotice.value } : null);
});
const single = computed(() => pill.value?.kind === "live" && pill.value.work.length === 1 ? pill.value.work[0]! : null);
const listOpen = computed(() => expanded.value && (pill.value?.kind === "live" || pill.value?.kind === "background"));
const listWork = computed(() => listOpen.value && pill.value?.kind === "live" ? pill.value.work : []);
/** Agents with background commands that are not in the list as working agents. */
const restingBackground = computed(() => {
  if (!listOpen.value) return [];
  const working = new Set(listWork.value.map((work) => work.id));
  return backgroundAgents.value.filter((agent) => !working.has(agent.entryId));
});
const listCommandCount = computed(() => listOpen.value ? backgroundCount.value : 0);
const backgroundLabel = computed(() => {
  const agents = backgroundAgents.value;
  const head = agents.length === 1 && agents[0]!.commands.length === 1
    ? `${agents[0]!.displayName} runs ${agents[0]!.commands[0]!.command} in the background`
    : `${backgroundCount.value} commands run in the background`;
  return `${head}. ${expanded.value ? "Hide" : "Show"} the commands`;
});

function commandsOf(entryId: string): readonly DesktopBackgroundCommand[] {
  return backgroundAgents.value.find((agent) => agent.entryId === entryId)?.commands ?? [];
}
const commandKey = (entryId: string, taskId: string) => `${entryId}\n${taskId}`;
const openCommands = ref(new Set<string>());
const stopStates = ref(new Map<string, "stopping" | "failed">());

const listElement = ref<HTMLElement | null>(null);

/** Open or close a command's output, with the strip's motion (see room-activity-motion.ts). */
async function toggleCommand(entryId: string, taskId: string): Promise<void> {
  // A close that still runs lands first, so this click sees the row as it will be.
  await settleCommandMotion();
  const key = commandKey(entryId, taskId);
  const opening = !openCommands.value.has(key);
  const apply = async () => {
    const next = new Set(openCommands.value);
    if (opening) next.add(key); else next.delete(key);
    openCommands.value = next;
    await nextTick();
  };
  const command = [...(listElement.value?.querySelectorAll<HTMLElement>("[data-command-key]") ?? [])]
    .find((element) => element.dataset.commandKey === key) ?? null;
  await (opening ? openCommandOutput : closeCommandOutput)(listElement.value, command, apply);
}

// Output is read only for the agents whose command rows are open, and only while the list is open.
const backgroundOutput = useBackgroundCommandOutput(() => listOpen.value
  ? [...new Set([...openCommands.value].map((key) => key.split("\n")[0]!))] : []);

const stopWaits = new Map<string, ReturnType<typeof setTimeout>>();
async function stopCommand(entryId: string, command: DesktopBackgroundCommand): Promise<void> {
  const key = commandKey(entryId, command.taskId);
  if (!backgroundCommands || stopStates.value.get(key) === "stopping") return;
  const setState = (state: "stopping" | "failed" | null) => {
    const next = new Map(stopStates.value);
    if (state) next.set(key, state); else next.delete(key);
    stopStates.value = next;
  };
  setState("stopping");
  const outcome = await backgroundCommands.stop(entryId, command.taskId);
  if (outcome === "not_running") { setState(null); return; }
  if (outcome !== "stopping") { setState("failed"); return; }
  // Accepted: the command's end removes it from the agent's state. A command that is still listed after this
  // long did not stop.
  clearTimeout(stopWaits.get(key));
  stopWaits.set(key, setTimeout(() => {
    stopWaits.delete(key);
    if (stopStates.value.get(key) === "stopping") setState("failed");
  }, 15_000));
}

function openCommand(entryId: string, taskId: string): void {
  expanded.value = false;
  backgroundCommands?.open(entryId, taskId);
}

// A command that ended leaves its row. One that the owner stopped says so in one quiet line.
let stoppedTimer: ReturnType<typeof setTimeout> | null = null;
watch(backgroundAgents, (agents, previous) => {
  const running = new Set(agents.flatMap((agent) => agent.commands.map((command) => commandKey(agent.entryId, command.taskId))));
  for (const key of [...stopStates.value.keys()]) {
    if (running.has(key)) continue;
    const [entryId, taskId] = key.split("\n");
    const agent = previous?.find((candidate) => candidate.entryId === entryId);
    const command = agent?.commands.find((candidate) => candidate.taskId === taskId);
    if (stopStates.value.get(key) === "stopping" && agent && command) {
      stoppedNotice.value = { command: command.command, agent: agent.displayName, at: Date.now() };
      if (stoppedTimer) clearTimeout(stoppedTimer);
      stoppedTimer = setTimeout(() => { stoppedNotice.value = null; }, 4_000);
    }
    clearTimeout(stopWaits.get(key));
    stopWaits.delete(key);
    const next = new Map(stopStates.value);
    next.delete(key);
    stopStates.value = next;
  }
  const open = new Set([...openCommands.value].filter((key) => running.has(key)));
  if (open.size !== openCommands.value.size) openCommands.value = open;
});
// Opened from the quiet pill with one command, the list shows that command's output at once.
watch(listOpen, (open) => {
  if (!open || pill.value?.kind !== "background") return;
  const agents = backgroundAgents.value;
  if (agents.length === 1 && agents[0]!.commands.length === 1) {
    openCommands.value = new Set([commandKey(agents[0]!.entryId, agents[0]!.commands[0]!.taskId)]);
  }
});
const liveLabel = computed(() => {
  if (pill.value?.kind !== "live") return "";
  const head = single.value ? `${single.value.displayName}: ${single.value.summary}` : `${pill.value.work.length} agents are working`;
  return `${head}. ${expanded.value ? "Hide" : "Show"} who is working`;
});

/** Notices and the Steer offer are announced; live work changes too often to read out. */
const announcement = computed(() => {
  const current = pill.value;
  if (current?.kind === "steer") return `${current.offer.displayName} is mid-turn. Your message waits. Steer is available.`;
  if (current?.kind === "stopped") return `Stopped ${current.command} for ${current.agent}`;
  if (current?.kind === "background") return "";
  if (current?.kind !== "notice") return current?.kind === "typing" ? typingLabel(current.names) : "";
  const notice = current.notice;
  if (notice.kind === "github") return notice.preview.headline;
  if (notice.kind === "calm") return notice.action ? `${calmNoticeText(notice)}. ${notice.action.label} is available.` : calmNoticeText(notice);
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
watch(() => pill.value?.kind, (kind) => { if (kind !== "live" && kind !== "background") expanded.value = false; });

// A focused control that leaves with its pill fires no focusout: let the queue run again,
// and keep the keyboard on the line instead of dropping it to the page.
const pillKey = computed(() => {
  const current = pill.value;
  if (!current) return "";
  return current.kind === "notice" ? current.notice.id : current.kind === "steer" ? `steer:${current.offer.entryId}`
    : current.kind === "stopped" ? `stopped:${current.at}` : current.kind;
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
  if (stoppedTimer) clearTimeout(stoppedTimer);
  for (const timer of stopWaits.values()) clearTimeout(timer);
  if (ticker) clearInterval(ticker);
  if (typeof document !== "undefined") document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  if (held) emit("hold", false);
});
</script>
