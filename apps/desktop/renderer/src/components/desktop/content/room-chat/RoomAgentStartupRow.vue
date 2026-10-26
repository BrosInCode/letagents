<template>
  <article
    class="room-agent-startup"
    :data-state="view.status"
    :data-testid="`room-agent-startup-${view.entryId}`"
    :aria-label="`${view.name} start-up`"
  >
    <span class="room-agent-startup-slot" aria-hidden="true">
      <svg viewBox="0 0 36 36">
        <circle class="track" cx="18" cy="18" r="16" />
        <circle class="arc" cx="18" cy="18" r="16" :style="{ strokeDashoffset: ringOffset }" />
        <circle v-if="view.status === 'running'" class="spin" cx="18" cy="18" r="16" />
      </svg>
      <span class="room-agent-startup-avatar">{{ view.initials }}</span>
    </span>
    <div class="room-agent-startup-body">
      <div class="room-agent-startup-meta">
        <strong>{{ view.name }}</strong>
        <span class="room-agent-startup-tag">{{ view.providerLabel }} agent</span>
        <time v-if="elapsedLabel" class="room-agent-startup-elapsed">{{ elapsedLabel }}</time>
      </div>
      <button
        class="room-agent-startup-line"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="detailId"
        @click="expanded = !expanded"
      >
        <span class="room-agent-startup-text" :class="{ 'is-shimmer': view.status === 'running' }" aria-live="polite">{{ view.line }}</span>
        <ChevronRight class="room-agent-startup-chevron" :size="13" aria-hidden="true" />
      </button>
      <div v-if="view.status !== 'joined'" class="room-agent-startup-segments" aria-hidden="true">
        <i v-for="stage in view.stages" :key="stage.key" :data-s="stage.state" />
      </div>
      <ol v-show="expanded" :id="detailId" class="room-agent-startup-detail">
        <li v-for="stage in view.stages" :key="stage.key" :data-s="stage.state">
          <span class="room-agent-startup-mark">
            <Check v-if="stage.state === 'done'" :size="13" aria-hidden="true" />
            <X v-else-if="stage.state === 'failed'" :size="13" aria-hidden="true" />
          </span>
          <span>{{ stage.label }}<span class="room-agent-startup-sr">{{ stageStateText(stage.state) }}</span></span>
          <time>{{ stage.ms != null ? formatStartupElapsed(stage.ms) : "" }}</time>
        </li>
      </ol>
      <div v-if="view.status === 'failed' && view.failure" class="room-agent-startup-actions">
        <button
          v-if="view.failure.action === 'sign_in' || view.failure.action === 'install'"
          type="button"
          class="is-primary"
          @click="emit('setup', view.entryId)"
        >{{ view.failure.action === "sign_in" ? "Sign in…" : "Set up…" }}</button>
        <button type="button" :class="{ 'is-primary': view.failure.action === 'retry' }" :disabled="busy" @click="run(() => emit('retry', view.entryId))">Try again</button>
        <button type="button" :disabled="busy" @click="run(() => emit('cancel', view.entryId))">Cancel</button>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { Check, ChevronRight, X } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { formatStartupElapsed, type AgentStartupStageState, type AgentStartupView } from "../../../../domain/agent-startup";

const props = defineProps<{ view: AgentStartupView }>();
const emit = defineEmits<{
  retry: [entryId: string];
  cancel: [entryId: string];
  /** Sign in or install the agent's runtime. */
  setup: [entryId: string];
}>();

const expanded = ref(false);
const busy = ref(false);
const detailId = computed(() => `room-agent-startup-${props.view.entryId}-detail`);
// The ring's circumference (2πr with r = 16). A running stage shows a part of its share.
const RING = 100.5;
const ringOffset = computed(() => {
  const share = props.view.stages.length ? 1 / props.view.stages.length : 0;
  const filled = props.view.fraction + (props.view.status === "running" ? share * 0.35 : 0);
  return String(RING * (1 - Math.min(1, filled)));
});

