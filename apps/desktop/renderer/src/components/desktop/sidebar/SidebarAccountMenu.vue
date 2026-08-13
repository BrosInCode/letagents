<template>
  <div ref="root" class="sidebar-account-shell">
    <Transition name="sidebar-account-menu">
      <div
        v-if="open"
        :id="menuId"
        ref="menu"
        class="sidebar-account-menu"
        role="menu"
        aria-label="Account menu"
        data-testid="sidebar-account-menu"
        @keydown.esc.stop.prevent="closeMenu(true)"
        @keydown.down.prevent="moveMenuFocus(1)"
        @keydown.up.prevent="moveMenuFocus(-1)"
        @focusout="handleMenuFocusOut"
      >
        <div class="sidebar-account-card">
          <AccountAvatar :auth-status="authStatus" size="large" />
          <span>
            <strong>{{ accountTitle }}</strong>
            <small>{{ accountSubtitle }}</small>
          </span>
        </div>
        <div class="sidebar-account-menu-items">
          <button
            type="button"
            role="menuitem"
            data-testid="sidebar-account-settings"
            @click="selectSettings"
          >
            <Settings aria-hidden="true" />
            <span>Settings</span>
          </button>
          <button
            v-if="authenticated"
            class="sidebar-account-logout"
            type="button"
            role="menuitem"
            :disabled="busy"
            data-testid="sidebar-account-logout"
            @click="selectSignOut"
          >
            <LoaderCircle v-if="busy" class="sidebar-account-spinner" aria-hidden="true" />
            <LogOut v-else aria-hidden="true" />
            <span>{{ busy ? "Logging out..." : "Log out" }}</span>
          </button>
          <button
            v-else
            type="button"
            role="menuitem"
            :disabled="busy"
            data-testid="sidebar-account-connect"
            @click="selectConnect"
          >
            <LoaderCircle v-if="busy" class="sidebar-account-spinner" aria-hidden="true" />
            <LogIn v-else aria-hidden="true" />
            <span>{{ busy ? "Connecting..." : "Connect GitHub" }}</span>
          </button>
        </div>
      </div>
    </Transition>

    <button
      ref="trigger"
      class="sidebar-account-trigger"
      type="button"
      aria-haspopup="menu"
      :aria-controls="menuId"
      :aria-expanded="open"
      data-testid="sidebar-account-trigger"
      @click="toggleMenu"
    >
      <AccountAvatar :auth-status="authStatus" size="small" />
      <span class="sidebar-account-trigger-copy">
        <strong>{{ accountTitle }}</strong>
        <small>{{ authenticated ? "GitHub connected" : "Signed out" }}</small>
      </span>
      <ChevronUp class="sidebar-account-chevron" aria-hidden="true" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { ChevronUp, LoaderCircle, LogIn, LogOut, Settings } from "@lucide/vue";
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DesktopAuthStatus } from "../../../../../electron/ipc-types";
import { wordInitials } from "../../../domain/initials";

const props = defineProps<{
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  "open-settings": [];
  connect: [];
  "sign-out": [];
}>();

const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const open = ref(false);
const menuId = "sidebar-account-menu";
const authenticated = computed(() => Boolean(props.authStatus?.authenticated && props.authStatus.account));
const accountTitle = computed(() => {
  const account = props.authStatus?.account;
  return authenticated.value && account
    ? account.displayName || account.login
    : "Connect GitHub";
});
const accountSubtitle = computed(() => {
  const account = props.authStatus?.account;
  return authenticated.value && account ? `@${account.login}` : "Sign in to manage rooms";
});

const AccountAvatar = defineComponent({
  props: {
    authStatus: { type: Object as () => DesktopAuthStatus | null, default: null },
    size: { type: String as () => "small" | "large", required: true },
  },
  setup(componentProps) {
    return () => {
      const account = componentProps.authStatus?.account;
      const label = account?.displayName || account?.login || "GitHub";
      if (componentProps.authStatus?.authenticated && account?.avatarUrl) {
        return h("img", {
          class: "sidebar-account-avatar",
          "data-size": componentProps.size,
          src: account.avatarUrl,
          alt: "",
          referrerpolicy: "no-referrer",
        });
      }
      return h(
        "span",
        {
          class: "sidebar-account-avatar",
          "data-size": componentProps.size,
          "data-signed-out": !componentProps.authStatus?.authenticated,
          "aria-hidden": "true",
        },
        componentProps.authStatus?.authenticated ? wordInitials(label, "LA") : "GH",
      );
    };
  },
});

function closeMenu(restoreFocus = false): void {
  open.value = false;
  if (restoreFocus) void nextTick(() => trigger.value?.focus());
}

