<template>
  <article ref="article" class="welcome" :data-skipped="ink.skipped.value" :data-fallback="ink.fallback.value"
    :data-morphing="morphing" data-testid="onboarding-welcome" @pointerdown="onPress" @keydown="onPress" @pointermove="ink.stir">
    <canvas v-if="!ink.fallback.value" ref="sceneCanvas" class="welcome-scene" :data-veiled="ink.veiled.value" aria-hidden="true" />
    <OnboardingStaticMark v-else class="welcome-static-mark" />
    <div class="welcome-grain" :style="{ backgroundImage: grain }" aria-hidden="true" />
    <div class="welcome-drag" aria-hidden="true" />

    <div class="welcome-copy">
      <div class="welcome-text">
        <h1 ref="heading" tabindex="-1">
          <span class="line"><span>Humans and agents,</span></span>
          <span class="line line-muted"><span>working as one.</span></span>
        </h1>
        <p ref="subline" class="reveal">One room for your team and its agents. The same conversation, the same board, the same work.</p>
      </div>
      <div class="welcome-action reveal" :data-auth="state">
        <button ref="authButton" type="button" class="welcome-start" :data-auth="state" data-testid="onboarding-welcome-start"
          :disabled="state === 'opening' || state === 'waiting' || state === 'success'" :aria-busy="state === 'opening' || state === 'waiting'"
          :style="{ width: buttonWidth }" @click="start">
          <Transition name="auth-label" mode="out-in">
            <span :key="labelKey" class="auth-label">
              <template v-if="state === 'opening'">Opening GitHub…</template>
              <template v-else-if="state === 'waiting'"><i class="auth-pulse" aria-hidden="true" />Waiting for GitHub</template>
              <template v-else-if="state === 'success' && account"><img v-if="account.avatarUrl" class="auth-avatar" :src="account.avatarUrl" alt="">Signed in as {{ account.login }}</template>
              <template v-else-if="state === 'continue' && account"><img v-if="account.avatarUrl" class="auth-avatar" :src="account.avatarUrl" alt="">Continue as {{ account.login }}</template>
              <template v-else><GitHubMark aria-hidden="true" /> Continue with GitHub</template>
            </span>
          </Transition>
        </button>
        <Transition name="auth-hint" mode="out-in">
          <p v-if="state === 'waiting' && pending" key="wait" class="auth-hint" role="status">
            <button type="button" class="auth-code" :aria-label="`Copy the code ${pending.userCode}`" @click="copyCode(pending.userCode)">
              <code>{{ pending.userCode }}</code><span>{{ copied ? "Copied" : "Copy" }}</span>
            </button>
            <span aria-hidden="true">·</span>
            <button type="button" class="auth-link" @click="emit('open-verification', pending.verificationUri)">Open GitHub</button>
            <span aria-hidden="true">·</span>
            <button type="button" class="auth-link" @click="cancel">Cancel</button>
          </p>
          <p v-else-if="state === 'failed'" key="fail" class="auth-hint" role="status">{{ feedback || "Sign-in didn’t finish. Continue when you are ready." }}</p>
        </Transition>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DesktopAuthStatus } from "../../../../../electron/ipc-types";
import { copyTextToClipboard } from "../../../../../../../shared/ui/clipboard";
import { useInkScene, type InkMarkPlacement } from "../../../../../../../shared/ui/ink/useInkScene";
import GitHubMark from "./GitHubMark.vue";
import OnboardingStaticMark from "./OnboardingStaticMark.vue";
import { morphInto } from "./onboarding-morph";
import { useFilmGrain } from "./useFilmGrain";

const props = defineProps<{
  authStatus: DesktopAuthStatus | null;
  authBusy: boolean;
  /** Why the last sign-in did not finish (denied, expired, network). */
  feedback: string | null;
}>();
const emit = defineEmits<{
  "start-auth": [];
  "cancel-auth": [];
  "open-verification": [url: string];
  /** Signed in and the ink has let go: the next screen can take over. */
  continue: [];
}>();

