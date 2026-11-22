<template>
  <span ref="root" class="desktop-composer-agent-chip-wrap" data-testid="desktop-composer-agent-chip">
    <span ref="chipElement" class="desktop-composer-agent-chip" :data-launching="launching || undefined">
      <button ref="identityTrigger" type="button" class="desktop-composer-agent-identity-trigger" :disabled="launching"
        aria-label="Choose agent name and avatar" aria-haspopup="dialog" :aria-expanded="identityOpen"
        data-testid="desktop-composer-agent-identity-button" @click="showIdentity">
        <span ref="identityAvatarAnchor" class="desktop-composer-agent-avatar-anchor">
          <AgentAvatar :avatar="chip.avatar" :name="chip.displayName || providerName" :size="25" />
        </span>
        <span class="desktop-composer-agent-chip-copy">
          <span class="desktop-composer-agent-chip-who">{{ chip.displayName || `New ${providerName} agent` }}<template v-if="launching"> · starting…</template></span>
          <span class="desktop-composer-agent-chip-spec">Name &amp; avatar</span>
        </span>
      </button>
      <button
        ref="trigger"
        class="desktop-composer-agent-chip-open"
        type="button"
        aria-haspopup="dialog"
        :aria-expanded="open"
        :aria-controls="open ? menuId : undefined"
        :aria-label="`New ${providerName} agent settings: ${spec}`"
        :disabled="launching"
        data-testid="desktop-composer-agent-chip-button"
        @click="toggle($event)"
      >
        <span class="desktop-composer-agent-chip-mark" :data-provider="chip.providerId" :data-logo="chipIcon ? true : undefined" aria-hidden="true">
          <img v-if="chipIcon" :src="chipIcon" alt="" draggable="false" />
          <Bot v-else :size="13" />
        </span>
        <span class="desktop-composer-agent-chip-copy">
          <span class="desktop-composer-agent-chip-who">Settings</span>
          <span class="desktop-composer-agent-chip-spec">{{ spec }}</span>
        </span>
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

    <Teleport to="body">
    <div v-if="identityOpen" ref="identityPanel" class="desktop-composer-agent-identity" :style="identityPosition" role="dialog" aria-label="Agent identity"
      data-testid="desktop-composer-agent-identity" @keydown.esc.stop.prevent="closeIdentity" @keydown.tab="trapIdentityFocus">
      <header><strong>Make it yours</strong><button type="button" aria-label="Close agent identity" @click="closeIdentity"><X :size="17" /></button></header>
      <AgentIdentityPicker :model-value="identityAvatar" :name="identityName" compact
        @update:model-value="chooseAvatar" @update:name="updateIdentityName" />
      <footer><button type="button" @click="applyIdentity">Done <Check :size="15" /></button></footer>
    </div>
    </Teleport>

    <div
      v-if="coachVisible && !open && !identityOpen"
      class="desktop-composer-agent-coach"
      role="dialog"
      :aria-labelledby="`${menuId}-coach-title`"
      :aria-describedby="`${menuId}-coach-steps`"
      data-testid="desktop-composer-agent-coach"
    >
      <p :id="`${menuId}-coach-title`" class="desktop-composer-agent-coach-title">Two steps to start this agent</p>
      <ol :id="`${menuId}-coach-steps`">
        <li>Choose a name and avatar, or adjust the model{{ efforts.length ? ", effort" : "" }} and access in Settings.</li>
        <li>Type its first message, then press Enter.</li>
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
      role="dialog"
      :aria-label="view === 'where' ? 'Works in' : `New ${providerName} agent settings`"
      :data-animate="animate || undefined"
      data-testid="desktop-composer-agent-menu"
      @keydown="handleMenuKey"
      @pointermove="focusUnderPointer"
    >
      <template v-if="view === 'where'">
        <button type="button" tabindex="-1" class="desktop-composer-agent-menu-item" data-item="back" @click="showMain('where')">
          <ChevronLeft :size="14" aria-hidden="true" /><span class="desktop-composer-agent-menu-label">Works in</span>
        </button>
        <div class="desktop-composer-add-menu-separator" role="separator"></div>
        <div role="radiogroup" aria-label="Works in" class="desktop-composer-agent-group" data-fit>
        <button
          v-for="worktree in worktrees"
          :key="worktree.rootPath"
          type="button"
          role="radio"
          tabindex="-1"
          class="desktop-composer-agent-menu-item desktop-composer-agent-pick"
          :aria-checked="worktree.rootPath === repoRootPath"
          :data-item="`where:${worktree.rootPath}`"
          @click="emit('choose-worktree', worktree.rootPath)"
        >
          <span class="desktop-composer-agent-menu-label">{{ worktree.label }}</span>
          <Check v-if="worktree.rootPath === repoRootPath" class="desktop-composer-agent-tick" :size="15" aria-hidden="true" />
        </button>
        </div>
      </template>
      <template v-else>
        <div class="desktop-composer-agent-menu-head" aria-hidden="true">{{ modelHeading }}</div>
        <template v-if="readiness?.state === 'not_set_up'">
          <p class="desktop-composer-agent-menu-note">No endpoint or model yet.</p>
          <button type="button" tabindex="-1" class="desktop-composer-agent-menu-item" data-item="configure-open-model"
            data-testid="desktop-composer-agent-configure-open-model" @click="emit('configure-open-model')">
            <span class="desktop-composer-agent-menu-label">Configure Open Model…</span>
            <ChevronRight :size="14" class="desktop-composer-agent-menu-end" aria-hidden="true" />
          </button>
        </template>
        <div v-else role="radiogroup" :aria-label="modelHeading" class="desktop-composer-agent-group" data-fit>
        <button
          v-for="(model, index) in models"
          :key="model.id ?? ''"
          type="button"
          role="radio"
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
        </div>
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
          tabindex="-1"
          class="desktop-composer-agent-menu-item"
          :aria-haspopup="worktrees.length ? 'true' : undefined"
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
          <button type="button" tabindex="-1" class="desktop-composer-agent-menu-item" data-item="configure-open-model"
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
import { providerIconSrc } from "./provider-icon";
import AgentAvatar from "../../../../../../../../shared/ui/agent-identity/AgentAvatar.vue";
import AgentIdentityPicker from "../../../../../../../../shared/ui/agent-identity/AgentIdentityPicker.vue";
import type { AgentAvatar as AgentAvatarDescriptor } from "../../../../../../../../src/shared/agent-avatar";
import { captureAgentAvatarSource, flyAgentAvatar } from "./agent-avatar-flight";
import { composerIdentityPosition } from "./composer-identity-position";
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
  "set-identity": [identity: { displayName: string; avatar: AgentAvatarDescriptor | null }];
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
const identityOpen = ref(false);
const identityName = ref("");
const identityTrigger = ref<HTMLButtonElement | null>(null);
const identityAvatarAnchor = ref<HTMLElement | null>(null);
const identityPanel = ref<HTMLElement | null>(null);
const identityPosition = ref<Record<string, string>>({ visibility: "hidden" });
const animate = ref(false);
const view = ref<"main" | "where">("main");
const coachOff = ref(false);

