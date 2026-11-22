import { computed, hasInjectionContext, inject, onMounted, onUnmounted, provide, ref, watch, type InjectionKey, type Ref } from "vue";
import { chatBubbleStyle, chatColorRoles, type ChatColorRole } from "../chat-colors";
import { roomThemeId, roomThemePreset, type RoomCompanyAppearance, type RoomThemeId } from "../room-themes.mjs";

export function roomThemeStyle(id: RoomThemeId | null) {
  const theme = roomThemePreset(id);
  return theme ? {
    "--workspace-accent": `light-dark(${theme.lightAccent}, ${theme.accent})`,
    "--workspace-selection": `light-dark(${theme.lightAccent}, ${theme.accent})`,
    "--workspace-canvas": `light-dark(color-mix(in srgb, ${theme.lightAccent} 5%, white), color-mix(in srgb, ${theme.accent} 8%, #0a0a0a))`,
    "--workspace-sidebar": `light-dark(color-mix(in srgb, ${theme.lightAccent} 9%, white), color-mix(in srgb, ${theme.accent} 5%, #111111))`,
    "--workspace-composer": `light-dark(color-mix(in srgb, ${theme.lightAccent} 9%, white), color-mix(in srgb, ${theme.accent} 14%, #151515))`,
    "--workspace-border": `light-dark(color-mix(in srgb, ${theme.lightAccent} 28%, white), color-mix(in srgb, ${theme.accent} 30%, #171717))`,
  } : {};
}

const bubbleTints = {
  self: { dark: .42, light: .16 },
  "own-agent": { dark: .34, light: .14 },
  human: { dark: .21, light: .08 },
  "other-agent": { dark: .28, light: .11 },
} satisfies Record<ChatColorRole, { dark: number; light: number }>;

export function themeChatBubble(id: RoomThemeId, role: ChatColorRole) {
  const preset = roomThemePreset(id)!;
  const { dark, light } = bubbleTints[role];
  const darkStyle = chatBubbleStyle(tint(preset.accent, "#16171A", dark));
  const lightStyle = chatBubbleStyle(tint(preset.lightAccent, "#FFFFFF", light));
  return Object.fromEntries(Object.entries(darkStyle).map(([key, value]) => [
    key, `light-dark(${lightStyle[key]}, ${value})`,
  ]));
}

function tint(accent: string, base: string, amount: number) {
  return "#" + [1, 3, 5].map(index => {
    const foreground = parseInt(accent.slice(index, index + 2), 16);
    const background = parseInt(base.slice(index, index + 2), 16);
    return Math.round(background + (foreground - background) * amount).toString(16).padStart(2, "0");
  }).join("");
}

const roomThemeKey: InjectionKey<ReturnType<typeof provideRoomTheme>> = Symbol("room-theme");

export function provideRoomTheme(accountKey: Readonly<Ref<string | null>>, company: Readonly<Ref<RoomCompanyAppearance | null>>) {
  const personal = ref<RoomThemeId | null>(null);
  const key = computed(() => accountKey.value ? `letagents:room-theme:v1:${accountKey.value}` : null);
  const storageAvailable = ref(true);

  function restore() {
    personal.value = null;
    if (!key.value) return;
    try {
      personal.value = roomThemeId(window.localStorage.getItem(key.value));
      storageAvailable.value = true;
    } catch {
      storageAvailable.value = false;
    }
  }

  watch(key, restore, { immediate: true, flush: "sync" });
  function onStorage(event: StorageEvent) {
    if (event.key === key.value || event.key === null) restore();
  }
  onMounted(() => window.addEventListener("storage", onStorage));
  onUnmounted(() => window.removeEventListener("storage", onStorage));

  const effective = computed(() => personal.value ?? company.value?.theme ?? null);
  const css = computed(() => roomThemeStyle(effective.value));
  const bubbles = computed<Partial<Record<ChatColorRole, Record<string, string>>>>(() => {
    const theme = effective.value;
    return theme ? Object.fromEntries(chatColorRoles.map(role => [role, themeChatBubble(theme, role)])) : {};
  });

  function choose(theme: RoomThemeId | null) {
    personal.value = roomThemeId(theme);
    if (!key.value) return;
    try {
      if (personal.value) window.localStorage.setItem(key.value, personal.value);
      else window.localStorage.removeItem(key.value);
      storageAvailable.value = true;
    } catch {
      storageAvailable.value = false;
    }
  }

  const appearance = { personal, company, effective, css, bubbles, choose, storageAvailable };
  provide(roomThemeKey, appearance);
  return appearance;
}

export function useRoomTheme() {
  return hasInjectionContext() ? inject(roomThemeKey, null) : null;
}