const sceneCanvas = ref<HTMLCanvasElement | null>(null);
const article = ref<HTMLElement | null>(null);
const heading = ref<HTMLElement | null>(null);
const subline = ref<HTMLElement | null>(null);
const authButton = ref<HTMLButtonElement | null>(null);
const grain = useFilmGrain();

// The mark forms in the upper part of the window, above the copy.
const ink = useInkScene({
  canvas: sceneCanvas,
  placeMark: (): InkMarkPlacement => ({ center: [.5, .66], height: .3 }),
  light: () => matchMedia("(max-width: 760px)").matches,
});

// ---- Sign-in: the real device flow, told as one button.
type State = "idle" | "continue" | "opening" | "waiting" | "success" | "failed";
const pressed = ref(false);
const leaving = ref(false);
const buttonWidth = ref<string | undefined>(undefined);
const copied = ref(false);
const account = computed(() => props.authStatus?.authenticated ? props.authStatus.account : null);
const pending = computed(() => props.authStatus?.pendingDeviceAuth ?? null);

const state = computed<State>(() => {
  if (leaving.value) return "success";
  if (account.value) return pressed.value ? "success" : "continue";
  if (pending.value) return "waiting";
  if (pressed.value && props.authBusy) return "opening";
  if (pressed.value && props.feedback) return "failed";
  return pressed.value ? "opening" : "idle";
});
const labelKey = computed(() => state.value === "failed" ? "idle" : state.value);

function start() {
  if (state.value === "continue") { pressed.value = true; succeed(); return; }
  if (state.value !== "idle" && state.value !== "failed") return;
  // Freeze the width so the button eases into the quieter pill.
  buttonWidth.value = `${authButton.value?.offsetWidth ?? 220}px`;
  requestAnimationFrame(() => { buttonWidth.value = "212px"; });
  pressed.value = true;
  emit("start-auth");
}

function cancel() {
  emit("cancel-auth");
  pressed.value = false;
  buttonWidth.value = undefined;
  ink.setMode("settle");
}

async function copyCode(code: string) {
  copied.value = await copyTextToClipboard(code);
}

// GitHub opens by itself once the code exists: the person only has to approve there.
let openedFor: string | null = null;
watch(pending, (next) => {
  if (!next || !pressed.value || openedFor === next.requestId) return;
  openedFor = next.requestId;
  copied.value = false;
  emit("open-verification", next.verificationUri);
  ink.setMode("simmer");
});

// Approved: the ink lets go, then the next screen takes over (the morph runs from the flow).
let succeeded = false;
function succeed() {
  if (succeeded) return;
  succeeded = true;
  leaving.value = true;
  buttonWidth.value = "236px";
  ink.setMode("success");
  setTimeout(() => emit("continue"), ink.reduced ? 200 : 1300);
}
watch(account, (next) => { if (next && pressed.value) succeed(); });

// A sign-in that ended without an account: settle the water back into the mark.
watch(state, (next, previous) => {
  if (next === "failed" && previous !== "failed") { buttonWidth.value = undefined; ink.setMode("settle"); }
});

// Any press during the opening finishes it at once.
function onPress(event: Event) {
  if ((event.target as HTMLElement).closest("button")) return;
  ink.skip();
}

// ---- Morph into the next screen: each piece travels to its counterpart and blends into it.
const morphing = ref(false);
async function morphTo(target: HTMLElement | null) {
  if (!target || !article.value) return;
  morphing.value = true;
  await morphInto({
    from: article.value, to: target, reduced: ink.reduced,
    heading: heading.value, subline: subline.value, button: authButton.value, canvas: sceneCanvas.value,
    markCenter: [.5, .66], markHeight: .3,
  });
}
defineExpose({ morphTo });
</script>

