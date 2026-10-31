import {
  ROOM_LIVE_LIMITS,
  ROOM_LIVE_SNAPSHOT_VERSION,
  foldAgentStreamEvents,
  liveStreamTextPart,
  normalizeRoomLiveSnapshot,
  roomLiveTraceEntries,
  withoutRoomLiveControls,
  type RoomLiveEntry,
  type RoomLiveSnapshot,
} from "../../../shared/agent-live-trace.mjs";
import { readableContributionText } from "../../../shared/contribution-text.mjs";
import { boundLiveActivityLine, cleanLiveActivityLine } from "../../../shared/live-activity-summary.mjs";
import { redactCredentialText } from "./credential-redaction.js";
import type { DaemonAgentStreamEvent } from "./types.js";

/** A changed snapshot of an agent's turn reaches the room at most this often. */
export const LIVE_ROOM_SHARE_INTERVAL_MS = 3_000;
/** Longest wait between attempts after the room server could not be reached. */
const MAX_RETRY_DELAY_MS = 60_000;
/** Publication attempts after which a failing agent waits for its next activity before trying again. */
const MAX_CONSECUTIVE_FAILURES = 8;
/**
 * How long a removal the owner asked for keeps being retried (once a minute
 * at most): the server's retention removes a live session with no snapshot
 * for this long, and the daemon sends none once sharing is off.
 */
const WITHDRAW_RETRY_LIMIT_MS = 24 * 60 * 60 * 1000;
/** Text blocks of one turn whose beginning is remembered; a later block counts as cut once the feed drops events. */
const MAX_TRACKED_TEXT_PARTS = 4_096;
/** Longest current-step line of a live session. */
export const LIVE_ROOM_SHARE_SUMMARY_MAX_LENGTH = 200;
const MESSAGE_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
/**
 * An absolute or home path in any script, Unix or Windows: a leading `/`,
 * `~/`, `file://` or drive letter, then at least one folder, whose names may
 * hold single spaces ("Application Support") but no comma or semicolon, so
 * a list of paths is read as several. A path never starts right after
 * a letter, digit or slash, so a URL keeps its host and "and/or" stays.
 */