const identityAvatar = computed<AgentAvatarDescriptor>(() => props.chip.avatar || { kind: "character", character: "orbit", color: "sage" });
const chipIcon = computed(() => providerIconSrc(props.chip.providerId));

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

function showIdentity(): void {
  if (props.launching) return;
  if (identityOpen.value) { closeIdentity(); return; }
  closeMenu();
  dismissCoach();
  identityName.value = props.chip.displayName || "";
  identityOpen.value = true;
  void nextTick(() => {
    fitIdentity();
    identityPanel.value?.querySelector<HTMLInputElement>(".identity-name")?.focus({ preventScroll: true });
  });
}
function fitIdentity(): void {
  if (!identityOpen.value || !identityTrigger.value || typeof window === "undefined") return;
  const visual = window.visualViewport;
  const placement = composerIdentityPosition(identityTrigger.value.getBoundingClientRect(), {
    left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0,
    width: visual?.width || window.innerWidth, height: visual?.height || window.innerHeight,
  });
  identityPosition.value = {
    left: `${placement.left}px`, width: `${placement.width}px`, maxHeight: `${placement.height}px`,
    top: placement.opensAbove ? "auto" : `${placement.top}px`,
    bottom: placement.opensAbove ? `${window.innerHeight - placement.top - placement.height}px` : "auto",
    visibility: "visible",
  };
}
function fitPopovers(): void { fitMenu(); fitIdentity(); }
function closeIdentity(): void {
  identityOpen.value = false;
  identityTrigger.value?.focus({ preventScroll: true });
}
function updateIdentityName(name: string): void {
  identityName.value = name;
  emit("set-identity", { displayName: name, avatar: identityAvatar.value });
}
function applyIdentity(): void {
  emit("set-identity", { displayName: identityName.value, avatar: identityAvatar.value });
  closeIdentity();
}
function chooseAvatar(avatar: AgentAvatarDescriptor | null): void {
  emit("set-identity", { displayName: identityName.value, avatar });
  void nextTick(() => {
    const selector = avatar?.kind === "character"
      ? `.identity-character-rail [data-character="${avatar.character}"] .agent-identity-avatar`
      : "[data-agent-avatar-source] .agent-identity-avatar";
    const source = captureAgentAvatarSource(identityPanel.value?.querySelector<HTMLElement>(selector) ?? null);
    flyAgentAvatar(source, identityAvatarAnchor.value);
  });
}
function trapIdentityFocus(event: KeyboardEvent): void {
  const controls = Array.from(identityPanel.value?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]') ?? [])
    .filter(element => element.getClientRects().length > 0);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}