function toggleMenu(): void {
  open.value = !open.value;
  if (open.value) {
    void nextTick(() => menu.value?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus());
  }
}

function selectSettings(): void {
  closeMenu();
  emit("open-settings");
}

function selectSignOut(): void {
  if (props.busy) return;
  closeMenu();
  emit("sign-out");
}

function selectConnect(): void {
  if (props.busy) return;
  closeMenu();
  emit("connect");
}

function moveMenuFocus(direction: 1 | -1): void {
  const items = Array.from(
    menu.value?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? [],
  );
  if (!items.length) return;
  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex = currentIndex < 0
    ? 0
    : (currentIndex + direction + items.length) % items.length;
  items[nextIndex]?.focus();
}

function handleMenuFocusOut(event: FocusEvent): void {
  const nextTarget = event.relatedTarget;
  if (nextTarget instanceof Node && root.value?.contains(nextTarget)) return;
  closeMenu();
}

function handleOutsidePointer(event: PointerEvent): void {
  if (open.value && !root.value?.contains(event.target as Node)) closeMenu();
}

watch(authenticated, () => closeMenu());
onMounted(() => document.addEventListener("pointerdown", handleOutsidePointer, true));
onBeforeUnmount(() => document.removeEventListener("pointerdown", handleOutsidePointer, true));
</script>

<style scoped>
.sidebar-account-shell {
  position: relative;
  margin-top: 6px;
}

.sidebar-account-trigger {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 48px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
}

.sidebar-account-trigger:hover,
.sidebar-account-trigger[aria-expanded="true"] {
  border-color: var(--border);
  background: var(--accent-hover);
}

.sidebar-account-trigger:focus-visible,
.sidebar-account-menu button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--blue) 58%, white);
  outline-offset: 1px;
}

.sidebar-account-avatar {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--green) 74%, #111827);
  color: white;
  object-fit: cover;
  font-weight: 720;
  letter-spacing: -0.02em;
}

.sidebar-account-avatar[data-size="small"] { width: 30px; height: 30px; font-size: 0.67rem; }
.sidebar-account-avatar[data-size="large"] { width: 38px; height: 38px; font-size: 0.74rem; }
.sidebar-account-avatar[data-signed-out="true"] { background: var(--accent-active); color: var(--text-secondary); }

.sidebar-account-trigger-copy,
.sidebar-account-card > span {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.sidebar-account-trigger-copy strong,
.sidebar-account-card strong {
  overflow: hidden;
  font-size: 0.86rem;
  font-weight: 660;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-account-trigger-copy small,
.sidebar-account-card small {
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: 0.68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-account-chevron {
  width: 15px;
  color: var(--text-tertiary);
  transition: transform var(--duration-fast) var(--ease-out);
}

.sidebar-account-trigger[aria-expanded="true"] .sidebar-account-chevron { transform: rotate(180deg); }

.sidebar-account-menu {
  position: absolute;
  z-index: 50;
  right: 0;
  bottom: calc(100% + 8px);
  left: 0;
  overflow: hidden;
  padding: 6px;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-elevated) 96%, transparent);
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(18px) saturate(1.18);
}

.sidebar-account-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-height: 58px;
  padding: 7px 8px 10px;
  border-bottom: 1px solid var(--border);
}

.sidebar-account-menu-items { display: grid; gap: 2px; padding-top: 5px; }

.sidebar-account-menu button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 0.82rem;
  text-align: left;
  cursor: pointer;
}

.sidebar-account-menu button:hover:not(:disabled) { background: var(--accent-hover); color: var(--text); }
.sidebar-account-menu button:disabled { opacity: 0.52; cursor: default; }
.sidebar-account-menu button svg { width: 16px; height: 16px; }
.sidebar-account-menu .sidebar-account-logout:hover:not(:disabled) { background: var(--red-dim); color: var(--red); }

.sidebar-account-spinner { animation: sidebar-account-spin 0.9s linear infinite; }
@keyframes sidebar-account-spin { to { transform: rotate(360deg); } }

.sidebar-account-menu-enter-active,
.sidebar-account-menu-leave-active {
  transition: opacity 120ms var(--ease-out), transform 150ms var(--ease-out);
  transform-origin: bottom center;
}
.sidebar-account-menu-enter-from,
.sidebar-account-menu-leave-to { opacity: 0; transform: translateY(4px) scale(0.985); }

@media (prefers-reduced-motion: reduce) {
  .sidebar-account-chevron,
  .sidebar-account-menu-enter-active,
  .sidebar-account-menu-leave-active { transition: none; }
  .sidebar-account-spinner { animation: none; }
}
</style>
