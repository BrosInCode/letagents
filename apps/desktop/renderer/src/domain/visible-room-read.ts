import type { DesktopRoomMessage } from "../../../electron/ipc-types";
import { isHiddenChatMessage } from "../components/desktop/content/room-shell/messages";

/**
 * What the room's main message list shows right now, by the web's rule for
 * read evidence: a message counts as seen when at least half of it, or 96 px
 * of it, is inside the visible part of the list, in a shown and focused window.
 * `seen` is the newest message seen (null when the window is hidden or
 * unfocused, or none shows); `rendered` is the newest message the list holds.
 */
export const VISIBLE_MESSAGE_MIN_PX = 96;

type Page = Pick<Document, "querySelector" | "hasFocus" | "visibilityState">;
const pageOrNull = (): Page | null => typeof document === "undefined" ? null : document;

export function roomListReadState(root: Page | null = pageOrNull()): { seen: string | null; rendered: string | null } {
  if (!root || root.visibilityState !== "visible" || !root.hasFocus()) return { seen: null, rendered: null };
  const list = root.querySelector<HTMLElement>('[data-testid="room-chat-list"]');
  if (!list) return { seen: null, rendered: null };
  const view = list.getBoundingClientRect();
  let seen = 0;
  let rendered = 0;
  for (const element of list.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const id = element.dataset.messageId ?? "";
    if (!/^msg_[1-9]\d*$/.test(id) || element.classList.contains("room-window-pinned-hidden")) continue;
    const box = element.getBoundingClientRect();
    if (box.height <= 0) continue;
    const number = Number(id.slice(4));
    rendered = Math.max(rendered, number);
    const shown = Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top);
    if (shown <= 0 || shown < Math.min(VISIBLE_MESSAGE_MIN_PX, box.height / 2)) continue;
    seen = Math.max(seen, number);
  }
  return { seen: seen ? `msg_${seen}` : null, rendered: rendered ? `msg_${rendered}` : null };
}

/** The newest room message a person can see right now (see `roomListReadState`). */
export function lastVisibleRoomMessageId(root: Page | null = pageOrNull()): string | null {
  return roomListReadState(root).seen;
}

/**
 * A message the main list does not draw as a row of its own: a thread reply, a
 * GitHub event, or what the room view hides everywhere (`isHiddenChatMessage`:
 * blank automatic prompts and agent `[status]` posts), the same function the
 * room view uses, so the two rules cannot drift.
 */
function isSilentInMainList(message: DesktopRoomMessage): boolean {
  const threadReply = Boolean(message.threadRootId && message.threadRootId !== message.id);
  const github = message.source === "github" || message.sender.toLowerCase() === "github";
  return threadReply || github || isHiddenChatMessage(message);
}

/**
 * The read a person proved in the open room. When the newest message the main
 * list holds is on screen, the person is at the bottom: the read reaches the
 * room's newest loaded message, including thread replies, GitHub events and
 * blank prompts after it that the main list does not show (threads keep their
 * own unread state). Otherwise it reaches the newest message on screen.
 */
export function provenRoomRead(state: { seen: string | null; rendered: string | null },
  messages: readonly DesktopRoomMessage[]): string | null {
  if (!state.seen) return null;
  const seen = Number(state.seen.slice(4));
  if (state.seen !== state.rendered) return state.seen;
  let newest = seen;
  for (const message of messages) {
    if (!/^msg_[1-9]\d*$/.test(message.id)) continue;
    const number = Number(message.id.slice(4));
    if (number <= seen) continue;
    // A later message the main list would show, but has not drawn yet: not at the bottom.
    if (!isSilentInMainList(message)) return state.seen;
    newest = Math.max(newest, number);
  }
  return `msg_${newest}`;
}

/**
 * Runs `run` at most once every `everyMs` while calls keep coming, and once
 * more after the last call: a fast burst of messages is still checked while
 * it lasts, not only after it stops.
 */
export function createThrottledCheck(run: () => void, everyMs: number,
  timers: { now(): number; set(callback: () => void, ms: number): unknown; clear(timer: unknown): void } = {
    now: () => Date.now(), set: (callback, ms) => setTimeout(callback, ms), clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }) {
  let timer: unknown = null;
  let lastAt = -Infinity;
  return {
    schedule(): void {
      if (timer !== null) return;
      const wait = Math.max(0, lastAt + everyMs - timers.now());
      timer = timers.set(() => { timer = null; lastAt = timers.now(); run(); }, wait);
    },
    dispose(): void { if (timer !== null) timers.clear(timer); timer = null; },
  };
}

/**
 * A room opened at a saved scroll position shows something else until the
 * list restores that position; the list reports its first position after the
 * restore. Until then the screen proves no read.
 */
export function createRestoreGuard(positionFor: (room: string) => unknown) {
  let openRoom: string | null = null;
  let pending: { room: string; position: unknown } | null = null;
  return {
    /** Call with the open room whenever it may have changed. */
    note(room: string | null): void {
      if (room === openRoom) return;
      openRoom = room;
      const position = room ? positionFor(room) : null;
      pending = room && position ? { room, position } : null;
    },
    /** Whether the screen of this room cannot yet prove a read. */
    blocks(room: string): boolean {
      if (pending?.room !== room) return false;
      if (positionFor(room) === pending.position) return true;
      pending = null;
      return false;
    },
  };
}