/** A click with detail 0 came from the keyboard. */
function toggle(event: MouseEvent): void {
  if (open.value) {
    closeMenu();
    return;
  }
  dismissCoach();
  identityOpen.value = false;
  view.value = "main";
  animate.value = event.detail !== 0 && !prefersReducedMotion();
  open.value = true;
  emit("opened");
  void nextTick(() => {
    fitMenu();
    focusItem(checkedOrFirst());
  });
}

function closeMenu(): void {
  identityOpen.value = false;
  open.value = false;
  animate.value = false;
  view.value = "main";
}

function dismissCoach(): void {
  if (props.coachVisible) emit("coach-dismissed", coachOff.value);
}

function showWhere(): void {
  view.value = "where";
  void nextTick(() => {
    fitMenu();
    focusItem(checkedOrFirst());
  });
}

function showMain(from: string): void {
  view.value = "main";
  void nextTick(() => {
    fitMenu();
    focusItem(items().find((item) => item.dataset.item === from) ?? null);
  });
}

/**
 * The menu opens upward from the chip. When it is taller than the space above
 * (a short window, a long model list), the list scrolls instead of being cut off.
 */
function fitMenu(): void {
  const element = menu.value;
  if (typeof element?.querySelector !== "function" || !root.value) return;
  const list = element.querySelector<HTMLElement>("[data-fit]");
  if (!list) return;
  list.style.maxHeight = "";
  const room = root.value.getBoundingClientRect().top - 6 - clipTop(root.value) - 12;
  const over = element.offsetHeight - room;
  if (over > 0) list.style.maxHeight = `${Math.max(96, list.offsetHeight - over)}px`;
}

/** The lowest top edge of the window or of an ancestor that clips its overflow. */
function clipTop(from: HTMLElement): number {
  let top = 0;
  if (typeof getComputedStyle !== "function") return top;
  for (let node = from.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY !== "visible") top = Math.max(top, node.getBoundingClientRect().top);
  }
  return top;
}

