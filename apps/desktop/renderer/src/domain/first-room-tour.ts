import { normalizeRoomIdentifier } from "./sidebar-rooms";

/**
 * The first room after onboarding opens the quick tour once, with a short
 * welcome. Onboarding marks the room; the room shell takes the mark when that
 * room is ready. Kept in localStorage so a slow room load or a reload in
 * between does not lose it.
 */
const KEY = "letagents-desktop:first-room-tour";

export function markFirstRoomTour(roomIdentifier: string): void {
  const id = normalizeRoomIdentifier(roomIdentifier);
  if (!id) return;
  try { localStorage.setItem(KEY, id); } catch { /* storage full or blocked: no tour, nothing else breaks */ }
}

/** True once for the marked room; the mark is removed. */
export function takeFirstRoomTour(roomIdentifier: string | null | undefined): boolean {
  const id = normalizeRoomIdentifier(roomIdentifier);
  try {
    if (!id || localStorage.getItem(KEY) !== id) return false;
    localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
