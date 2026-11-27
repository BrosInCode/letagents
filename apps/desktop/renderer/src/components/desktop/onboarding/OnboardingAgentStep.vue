<template>
  <article class="onb-step agent-step" :data-phase="phase" data-testid="onboarding-agent-step" :style="accent ? { '--mint': accent } : undefined">
    <div class="onb-grain" :style="{ backgroundImage: grain }" aria-hidden="true" />
    <div class="onb-drag" aria-hidden="true" />
    <span class="onb-brand" data-morph="brand"><span class="onb-brand-mark"><LetAgentsLogoMark aria-hidden="true" /></span>LetAgents</span>

    <!-- The choice sits with the heading, like a line of a sentence; the rest of the screen stays quiet. -->
    <footer class="onb-bottom">
      <div class="onb-left">
        <Transition name="agent-heading" mode="out-in">
          <h1 :key="phase" ref="headingEl" class="onb-heading" tabindex="-1" data-morph="heading">
            {{ phase === 'pick' ? 'Pick your first agent.' : 'Setting up your room.' }}
          </h1>
        </Transition>

        <!-- A short list that scrolls; the top or bottom fades only where more agents are hidden. -->
        <div ref="scroller" class="provider-scroller" :data-loop="loop" :data-fade-start="fadeStart" :data-fade-end="fadeEnd"
          data-morph="rise" @wheel="onWheel" @mousemove="onHover" @mouseleave="stopHover">
          <TransitionGroup tag="div" name="pill" class="provider-list" role="radiogroup" aria-label="Agent app" @keydown="arrows">
            <!-- In a loop the list is drawn three times; only the middle copy takes focus and is read out. -->
            <button v-for="{ key, copy, provider } in rows" :key="key" type="button" class="provider-row"
              :data-copy="copy" :aria-hidden="copy !== 1 || undefined"
              :data-state="provider.state" :data-selected="provider.id === selectedId" :style="{ '--brand': brands[provider.id] }"
              :role="phase === 'pick' ? 'radio' : undefined"
              :aria-checked="phase === 'pick' ? provider.id === selectedId : undefined"
              :aria-label="phase === 'pick' ? labelOf(provider) : undefined" :title="phase === 'pick' ? hintOf(provider) : undefined"
              :tabindex="phase === 'pick' && copy === 1 ? 0 : -1"
              :data-testid="copy === 1 ? `onboarding-provider-${provider.id}` : undefined"
              @click="choose(provider)">
              <img class="provider-icon" :src="icons[provider.id]" alt="" draggable="false">
              <strong>{{ provider.name }}</strong>
              <Check v-if="provider.state === 'ready' && provider.id === selectedId && phase === 'pick'" class="pill-check" aria-hidden="true" />
              <!-- Not available yet: one small icon says why, and clicking it fixes it. -->
              <LoaderCircle v-else-if="provider.state === 'signing-in' || provider.state === 'checking'" class="pill-action onb-spin" aria-hidden="true" />
              <LogIn v-else-if="provider.state === 'signin'" class="pill-action" aria-hidden="true" />
              <ArrowDownToLine v-else-if="provider.state === 'missing'" class="pill-action" aria-hidden="true" />
              <CircleAlert v-else-if="provider.state === 'unavailable'" class="pill-action" aria-hidden="true" />
            </button>
          </TransitionGroup>
        </div>

        <!-- The app runs the provider's own sign-in: it shows the page, the one-time code or a paste field, and moves on by itself. -->
        <Transition name="signin-card">
          <section v-if="phase === 'pick' && signing?.signIn" :key="signing.id" class="signin-card" aria-live="polite"
            :aria-label="`${signing.name} sign-in`" data-testid="onboarding-provider-sign-in">
            <header>
              <LoaderCircle class="onb-spin" aria-hidden="true" />
              <strong>{{ signing.signIn.verifying ? "Checking the sign-in" : signing.signIn.inTerminal ? "Finish in Terminal" : "Finish in your browser" }}</strong>
              <button type="button" class="onb-quiet signin-cancel" @click="emit('cancel-sign-in', signing.id)">Cancel</button>
            </header>
            <p>{{ signInNote(signing) }}</p>
            <div v-if="signing.signIn.code" class="signin-code">
              <code aria-label="One-time code">{{ signing.signIn.code }}</code>
              <button type="button" class="onb-quiet" @click="copyCode(signing.signIn.code)">{{ copied ? "Copied" : "Copy" }}</button>
            </div>
            <form v-if="signing.signIn.acceptsCode && !signing.signIn.verifying" class="signin-paste"
              @submit.prevent="pasted.trim() && emit('submit-code', signing.id, pasted.trim())">
              <input v-model="pasted" type="text" aria-label="Code from the browser" placeholder="Browser shows a code? Paste it here" autocomplete="off" spellcheck="false">
              <button type="submit" :disabled="!pasted.trim()">Use code</button>
            </form>
            <button v-if="signing.signIn.url && !signing.signIn.verifying" type="button" class="agent-link signin-open"
              @click="emit('open-link', signing.id)">Open {{ linkLabel(signing.signIn.url) }} <ArrowUpRight aria-hidden="true" /></button>
          </section>
        </Transition>
        <p v-if="phase === 'pick' && (signInError || loadError)" class="onb-feedback" role="alert">{{ signInError || loadError }}</p>
        <!-- An agent that can't be used says why, in place, and is checked again on each click. -->
        <p v-else-if="phase === 'pick' && unavailableNote" class="onb-feedback" role="status" data-testid="onboarding-agent-unavailable">{{ unavailableNote }}</p>

        <ol v-if="phase === 'setup'" class="setup-steps" aria-live="polite" data-testid="onboarding-setup-steps">
          <li v-for="(item, index) in tasks" :key="item.id" :data-state="taskState(index)" :style="{ '--delay': `${index * 70}ms` }">
            <span class="setup-mark" aria-hidden="true">
              <Check v-if="taskState(index) === 'done'" />
              <LoaderCircle v-else-if="taskState(index) === 'active'" class="onb-spin" />
              <X v-else-if="taskState(index) === 'failed'" />
            </span>
            <span>{{ item.label }}</span>
            <AgentAvatar v-if="item.id === 'agent' && agentAvatar && taskState(index) !== 'waiting'" class="setup-avatar"
              :avatar="agentAvatar" :name="agentName" :size="24" />
          </li>
        </ol>
        <p v-if="phase === 'setup' && setupState !== 'failed'" class="onb-note">{{ agentName }} will be waiting there with you.</p>
        <p v-if="phase === 'setup' && setupState === 'failed'" class="onb-feedback" role="alert">{{ setupError || "Setup didn’t finish." }}</p>
      </div>

      <div class="onb-actions">
        <template v-if="phase === 'pick'">
          <button type="button" class="onb-quiet" data-testid="onboarding-agent-skip" @click="emit('skip')">Skip for now</button>
          <button type="button" class="onb-primary" data-morph="primary" data-testid="onboarding-agent-start"
            :disabled="!selected && (!signInNext || signInNext.state === 'signing-in')" @click="primary">
            <template v-if="selected">Start with {{ selected.name }} <ArrowRight aria-hidden="true" /></template>
            <template v-else-if="signInNext?.state === 'signing-in'"><LoaderCircle class="onb-spin" aria-hidden="true" /> Signing in to {{ signInNext.name }}</template>
            <template v-else-if="signInNext">Sign in to {{ signInNext.name }} <LogIn aria-hidden="true" /></template>
            <template v-else-if="checking"><LoaderCircle class="onb-spin" aria-hidden="true" /> Looking for agents</template>
            <template v-else>Get an agent to start</template>
          </button>
        </template>
        <template v-else-if="setupState === 'failed'">
          <button type="button" class="onb-quiet" data-testid="onboarding-setup-back" @click="emit('back')">Back</button>
          <button type="button" class="onb-primary" data-testid="onboarding-setup-retry" @click="emit('retry')">Try again <RotateCw aria-hidden="true" /></button>
        </template>
      </div>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Check, CircleAlert, LoaderCircle, LogIn, RotateCw, X } from "@lucide/vue";
