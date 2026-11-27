import { watch, type WatchSource } from "vue";

/**
 * Mirrors a set of CSS custom properties onto <html>, so content moved to
 * <body> (menus, pop-ups, dialogs) gets them too. Properties the source
 * drops are removed again.
 */
export function useRootStyle(source: WatchSource<Record<string, string>>): void {
  if (typeof document === "undefined") return;
  watch(source, (next, previous) => {
    const style = document.documentElement.style;
    // Test pages can lack setProperty; these are only looks.
    if (typeof style?.setProperty !== "function") return;
    for (const key of Object.keys(previous ?? {})) if (!(key in next)) style.removeProperty(key);
    for (const [key, value] of Object.entries(next)) style.setProperty(key, value);
  }, { immediate: true });
}