const ABSOLUTE_PATH = /(?<![\p{L}\p{N}_.~\/\\-])(?:file:\/\/)?(?:~|[A-Za-z]:)?[\\/](?:[^\s\\/`'"<>()[\]{}|*,;]+(?: [^\s\\/`'"<>()[\]{}|*,;~:]+)*[\\/])+([^\s\\/`'"<>()[\]{}|*,;]+)/gu;

/** Every absolute or home path becomes its file name, whatever letters its folders use. */
export function withoutMachinePaths(value: string): string {
  return value.replace(ABSOLUTE_PATH, (_match, name: string) => {
    const punctuation = /[.,;:!?]+$/.exec(name)?.[0] ?? "";
    return `\`${name.slice(0, name.length - punctuation.length)}\`${punctuation}`;
  });
}

/**
 * One line the room may see: credentials redacted (URL passwords of any
 * scheme among them), machine paths reduced to file names, controls removed,
 * and the length bounded. Null when nothing is left.
 */
export function roomSafeLine(value: string, max: number): string | null {
  const line = cleanLiveActivityLine(withoutMachinePaths(redactCredentialText(value, 8_192).value));
  if (!line) return null;
  const readable = cleanLiveActivityLine(readableContributionText(line, 100_000));
  return readable ? boundLiveActivityLine(readable, max) : null;
}

/** A work note or agent update for the room, with its line breaks, under the same rules as roomSafeLine. */
export function roomSafeText(value: string, max: number): string | null {
  const visible = withoutRoomLiveControls(withoutMachinePaths(redactCredentialText(value, 32_768).value));
  const readable = readableContributionText(visible, 100_000)?.trim();
  if (!readable) return null;
  return boundLiveActivityLine(readable, max).trim() || null;
}

/** The one-line current step of a live session, in fixed product language. */
function currentStep(snapshot: RoomLiveSnapshot): string {
  if (snapshot.state === "ended") return "Finished this request";
  const ongoing = [...snapshot.entries].reverse()
    .find((entry) => entry.kind === "action" && (entry.status === "running" || entry.status === "pending"));
  const latest = ongoing ?? snapshot.entries.at(-1);
  if (!latest) return "Working on the request";
  if (latest.kind === "action") return latest.headline;
  return latest.kind === "note" ? "Thinking through the request" : "Writing a response";
}

/**
 * What other members may see of one turn, built from the owner's live feed
 * with the shared fold and presentation. Only work notes, agent updates and
 * fixed tool headlines are kept, and a text block is kept only when its
 * beginning is known (`textIntact`): redaction finds a secret by its start, so
 * a block the feed has cut is left out whole. Every string is made room safe,
 * the newest entries are kept within the snapshot limits, and the result is
 * checked against the shape the server stores.
 */
export function buildRoomLiveSnapshot(input: {
  events: readonly DaemonAgentStreamEvent[];
  /** The live feed no longer holds some of the turn's events. */
  dropped: boolean;
  textIntact?: (part: { kind: "reasoning" | "message"; id: string }) => boolean;
  startedAt: string;
  endedAt: string | null;
  requestMessageId: string | null;
}): { summary: string; live: RoomLiveSnapshot } {
  const transcript = foldAgentStreamEvents(input.events.map((event) => ({
    observedAt: event.observed_at,
    kind: event.kind,
    method: event.method,
    summary: event.summary,
    payload: event.payload,
  })), input.endedAt !== null);
  const textIntact = input.textIntact ?? (() => !input.dropped);
  const entries: RoomLiveEntry[] = [];
  for (const entry of roomLiveTraceEntries(transcript.items, null, (item) => textIntact({ kind: item.kind, id: item.id }))) {
    if (entry.kind === "action") {
      const headline = roomSafeLine(entry.headline, ROOM_LIVE_LIMITS.headlineChars);
      if (headline) entries.push({ ...entry, headline });
    } else {
      const text = roomSafeText(entry.text, ROOM_LIVE_LIMITS.textChars);
      if (text) entries.push({ ...entry, text });
    }
  }
  const omittedAtStart = input.dropped || entries.length > ROOM_LIVE_LIMITS.entries;
  const newest = entries.slice(-ROOM_LIVE_LIMITS.entries);
  const live = (list: RoomLiveEntry[], omitted: boolean) => ({
    version: ROOM_LIVE_SNAPSHOT_VERSION,
    state: input.endedAt ? "ended" as const : "working" as const,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    request_message_id: input.requestMessageId && MESSAGE_ID.test(input.requestMessageId) ? input.requestMessageId : null,
    omitted_earlier: omitted,
    entries: list,
  });
  // Leave room for the request body around the snapshot.
  const fits = (dropFromStart: number) => Buffer.byteLength(JSON.stringify(
    live(newest.slice(dropFromStart), omittedAtStart || dropFromStart > 0))) <= ROOM_LIVE_LIMITS.snapshotBytes - 1_024;
  // The snapshot only shrinks as older entries go (dropping any sets the
  // omitted flag once), so the fewest entries to drop is found by bisection
  // instead of one full serialization per dropped entry.
  let drop = 0;
  if (!fits(0)) {
    let low = 1;
    let high = newest.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (fits(middle)) high = middle; else low = middle + 1;
    }
    drop = Math.min(low, newest.length);
  }
  const snapshot = normalizeRoomLiveSnapshot(live(newest.slice(drop), omittedAtStart || drop > 0));
  return { summary: boundLiveActivityLine(currentStep(snapshot), LIVE_ROOM_SHARE_SUMMARY_MAX_LENGTH), live: snapshot };
}

/** Where and as whom an agent's live activity is published. */
export type LiveRoomShareTarget = { apiUrl: string; roomId: string; bearer: string };
type SnapshotBody = { summary: string; live: RoomLiveSnapshot };

/**
 * The owner's saved choice: shared, not shared, or not shared while the room
 * may still show earlier turns that must be removed.
 */
export type LiveSharingState = "off" | "on" | "withdrawing";

export type LiveRoomSharePorts = {
  /** The owner's saved choice for this agent. */
  sharing(entryId: string): Promise<LiveSharingState>;
  /** The room no longer shows the agent's live activity: the saved state stops asking for removal. */
  withdrawn(entryId: string): Promise<void>;
  /** The agent's room binding and bearer, or null while it has none (or its room has no server). */
  target(entryId: string): Promise<LiveRoomShareTarget | null>;
  /** The owner's live feed: the buffer the Live tab reads. */
  feed: {
    highWater(entryId: string): number;
    retainedAfter(entryId: string, afterSequence: number): { events: DaemonAgentStreamEvent[]; dropped: boolean };
  };
  http: {
    create(target: LiveRoomShareTarget, body: SnapshotBody): Promise<string>;
    /** False when the session is gone. */
    update(target: LiveRoomShareTarget, sessionId: string, body: SnapshotBody): Promise<boolean>;
    withdraw(target: LiveRoomShareTarget): Promise<void>;
  };
  nowMs?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  intervalMs?: number;
};

type ShareTurn = {
  inboxItemId: string;
  requestMessageId: string | null;
  startedAt: string;
  /** The feed's high-water sequence when the turn began: the turn's events come after it. */
  startSequence: number;
  endedAt: string | null;
  /** The sequence of the first delta of each text block of the turn, as the feed received it. */
  textStarts: Map<string, number>;
};

type ShareState = {
  turn: ShareTurn | null;
  session: { id: string; inboxItemId: string } | null;
  sentKey: string | null;
  /** The shape of the feed (turn, end, window) the sent snapshot was built from; read only with sentKey. */
  sentShape: string | null;
  lastPublishMs: number;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** All network work of one agent runs in order, so a withdrawal is never overtaken by an earlier publication. */
  chain: Promise<void>;
  /** Earlier live sessions may still be in the room and must be removed. */
  withdrawPending: boolean;
  /** When this process began trying to remove them; null while nothing waits for removal. */
  withdrawSinceMs: number | null;
  /** Counts the owner's changes, so a request that started before one cannot undo it. */
  epoch: number;
  /** The turn the room server refused to keep as a live session; nothing more is sent for it. */
  unsupportedTurn: string | null;
};

/**
 * Publishes the room's view of an agent's current turn while, and only while,
 * its owner shares live activity. The turn's events are read from the owner's
 * live feed, so no second buffer exists; the publisher only remembers where
 * each text block of the turn began. One snapshot per agent reaches the room
 * at most once per interval; turning sharing off cancels what waits and
 * removes every live session of the agent from the room, and the saved state
 * keeps asking for that removal until the room server confirms it.
 */
export class LiveRoomSharePublisher {
  private readonly states = new Map<string, ShareState>();
  private readonly enabled = new Map<string, boolean>();
  private readonly nowMs: () => number;
  private readonly setTimer: NonNullable<LiveRoomSharePorts["setTimeout"]>;
  private readonly clearTimer: NonNullable<LiveRoomSharePorts["clearTimeout"]>;
  private readonly intervalMs: number;

  constructor(private readonly ports: LiveRoomSharePorts) {
    this.nowMs = ports.nowMs ?? Date.now;
    this.setTimer = ports.setTimeout ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = ports.clearTimeout ?? clearTimeout;
    this.intervalMs = ports.intervalMs ?? LIVE_ROOM_SHARE_INTERVAL_MS;
  }

  /**
   * The saved choices when the daemon starts: an agent whose earlier turns a
   * stopped process could not remove from the room gets them removed now.
   */
  resume(saved: ReadonlyMap<string, LiveSharingState>): void {
    for (const [entryId, choice] of saved) {
      if (this.enabled.has(entryId)) continue;
      this.enabled.set(entryId, choice === "on");
      if (choice !== "withdrawing") continue;
      const state = this.state(entryId);
      this.awaitWithdrawal(state);
      this.schedule(entryId, state, true);
    }
  }

  /** A delivered turn began (or moved to its next phase) for this room message. */
  turnStarted(entryId: string, inboxItemId: string, sourceMessageId: string): void {
    const state = this.state(entryId);
    if (state.turn?.inboxItemId === inboxItemId && !state.turn.endedAt) return;
    state.turn = {
      inboxItemId,
      requestMessageId: sourceMessageId,
      startedAt: new Date(this.nowMs()).toISOString(),
      startSequence: this.ports.feed.highWater(entryId),
      endedAt: null,
      textStarts: new Map(),
    };
    state.sentKey = null;
    state.failures = 0;
    this.schedule(entryId, state);
  }

  /** The delivered turn ended; null ends whichever turn is current (the agent stopped). */
  turnEnded(entryId: string, inboxItemId: string | null): void {
    const state = this.states.get(entryId);
    const turn = state?.turn;
    if (!state || !turn || turn.endedAt || (inboxItemId !== null && turn.inboxItemId !== inboxItemId)) return;
    turn.endedAt = new Date(this.nowMs()).toISOString();
    this.schedule(entryId, state);
  }

  /** The owner's live feed received this event for the agent. */
  observe(entryId: string, event: DaemonAgentStreamEvent | null): void {
    const state = this.states.get(entryId);
    const turn = state?.turn;
    if (!state || !turn || turn.endedAt || !event || event.sequence <= turn.startSequence) return;
    const part = liveStreamTextPart(event);
    if (part) {
      const key = `${part.kind}:${part.id}`;
      if (!turn.textStarts.has(key) && turn.textStarts.size < MAX_TRACKED_TEXT_PARTS) turn.textStarts.set(key, event.sequence);
    }
    this.schedule(entryId, state);
  }

  /**
   * The owner changed the choice; `saved` is the stored result. Off: nothing
   * that waits is sent, and the agent's live sessions are removed from the
   * room when it ever shared. On: publication starts with the current turn,
   * if one is running; a turn that ended while sharing was off stays private.
   */
  setSharing(entryId: string, saved: LiveSharingState): void {
    const enabled = saved === "on";
    this.enabled.set(entryId, enabled);
    const state = this.state(entryId);
    state.epoch += 1;
    state.failures = 0;
    state.sentKey = null;
    if (enabled) {
      if (state.turn?.endedAt) state.turn = null;
    } else {
      if (state.timer) this.clearTimer(state.timer);
      state.timer = null;
      state.session = null;
      if (saved === "withdrawing") this.awaitWithdrawal(state);
    }
    this.schedule(entryId, state, !enabled);
  }

  /** The agent is gone: forget it and everything that waits for it. */
  forget(entryId: string): void {
    const state = this.states.get(entryId);
    if (state?.timer) this.clearTimer(state.timer);
    this.states.delete(entryId);
    this.enabled.delete(entryId);
  }

  dispose(): void {
    for (const entryId of [...this.states.keys()]) this.forget(entryId);
  }

  private state(entryId: string): ShareState {
    let state = this.states.get(entryId);
    if (!state) {
      state = {
        turn: null, session: null, sentKey: null, sentShape: null, lastPublishMs: Number.NEGATIVE_INFINITY, failures: 0,
        timer: null, chain: Promise.resolve(), withdrawPending: false, withdrawSinceMs: null, epoch: 0, unsupportedTurn: null,
      };
      this.states.set(entryId, state);
    }
    return state;
  }

  /** The owner's choice. A failed read counts as off for this attempt only, and is not remembered. */
  private async isEnabled(entryId: string, state: ShareState): Promise<boolean> {
    const known = this.enabled.get(entryId);
    if (known !== undefined) return known;
    let saved: LiveSharingState;
    try { saved = await this.ports.sharing(entryId); } catch { return false; }
    // A change the owner made meanwhile wins over the read.
    if (!this.enabled.has(entryId)) {
      this.enabled.set(entryId, saved === "on");
      if (saved === "withdrawing") this.awaitWithdrawal(state);
    }
    return this.enabled.get(entryId) === true;
  }

  private schedule(entryId: string, state: ShareState, immediately = false): void {
    if (state.timer || this.states.get(entryId) !== state) return;
    // While the owner does not share and nothing is left to remove, there is no work.
    if (this.enabled.get(entryId) === false && !state.withdrawPending) return;
    const backoff = state.failures
      ? Math.min(MAX_RETRY_DELAY_MS, this.intervalMs * 2 ** Math.min(state.failures, 10)) : 0;
    const paced = immediately ? 0 : Math.max(0, state.lastPublishMs + this.intervalMs - this.nowMs());
    state.timer = this.setTimer(() => {
      state.timer = null;
      state.chain = state.chain.then(() => this.work(entryId, state)).catch(() => undefined);
    }, Math.max(paced, backoff));
  }

  private awaitWithdrawal(state: ShareState): void {
    state.withdrawPending = true;
    state.withdrawSinceMs ??= this.nowMs();
  }

  private withdrawalDone(state: ShareState): void {
    state.withdrawPending = false;
    state.withdrawSinceMs = null;
  }

  /**
   * Try again later. A removal the owner asked for is never given up while
   * the room may still show the agent's work: it is retried at most once a
   * minute until it succeeds, or until the server's retention has removed
   * what was shared. A publication gives up after a few failures and waits
   * for the agent's next activity.
   */
  private retryLater(entryId: string, state: ShareState): void {
    state.failures += 1;
    if (state.withdrawPending) {
      if (this.nowMs() - (state.withdrawSinceMs ?? this.nowMs()) < WITHDRAW_RETRY_LIMIT_MS) {
        this.schedule(entryId, state);
        return;
      }
      this.withdrawalDone(state);
      if (this.enabled.get(entryId) !== true) void this.ports.withdrawn(entryId).catch(() => undefined);
      return;
    }
    if (state.failures < MAX_CONSECUTIVE_FAILURES) this.schedule(entryId, state);
  }

  private async work(entryId: string, state: ShareState): Promise<void> {
    if (this.states.get(entryId) !== state) return;
    const sharing = await this.isEnabled(entryId, state);
    if (state.withdrawPending) {
      const target = await this.ports.target(entryId).catch(() => null);
      if (!target) { this.retryLater(entryId, state); return; }
      const epoch = state.epoch;
      try {
        await this.ports.http.withdraw(target);
      } catch {
        this.retryLater(entryId, state);
        return;
      }
      if (state.epoch === epoch) {
        this.withdrawalDone(state);
        state.failures = 0;
        if (!sharing) await this.ports.withdrawn(entryId).catch(() => undefined);
      }
    }
    const turn = state.turn;
    if (!turn || turn.inboxItemId === state.unsupportedTurn || !sharing) return;
    let body: SnapshotBody;
    let feedShape: string;
    try {
      const feed = this.ports.feed.retainedAfter(entryId, turn.startSequence);
      // Feed events are appended with new sequences and never changed, so the
      // same turn, end, window and dropped flag give the same snapshot as the
      // one already sent. Skip building it again.
      feedShape = [turn.inboxItemId, turn.endedAt ?? "", feed.dropped, feed.events.length,
        feed.events[0]?.sequence ?? "", feed.events.at(-1)?.sequence ?? ""].join("|");
      if (state.sentKey !== null && state.sentShape === feedShape
        && state.session?.inboxItemId === turn.inboxItemId) return;
      const windowStart = feed.events[0]?.sequence ?? Number.POSITIVE_INFINITY;
      body = buildRoomLiveSnapshot({
        events: feed.events,
        dropped: feed.dropped,
        // With nothing dropped every block is whole; otherwise only a block that began inside the feed's window.
        textIntact: (part) => {
          if (!feed.dropped) return true;
          const start = turn.textStarts.get(`${part.kind}:${part.id}`);
          return start !== undefined && start >= windowStart;
        },
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        requestMessageId: turn.requestMessageId,
      });
    } catch {
      // A snapshot that cannot take the stored shape is never sent.
      return;
    }
    const key = JSON.stringify(body);
    if (key === state.sentKey && state.session?.inboxItemId === turn.inboxItemId) return;
    const target = await this.ports.target(entryId).catch(() => null);
    if (!target) { this.retryLater(entryId, state); return; }
    const epoch = state.epoch;
    // The owner may have turned sharing off while this snapshot was built.
    const current = () => state.epoch === epoch && this.enabled.get(entryId) === true && this.states.get(entryId) === state;
    if (!current()) return;
    state.lastPublishMs = this.nowMs();
    try {
      if (state.session?.inboxItemId === turn.inboxItemId) {
        if (!await this.ports.http.update(target, state.session.id, body)) state.session = null;
        if (!current()) return;
      }
      if (state.session?.inboxItemId !== turn.inboxItemId) {
        const id = await this.ports.http.create(target, body);
        if (!current()) return;
        state.session = { id, inboxItemId: turn.inboxItemId };
        // The server replaced every earlier live session of the agent.
        this.withdrawalDone(state);
      }
      state.sentKey = key;
      state.sentShape = feedShape;
      state.failures = 0;
    } catch (error) {
      if (!current()) return;
      // An older room server: try again with the next turn, not with every change of this one.
      if ((error as { unsupported?: unknown } | null)?.unsupported === true) state.unsupportedTurn = turn.inboxItemId;
      else this.retryLater(entryId, state);
    }
  }
}