import type { AgentAvatar as AgentAvatarValue } from "../../../../../../../src/shared/agent-avatar";
import AgentAvatar from "../../../../../../../shared/ui/agent-identity/AgentAvatar.vue";
import { copyTextToClipboard } from "../../../../../../../shared/ui/clipboard";
import antigravityIcon from "../../../assets/harness-icons/antigravity.png";
import claudeCodeIcon from "../../../assets/harness-icons/claude-code.png";
import codexIcon from "../../../assets/harness-icons/codex.png";
import cursorIcon from "../../../assets/harness-icons/cursor.png";
import LetAgentsLogoMark from "../brand/LetAgentsLogoMark.vue";
import type { FirstRoomState, FirstRoomTask } from "./useOnboardingFirstRoom";
import { onboardingNeedsProject, onboardingUnavailableText, type OnboardingProvider } from "./useOnboardingAgents";
import { useFilmGrain } from "./useFilmGrain";
import "./onboarding-step.css";

const props = defineProps<{
  providers: OnboardingProvider[];
  phase: "pick" | "setup";
  selectedId: string | null;
  agentName: string;
  agentAvatar: AgentAvatarValue | null;
  /** The company colour chosen on the previous screen, if any. */
  accent?: string;
  loadError: string | null;
  signInError: string | null;
  setupTask: FirstRoomTask | null;
  setupState: FirstRoomState;
  setupError: string | null;
}>();
const emit = defineEmits<{
  select: [id: string]; "sign-in": [id: string]; install: [id: string]; recheck: [id: string]; start: []; skip: []; back: []; retry: [];
  "cancel-sign-in": [id: string]; "open-link": [id: string]; "submit-code": [id: string, code: string];
}>();

