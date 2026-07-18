/** Persist only launches the user started or explicitly chose to recover. */
export function createSupervisedLaunchAttachments() {
  const remembered = new Set<string>();

  function key(roomIdentifier: string, entryId: string): string {
    return `letagents:add-agent:attached-launch:${encodeURIComponent(roomIdentifier)}:${encodeURIComponent(entryId)}`;
  }

  function has(roomIdentifier: string, entryId: string): boolean {
    const storageKey = key(roomIdentifier, entryId);
    if (remembered.has(storageKey)) return true;
    try {
      return window.sessionStorage?.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  }

  function remember(roomIdentifier: string, entryId: string): void {
    const storageKey = key(roomIdentifier, entryId);
    remembered.add(storageKey);
    try {
      window.sessionStorage?.setItem(storageKey, "1");
    } catch {
      // In-memory state still preserves the attachment for this renderer lifetime.
    }
  }

  function forget(roomIdentifier: string, entryId: string): void {
    const storageKey = key(roomIdentifier, entryId);
    remembered.delete(storageKey);
    try {
      window.sessionStorage?.removeItem(storageKey);
    } catch {
      // Storage can be unavailable in hardened renderer contexts.
    }
  }

  return { has, remember, forget };
}
