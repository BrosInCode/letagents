<template>
  <span ref="root" class="desktop-composer-agent-chip-wrap" data-testid="desktop-composer-agent-chip">
    <span ref="chipElement" class="desktop-composer-agent-chip" :data-launching="launching || undefined">
      <button
        ref="trigger"
        class="desktop-composer-agent-chip-open"
        type="button"
        aria-haspopup="menu"
        :aria-expanded="open"
        :aria-controls="open ? menuId : undefined"
        :aria-label="`New ${providerName} agent settings: ${spec}`"
        :disabled="launching"
        data-testid="desktop-composer-agent-chip-button"
        @click="toggle($event)"
      >
        <span class="desktop-composer-agent-chip-mark" :data-provider="chip.providerId" aria-hidden="true"><Bot :size="13" /></span>
        <span class="desktop-composer-agent-chip-who">New {{ providerName }} agent<template v-if="launching"> · starting…</template></span>
        <span class="desktop-composer-agent-chip-spec">{{ spec }}</span>
        <ChevronUp class="desktop-composer-agent-chip-caret" :size="12" aria-hidden="true" />
      </button>
      <button
        v-if="!launching"
        class="desktop-composer-agent-chip-remove"
        type="button"
        :aria-label="`Remove new ${providerName} agent`"
        data-testid="desktop-composer-agent-chip-remove"
        @click="emit('remove')"
      >
        <X :size="14" aria-hidden="true" />
      </button>
    </span>

    <div
      v-if="coachVisible && !open"
      class="desktop-composer-agent-coach"
      role="dialog"
      aria-label="How to start this agent"
      data-testid="desktop-composer-agent-coach"
    >
      <p class="desktop-composer-agent-coach-title">Two steps to start this agent</p>
      <ol>
        <li>Click the chip to choose the model{{ efforts.length ? ", effort" : "" }} and access.</li>
        <li>Type its first task, then press Enter.</li>
      </ol>
      <p v-if="fellBackLine" class="desktop-composer-agent-coach-note">{{ fellBackLine }}</p>
      <div class="desktop-composer-agent-coach-foot">
        <label><input v-model="coachOff" type="checkbox" data-testid="desktop-composer-agent-coach-off"> Don't show again</label>
        <button type="button" data-testid="desktop-composer-agent-coach-ok" @click="dismissCoach">Got it</button>
      </div>
    </div>

    <div
      v-if="open"
      :id="menuId"
      ref="menu"
      class="desktop-composer-agent-menu"
      role="menu"
      :aria-label="view === 'where' ? 'Works in' : `New ${providerName} agent settings`"
      :data-animate="animate || undefined"
      data-testid="desktop-composer-agent-menu"
      @keydown="handleMenuKey"
      @pointermove="focusUnderPointer"
    >
      <template v-if="view === 'where'">
        <button type="button" role="menuitem" tabindex="-1" class="desktop-composer-agent-menu-item" data-item="back" @click="showMain('where')">
          <ChevronLeft :size="14" aria-hidden="true" /><span class="desktop-composer-agent-menu-label">Works in</span>
        </button>
        <div class="desktop-composer-add-menu-separator" role="separator"></div>
        <button
          v-for="worktree in worktrees"
          :key="worktree.rootPath"
          type="button"
          role="menuitemradio"
          tabindex="-1"
          class="desktop-composer-agent-menu-item desktop-composer-agent-pick"
          :aria-checked="worktree.rootPath === repoRootPath"
          :data-item="`where:${worktree.rootPath}`"
          @click="emit('choose-worktree', worktree.rootPath)"
        >
          <span class="desktop-composer-agent-menu-label">{{ worktree.label }}</span>
          <Check v-if="worktree.rootPath === repoRootPath" class="desktop-composer-agent-tick" :size="15" aria-hidden="true" />
        </button>
      </template>
      <template v-else>
        <div class="desktop-composer-agent-menu-head">{{ modelHeading }}</div>
        <template v-if="readiness?.state === 'not_set_up'">
          <p class="desktop-composer-agent-menu-note">No endpoint or model yet.</p>
          <button type="button" role="menuitem" tabindex="-1" class="desktop-composer-agent-menu-item" data-item="configure-open-model"
            data-testid="desktop-composer-agent-configure-open-model" @click="emit('configure-open-model')">
            <span class="desktop-composer-agent-menu-label">Configure Open Model…</span>
            <ChevronRight :size="14" class="desktop-composer-agent-menu-end" aria-hidden="true" />
          </button>
        </template>
        <template v-else>
        <button
          v-for="(model, index) in models"
          :key="model.id ?? ''"
          type="button"
          role="menuitemradio"
          tabindex="-1"
          class="desktop-composer-agent-menu-item desktop-composer-agent-pick"
          :class="{ 'desktop-composer-agent-mono': chip.providerId === 'open-model' }"
          :aria-checked="model.id === chip.model"
          :data-item="`model:${model.id ?? ''}`"
          @click="emit('set-model', model.id)"
        >
          <span class="desktop-composer-agent-menu-label">{{ model.label }}</span>
          <Check v-if="model.id === chip.model" class="desktop-composer-agent-tick" :size="15" aria-hidden="true" />
          <span v-if="index < 9" class="desktop-composer-agent-menu-end">{{ index + 1 }}</span>
        </button>
        </template>
        <div class="desktop-composer-add-menu-separator" role="separator"></div>
        <ComposerStepSlider
          v-if="efforts.length"
          kind="effort"
          label="Effort"
          :stops="efforts.map(option => option.label)"
          :index="Math.max(0, efforts.findIndex(option => option.value === chip.effort))"
          @update:index="emit('set-effort', efforts[$event]!.value)"
        />
        <ComposerStepSlider
          v-if="accessStops.length"
          kind="access"
          label="Access"
          :stops="accessStops.map(profile => profile.label)"
          :index="Math.max(0, accessStops.findIndex(profile => profile.id === chip.access))"
          :note="accessNote"
          @update:index="emit('set-access', accessStops[$event]!.id)"
        />
        <div class="desktop-composer-add-menu-separator" role="separator"></div>
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="desktop-composer-agent-menu-item"
          :aria-haspopup="worktrees.length ? 'menu' : undefined"
          :aria-disabled="worktrees.length ? undefined : 'true'"
          data-item="where"
          data-testid="desktop-composer-agent-works-in"
          @click="worktrees.length && showWhere()"
        >
          <span class="desktop-composer-agent-menu-label">Works in</span>
          <span class="desktop-composer-agent-menu-value">{{ worksIn }}</span>
          <ChevronRight v-if="worktrees.length" :size="14" class="desktop-composer-agent-menu-end" aria-hidden="true" />
        </button>
        <template v-if="chip.providerId === 'open-model' && readiness?.state !== 'not_set_up'">
          <div class="desktop-composer-add-menu-separator" role="separator"></div>
          <button type="button" role="menuitem" tabindex="-1" class="desktop-composer-agent-menu-item" data-item="configure-open-model"
            data-testid="desktop-composer-agent-configure-open-model" @click="emit('configure-open-model')">
            <span class="desktop-composer-agent-menu-label">Configure Open Model…</span>
            <span v-if="openModelHost" class="desktop-composer-agent-menu-value">{{ openModelHost }}</span>
            <ChevronRight :size="14" class="desktop-composer-agent-menu-end" aria-hidden="true" />
          </button>
        </template>
      </template>
    </div>
  </span>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Bot, Check, ChevronLeft, ChevronRight, ChevronUp, X } from "@lucide/vue";