const grain = useFilmGrain();
const headingEl = ref<HTMLElement | null>(null);

// ---- The sign-in the app runs for one provider
const signing = computed(() => props.providers.find(provider => provider.state === "signing-in" && provider.signIn) ?? null);
const pasted = ref("");
const copied = ref(false);
watch(() => signing.value?.id, () => { pasted.value = ""; copied.value = false; });
async function copyCode(code: string) { copied.value = await copyTextToClipboard(code); }
/** A device page keeps its path; a long sign-in link shows only its site. */
function linkLabel(raw: string) {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/$/, "");
    return !url.search && path.length <= 24 ? `${url.host}${path}` : url.host;
  } catch { return "the sign-in page"; }
}
function signInNote(provider: OnboardingProvider) {
  const run = provider.signIn!;
  if (run.verifying) return `Making sure ${provider.name} is signed in.`;
  if (run.inTerminal) return `${provider.name} signs in from Terminal. We opened it for you and check every few seconds.`;
  if (run.code) return "Open the page and enter this code.";
  return `We opened ${provider.name}'s sign-in page in your browser.`;
}

// Each provider's own colour, taken from its mark. Codex and Cursor marks are black and white, so they glow silver.
const brands: Record<string, string> = { "claude-code": "#d97757", codex: "#c9d1e6", cursor: "#e6e6e6", antigravity: "#4285f4" };
const icons: Record<string, string> = { "claude-code": claudeCodeIcon, codex: codexIcon, cursor: cursorIcon, antigravity: antigravityIcon };
const selected = computed(() => props.providers.find(provider => provider.id === props.selectedId && provider.state === "ready") ?? null);
const checking = computed(() => props.providers.some(provider => provider.state === "checking"));

const tiles = computed(() => props.phase === "setup"
  ? props.providers.filter(provider => provider.id === props.selectedId)
  : props.providers);
// The reason shows for the agent last clicked while it stays unavailable. Only the person's
// own click clears it (choose()): a check that finishes in the background must not.
const noteFor = ref<string | null>(null);
const unavailableNote = computed(() => {
  const provider = props.providers.find(item => item.id === noteFor.value);
  if (!provider) return null;
  if (provider.state === "checking") return `Checking ${provider.name} again…`;
  return provider.state === "unavailable" ? onboardingUnavailableText(provider.name, provider.detail) : null;
});
// The same plain words as the note; a check again can't help an agent that needs a project folder.
const unavailableHint = (provider: OnboardingProvider) => {
  const text = onboardingUnavailableText(provider.name, provider.detail);
  return onboardingNeedsProject(provider.detail) ? text : `${text} Click to check again.`;
};
const hintOf = (provider: OnboardingProvider) => ({
  ready: undefined, checking: "Checking this agent.", signin: "Needs sign-in. Click to sign in.",
  "signing-in": "Finish signing in in your browser.", missing: "Not on this Mac. Click to get it.", unavailable: unavailableHint(provider),
})[provider.state];
const labelOf = (provider: OnboardingProvider) => provider.state === "ready" ? `${provider.name}, ready` : `${provider.name}. ${hintOf(provider) ?? ""}`;

