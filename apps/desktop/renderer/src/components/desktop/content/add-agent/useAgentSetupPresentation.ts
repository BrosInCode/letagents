import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import type { AgentAvatar as Avatar } from "../../../../../../../../src/shared/agent-avatar";
import type { AddAgentModalProps, AddAgentSupervisedUi } from "./useAddAgentController";
import type AddAgentOpenModelSettings from "./AddAgentOpenModelSettings.vue";
import { currentFocusableElement, restoreFocus, trapFocusInDialog } from "../modal-focus";

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

async function handleRecoverSupervisedLaunch(): Promise<void> {
  await supervisedUi.launch.recoverDetectedLaunch();
  if (supervisedUi.launch.recoveryCandidate.value) return;
  await nextTick();
  dialogElement.value?.querySelector<HTMLElement>('[data-testid="desktop-add-agent-supervised-runtime"], [data-testid="desktop-add-agent-supervised-lookup-error"]')?.focus();
}

const step = ref<'identity' | 'brain'>('identity');
const identityError = ref('');
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
    if (!name || !/[\p{L}\p{N}]/u.test(name) || [...name].length > 32) { identityError.value = 'Choose a name with 1–32 characters.'; return; }
    identityError.value = '';
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
  if (open) { if (!configuredName.value) configuredName.value = 'Atlas'; configuredAvatar.value ??= identityAvatar.value; step.value = props.initialSection ? 'brain' : 'identity'; target = step.value === 'brain' ? 1 : 0; }
  settleTurn();
}, { immediate: true });
watch(motionPaused, () => { if (motionPaused.value) settleTurn(); });
function reduceTurn() { if (reducedMotion?.matches) settleTurn(); }
onMounted(() => {
  reducedMotion = matchMedia('(prefers-reduced-motion: reduce)'); reducedMotion.addEventListener('change', reduceTurn);
  sizeObserver = new ResizeObserver(() => turnStage.value?.style.setProperty('--turn-depth', `${(turnBody.value?.clientWidth || 620) / 2}px`));
  watch(turnBody, element => { sizeObserver?.disconnect(); if (element) sizeObserver?.observe(element); }, { immediate: true });
});
onBeforeUnmount(() => { cancelAnimationFrame(frame); sizeObserver?.disconnect(); reducedMotion?.removeEventListener('change', reduceTurn); });

return { dialogElement, openModelSettings, handleAfterLeave, handleDialogTab, handleRecoverSupervisedLaunch, step, identityError, identityAvatar, motionPaused, turnBody, turnStage, turning, showStep };
}