import type {
  DesktopManagedAgentEffort,
  DesktopManagedAgentPermissionProfile,
  DesktopManagedAgentPermissionProfileId,
} from "../../../../../../electron/ipc-types";
import ComposerStepSlider from "./ComposerStepSlider.vue";
import type { ComposerAgentReadiness } from "./composer-agent-launch";
import type { ComposerAgentChip } from "./useComposerAgentDraft";

export interface ComposerAgentWorktreeOption {
  rootPath: string;
  label: string;
}

const props = defineProps<{
  chip: ComposerAgentChip;
  providerName: string;
  readiness: ComposerAgentReadiness | null;
  models: ReadonlyArray<{ id: string | null; label: string }>;
  efforts: ReadonlyArray<{ value: DesktopManagedAgentEffort | ""; label: string }>;
  accessStops: readonly DesktopManagedAgentPermissionProfile[];
  worksIn: string;
  worktrees: readonly ComposerAgentWorktreeOption[];
  repoRootPath: string | null;
  openModelHost: string | null;
  launching: boolean;
  coachVisible: boolean;
  /** The personal default this chip could not use, named in the coach hint. */
  wantedAccessLabel: string | null;
  /** Where the chosen menu row was, so the chip can grow out of it. */
  fromRect?: DOMRect | null;
}>();

const emit = defineEmits<{
  "set-model": [model: string | null];
  "set-effort": [effort: DesktopManagedAgentEffort | ""];
  "set-access": [access: DesktopManagedAgentPermissionProfileId];
  "choose-worktree": [rootPath: string];
  "configure-open-model": [];
  "opened": [];
  remove: [];
  "coach-dismissed": [dontShowAgain: boolean];
  /** The popover closed from inside (Escape); the composer takes focus back. */
  dismiss: [];
}>();

const menuId = `desktop-composer-agent-menu-${Math.random().toString(36).slice(2, 10)}`;
const root = ref<HTMLElement | null>(null);
const chipElement = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const open = ref(false);
const animate = ref(false);
const view = ref<"main" | "where">("main");
const coachOff = ref(false);

const spec = computed(() => {
  const bits: string[] = [];
  if (props.readiness?.state === "not_set_up") bits.push("Not set up");
  else bits.push(props.models.find((model) => model.id === props.chip.model)?.label.replace(/^Default \(.*\)$/, "Default") ?? props.chip.model ?? "Default");
  const effort = props.efforts.find((option) => option.value === props.chip.effort);
  if (effort && effort.value) bits.push(effort.label);
  const access = props.accessStops.find((profile) => profile.id === props.chip.access);
  if (access) bits.push(access.label);
  return bits.join(" · ");
});
const modelHeading = computed(() => props.chip.providerId === "open-model"
  ? props.openModelHost && props.readiness?.state !== "not_set_up" ? `Model · ${props.openModelHost}` : "Model"
  : `${props.providerName} model`);