<style scoped>
.welcome {
  --ink: #efeee6;
  --ink-2: rgba(239, 238, 230, .56);
  --ink-3: rgba(239, 238, 230, .3);
  --edge: clamp(28px, 6vw, 96px);
  --reveal: cubic-bezier(.19, 1, .22, 1);
  position: relative; isolation: isolate; overflow: hidden;
  display: grid; grid-template-rows: 1fr auto;
  width: 100%; height: 100dvh; min-height: 520px; box-sizing: border-box;
  padding: 0 var(--edge) 28px;
  background: #0a0b0a; color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
.welcome-grain { position: absolute; inset: 0; z-index: -1; opacity: .045; pointer-events: none; }
.welcome-scene { position: absolute; inset: 0; z-index: -3; width: 100%; height: 100%; transition: opacity 450ms ease; }
.welcome-scene[data-veiled="true"] { opacity: 0; transition: none; }
.welcome-static-mark { top: 34%; }
.welcome::after {
  content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background: radial-gradient(120% 90% at 50% 42%, transparent 55%, rgba(0, 0, 0, .55));
}
/* The window can be dragged by its top edge; the macOS buttons sit there. */
.welcome-drag { position: absolute; inset: 0 0 auto; height: 40px; -webkit-app-region: drag; }

.welcome-copy {
  grid-row: 2;
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 32px;
  padding-bottom: clamp(36px, 7vh, 72px);
}
.welcome-text { max-width: 640px; }
.welcome h1 {
  margin: 0; font-family: "Iowan Old Style", "New York", ui-serif, Georgia, serif;
  font-size: clamp(42px, 5.6vw, 76px); font-weight: 400; line-height: .98; letter-spacing: -.038em;
  font-feature-settings: "kern", "liga";
}
.welcome h1:focus { outline: none; }
.line { display: block; overflow: hidden; padding-bottom: .08em; margin-bottom: -.08em; }
.line > span { display: inline-block; white-space: nowrap; animation: line-up 1.15s var(--reveal) both; }
.line:first-child > span { animation-delay: 3.15s; }
.line-muted > span { color: var(--ink-3); animation-delay: 3.25s; }
.welcome-text p {
  max-width: 400px; margin: 22px 0 0; color: var(--ink-2);
  font: 400 15px/1.55 ui-sans-serif, system-ui, sans-serif; letter-spacing: -.005em;
}
.reveal { animation: fade-up 1s var(--reveal) both; }
.welcome-text p.reveal { animation-delay: 3.4s; }
.welcome-action.reveal { animation-delay: 3.55s; }
.welcome[data-fallback="true"] .line:first-child > span { animation-delay: .2s; }
.welcome[data-fallback="true"] .line-muted > span { animation-delay: .3s; }
.welcome[data-fallback="true"] .welcome-text p.reveal { animation-delay: .42s; }
.welcome[data-fallback="true"] .welcome-action.reveal { animation-delay: .52s; }

.welcome-action { display: grid; justify-items: end; gap: 12px; }
.welcome-start {
  display: inline-flex; align-items: center; justify-content: center; gap: 10px; height: 48px; padding: 0 22px 0 18px;
  overflow: hidden; white-space: nowrap; border: 0; border-radius: 12px; cursor: pointer;
  background: linear-gradient(#f5f4ee, #e6e4db); color: #0b0c0b;
  font: 560 15px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: -.01em;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .8), inset 0 -1px 0 rgba(0, 0, 0, .12),
    0 1px 2px rgba(0, 0, 0, .5), 0 12px 32px -12px rgba(236, 228, 205, .35);
  transition: width 420ms cubic-bezier(.23, 1, .32, 1), background-color 300ms ease, color 300ms ease,
    box-shadow 300ms ease, transform 160ms cubic-bezier(.23, 1, .32, 1);
  -webkit-app-region: no-drag;
}
.welcome-start svg { width: 18px; height: 18px; }
@media (hover: hover) and (pointer: fine) {
  .welcome-start:not(:disabled):hover { box-shadow: inset 0 1px 0 rgba(255, 255, 255, .9), inset 0 -1px 0 rgba(0, 0, 0, .12),
    0 1px 2px rgba(0, 0, 0, .5), 0 16px 40px -12px rgba(236, 228, 205, .5); }
}
.welcome-start:active { transform: scale(.97); }
.welcome-start:focus-visible { outline: 2px solid rgba(159, 230, 207, .8); outline-offset: 3px; }
.welcome-start:is([data-auth="opening"], [data-auth="waiting"], [data-auth="success"]) {
  background: rgba(255, 255, 255, .06); color: var(--ink);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12); cursor: default;
}
.welcome-start:disabled { opacity: 1; }
.auth-label { display: inline-flex; align-items: center; gap: 10px; }
.auth-pulse { width: 7px; height: 7px; border-radius: 50%; background: #7fe0bd; animation: auth-breathe 1.6s ease-in-out infinite; }
.auth-avatar { width: 20px; height: 20px; border-radius: 50%; }
.auth-label-enter-active { transition: opacity 220ms ease, transform 280ms cubic-bezier(.23, 1, .32, 1), filter 220ms ease; }
.auth-label-leave-active { transition: opacity 120ms ease, filter 120ms ease; }
.auth-label-enter-from { opacity: 0; transform: translateY(5px); filter: blur(2px); }
.auth-label-leave-to { opacity: 0; filter: blur(2px); }

.auth-hint {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px;
  margin: 0; color: var(--ink-2); font: 400 13px/1.4 ui-sans-serif, system-ui, sans-serif; text-align: right;
}
.auth-code {
  display: inline-flex; align-items: center; gap: 8px; padding: 3px 4px 3px 8px; border: 0; border-radius: 7px;
  background: rgba(255, 255, 255, .07); color: var(--ink); cursor: pointer; -webkit-app-region: no-drag;
  transition: background-color 160ms ease;
}
.auth-code:hover { background: rgba(255, 255, 255, .11); }
.auth-code code { font: 500 13px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: .08em; }
.auth-code span { padding: 3px 6px; border-radius: 5px; background: rgba(255, 255, 255, .08); color: var(--ink-2); font-size: 11.5px; }
.auth-link {
  padding: 0; border: 0; background: none; color: var(--ink); font: inherit; cursor: pointer; -webkit-app-region: no-drag;
  text-decoration: underline; text-decoration-color: rgba(239, 238, 230, .3); text-underline-offset: 3px;
}
.auth-link:hover { text-decoration-color: currentColor; }
.auth-code:focus-visible, .auth-link:focus-visible { outline: 2px solid rgba(159, 230, 207, .8); outline-offset: 2px; }
.auth-hint-enter-active { transition: opacity 260ms ease, transform 320ms cubic-bezier(.23, 1, .32, 1); }
.auth-hint-leave-active { transition: opacity 140ms ease; }
.auth-hint-enter-from { opacity: 0; transform: translateY(-4px); }
.auth-hint-leave-to { opacity: 0; }

/* During the morph this view floats over the next one and lets it show through. */
.welcome[data-morphing="true"] { position: fixed; inset: 0; z-index: 5; pointer-events: none; }
.welcome[data-morphing="true"]::after { opacity: 0; transition: opacity 380ms ease; }

/* Pressed during the opening: show everything at once, without the stagger. */
.welcome[data-skipped="true"] :is(.line > span, .reveal) { animation-delay: 0s !important; animation-duration: .45s !important; }

@keyframes line-up { from { transform: translateY(105%); } }
@keyframes fade-up { from { opacity: 0; transform: translateY(10px); } }
@keyframes fade { from { opacity: 0; } }
@keyframes auth-breathe { 0%, 100% { opacity: .35; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) {
  .auth-pulse { animation: none; opacity: .85; }
  .line > span, .reveal { animation: fade 400ms ease both !important; }
  .welcome-start { transition: none; }
}
@media (max-width: 760px) {
  .welcome-copy { grid-template-columns: 1fr; }
  .welcome-action { justify-items: start; }
  .auth-hint { justify-content: flex-start; text-align: left; }
}
</style>