// Tenths of a second while it runs; the domain gives the start and, once it ends, the end.
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
watch(() => props.view.timerEndMs == null && props.view.status === "running", (running) => {
  if (timer) clearInterval(timer);
  timer = null;
  now.value = Date.now();
  if (running) timer = setInterval(() => { now.value = Date.now(); }, 100);
}, { immediate: true });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

const elapsedLabel = computed(() => {
  if (props.view.status === "joined" || props.view.status === "cancelled") return "";
  const end = props.view.timerEndMs ?? now.value;
  return formatStartupElapsed(end - props.view.timerStartMs);
});

function stageStateText(state: AgentStartupStageState): string {
  if (state === "done") return " (done)";
  if (state === "now") return " (in progress)";
  if (state === "failed") return " (failed)";
  return "";
}

/** Ignores repeat clicks for a moment; the row's next state comes from the daemon. */
function run(action: () => void): void {
  if (busy.value) return;
  busy.value = true;
  action();
  setTimeout(() => { busy.value = false; }, 600);
}
</script>

<style scoped>
.room-agent-startup {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 12px;
  padding: 6px 0;
  animation: room-agent-startup-rise 240ms var(--ease-out) both;
}

.room-agent-startup-slot {
  position: relative;
  width: 32px;
  height: 32px;
}

.room-agent-startup-slot svg {
  position: absolute;
  inset: -4px;
  width: 40px;
  height: 40px;
  overflow: visible;
  transform: rotate(-90deg);
  transition: opacity 260ms ease 120ms;
}

.room-agent-startup-slot circle { fill: none; stroke-width: 2; }
.room-agent-startup-slot .track { stroke: var(--border-strong); }
.room-agent-startup-slot .arc {
  stroke: var(--blue);
  stroke-linecap: round;
  stroke-dasharray: 100.5;
  transition: stroke-dashoffset 420ms var(--ease-out), stroke 200ms ease;
}
.room-agent-startup-slot .spin {
  stroke: color-mix(in srgb, var(--blue) 55%, transparent);
  stroke-linecap: round;
  stroke-dasharray: 9 91.5;
  transform-origin: 18px 18px;
  animation: room-agent-startup-spin 900ms linear infinite;
}

.room-agent-startup-avatar {
  position: absolute;
  inset: 3px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: light-dark(#e6e5e3, #292a2c);
  color: var(--text-secondary);
  font-size: 9px;
  font-weight: 650;
  opacity: 0.32;
  transform: scale(0.86);
  transition: opacity 300ms ease, transform 300ms ease, inset 300ms ease, font-size 300ms ease;
}

.room-agent-startup[data-state="joined"] .room-agent-startup-slot svg { opacity: 0; }
.room-agent-startup[data-state="joined"] .room-agent-startup-avatar {
  inset: 0;
  opacity: 1;
  transform: none;
  font-size: 11px;
  animation: room-agent-startup-pop 520ms cubic-bezier(0.34, 1.36, 0.64, 1) both;
}
.room-agent-startup[data-state="failed"] .arc { stroke: var(--red-text); }
.room-agent-startup[data-state="cancelled"] .arc { stroke: var(--text-muted); }

.room-agent-startup-body { min-width: 0; }

.room-agent-startup-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}
.room-agent-startup-meta strong { color: var(--text); font-weight: 600; }
.room-agent-startup-tag { color: var(--text-tertiary); font-size: 12px; }
.room-agent-startup-elapsed { color: var(--text-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }

.room-agent-startup-line {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  margin-top: 3px;
  padding: 2px 6px 2px 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
}
.room-agent-startup-line:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.room-agent-startup-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.room-agent-startup-text.is-shimmer {
  background: linear-gradient(90deg, var(--text-secondary) 0%, var(--text-secondary) 40%, var(--text) 50%, var(--text-secondary) 60%, var(--text-secondary) 100%);
  background-size: 250% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: room-agent-startup-sheen 1.6s linear infinite;
}
.room-agent-startup[data-state="failed"] .room-agent-startup-text { color: var(--red-text); }
.room-agent-startup-chevron { flex: 0 0 auto; color: var(--text-tertiary); transition: transform 180ms var(--ease-out); }
.room-agent-startup-line[aria-expanded="true"] .room-agent-startup-chevron { transform: rotate(90deg); }

.room-agent-startup-segments { display: flex; gap: 3px; width: min(180px, 100%); margin-top: 7px; }
.room-agent-startup-segments i {
  position: relative;
  flex: 1;
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--border-strong);
}
.room-agent-startup-segments i::after {
  content: "";
  position: absolute;
  inset: 0;
  background: var(--blue);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 380ms var(--ease-out);
}
.room-agent-startup-segments i[data-s="done"]::after { transform: scaleX(1); }
.room-agent-startup-segments i[data-s="now"]::after {
  transform: scaleX(0.45);
  animation: room-agent-startup-pulse 1.1s ease-in-out infinite alternate;
}
.room-agent-startup-segments i[data-s="failed"]::after { transform: scaleX(1); background: var(--red-text); }