// Only Open Model's own Auto, which LetAgents and Jev built, carries a line.
const accessNote = computed(() => props.chip.providerId === "open-model" && props.chip.access === "auto_review"
  ? "LetAgents and Jev review each command before it runs. Routine commands and project edits run without asking."
  : null);
const fellBackLine = computed(() => {
  if (!props.chip.fellBack || !props.wantedAccessLabel) return null;
  const access = props.accessStops.find((profile) => profile.id === props.chip.access);
  return access ? `${props.providerName} has no ${props.wantedAccessLabel}, so it starts with ${access.label}.` : null;
});

/** A click with detail 0 came from the keyboard. */
function toggle(event: MouseEvent): void {
  if (open.value) {
    closeMenu();
    return;
  }
  dismissCoach();
  view.value = "main";
  animate.value = event.detail !== 0 && !prefersReducedMotion();
  open.value = true;
  emit("opened");
  void nextTick(() => focusItem(checkedOrFirst()));
}

function closeMenu(): void {
  open.value = false;
  animate.value = false;
  view.value = "main";
}

function dismissCoach(): void {
  if (props.coachVisible) emit("coach-dismissed", coachOff.value);
}

function showWhere(): void {
  view.value = "where";
  void nextTick(() => focusItem(checkedOrFirst()));
}

function showMain(from: string): void {
  view.value = "main";
  void nextTick(() => focusItem(items().find((item) => item.dataset.item === from) ?? null));
}

/** Rows and sliders, in order; one of them holds the highlight. */
function items(): HTMLElement[] {
  return Array.from(menu.value?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"]), [role="slider"]') ?? []);
}

function checkedOrFirst(): HTMLElement | null {
  const list = items();
  return list.find((item) => item.getAttribute("aria-checked") === "true") ?? list.find((item) => item.dataset.item !== "back") ?? list[0] ?? null;
}

function focusItem(item: HTMLElement | null): void {
  if (item && typeof document !== "undefined" && document.activeElement !== item) item.focus({ preventScroll: true });
}

// The pointer moves the one highlight; it never opens or closes anything.
function focusUnderPointer(event: PointerEvent): void {
  if ((event.buttons ?? 0) !== 0) return;
  const item = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[role^="menuitem"], [role="slider"]');
  if (item && item.getAttribute("aria-disabled") !== "true" && menu.value?.contains(item)) focusItem(item);
}

function handleMenuKey(event: KeyboardEvent): void {
  const list = items();
  const index = list.indexOf(event.target as HTMLElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!list.length) return;
    focusItem(list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length] ?? null);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    focusItem((event.key === "Home" ? list[0] : list.at(-1)) ?? null);
  } else if (event.key === "Escape" || (event.key === "ArrowLeft" && view.value === "where")) {
    event.preventDefault();
    event.stopPropagation();
    if (view.value === "where") showMain("where");
    else {
      closeMenu();
      emit("dismiss");
    }
  } else if (event.key === "ArrowRight" && (event.target as HTMLElement).dataset?.item === "where" && props.worktrees.length) {
    event.preventDefault();
    showWhere();
  } else if (view.value === "main" && /^[1-9]$/.test(event.key) && props.readiness?.state !== "not_set_up") {
    const model = props.models[Number(event.key) - 1];
    if (!model) return;
    event.preventDefault();
    emit("set-model", model.id);
    void nextTick(() => focusItem(items().find((item) => item.dataset.item === `model:${model.id ?? ""}`) ?? null));
  }
  // Tab moves focus as usual; the popover stays open until a click outside or Escape.
}

function closeOnOutsidePointer(event: PointerEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) closeMenu();
}
function closeOnEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape" || menu.value?.contains(event.target as Node)) return;
  event.preventDefault();
  closeMenu();
}
function setDocumentListeners(listening: boolean): void {
  if (typeof document === "undefined") return;
  const method = listening ? "addEventListener" : "removeEventListener";
  document[method]("pointerdown", closeOnOutsidePointer as EventListener, true);
  document[method]("keydown", closeOnEscape as EventListener, true);
}
watch(open, setDocumentListeners);
watch(() => props.launching, (launching) => { if (launching) closeMenu(); });
onBeforeUnmount(() => setDocumentListeners(false));

// The chosen row travels into the tray and becomes the chip.
onMounted(() => {
  const from = props.fromRect;
  const element = chipElement.value;
  if (!from || !element || prefersReducedMotion() || typeof element.animate !== "function") return;
  const to = element.getBoundingClientRect();
  if (!to.width || !to.height) return;
  element.animate([
    { transformOrigin: "0 0", transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`, opacity: 0.6 },
    { transformOrigin: "0 0", transform: "none", opacity: 1 },
  ], { duration: 340, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
});

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

defineExpose({ close: closeMenu, isOpen: () => open.value, focus: () => trigger.value?.focus({ preventScroll: true }) });
</script>
