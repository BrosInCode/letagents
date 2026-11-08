<template>
  <button
    ref="trigger"
    class="company-scope-trigger"
    type="button"
    aria-haspopup="menu"
    :aria-controls="menuId"
    :aria-expanded="open"
    :aria-label="triggerLabel"
    data-testid="sidebar-company-scope"
    @click="toggleMenu"
  >
    <template v-if="selected">
      <CompanyAvatar :login="selected.login" :avatar-url="selected.avatar_url" size="s" />
      <strong>{{ selected.login }}</strong>
    </template>
    <span v-else class="sidebar-heading">Rooms</span>
    <span v-if="needsAttention" class="company-scope-dot" aria-hidden="true" />
    <ChevronDown class="company-scope-chevron" aria-hidden="true" />
  </button>

  <Teleport to="body">
    <Transition name="company-scope-menu">
      <div
        v-if="open"
        :id="menuId"
        ref="menu"
        class="company-scope-menu"
        role="menu"
        aria-label="Show rooms from"
        :style="menuPosition"
        data-testid="sidebar-company-menu"
        @keydown.esc.stop.prevent="closeMenu(true)"
        @keydown.down.prevent="moveFocus(1)"
        @keydown.up.prevent="moveFocus(-1)"
        @keydown.tab="closeMenu()"
      >
        <div class="company-scope-label">Show rooms from</div>
        <button
          class="company-scope-item"
          type="button"
          role="menuitemradio"
          :aria-checked="!state.selectedId"
          data-testid="company-menu-all"
          @click="choose(null)"
        >
          <CompanyAvatar all size="m" />
          <span>All rooms<small>No company filter</small></span>
          <Check class="company-scope-tick" aria-hidden="true" />
        </button>
        <button
          v-for="org in state.organizations"
          :key="org.github_org_id"
          class="company-scope-item"
          type="button"
          role="menuitemradio"
          :aria-checked="state.selectedId === org.github_org_id"
          :aria-disabled="!org.setup && org.role !== 'owner' ? 'true' : undefined"
          :data-testid="`company-menu-${org.github_org_id}`"
          @click="choose(org.github_org_id)"
        >
          <CompanyAvatar :login="org.login" :avatar-url="org.avatar_url" size="m" />
          <span>{{ org.login }}<small>{{ organizationDetail(org) }}</small></span>
          <Check v-if="state.selectedId === org.github_org_id || org.joined || (!org.setup && org.role !== 'owner')" class="company-scope-tick" aria-hidden="true" />
          <span v-else class="company-scope-tag">{{ org.setup ? "Join" : "Set up" }}</span>
        </button>

        <template v-if="githubSteps.length || state.status === 'github_access_required'">
          <hr>
          <button
            v-if="state.status === 'github_access_required'"
            class="company-scope-item company-scope-action"
            type="button"
            role="menuitem"
            data-testid="company-menu-allow"
            @click="openGitHub({ kind: 'allow' })"
          >
            <span class="company-scope-icon"><GitHubMark /></span>
            <span>{{ state.accessReason === "signin" ? "Reconnect GitHub" : "Allow LetAgents to see your organizations" }}</span>
          </button>
          <button
            v-for="step in githubSteps"
            :key="step.key"
            class="company-scope-item company-scope-action"
            type="button"
            role="menuitem"
            @click="openGitHub(step.page)"
          >
            <CompanyAvatar :login="step.name" :avatar-url="step.avatarUrl" size="m" />
            <span>{{ step.name }}<small>{{ step.detail }}</small></span>
            <ExternalLink class="company-scope-tick company-scope-external" aria-hidden="true" />
          </button>
        </template>

        <hr>
        <button
          v-if="selected"
          class="company-scope-item company-scope-action"
          type="button"
          role="menuitem"
          data-testid="company-menu-copy-link"
          @click="copyLink"
        >
          <span class="company-scope-icon"><Link2 aria-hidden="true" /></span>
          <span>Copy {{ selected.login }} link</span>
        </button>
        <button
          class="company-scope-item company-scope-action"
          type="button"
          role="menuitem"
          :disabled="state.status === 'loading'"
          data-testid="company-menu-refresh"
          @click="refresh"
        >
          <span class="company-scope-icon"><RefreshCw aria-hidden="true" /></span>
          <span>{{ state.status === "loading" ? "Checking GitHub…" : "Refresh from GitHub" }}</span>
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Check, ChevronDown, ExternalLink, Link2, RefreshCw } from "@lucide/vue";
import type { DesktopOrganization, DesktopOrganizationGitHubPage } from "../../../../../electron/ipc-types/organizations.js";
import type { FirstRunCompanyStepState } from "../setup/types";
import CompanyAvatar from "../company/CompanyAvatar.vue";
import GitHubMark from "../company/GitHubMark.vue";