// ---- Setup: the real tasks, in order
const tasks = computed(() => [
  { id: "connect" as const, label: `Connect ${selected.value?.name ?? props.providers.find(p => p.id === props.selectedId)?.name ?? "your agent"}` },
  { id: "room" as const, label: "Create your Welcome room" },
  { id: "agent" as const, label: `Start ${props.agentName}` },
]);
function taskState(index: number): "done" | "active" | "failed" | "waiting" {
  if (props.setupState === "done") return "done";
  const at = tasks.value.findIndex(item => item.id === props.setupTask);
  // Failed with no task: every task finished, but the room could not be opened.
  if (at < 0) return props.setupState === "failed" ? "done" : "waiting";
  if (index < at) return "done";
  if (index > at) return "waiting";
  return props.setupState === "failed" ? "failed" : "active";
}

// Nothing ready yet: the main button signs in the first installed agent instead of sitting disabled.
const signInNext = computed(() => props.providers.find(provider => provider.state === "signing-in")
  ?? props.providers.find(provider => provider.state === "signin") ?? null);
function primary() {
  if (selected.value) emit("start");
  else if (signInNext.value?.state === "signin") emit("sign-in", signInNext.value.id);
}
function choose(provider: OnboardingProvider) {
  if (props.phase !== "pick") return;
  // The note belongs to the agent last clicked; any other choice clears it.
  if (provider.state !== "unavailable") noteFor.value = null;
  if (provider.state === "ready") emit("select", provider.id);
  else if (provider.state === "signin") emit("sign-in", provider.id);
  else if (provider.state === "missing") emit("install", provider.id);
  else if (provider.state === "unavailable") { noteFor.value = provider.id; emit("recheck", provider.id); }
}

// ---- The scroll list: a small wheel. With more agents than fit, it loops (the list is drawn
// three times and the position jumps by one copy near an edge, so it never ends). The wheel
// sets a target the list eases toward; holding the cursor near the top or bottom scrolls by
// itself. The frame loop runs only while the list moves.
const VISIBLE = 3;
const scroller = ref<HTMLElement | null>(null);
const fadeStart = ref(false), fadeEnd = ref(false);
const loop = computed(() => props.phase === "pick" && tiles.value.length > VISIBLE);
const rows = computed(() => loop.value
  ? [0, 1, 2].flatMap(copy => tiles.value.map(provider => ({ key: `${copy}:${provider.id}`, copy, provider })))
  : tiles.value.map(provider => ({ key: provider.id, copy: 1, provider })));
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
let target = 0, frame = 0, hoverSpeed = 0, last = 0;

