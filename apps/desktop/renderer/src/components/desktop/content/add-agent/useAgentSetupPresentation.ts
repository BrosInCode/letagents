import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import type { AgentAvatar as Avatar } from "../../../../../../../../src/shared/agent-avatar";
import type { AddAgentModalProps, AddAgentSupervisedUi } from "./useAddAgentController";
import type AddAgentOpenModelSettings from "./AddAgentOpenModelSettings.vue";
import { currentFocusableElement, restoreFocus, trapFocusInDialog } from "../modal-focus";
import { freeAgentName, heldNameMatch, heldNameMessage } from "../../../../domain/room-held-names";

/** Presentation only: mounted drafts, reversible scene turn and modal focus. */
export function useAgentSetupPresentation(props: AddAgentModalProps, configuredName: Ref<string>, configuredAvatar: Ref<Avatar | null>, supervisedUi: AddAgentSupervisedUi) {
const dialogElement = ref<HTMLElement | null>(null);
const openModelSettings = ref<InstanceType<typeof AddAgentOpenModelSettings> | null>(null);
let previousFocusElement: HTMLElement | null = null;

watch(() => props.open, (open) => {
  if (open) {
    previousFocusElement = currentFocusableElement();
    void nextTick(() => dialogElement.value?.focus());
  }
}, { immediate: true });

// Opened from a chip's "Configure Open Model…": bring the Open Model settings into view once they render.
watch(() => props.open && props.initialSection === "open-model" && Boolean(openModelSettings.value), (show) => {
  if (!show) return;
  void nextTick(() => {
    const element = openModelSettings.value?.$el as HTMLElement | undefined;
    element?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    element?.querySelector<HTMLElement>("input")?.focus({ preventScroll: true });
  });
});

function handleAfterLeave(): void {
  if (props.open) return;
  restoreFocus(previousFocusElement);
  previousFocusElement = null;
}

function handleDialogTab(event: KeyboardEvent): void {
  trapFocusInDialog(event, dialogElement.value);
}

async function revealLaunchSurface(onlyWhileFailed = false): Promise<void> {
  await nextTick();
  if (!props.open || (onlyWhileFailed && !supervisedUi.launch.view.value?.failed)) return;
  const surface = dialogElement.value?.querySelector<HTMLElement>('[data-testid="desktop-add-agent-supervised-runtime"], [data-testid="desktop-add-agent-supervised-lookup-error"]');
  surface?.focus({ preventScroll: true });
  // Recovery should be immediately reachable, including with reduced motion.
  // Scroll the compact recovery section, not the Brain form above it.
  surface?.scrollIntoView({ block: "nearest", behavior: "instant" });
}

async function handleRecoverSupervisedLaunch(): Promise<void> {
  await supervisedUi.launch.recoverDetectedLaunch();
  if (supervisedUi.launch.recoveryCandidate.value) return;
  // Failed attachments are revealed by the terminal-state watcher below.
  if (!supervisedUi.launch.view.value?.failed) await revealLaunchSurface();
}

// One transition into failure (or reopening it) reveals recovery after render.
// A fresh snapshot with the same failure must not steal focus or scroll again.
watch(() => props.open && Boolean(supervisedUi.launch.view.value?.failed), failed => {
  if (failed) void revealLaunchSurface(true);
}, { immediate: true, flush: "post" });

const step = ref<'identity' | 'brain'>('identity');
const formatError = ref('');
// The name this dialog chose, so a later room update may replace it; a name
// the person typed is never replaced, only warned about.
let defaultName = '';
let defaultSeed = '';
const heldNames = computed(() => props.heldNames ?? []);
// A launch in progress or saved is this agent's own name, already in the room.
const heldNameError = computed(() => {
  if (supervisedUi.launch.view.value) return '';
  const match = heldNameMatch(configuredName.value, heldNames.value);
  return match ? heldNameMessage(match) : '';
});
const identityError = computed(() => formatError.value || heldNameError.value);
const takenNames = computed(() => heldNames.value.map(entry => entry.name));
function chooseDefaultName(): void {
  if (!defaultSeed) defaultSeed = globalThis.crypto?.randomUUID?.() ?? String(Math.random());
  defaultName = freeAgentName(heldNames.value, defaultSeed);
  configuredName.value = defaultName;
}
watch(configuredName, () => { formatError.value = ''; });
const identityAvatar = computed<Avatar>({ get: () => configuredAvatar.value || { kind: 'character', character: 'orbit', color: 'sage' }, set: value => { configuredAvatar.value = value; } });
const motionPaused = ref(false);
const turnBody = ref<HTMLElement | null>(null), turnStage = ref<HTMLElement | null>(null), turning = ref(false);
let position = 0, velocity = 0, target = 0, frame = 0, lastTime = 0;
let reducedMotion: MediaQueryList | undefined, sizeObserver: ResizeObserver | undefined;
function paintTurn() {
  const value = Math.max(0, Math.min(1, position));
  turnStage.value?.style.setProperty('--turn-angle', `${-90 * value}deg`);
  turnStage.value?.style.setProperty('--turn-retreat', `${Math.sin(Math.PI * value) * 210}px`);
  turnStage.value?.style.setProperty('--turn-tilt', `${Math.sin(Math.PI * value) * 4}deg`);
}
function settleTurn() { cancelAnimationFrame(frame); frame = 0; lastTime = 0; velocity = 0; position = target; turning.value = false; paintTurn(); }
function tickTurn(time: number) {
  const delta = lastTime ? Math.min((time - lastTime) / 1000, .032) : 1 / 60; lastTime = time;
  velocity += (160 * (target - position) - 25 * velocity) * delta; position += velocity * delta;
  if (Math.abs(target - position) < .0004 && Math.abs(velocity) < .006) { settleTurn(); return; }
  paintTurn(); frame = requestAnimationFrame(tickTurn);
}
function showStep(next: 'identity' | 'brain', event?: MouseEvent) {
  if (next === 'brain') {
    const name = configuredName.value.trim();
    if (!name || !/[\p{L}\p{N}]/u.test(name) || [...name].length > 32) { formatError.value = 'Choose a name with 1–32 characters.'; return; }
    formatError.value = '';
    if (heldNameError.value) return;
    configuredAvatar.value = identityAvatar.value;
  }
  // Focus leaves the outgoing panel before it becomes inert. Drafts remain mounted.
  (event?.currentTarget as HTMLElement | undefined)?.blur();
  dialogElement.value?.focus({ preventScroll: true });
  step.value = next; target = next === 'brain' ? 1 : 0;
  if (!event?.detail || motionPaused.value || reducedMotion?.matches) settleTurn();
  else { turning.value = true; if (!frame) { lastTime = 0; frame = requestAnimationFrame(tickTurn); } }
}
watch(() => props.open, open => {
  if (open) { if (!configuredName.value || configuredName.value === defaultName || (!supervisedUi.launch.view.value && heldNameMatch(configuredName.value, heldNames.value))) chooseDefaultName(); configuredAvatar.value ??= identityAvatar.value; step.value = props.initialSection ? 'brain' : 'identity'; target = step.value === 'brain' ? 1 : 0; }
  settleTurn();
}, { immediate: true });
// The room's names can arrive after the dialog opens. Move off a default
// name that turned out to be taken; leave a typed name to its warning.
watch(heldNames, () => {
  if (props.open && !supervisedUi.launch.view.value && configuredName.value === defaultName
    && heldNameMatch(defaultName, heldNames.value)) chooseDefaultName();
});
// A remembered launch may be restored after the modal opens. Its progress and
// recovery controls live on Brain; Identity is only for configuring a new agent.
watch(() => props.open && Boolean(supervisedUi.launch.view.value), active => {
  if (!active) return;
  if (step.value !== 'brain') dialogElement.value?.focus({ preventScroll: true });
  step.value = 'brain'; target = 1; settleTurn();
}, { immediate: true });
watch(motionPaused, () => { if (motionPaused.value) settleTurn(); });
function reduceTurn() { if (reducedMotion?.matches) settleTurn(); }
onMounted(() => {
  reducedMotion = matchMedia('(prefers-reduced-motion: reduce)'); reducedMotion.addEventListener('change', reduceTurn);
  sizeObserver = new ResizeObserver(() => turnStage.value?.style.setProperty('--turn-depth', `${(turnBody.value?.clientWidth || 620) / 2}px`));
  watch(turnBody, element => { sizeObserver?.disconnect(); if (element) sizeObserver?.observe(element); }, { immediate: true });
});
onBeforeUnmount(() => { cancelAnimationFrame(frame); sizeObserver?.disconnect(); reducedMotion?.removeEventListener('change', reduceTurn); });

return { dialogElement, openModelSettings, handleAfterLeave, handleDialogTab, handleRecoverSupervisedLaunch, step, identityError, takenNames, identityAvatar, motionPaused, turnBody, turnStage, turning, showStep };
}
