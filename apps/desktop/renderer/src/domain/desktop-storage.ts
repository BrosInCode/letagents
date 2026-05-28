export function readStoredString(storageKey: string): string | null {
  try {
    return window.localStorage.getItem(storageKey)?.trim() || null;
  } catch {
    return null;
  }
}

export function rememberStoredString(storageKey: string, value: string | null): void {
  try {
    const trimmed = value?.trim();
    if (trimmed) {
      window.localStorage.setItem(storageKey, trimmed);
      return;
    }
    window.localStorage.removeItem(storageKey);
  } catch {
    // Local persistence should never block the desktop UI.
  }
}