const overflows = () => !!scroller.value && scroller.value.scrollHeight > scroller.value.clientHeight + 1;
function copyHeight() {
  const el = scroller.value;
  const a = el?.querySelector<HTMLElement>('[data-copy="0"]'), b = el?.querySelector<HTMLElement>('[data-copy="1"]');
  return a && b ? b.offsetTop - a.offsetTop : 0;
}
function measure() {
  const el = scroller.value;
  if (!el) return;
  fadeStart.value = loop.value || el.scrollTop > 2;
  fadeEnd.value = loop.value || el.scrollTop + el.clientHeight < el.scrollHeight - 2;
}
function wrap() {
  const el = scroller.value, h = copyHeight();
  if (!el || !loop.value || !h) return;
  if (el.scrollTop < h * .5) { el.scrollTop += h; target += h; }
  else if (el.scrollTop > h * 1.5) { el.scrollTop -= h; target -= h; }
}
function tick(now: number) {
  const el = scroller.value;
  if (!el) { frame = 0; return; }
  const dt = last ? Math.min((now - last) / 1000, .05) : 1 / 60;
  last = now;
  target += hoverSpeed * dt;
  if (!loop.value) target = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight));
  const gap = target - el.scrollTop;
  el.scrollTop += reduce || Math.abs(gap) < .5 ? gap : gap * (1 - Math.pow(1 - .16, dt * 60));
  wrap();
  measure();
  const going = Math.abs(target - el.scrollTop) > .5 || hoverSpeed;
  frame = going ? requestAnimationFrame(tick) : 0;
  if (!going) last = 0;
}
function glide(to: number) {
  if (!frame && scroller.value) target = scroller.value.scrollTop;
  target = to;
  if (!frame) frame = requestAnimationFrame(tick);
}
function onWheel(event: WheelEvent) {
  if (!overflows()) return;
  event.preventDefault();
  glide((frame ? target : scroller.value!.scrollTop) + event.deltaY);
}
function onHover(event: MouseEvent) {
  const el = scroller.value;
  if (!el || !overflows()) return;
  const box = el.getBoundingClientRect(), zone = 48, top = event.clientY - box.top, bottom = box.bottom - event.clientY;
  const speed = reduce ? 90 : 260;
  hoverSpeed = top < zone ? -speed * (1 - top / zone) ** 2 : bottom < zone ? speed * (1 - bottom / zone) ** 2 : 0;
  if (hoverSpeed && !frame) { target = el.scrollTop; frame = requestAnimationFrame(tick); }
}
function stopHover() { hoverSpeed = 0; }
function reveal(row: HTMLElement | null | undefined) {
  const el = scroller.value;
  if (!el || !row || !overflows()) return;
  glide(row.offsetTop - (el.clientHeight - row.offsetHeight) / 2);
}
const middleRows = () => [...(scroller.value?.querySelectorAll<HTMLElement>('.provider-row[data-copy="1"]') ?? [])];
function arrows(event: KeyboardEvent) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const pills = middleRows();
  const index = pills.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  const step = event.key === "ArrowDown" ? 1 : -1;
  const next = loop.value ? pills[(index + step + pills.length) % pills.length] : pills[index + step];
  if (!next) return;
  event.preventDefault();
  next.focus({ preventScroll: true });
  reveal(next);
}
watch(() => props.selectedId, async () => {
  await nextTick();
  reveal(scroller.value?.querySelector<HTMLElement>('.provider-row[data-copy="1"][data-selected="true"]'));
});
watch(() => [props.providers.map(provider => provider.state).join(), props.phase], () => nextTick(measure));
async function settle() {
  await nextTick();
  const el = scroller.value;
  if (el && loop.value) { el.scrollTop = copyHeight(); target = el.scrollTop; }
  measure();
}
watch(loop, settle);
let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  void settle();
  resizeObserver = new ResizeObserver(measure);
  if (scroller.value) resizeObserver.observe(scroller.value);
});
onUnmounted(() => { resizeObserver?.disconnect(); cancelAnimationFrame(frame); });

defineExpose({ focusHeading: () => headingEl.value?.focus({ preventScroll: true }) });
</script>

