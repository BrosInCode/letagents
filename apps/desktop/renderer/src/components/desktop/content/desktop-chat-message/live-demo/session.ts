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
  markInput,
  pendingRetryDelay,
  PENDING_MAX_ATTEMPTS,
  PENDING_MAX_LIVE_FAILURES,
  sameMarkBody,
  type MarkBody,
  type PendingMark,
} from "./pending-marks";
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
  /** Waits between tries of a mark that did not save, and between paced deletes. */
  delay?: (ms: number, run: () => void) => () => void;
}

/** Something the card should tell the person ("Saved 2 marks", or why a mark was given up). */
export interface LiveDemoNotice {
  text: string;
  error: boolean;
}

// A delete the server refused for its rate is tried again after this long.
const DELETE_RETRY_MS = 1_100;
const DELETE_TRIES = 3;

function defaultDelay(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
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
  const delay = options.delay ?? defaultDelay;

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
  const noticeListeners = new Set<(notice: LiveDemoNotice) => void>();
  /**
   * Your marks the server does not have yet, oldest first. They outlive a stop
   * (the card scrolled away), so a bad link or a short trip elsewhere loses nothing.
   */
  const pending = shallowRef<readonly PendingMark[]>([]);
  /** The ones on this card's demo, for drawing. */
  const pendingHere = computed(() => {
    const room = options.roomIdentifier();
    const key = options.demoKey();
    return pending.value.filter((entry) => entry.room === room && entry.demo === key);
  });
  let pendingSeq = 0;
  let flushing = false;
  let inFlightKey: number | null = null;
  // Taken back while their save was on its way.
  const cancelled = new Set<number>();
  let cancelRetry: (() => void) | null = null;
  // Marks that had to wait and are saved now; the person hears about them once the queue is empty.
  let savedAfterWait = 0;

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
      for (const mark of marks.value) settlePendingBy(mark);
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
      // The link is back: save what waited now, not at the next timer.
      if (event.status === "live" && pending.value.some((entry) => entry.waiting)) void flushPending();
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
        settlePendingBy(frame.mark);
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

  function notify(notice: LiveDemoNotice): void {
    for (const listener of [...noticeListeners]) listener(notice);
  }

  function dropPending(key: number): boolean {
    const before = pending.value.length;
    pending.value = pending.value.filter((entry) => entry.key !== key);
    return pending.value.length !== before;
  }

  /** A saved mark of yours that is a waiting one: the save went through though its answer was lost. */
  function settlePendingBy(mark: DemoMark): void {
    if (!isOwnMark(mark)) return;
    const match = pending.value.find((entry) => entry.demo === mark.demo && sameMarkBody(entry.body, mark));
    if (!match) return;
    dropPending(match.key);
    if (match.waiting) savedAfterWait++;
    if (pending.value.length === 0) reportSaved();
  }

  function reportSaved(): void {
    if (savedAfterWait === 0) return;
    notify({ text: `Saved ${savedAfterWait} ${savedAfterWait === 1 ? "mark" : "marks"}.`, error: false });
    savedAfterWait = 0;
  }

  /**
   * Saves a mark of yours. It shows at once; the server gets it in order, and a
   * save that fails waits for the link and is tried again. Nothing to await.
   */
  function queueMark(body: MarkBody): void {
    const target = active;
    if (!target) return;
    pending.value = [...pending.value, {
      key: ++pendingSeq, room: target.room, demo: target.key, body, waiting: false, attempts: 0, liveFailures: 0,
    }];
    void flushPending();
  }

  async function flushPending(): Promise<void> {
    if (flushing) return;
    flushing = true;
    cancelRetry?.();
    cancelRetry = null;
    try {
      while (pending.value.length > 0) {
        const entry = pending.value[0];
        let saved: DemoMark;
        inFlightKey = entry.key;
        try {
          saved = await api.addMark(entry.room, markInput(entry.demo, entry.body));
        } catch (error) {
          inFlightKey = null;
          // Taken back (undo) or settled by the server's copy while it was on its way.
          if (cancelled.delete(entry.key) || !pending.value.some((other) => other.key === entry.key)) continue;
          const attempts = entry.attempts + 1;
          const liveFailures = entry.liveFailures + (status.value === "live" ? 1 : 0);
          if (liveFailures >= PENDING_MAX_LIVE_FAILURES || attempts >= PENDING_MAX_ATTEMPTS) {
            dropPending(entry.key);
            const what = entry.body.kind === "pin" ? "the pin" : "the drawing";
            notify({ text: ipcErrorText(error, `Could not save ${what}.`), error: true });
            continue;
          }
          pending.value = pending.value.map((other) =>
            other.key === entry.key ? { ...other, waiting: true, attempts, liveFailures } : other);
          cancelRetry = delay(pendingRetryDelay(attempts), () => {
            cancelRetry = null;
            void flushPending();
          });
          return;
        }
        inFlightKey = null;
        if (cancelled.delete(entry.key)) {
          // Taken back while it saved: the person does not want it.
          dropPending(entry.key);
          marks.value = removeMark(marks.value, saved.id);
          void api.removeMark(entry.room, saved.id).catch(() => undefined);
          continue;
        }
        // False when the server's copy already settled it.
        if (dropPending(entry.key) && entry.waiting) savedAfterWait++;
        if (active && active.room === entry.room && active.key === entry.demo) {
          marks.value = mergeMark(marks.value, saved);
          loadingMarks?.push({ t: "mark", mark: saved });
        }
      }
      reportSaved();
    } finally {
      flushing = false;
    }
  }

  /** Takes back a mark that is not saved yet. One on its way is deleted when its save answers. */
  function cancelPending(key: number): MarkBody | null {
    const entry = pending.value.find((other) => other.key === key);
    if (!entry) return null;
    if (key === inFlightKey) cancelled.add(key);
    dropPending(key);
    return entry.body;
  }

  /**
   * Deletes saved marks one by one, at a pace the server accepts (it limits how
   * fast one person changes marks). Returns the ones that are gone.
   */
  async function deleteMarks(ids: readonly string[]): Promise<DemoMark[]> {
    const target = active ?? fail();
    const gone: DemoMark[] = [];
    for (const id of ids) {
      const mark = marks.value.find((other) => other.id === id);
      for (let tries = 1; ; tries++) {
        try {
          await api.removeMark(target.room, id);
          break;
        } catch (error) {
          if (tries >= DELETE_TRIES) {
            if (gone.length === 0) throw error;
            return gone;
          }
          await new Promise<void>((resolve) => { delay(DELETE_RETRY_MS, resolve); });
        }
      }
      marks.value = removeMark(marks.value, id);
      loadingMarks?.push({ t: "unmark", id });
      if (mark) gone.push(mark);
    }
    return gone;
  }

  function isOwnMark(mark: DemoMark): boolean {
    return viewerId.value !== null && mark.author.accountId === viewerId.value;
  }

  function onWake(listener: () => void): () => void {
    wakeListeners.add(listener);
    return () => wakeListeners.delete(listener);
  }

  function onNotice(listener: (notice: LiveDemoNotice) => void): () => void {
    noticeListeners.add(listener);
    return () => noticeListeners.delete(listener);
  }

  return {
    status, statusReason, joinError, people, selfCid, viewerColor, marks, cursorVersion, cursors, ink,
    pending: pendingHere,
    start, stop, sendCursor, sendInk, addStroke, addPin, deleteMark, deleteMarks, queueMark, cancelPending,
    isOwnMark, onWake, onNotice, wake,
  };
}

export type LiveDemoSession = ReturnType<typeof useLiveDemo>;
