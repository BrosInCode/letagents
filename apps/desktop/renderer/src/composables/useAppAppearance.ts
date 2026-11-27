import { computed, ref, watchEffect, type Ref } from "vue";

/** How the app picks light or dark: follow macOS / Windows, or a fixed choice. */
export type AppColorMode = "system" | "light" | "dark";

/**
 * The parts of the app that can carry the film grain, each switched on its
 * own. The id is the word in `data-texture` on <html>; app-texture.css says
 * which elements each one covers. Add a part here and a rule there.
 */
export const TEXTURE_SURFACES = [
  { id: "background", label: "App background", note: "Behind the sidebar, the chat and the board." },
  { id: "bubbles", label: "Chat bubbles", note: "Every message bubble, under the text." },
  { id: "composer", label: "Message box", note: "Where you write in the room and in threads." },
  { id: "cards", label: "Cards", note: "Task cards and the other cards in the app." },
  { id: "menus", label: "Menus and dialogs", note: "Right-click menus, pop-ups, dialogs and notices." },
] as const;
export type TextureSurface = typeof TEXTURE_SURFACES[number]["id"];

const COLOR_MODE_KEY = "letagents-desktop:color-mode";
const SURFACES_KEY = "letagents-desktop:textured-surfaces";
/** The first demo stored one choice for the whole app; read it once. */
const OLD_TEXTURE_KEY = "letagents-desktop:background-texture";
const ALL_SURFACES: TextureSurface[] = TEXTURE_SURFACES.map((surface) => surface.id);
const DEFAULT_SURFACES: TextureSurface[] = ["background", "bubbles"];

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readColorMode(): AppColorMode {
  const value = storage()?.getItem(COLOR_MODE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function readSurfaces(): TextureSurface[] {
  try {
    const raw = storage()?.getItem(SURFACES_KEY);
    if (raw) {
      const list: unknown = JSON.parse(raw);
      if (Array.isArray(list)) return ALL_SURFACES.filter((id) => list.includes(id));
    }
    if (storage()?.getItem(OLD_TEXTURE_KEY) === "plain") return [];
  } catch {
    // A broken saved value falls back to the default.
  }
  return [...DEFAULT_SURFACES];
}

function save(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// One copy for the whole window: App.vue applies it, Settings changes it.
const colorMode = ref<AppColorMode>(readColorMode());
const texturedSurfaces = ref<TextureSurface[]>(readSurfaces());
const saved = ref(true);
const systemDark = ref(true);
let started = false;
const resolvedMode = computed<"light" | "dark">(() =>
  colorMode.value === "system" ? (systemDark.value ? "dark" : "light") : colorMode.value);

/**
 * The person's appearance choices on this device. The first caller (App.vue)
 * passes the grain tile and starts applying the choices to <html>:
 * `data-theme` and `color-scheme`, so every `light-dark()` colour follows;
 * `data-texture`, the textured parts; and `--app-grain`, the tile. They sit on
 * <html> so menus and dialogs moved to <body> follow them too.
 */
export function useAppAppearance(grain?: Readonly<Ref<string>>) {
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
      root.dataset.texture = texturedSurfaces.value.join(" ");
      root.style.setProperty("--app-grain", grain?.value || "none");
    });
  }

  function setSurfaces(next: TextureSurface[]) {
    texturedSurfaces.value = ALL_SURFACES.filter((id) => next.includes(id));
    saved.value = save(SURFACES_KEY, JSON.stringify(texturedSurfaces.value));
  }

  return {
    colorMode,
    resolvedMode,
    texturedSurfaces,
    saved,
    isTextured: (surface: TextureSurface) => texturedSurfaces.value.includes(surface),
    setColorMode(value: AppColorMode) {
      colorMode.value = value;
      saved.value = save(COLOR_MODE_KEY, value);
    },
    setTextured(surface: TextureSurface, on: boolean) {
      setSurfaces(on
        ? [...texturedSurfaces.value, surface]
        : texturedSurfaces.value.filter((id) => id !== surface));
    },
    setAllTextured(on: boolean) {
      setSurfaces(on ? ALL_SURFACES : []);
    },
  };
}