<style scoped>
.provider-scroller {
  --fade: 34px;
  /* Three rows and a hint of the fourth; the rest scrolls. */
  width: min(430px, 100%); max-height: 214px; margin-top: 24px; padding: 2px 3px;
  position: relative; overflow-y: hidden; overscroll-behavior-y: contain; scrollbar-width: none;
  -webkit-mask-image: linear-gradient(180deg, var(--start, #000), #000 var(--fade), #000 calc(100% - var(--fade)), var(--end, #000));
  mask-image: linear-gradient(180deg, var(--start, #000), #000 var(--fade), #000 calc(100% - var(--fade)), var(--end, #000));
  -webkit-app-region: no-drag;
}
.provider-scroller::-webkit-scrollbar { display: none; }
.provider-scroller[data-fade-start="true"] { --start: transparent; }
.provider-scroller[data-fade-end="true"] { --end: transparent; }
.provider-list { position: relative; display: flex; flex-direction: column; gap: 8px; }
.provider-row {
  --brand: var(--mint);
  position: relative; display: flex; align-items: center; gap: 12px; width: 100%; height: 56px; padding: 0 18px 0 12px;
  box-sizing: border-box; border: 1px solid rgba(255, 255, 255, .07); border-radius: 14px; background: rgba(255, 255, 255, .022);
  color: var(--ink); font: inherit; text-align: left; white-space: nowrap; cursor: pointer;
  transition: background 240ms ease, background-color 180ms ease, border-color 220ms ease, box-shadow 280ms ease, transform 160ms var(--ease);
}
.provider-row:active { transform: scale(.98); }
.provider-row:focus-visible { outline: 2px solid color-mix(in srgb, var(--mint) 70%, transparent); outline-offset: 2px; }
.provider-row[data-selected="true"] { border-color: color-mix(in srgb, var(--mint) 48%, transparent); background: color-mix(in srgb, var(--mint) 8%, transparent); }
/* Under the pointer, an agent lights up in its own colour: a soft glow from the icon, a tinted edge. */
@media (hover: hover) and (pointer: fine) {
  [data-phase="pick"] .provider-row:hover {
    border-color: color-mix(in srgb, var(--brand) 50%, transparent);
    background:
      radial-gradient(120% 160% at 0% 50%, color-mix(in srgb, var(--brand) 20%, transparent), transparent 62%),
      color-mix(in srgb, var(--brand) 6%, transparent);
    box-shadow: 0 10px 30px -14px color-mix(in srgb, var(--brand) 55%, transparent);
  }
  [data-phase="pick"] .provider-row:hover .provider-icon { filter: none; opacity: 1; box-shadow: 0 0 18px -2px color-mix(in srgb, var(--brand) 60%, transparent); }
}
/* At rest every mark is muted; the pointer brings its colour back. */
.provider-icon { width: 32px; height: 32px; border-radius: 9px; user-select: none; filter: grayscale(1); opacity: .62; transition: box-shadow 280ms ease, filter 260ms ease, opacity 260ms ease; }
.provider-row strong { font: 540 15.5px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: -.005em; }
.pill-check { width: 17px; height: 17px; margin-left: auto; color: var(--mint); animation: pop 220ms var(--ease) both; }
/* Not available yet: dimmed, one quiet icon on the right. */
.provider-row:is([data-state="signin"], [data-state="missing"], [data-state="signing-in"], [data-state="checking"], [data-state="unavailable"]) {
  border-style: dashed; border-color: rgba(255, 255, 255, .1); background: transparent;
}
.provider-row:is([data-state="signin"], [data-state="missing"], [data-state="signing-in"], [data-state="checking"], [data-state="unavailable"]) :is(.provider-icon, strong) { opacity: .42; filter: grayscale(.6); }
.provider-row[data-state="checking"] { cursor: default; }
.pill-action { width: 17px; height: 17px; margin-left: auto; color: var(--ink-3); transition: color 160ms ease; }
@media (hover: hover) and (pointer: fine) {
  .provider-row:is([data-state="signin"], [data-state="missing"]):hover .pill-action { color: var(--ink); }
}

.signin-card {
  display: grid; gap: 12px; width: min(430px, 100%); box-sizing: border-box; margin-top: 14px; padding: 16px 18px;
  border: 1px solid rgba(255, 255, 255, .08); border-radius: 14px; background: rgba(255, 255, 255, .03);
  font: 400 14px/1.45 ui-sans-serif, system-ui, sans-serif; -webkit-app-region: no-drag;
}
.signin-card header { display: flex; align-items: center; gap: 10px; }
.signin-card header strong { font-weight: 560; letter-spacing: -.005em; }
.signin-card header .onb-spin { color: var(--mint); }
.signin-cancel { margin-left: auto; padding: 0; font-size: 13px; }
.signin-card p { margin: 0; color: var(--ink-2); }
.signin-code { display: flex; align-items: center; gap: 14px; }
.signin-code code {
  padding: 8px 14px; border: 1px solid rgba(255, 255, 255, .1); border-radius: 10px; background: rgba(0, 0, 0, .28);
  font: 560 19px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: .12em; color: var(--ink);
}
.signin-code .onb-quiet { padding: 0; font-size: 13px; }
.signin-paste { display: flex; gap: 8px; }
.signin-paste input {
  flex: 1; min-width: 0; height: 36px; padding: 0 12px; box-sizing: border-box;
  border: 1px solid rgba(255, 255, 255, .1); border-radius: 10px; background: rgba(0, 0, 0, .28); color: var(--ink); font: inherit; font-size: 13.5px;
}
.signin-paste input:focus-visible { outline: 2px solid color-mix(in srgb, var(--mint) 60%, transparent); outline-offset: 1px; }
.signin-paste button {
  height: 36px; padding: 0 14px; border: 0; border-radius: 10px; background: rgba(255, 255, 255, .1); color: var(--ink);
  font: 540 13px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer; transition: background-color 160ms ease, transform 160ms var(--ease);
}
.signin-paste button:hover:not(:disabled) { background: rgba(255, 255, 255, .16); }
.signin-paste button:active:not(:disabled) { transform: scale(.97); }
.signin-paste button:disabled { opacity: .4; cursor: default; }
.signin-open { justify-self: start; display: inline-flex; align-items: center; gap: 4px; font-size: 13.5px; }
.signin-open svg { width: 14px; height: 14px; }
.signin-card-enter-active { transition: opacity 240ms ease, transform 320ms var(--ease), filter 240ms ease; }
.signin-card-leave-active { transition: opacity 160ms ease, filter 160ms ease; }
.signin-card-enter-from { opacity: 0; transform: translateY(6px); filter: blur(3px); }
.signin-card-leave-to { opacity: 0; filter: blur(3px); }
.agent-link {
  padding: 0; border: 0; background: none; color: var(--ink-2); font: inherit; cursor: pointer;
  text-decoration: underline; text-decoration-color: rgba(239, 238, 230, .25); text-underline-offset: 3px;
}
.agent-link:hover { color: var(--ink); text-decoration-color: currentColor; }

.setup-steps { display: grid; gap: 2px; width: 300px; margin: 18px 0 0; padding: 0; list-style: none; }
.setup-steps li {
  display: grid; grid-template-columns: 20px 1fr auto; align-items: center; gap: 12px; min-height: 34px;
  color: var(--ink-3); font: 400 14px/1.3 ui-sans-serif, system-ui, sans-serif;
  animation: rise 360ms var(--ease) var(--delay) both; transition: color 220ms ease;
}
.setup-steps li:is([data-state="active"], [data-state="done"], [data-state="failed"]) { color: var(--ink); }
.setup-mark { display: grid; place-items: center; width: 18px; height: 18px; border: 1px solid rgba(255, 255, 255, .16); border-radius: 50%; }
[data-state="active"] .setup-mark { border-color: transparent; }
[data-state="done"] .setup-mark { border-color: transparent; background: color-mix(in srgb, var(--mint) 18%, transparent); color: var(--mint); }
[data-state="failed"] .setup-mark { border-color: transparent; background: rgba(240, 164, 138, .16); color: #f0a48a; }
.setup-mark svg { width: 12px; height: 12px; }
.setup-avatar { animation: pop 420ms cubic-bezier(.22, .84, .32, 1.22) both; }

.pill-enter-active { transition: opacity 280ms ease, transform 360ms var(--ease); }
.pill-leave-active { position: absolute; transition: opacity 180ms ease; }
.pill-enter-from { opacity: 0; transform: translateY(4px); }
.pill-leave-to { opacity: 0; }
.pill-move { transition: transform 420ms var(--ease); }
.agent-heading-enter-active { transition: opacity 260ms ease, transform 360ms var(--ease), filter 260ms ease; }
.agent-heading-leave-active { transition: opacity 160ms ease, filter 160ms ease; }
.agent-heading-enter-from { opacity: 0; transform: translateY(8px); filter: blur(4px); }
.agent-heading-leave-to { opacity: 0; filter: blur(4px); }
@keyframes pop { from { opacity: 0; transform: scale(.6); } }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }
@media (prefers-reduced-motion: reduce) {
  .provider-row, .pill-enter-active, .pill-leave-active, .pill-move, .agent-heading-enter-active { transition: opacity 150ms linear !important; transform: none !important; }
  .pill-check, .setup-steps li, .setup-avatar { animation: none; }
  .signin-card-enter-active { transition: opacity 150ms linear; transform: none; }
}
</style>
