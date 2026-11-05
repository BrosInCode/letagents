import type { DesktopLiveDemoEvent } from "../../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../../ipc/index";

export type LiveDemoEventHandler = (event: DesktopLiveDemoEvent) => void;

export interface LiveDemoEvents {
  /**
   * Sends one demo's frames to `handler`, and the room's connection state and
   * greeting. A card that registers late is told the last state of its room at
   * once. The returned function stops that and is safe to call more than once.
   */
  register(roomIdentifier: string, demoKey: string, handler: LiveDemoEventHandler): () => void;
}

/** Rooms are compared the way the rest of the app compares them: trimmed, lower case. */
function roomId(roomIdentifier: string): string {
  return roomIdentifier.trim().toLowerCase();
}

interface RoomState {
  status: DesktopLiveDemoEvent | null;
  hello: DesktopLiveDemoEvent | null;
}

/**
 * One listener on main's live channel serves every card in the window, and
 * routes by room and demo key. It is set up for the first card and then stays:
 * main says a room's state only when it changes, and a room's socket outlives
 * its last card for a minute, so a card that comes later must hear the state
 * and the greeting (the connection's own `cid`) from here, not from main.
 */
export function createLiveDemoEvents(
  subscribe: (listener: LiveDemoEventHandler) => (() => void) | null | undefined,
): LiveDemoEvents {
  // room -> demo key -> handlers (the same demo can show twice in one window)
  const rooms = new Map<string, Map<string, Set<LiveDemoEventHandler>>>();
  const states = new Map<string, RoomState>();
  let subscribed = false;

  function stateOf(room: string): RoomState {
    let state = states.get(room);
    if (!state) states.set(room, (state = { status: null, hello: null }));
    return state;
  }

  function deliver(handlers: Iterable<LiveDemoEventHandler>, event: DesktopLiveDemoEvent): void {
    // A handler may register or unregister while it runs.
    for (const handler of [...handlers]) handler(event);
  }

  function route(event: DesktopLiveDemoEvent): void {
    const room = roomId(event.roomIdentifier);
    const demos = rooms.get(room);
    if (event.type === "status") {
      stateOf(room).status = event;
      if (demos) for (const handlers of demos.values()) deliver(handlers, event);
      return;
    }
    const frame = event.frame;
    // A frame about one demo; an `error` may name the demo whose join failed.
    const demo = "demo" in frame && typeof frame.demo === "string" ? frame.demo : null;
    if (demo !== null) {
      const handlers = demos?.get(demo);
      if (handlers) deliver(handlers, event);
      return;
    }
    // A frame about the connection (`hello`, an error that names no demo).
    if (frame.t === "hello") stateOf(room).hello = event;
    if (demos) for (const handlers of demos.values()) deliver(handlers, event);
  }

  return {
    register(roomIdentifier, demoKey, handler) {
      const room = roomId(roomIdentifier);
      let demos = rooms.get(room);
      if (!demos) rooms.set(room, (demos = new Map()));
      let handlers = demos.get(demoKey);
      if (!handlers) demos.set(demoKey, (handlers = new Set()));
      handlers.add(handler);
      if (!subscribed) subscribed = Boolean(subscribe(route));
      const state = states.get(room);
      if (state?.hello) handler(state.hello);
      if (state?.status) handler(state.status);

      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        handlers.delete(handler);
        if (handlers.size === 0 && demos.get(demoKey) === handlers) demos.delete(demoKey);
        if (demos.size === 0 && rooms.get(room) === demos) rooms.delete(room);
      };
    },
  };
}

export const liveDemoEvents = createLiveDemoEvents(
  (listener) => desktopIpc.room?.onLiveDemoEvent?.(listener),
);