const props = defineProps<{
  state: FirstRunCompanyStepState;
  /** The number of rooms the selected company lists. */
  roomCount: number;
}>();

const emit = defineEmits<{
  choose: [id: string | null];
  refresh: [];
  "open-github": [page: DesktopOrganizationGitHubPage];
  "copy-link": [];
}>();

const menuId = "sidebar-company-menu";
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const open = ref(false);
const anchor = ref<{ top: number; left: number } | null>(null);

const selected = computed(() => props.state.organizations.find((org) => org.github_org_id === props.state.selectedId) ?? null);
const triggerLabel = computed(() => `Rooms: ${selected.value ? selected.value.login : "all rooms"}. Change company`);
/** A dot on the trigger: something on GitHub waits for the person. */
const needsAttention = computed(() => props.state.status === "github_access_required"
  || props.state.invitations.length > 0 || props.state.ssoRequired.length > 0);
const menuPosition = computed(() => anchor.value
  ? { top: `${anchor.value.top}px`, left: `${anchor.value.left}px` }
  : undefined);

const githubSteps = computed(() => [
  ...props.state.invitations.map((invite) => ({
    key: `invite-${invite.github_org_id}`,
    name: invite.login,
    avatarUrl: invite.avatar_url,
    detail: "Invited on GitHub · Accept it there",
    page: { kind: "invitation", login: invite.login } as DesktopOrganizationGitHubPage,
  })),
  ...props.state.ssoRequired.map((block) => ({
    key: `sso-${block.github_org_id}`,
    name: block.login ?? "Single sign-on organization",
    avatarUrl: null,
    detail: "Authorize LetAgents on GitHub",
    page: (block.login ? { kind: "sso", login: block.login } : { kind: "allow" }) as DesktopOrganizationGitHubPage,
  })),
]);

function organizationDetail(org: DesktopOrganization): string {
  const role = org.role === "owner" ? "Owner" : "Member";
  if (org.github_org_id === props.state.selectedId) {
    return `${role} · ${props.roomCount} ${props.roomCount === 1 ? "room" : "rooms"}`;
  }
  if (org.joined) return role;
  if (org.setup) return `${role} · Not joined yet`;
  if (org.role === "owner") return "Owner · Not set up in LetAgents yet";
  return "Waiting for an owner to set it up";
}

function placeMenu(): void {
  const bounds = trigger.value?.getBoundingClientRect();
  if (!bounds) return;
  const width = Math.min(300, window.innerWidth - 16);
  anchor.value = { top: Math.round(bounds.bottom + 4), left: Math.round(Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))) };
}

function toggleMenu(): void {
  if (open.value) {
    closeMenu();
    return;
  }
  placeMenu();
  open.value = true;
  void nextTick(() => {
    const items = menuItems();
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  });
}

function closeMenu(restoreFocus = false): void {
  open.value = false;
  if (restoreFocus) void nextTick(() => trigger.value?.focus());
}

function menuItems(): HTMLButtonElement[] {
  return Array.from(menu.value?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']:not(:disabled)") ?? []);
}

function moveFocus(direction: 1 | -1): void {
  const items = menuItems();
  if (!items.length) return;
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(index + direction + items.length) % items.length]?.focus();
}

function choose(id: string | null): void {
  const org = id ? props.state.organizations.find((item) => item.github_org_id === id) : null;
  if (org && !org.setup && org.role !== "owner") return;
  closeMenu(true);
  emit("choose", id);
}

function openGitHub(page: DesktopOrganizationGitHubPage): void {
  closeMenu(true);
  emit("open-github", page);
}

