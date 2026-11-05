import { computed, ref, shallowRef } from "vue";
import type {
  DesktopLiveDemoClientFrame,
  DesktopLiveDemoEvent,
  DesktopLiveDemoStatus,
} from "../../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../../ipc/index";
import { ipcErrorText } from "../attachments";
import { createCursorField } from "./cursor-interpolation";
import { liveDemoEvents, type LiveDemoEvents } from "./events";
import { createInkField } from "./ink-field";
import { createLiveDemoJoins, type LiveDemoJoins } from "./joins";
import { applyMarkChanges, mergeMark, removeMark, type MarkChange } from "./marks";
import {
  LIVE_DEMO_COLORS,
  liveDemoColor,
  type DemoMark,
  type DemoMarkInput,
  type LiveDemoPerson,
  type LiveDemoPoint,
} from "./protocol";

/** What the session needs from main. Every call may be missing on an older main process. */
export interface LiveDemoApi {
  join(roomIdentifier: string, demoKey: string, leaseUrl: string): Promise<void>;
  leave(roomIdentifier: string, demoKey: string): Promise<void>;
  send(roomIdentifier: string, frame: DesktopLiveDemoClientFrame): Promise<void>;
  listMarks(roomIdentifier: string, demoKey: string): Promise<DemoMark[]>;
  addMark(roomIdentifier: string, input: DemoMarkInput): Promise<DemoMark>;
  removeMark(roomIdentifier: string, markId: string): Promise<void>;
  viewerAccountId(): Promise<string | null>;
}

const UPDATE_TEXT = "Update LetAgents to use live demos.";

/** The call, or the reason it cannot be made (a main process that predates live demos). */
function needs<T>(call: T | undefined): T {
  if (!call) throw new Error(UPDATE_TEXT);
  return call;
}

/** True when this main process can run live demos at all. */
export function liveDemoAvailable(): boolean {
  const room = desktopIpc.room;
  return typeof room?.liveDemoJoin === "function"
    && typeof room.liveDemoLeave === "function"
    && typeof room.onLiveDemoEvent === "function"
    && typeof room.setInlineDemoWidth === "function";
}

export const desktopLiveDemoApi: LiveDemoApi = {
  join: async (room, key, lease) => needs(desktopIpc.room?.liveDemoJoin)(room, key, lease),
  leave: async (room, key) => needs(desktopIpc.room?.liveDemoLeave)(room, key),
  send: async (room, frame) => needs(desktopIpc.room?.liveDemoSend)(room, frame),
  listMarks: async (room, key) => needs(desktopIpc.room?.listDemoMarks)(room, key),
  addMark: async (room, input) => needs(desktopIpc.room?.addDemoMark)(room, input),
  removeMark: async (room, id) => needs(desktopIpc.room?.removeDemoMark)(room, id),
  viewerAccountId: async () => (await desktopIpc.auth?.getStatus?.())?.account?.id ?? null,
};

const sharedJoins = createLiveDemoJoins({
  join: (room, key, lease) => desktopLiveDemoApi.join(room, key, lease),
  leave: (room, key) => desktopLiveDemoApi.leave(room, key),
});

export interface UseLiveDemoOptions {
  roomIdentifier: () => string | null;
  demoKey: () => string | null;
  api?: LiveDemoApi;
  events?: LiveDemoEvents;
  joins?: LiveDemoJoins;
  now?: () => number;
}

/**
 * One card's live session: who is on the demo, where their pointers are, the
 * ink being drawn, and the saved marks. Presence, status and marks are reactive
 * (they change a few times a minute). Cursors and ink are plain data that a frame
 * loop reads, so a network frame never causes a render.
 */
