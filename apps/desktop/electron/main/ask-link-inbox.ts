import type { DesktopRoomLink } from "../../../../shared/room-app-links.mjs";

/**
 * A link that arrived before the window could take it. Kept apart from
 * ask-links.ts, which needs Electron's `app`, so the IPC handlers can read it
 * without loading Electron at import time. One link waits at a time: an ask
 * link (`letagents://ask/<token>`) or a room link (`letagents://in/<room>`);
 * each kind is taken by its own reader, once.
 */
let pendingToken: string | null = null;
let pendingRoom: DesktopRoomLink | null = null;
let rendererReady = false;

export function holdAskLink(token: string): void { pendingToken = token; pendingRoom = null; }
export function holdRoomLink(target: DesktopRoomLink): void { pendingRoom = target; pendingToken = null; }
export function askLinkRendererReady(): boolean { return rendererReady; }
/** A new window's renderer hasn't loaded yet: hold links for it to take. */
export function askLinkRendererGone(): void { rendererReady = false; }
export function clearHeldAskLink(): void { pendingToken = null; }
export function clearHeldRoomLink(): void { pendingRoom = null; }

/** The renderer takes an ask link that arrived before it loaded, once. */
export function takePendingAskLink(): string | null {
  rendererReady = true;
  const token = pendingToken;
  pendingToken = null;
  return token;
}

/** The renderer takes a room link that arrived before it loaded, once. */
export function takePendingRoomLink(): DesktopRoomLink | null {
  rendererReady = true;
  const target = pendingRoom;
  pendingRoom = null;
  return target;
}
