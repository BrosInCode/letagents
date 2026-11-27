import { computed, ref, watchEffect } from "vue";

/** How the app picks light or dark: follow macOS / Windows, or a fixed choice. */
export type AppColorMode = "system" | "light" | "dark";
/** Whether the app background carries the film grain. */
export type AppBackgroundTexture = "textured" | "plain";

const COLOR_MODE_KEY = "letagents-desktop:color-mode";
const TEXTURE_KEY = "letagents-desktop:background-texture";

function readChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.includes(value as T) ? value as T : fallback;
  } catch {
    return fallback;
  }
}

function saveChoice(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// One copy for the whole window: App.vue applies it, Settings changes it.
const colorMode = ref<AppColorMode>(readChoice(COLOR_MODE_KEY, ["system", "light", "dark"], "system"));
const texture = ref<AppBackgroundTexture>(readChoice(TEXTURE_KEY, ["textured", "plain"], "textured"));
const saved = ref(true);
const systemDark = ref(true);
let started = false;
const resolvedMode = computed<"light" | "dark">(() =>
  colorMode.value === "system" ? (systemDark.value ? "dark" : "light") : colorMode.value);

/**
 * The person's appearance choices on this device. The first caller starts
 * applying them to the page: `data-theme` and `color-scheme` on <html>, so
 * every `light-dark()` color in the app follows.
 */
export function useAppAppearance() {
  if (!started && typeof window !== "undefined") {
    started = true;
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (query) {
      systemDark.value = query.matches;
      query.addEventListener("change", (event) => { systemDark.value = event.matches; });
    }
    watchEffect(() => {
      const root = document.documentElement;
      root.dataset.theme = resolvedMode.value;
      root.style.colorScheme = resolvedMode.value;
    });
  }
  return {
    colorMode,
    texture,
    resolvedMode,
    saved,
    setColorMode(value: AppColorMode) {
      colorMode.value = value;
      saved.value = saveChoice(COLOR_MODE_KEY, value);
    },
    setTexture(value: AppBackgroundTexture) {
      texture.value = value;
      saved.value = saveChoice(TEXTURE_KEY, value);
    },
  };
}