.room-agent-startup-detail {
  display: grid;
  gap: 6px;
  max-width: 360px;
  margin: 8px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-subtle);
  list-style: none;
}
.room-agent-startup-detail li {
  display: grid;
  grid-template-columns: 16px 1fr auto;
  gap: 8px;
  align-items: center;
  color: var(--text-secondary);
  font-size: 12.5px;
}
.room-agent-startup-detail li[data-s="pending"] { color: var(--text-muted); }
.room-agent-startup-detail li[data-s="now"] { color: var(--text); }
.room-agent-startup-detail li[data-s="failed"] { color: var(--red-text); }
.room-agent-startup-detail li[data-s="done"] .room-agent-startup-mark { color: var(--green-text); }
.room-agent-startup-detail time { color: var(--text-tertiary); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.room-agent-startup-mark { display: grid; place-items: center; width: 14px; height: 14px; }
.room-agent-startup-detail li[data-s="pending"] .room-agent-startup-mark::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-muted);
}
.room-agent-startup-detail li[data-s="now"] .room-agent-startup-mark::before {
  content: "";
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--border-strong);
  border-top-color: var(--blue);
  border-radius: 50%;
  animation: room-agent-startup-spin 700ms linear infinite;
}
.room-agent-startup-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.room-agent-startup-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.room-agent-startup-actions button {
  height: 28px;
  padding: 0 11px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  font-weight: 550;
  cursor: pointer;
  transition: transform 140ms var(--ease-out), background-color 120ms ease;
}
.room-agent-startup-actions button:hover:not(:disabled) { background: var(--accent-hover); }
.room-agent-startup-actions button.is-primary { border-color: transparent; background: var(--blue); color: #fff; }
.room-agent-startup-actions button:active:not(:disabled) { transform: scale(0.97); }
.room-agent-startup-actions button:disabled { opacity: 0.6; cursor: default; }
.room-agent-startup-actions button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }

@keyframes room-agent-startup-spin { to { transform: rotate(360deg); } }
@keyframes room-agent-startup-sheen { from { background-position: 100% 0; } to { background-position: -150% 0; } }
@keyframes room-agent-startup-pulse { from { opacity: 0.45; } to { opacity: 1; } }
@keyframes room-agent-startup-pop { from { opacity: 0; transform: scale(0.6); } }
@keyframes room-agent-startup-rise { from { opacity: 0; transform: translateY(4px); } }

@media (prefers-reduced-motion: reduce) {
  .room-agent-startup,
  .room-agent-startup-slot .spin,
  .room-agent-startup-segments i[data-s="now"]::after,
  .room-agent-startup-detail li[data-s="now"] .room-agent-startup-mark::before,
  .room-agent-startup[data-state="joined"] .room-agent-startup-avatar { animation: none; }
  .room-agent-startup-slot .spin { display: none; }
  .room-agent-startup-text.is-shimmer { animation: none; background: none; color: var(--text-secondary); }
  .room-agent-startup-slot .arc,
  .room-agent-startup-slot svg,
  .room-agent-startup-avatar,
  .room-agent-startup-segments i::after,
  .room-agent-startup-chevron { transition: none; }
}
</style>