/** Rows and sliders, in order; one of them holds the highlight. */
function items(): HTMLElement[] {
  return Array.from(menu.value?.querySelectorAll<HTMLElement>('[data-item]:not([aria-disabled="true"]), [role="slider"]') ?? []);
}

function checkedOrFirst(): HTMLElement | null {
  const list = items();
  return list.find((item) => item.getAttribute("aria-checked") === "true") ?? list.find((item) => item.dataset.item !== "back") ?? list[0] ?? null;
}

function focusItem(item: HTMLElement | null): void {
  if (!item || typeof document === "undefined" || document.activeElement === item) return;
  item.focus({ preventScroll: true });
  // Only the fitted list scrolls; bring a row in it into view.
  if (item.closest?.("[data-fit]")) item.scrollIntoView?.({ block: "nearest" });
}

// The pointer moves the one highlight; it never opens or closes anything.
function focusUnderPointer(event: PointerEvent): void {
  if ((event.buttons ?? 0) !== 0) return;
  const item = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-item], [role="slider"]');
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
  if (root.value && !root.value.contains(event.target as Node) && !identityPanel.value?.contains(event.target as Node)) closeMenu();
}
function closeOnEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape" || (menu.value?.contains(event.target as Node) || identityPanel.value?.contains(event.target as Node))) return;
  event.preventDefault();
  closeMenu();
}
function setDocumentListeners(listening: boolean): void {
  if (typeof document === "undefined") return;
  const method = listening ? "addEventListener" : "removeEventListener";
  document[method]("pointerdown", closeOnOutsidePointer as EventListener, true);
  document[method]("keydown", closeOnEscape as EventListener, true);
  if (typeof window !== "undefined") {
    window[method]("resize", fitPopovers);
    window[method]("scroll", fitIdentity, true);
    window.visualViewport?.[method]("resize", fitIdentity);
    window.visualViewport?.[method]("scroll", fitIdentity);
  }
}
watch(() => open.value || identityOpen.value, setDocumentListeners);
watch(() => props.launching, (launching) => { if (launching) closeMenu(); });
// Models arrive late (a CLI cache read); refit when the list changes under an open menu.
watch(() => props.models, () => { if (open.value) void nextTick(fitMenu); });
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

/** Opens the settings from the composer's notice, at the main list or straight at "Works in". */
function openAt(at: "main" | "where"): void {
  identityOpen.value = false;
  dismissCoach();
  animate.value = false;
  open.value = true;
  emit("opened");
  if (at === "where" && props.worktrees.length) showWhere();
  else {
    view.value = "main";
    void nextTick(() => {
      fitMenu();
      focusItem(checkedOrFirst());
    });
  }
}

defineExpose({ avatarElement: () => identityAvatarAnchor.value, close: closeMenu, open: openAt, isOpen: () => open.value || identityOpen.value, focus: () => trigger.value?.focus({ preventScroll: true }) });
</script>

<style scoped>
.desktop-composer-agent-identity{position:fixed;box-sizing:border-box;z-index:1000;overflow:auto;padding:18px;border:1px solid var(--border-strong);border-radius:24px;background:var(--bg-secondary,#111);color:var(--text);box-shadow:0 20px 70px #0005;overscroll-behavior:contain;animation:identity-arrive 220ms cubic-bezier(.2,.75,.2,1)}
.desktop-composer-agent-identity header,.desktop-composer-agent-identity footer{display:flex;align-items:center;justify-content:space-between;gap:12px}
.desktop-composer-agent-identity header{margin-bottom:16px;font-size:14px}
.desktop-composer-agent-identity header button{border:0;background:transparent;color:var(--text-secondary);padding:7px;cursor:pointer}
.desktop-composer-agent-identity footer{justify-content:flex-end;margin-top:14px}
.desktop-composer-agent-identity footer button{display:flex;align-items:center;gap:10px;border:0;border-radius:10px;padding:9px 14px;background:var(--text);color:var(--bg);font:inherit;cursor:pointer}
@keyframes identity-arrive{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.desktop-composer-agent-identity{animation:none}}
</style>