export function useLiveDemo(options: UseLiveDemoOptions) {
  const api = options.api ?? desktopLiveDemoApi;
  const events = options.events ?? liveDemoEvents;
  // The cards of one window share the joins; a test that supplies its own api gets its own.
  const joins = options.joins ?? (options.api ? createLiveDemoJoins(options.api) : sharedJoins);
  const now = options.now ?? (() => performance.now());

  const status = ref<DesktopLiveDemoStatus | null>(null);
  /** Why the connection is off, in words main chose. */
  const statusReason = ref<string | null>(null);
  /** Why the room refused this demo's join, when it did. */
  const joinError = ref<string | null>(null);
  const people = shallowRef<readonly LiveDemoPerson[]>([]);
  const selfCid = ref<string | null>(null);
  const selfColor = ref<string | null>(null);
  const viewerId = ref<string | null>(null);
  const marks = shallowRef<readonly DemoMark[]>([]);
  /** Raised when someone's cursor appears or goes, not when it moves. */
  const cursorVersion = ref(0);
  const cursors = createCursorField();
  const ink = createInkField();
  const wakeListeners = new Set<() => void>();

  let generation = 0;
  let active: { room: string; key: string } | null = null;
  let stopEvents: (() => void) | null = null;
  let leaveJoin: (() => void) | null = null;
  let degraded = false;
  let loadingMarks: MarkChange[] | null = null;

  const viewerColor = computed(
    () => selfColor.value ?? (viewerId.value ? liveDemoColor(viewerId.value) : LIVE_DEMO_COLORS[5]),
  );

  function wake(): void {
    for (const listener of [...wakeListeners]) listener();
  }

  function fail(): never {
    throw new Error(UPDATE_TEXT);
  }

  async function loadMarks(run: number): Promise<void> {
    const target = active;
    if (!target) return;
    const changes: MarkChange[] = [];
    loadingMarks = changes;
    try {
      const listed = await api.listMarks(target.room, target.key);
      if (run !== generation) return;
      marks.value = applyMarkChanges(listed, changes);
    } catch {
      // The marks already on screen stay; the next reconnect tries again.
    } finally {
      if (loadingMarks === changes) loadingMarks = null;
    }
  }

  async function loadViewer(run: number): Promise<void> {
    try {
      const id = await api.viewerAccountId();
      if (run === generation) viewerId.value = id;
    } catch {
      // Without it, no mark is known as yours, so none can be deleted here.
    }
  }

  function noteCursorChange(before: boolean, cid: string): void {
    if (cursors.has(cid) !== before) cursorVersion.value++;
  }

  function onEvent(event: DesktopLiveDemoEvent): void {
    if (event.type === "status") {
      const before = status.value;
      status.value = event.status;
      statusReason.value = event.reason ?? null;
      if (event.status !== "live" && (before === "live" || event.status !== "connecting")) {
        degraded = true;
        // What the room does meanwhile is unknown.
        people.value = [];
        cursors.clear();
        ink.clear();
        cursorVersion.value++;
        wake();
      } else if (event.status === "live" && degraded) {
        degraded = false;
        void loadMarks(generation);
      }
      return;
    }
    const frame = event.frame;
    switch (frame.t) {
      case "hello":
        selfCid.value = frame.cid;
        selfColor.value = frame.color;
        break;
      case "presence": {
        joinError.value = null;
        people.value = frame.people;
        const keep = new Set(frame.people.map((person) => person.cid));
        const movedOn = cursors.keepOnly(keep);
        ink.keepOnly(keep);
        if (movedOn) cursorVersion.value++;
        wake();
        break;
      }
      case "cur": {
        if (frame.cid === selfCid.value) break;
        const had = cursors.has(frame.cid);
        if ("gone" in frame) cursors.gone(frame.cid);
        else cursors.move(frame.cid, frame.x, frame.y, now());
        noteCursorChange(had, frame.cid);
        wake();
        break;
      }
      case "ink":
        if (frame.cid === selfCid.value) break;
        ink.apply(frame, now());
        wake();
        break;
      case "mark":
        marks.value = mergeMark(marks.value, frame.mark);
        loadingMarks?.push({ t: "mark", mark: frame.mark });
        break;
      case "unmark":
        marks.value = removeMark(marks.value, frame.id);
        loadingMarks?.push({ t: "unmark", id: frame.id });
        break;
      case "error":
        // The server words its errors for the person ("Too many people are viewing this demo live.").
        joinError.value = frame.message;
        break;
      default:
        break;
    }
  }

  function reset(): void {
    status.value = null;
    statusReason.value = null;
    joinError.value = null;
    people.value = [];
    selfCid.value = null;
    selfColor.value = null;
    marks.value = [];
    degraded = false;
    loadingMarks = null;
    cursors.clear();
    ink.clear();
    cursorVersion.value++;
  }

  /** Joins the demo for the lease the card holds. Returns false when the card has no live demo. */
  function start(leaseUrl: string): boolean {
    stop();
    const room = options.roomIdentifier();
    const key = options.demoKey();
    if (!room || !key) return false;
    const run = ++generation;
    active = { room, key };
    stopEvents = events.register(room, key, onEvent);
    const join = joins.join(room, key, leaseUrl);
    leaveJoin = join.leave;
    join.done.catch((error: unknown) => {
      if (run === generation) joinError.value = ipcErrorText(error, "Live view is not available here.");
    });
    void loadMarks(run);
    void loadViewer(run);
    return true;
  }

  function stop(): void {
    generation++;
    stopEvents?.();
    stopEvents = null;
    leaveJoin?.();
    leaveJoin = null;
    active = null;
    reset();
    wake();
  }

  /** A `cur` or `ink` frame the chat owns (the pointer in draw mode). */
  function send(frame: DesktopLiveDemoClientFrame): void {
    const target = active;
    if (!target) return;
    void api.send(target.room, frame).catch(() => undefined);
  }

  function sendCursor(point: LiveDemoPoint | null): void {
    const target = active;
    if (!target) return;
    send(point ? { t: "cur", demo: target.key, x: point[0], y: point[1] } : { t: "cur", demo: target.key, gone: true });
  }

  function sendInk(id: string, pts: LiveDemoPoint[], end: boolean): void {
    const target = active;
    if (!target) return;
    send({ t: "ink", demo: target.key, id, pts, ...(end ? { end: true as const } : {}) });
  }

  async function addMark(input: (key: string) => DemoMarkInput): Promise<DemoMark> {
    const target = active ?? fail();
    const mark = await api.addMark(target.room, input(target.key));
    marks.value = mergeMark(marks.value, mark);
    loadingMarks?.push({ t: "mark", mark });
    return mark;
  }

  function addStroke(points: LiveDemoPoint[]): Promise<DemoMark> {
    return addMark((demo) => ({ demo, kind: "stroke", points, anchor: null }));
  }

  function addPin(at: LiveDemoPoint, text: string): Promise<DemoMark> {
    return addMark((demo) => ({ demo, kind: "pin", at, text, anchor: null }));
  }

  async function deleteMark(id: string): Promise<void> {
    const target = active ?? fail();
    await api.removeMark(target.room, id);
    marks.value = removeMark(marks.value, id);
    loadingMarks?.push({ t: "unmark", id });
  }

  function isOwnMark(mark: DemoMark): boolean {
    return viewerId.value !== null && mark.author.accountId === viewerId.value;
  }

  function onWake(listener: () => void): () => void {
    wakeListeners.add(listener);
    return () => wakeListeners.delete(listener);
  }

  return {
    status, statusReason, joinError, people, selfCid, viewerColor, marks, cursorVersion, cursors, ink,
    start, stop, sendCursor, sendInk, addStroke, addPin, deleteMark, isOwnMark, onWake, wake,
  };
}

export type LiveDemoSession = ReturnType<typeof useLiveDemo>;