function copyLink(): void {
  closeMenu(true);
  emit("copy-link");
}

function refresh(): void {
  closeMenu(true);
  emit("refresh");
}

function handleOutsidePointer(event: PointerEvent): void {
  const target = event.target as Node;
  if (open.value && !menu.value?.contains(target) && !trigger.value?.contains(target)) closeMenu();
}

watch(() => props.state.selectedId, () => closeMenu());
onMounted(() => {
  document.addEventListener("pointerdown", handleOutsidePointer, true);
  window.addEventListener("resize", closeMenuOnResize);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", handleOutsidePointer, true);
  window.removeEventListener("resize", closeMenuOnResize);
});

function closeMenuOnResize(): void {
  if (open.value) closeMenu();
}

defineExpose({ close: closeMenu });
</script>

<style scoped>
.company-scope-trigger {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  height: 26px;
  margin-left: -1px;
  padding: 0 7px 0 5px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 150ms ease, color 150ms ease;
}

.company-scope-trigger strong {
  overflow: hidden;
  color: var(--text);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.company-scope-trigger .sidebar-heading {
  flex: none;
}

.company-scope-trigger[aria-expanded="true"] {
  background: var(--accent-hover);
  color: var(--text);
}

.company-scope-trigger:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--text) 28%, transparent);
  outline-offset: 1px;
}

.company-scope-chevron {
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--text-tertiary);
  transition: transform 160ms var(--ease-out);
}

.company-scope-trigger[aria-expanded="true"] .company-scope-chevron {
  transform: rotate(180deg);
}

.company-scope-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--amber, #f59e0b);
}

.company-scope-menu {
  position: fixed;
  z-index: 80;
  width: min(300px, calc(100vw - 16px));
  padding: 6px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-lg);
  transform-origin: top left;
}

.company-scope-label {
  padding: 8px 10px 6px;
  color: var(--text-tertiary);
  font-size: 11.5px;
  font-weight: 500;
}

.company-scope-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  width: 100%;
  min-height: 40px;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;
}

.company-scope-item > span:not(.company-scope-icon):not(.company-scope-tag) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.company-scope-item small {
  display: block;
  overflow: hidden;
  margin-top: 1px;
  color: var(--text-tertiary);
  font-size: 11.5px;
  text-overflow: ellipsis;
}

.company-scope-item:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--text) 24%, transparent);
  outline-offset: -2px;
}

.company-scope-item[aria-disabled="true"] {
  cursor: default;
}

.company-scope-item[aria-disabled="true"] > :not(.company-scope-tick) {
  opacity: 0.5;
}

.company-scope-item:disabled {
  cursor: default;
  opacity: 0.55;
}

.company-scope-tick {
  width: 16px;
  height: 16px;
  color: var(--text);
  opacity: 0;
}

.company-scope-item[aria-checked="true"] .company-scope-tick,
.company-scope-external {
  opacity: 1;
}

.company-scope-external {
  color: var(--text-tertiary);
}

.company-scope-tag {
  padding: 2px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  color: var(--text-secondary);
  font-size: 11.5px;
}

.company-scope-action {
  grid-template-columns: auto minmax(0, 1fr) auto;
  min-height: 34px;
  color: var(--text-secondary);
}

.company-scope-icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  color: var(--text-secondary);
}

.company-scope-icon svg {
  width: 16px;
  height: 16px;
}

.company-scope-menu hr {
  margin: 6px 4px;
  border: 0;
  border-top: 1px solid var(--border);
}

.company-scope-menu-enter-active,
.company-scope-menu-leave-active {
  transition: opacity 150ms ease, transform 160ms var(--ease-out);
}

.company-scope-menu-enter-from,
.company-scope-menu-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(-4px);
}

@media (hover: hover) and (pointer: fine) {
  .company-scope-trigger:hover {
    background: var(--accent-hover);
    color: var(--text);
  }

  .company-scope-item:not([aria-disabled="true"]):not(:disabled):hover {
    background: var(--accent-hover);
    color: var(--text);
  }
}

@media (prefers-reduced-motion: reduce) {
  .company-scope-chevron,
  .company-scope-menu-enter-active,
  .company-scope-menu-leave-active {
    transition: none;
  }
}
</style>
