import type { EventEmitter } from "node:events";

import { ACTIVE_AGENT_PRESENCE_WINDOW_MS } from "../../shared/agent-presence.js";
import { PRESENCE_CHANGED, PRESENCE_RESYNC } from "../server/presence-change-events.js";

/** An agent answering in a room right now. */
export interface AccountWorkingAgent {
  agent_key: string | null;
  display_name: string;
}

/** What the sidebar shows for one room. */
export interface AccountRoomActivity {
  room_id: string;
  latest_message_id: string | null;
  latest_message_at: string | null;
  working: AccountWorkingAgent[];
}

export interface WorkingPresence {
  agents: AccountWorkingAgent[];
  /** Heartbeat of the working agent that will go quiet first, in epoch ms. */
  oldestHeartbeatMs: number | null;
}

export interface AccountActivityLoaders {
  /** Agents working in each room whose heartbeat is newer than `sinceMs`. */
  loadWorking(roomIds: readonly string[], sinceMs: number): Promise<Map<string, WorkingPresence>>;
  loadLatest(roomIds: readonly string[]): Promise<Map<string, { latest_message_id: string | null; latest_message_at: string | null }>>;
}

export interface AccountActivityWatch {
  snapshot: AccountRoomActivity[];
  close(): void;
}

type Watcher = { onChange: (activity: AccountRoomActivity) => void; ready: boolean };
type Pending = { working: boolean; latest: boolean };

export interface AccountActivityHubOptions {
  /** Changes are gathered this long, so a burst in one room reads the database once. */
  coalesceMs?: number;
  /** An agent whose heartbeat is older than this is no longer shown as working. */
  presenceWindowMs?: number;
  /** After a failed read, the first retry waits this long, doubling up to `maxRetryMs`. */
  firstRetryMs?: number;
  maxRetryMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * Keeps each watched room's activity current from events, never by polling.
 *
 * - An agent starting or stopping work arrives as a presence change (a
 *   database trigger, delivered at commit) and re-reads that room's workers.
 * - A new message re-reads that room's latest visible message.
 * - An agent that stops sending heartbeats cannot announce it; the one timer
 *   per room, set for when its first working agent would go quiet, covers that.
 *
 * Rooms nobody is watching are ignored, and a watcher is only told about a
 * room when what it would show has changed.
 */
export class AccountActivityHub {
  private readonly watchers = new Map<string, Set<Watcher>>();
  private readonly current = new Map<string, AccountRoomActivity>();
  private readonly versions = new Map<string, number>();
  private readonly quietTimers = new Map<string, unknown>();
  private pending = new Map<string, Pending>();
  /** Changes to rooms whose first snapshot is still loading; read again once it lands. */
  private readonly missed = new Map<string, Pending>();
  private flushTimer: unknown = null;
  /** The armed flush is a retry after a failed read, not a gathered change. */
  private flushIsRetry = false;
  private flushing: Promise<void> = Promise.resolve();
  private readonly coalesceMs: number;
  private readonly presenceWindowMs: number;
  private readonly firstRetryMs: number;
  private readonly maxRetryMs: number;
  private retryMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private detach: (() => void) | null = null;

  constructor(private readonly loaders: AccountActivityLoaders, options: AccountActivityHubOptions = {}) {
    this.coalesceMs = options.coalesceMs ?? 150;
    this.presenceWindowMs = options.presenceWindowMs ?? ACTIVE_AGENT_PRESENCE_WINDOW_MS;
    this.firstRetryMs = options.firstRetryMs ?? 2_000;
    this.maxRetryMs = options.maxRetryMs ?? 30_000;
    this.retryMs = this.firstRetryMs;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  attach(sources: { presence: EventEmitter; messages: EventEmitter }): void {
    this.detach?.();
    const onPresence = (roomId: unknown) => {
      if (typeof roomId === "string") this.invalidate(roomId, { working: true, latest: false });
    };
    const onResync = () => {
      for (const roomId of this.watchers.keys()) this.invalidate(roomId, { working: true, latest: true });
    };
    const onMessage = (payload: unknown) => {
      const roomId = (payload as { projectId?: unknown } | null)?.projectId;
      if (typeof roomId === "string") this.invalidate(roomId, { working: false, latest: true });
    };
    sources.presence.on(PRESENCE_CHANGED, onPresence);
    sources.presence.on(PRESENCE_RESYNC, onResync);
    sources.messages.on("message:created", onMessage);
    this.detach = () => {
      sources.presence.off(PRESENCE_CHANGED, onPresence);
      sources.presence.off(PRESENCE_RESYNC, onResync);
      sources.messages.off("message:created", onMessage);
    };
  }

  /**
   * Watch these rooms. The watcher is registered before the snapshot is read,
   * so a change that lands while it loads is not lost: the newer value wins.
   */
  async watch(roomIds: readonly string[], onChange: (activity: AccountRoomActivity) => void): Promise<AccountActivityWatch> {
    const ids = [...new Set(roomIds.filter(Boolean))];
    const watcher: Watcher = { onChange, ready: false };
    for (const id of ids) {
      let set = this.watchers.get(id);
      if (!set) this.watchers.set(id, set = new Set());
      set.add(watcher);
    }
    const close = () => this.unwatch(ids, watcher);
    try {
      const versionsAtStart = new Map(ids.map((id) => [id, this.versions.get(id) ?? 0]));
      const loaded = await this.load(ids, { working: true, latest: true });
      const snapshot = ids.map((id) => {
        const newer = (this.versions.get(id) ?? 0) > (versionsAtStart.get(id) ?? 0);
        const value = newer ? this.current.get(id)! : loaded.get(id)!;
        if (!newer) this.remember(id, value);
        return value;
      });
      watcher.ready = true;
      // A change that arrived before any snapshot of the room existed may be
      // missing from the one just read; read it again now there is one to update.
      for (const id of ids) {
        const parts = this.missed.get(id);
        if (!parts) continue;
        this.missed.delete(id);
        this.invalidate(id, parts);
      }
      return { snapshot, close };
    } catch (error) {
      close();
      throw error;
    }
  }

  /** Whether any account is watching this room, so its events are worth hearing. */
  watches(roomId: string): boolean {
    return this.watchers.has(roomId);
  }

  close(): void {
    this.detach?.();
    this.detach = null;
    if (this.flushTimer) this.clearTimer(this.flushTimer);
    this.flushTimer = null;
    this.flushIsRetry = false;
    for (const timer of this.quietTimers.values()) this.clearTimer(timer);
    this.quietTimers.clear();
    this.watchers.clear();
    this.current.clear();
    this.pending.clear();
    this.missed.clear();
  }

  /**
   * Test seam: resolves once every gathered change has been read and sent. A
   * retry after a failed read is left to its timer.
   */
  async settle(): Promise<void> {
    await this.flushing;
    while (this.flushTimer && !this.flushIsRetry) {
      this.clearTimer(this.flushTimer);
      this.flushTimer = null;
      this.queueFlush();
      await this.flushing;
    }
  }

  private unwatch(ids: readonly string[], watcher: Watcher): void {
    for (const id of ids) {
      const set = this.watchers.get(id);
      if (!set) continue;
      set.delete(watcher);
      if (set.size) continue;
      this.watchers.delete(id);
      this.current.delete(id);
      this.pending.delete(id);
      this.missed.delete(id);
      const timer = this.quietTimers.get(id);
      if (timer) this.clearTimer(timer);
      this.quietTimers.delete(id);
    }
  }

  private invalidate(roomId: string, parts: Pending): void {
    if (!this.watchers.has(roomId)) return;
    mergeInto(this.pending, roomId, parts);
    this.armFlush(this.coalesceMs, false);
  }

  private armFlush(delayMs: number, retry: boolean): void {
    if (this.flushTimer) return;
    this.flushIsRetry = retry;
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = null;
      this.flushIsRetry = false;
      this.queueFlush();
    }, delayMs);
  }

  /** Flushes run one at a time; one that throws must not stop the ones after it. */
  private queueFlush(): void {
    this.flushing = this.flushing
      .then(() => this.flush())
      .catch((error) => console.error("[account activity] could not send room activity", error));
  }

  private async flush(): Promise<void> {
    const batch = this.pending;
    this.pending = new Map();
    const working = [...batch].filter(([id, part]) => part.working && this.watchers.has(id)).map(([id]) => id);
    const latest = [...batch].filter(([id, part]) => part.latest && this.watchers.has(id)).map(([id]) => id);
    if (!working.length && !latest.length) return;
    let loadedWorking: Map<string, WorkingPresence>;
    let loadedLatest: Awaited<ReturnType<AccountActivityLoaders["loadLatest"]>>;
    try {
      [loadedWorking, loadedLatest] = await Promise.all([
        working.length ? this.loaders.loadWorking(working, this.now() - this.presenceWindowMs) : Promise.resolve(new Map()),
        latest.length ? this.loaders.loadLatest(latest) : Promise.resolve(new Map()),
      ]);
    } catch (error) {
      // Keep what was last shown and read again after a pause: an agent that
      // started working sends no further change until it stops.
      console.error("[account activity] could not read room activity", error);
      for (const [id, parts] of batch) if (this.watchers.has(id)) mergeInto(this.pending, id, parts);
      if (this.pending.size) this.armFlush(this.retryMs, true);
      this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
      return;
    }
    this.retryMs = this.firstRetryMs;
    for (const id of new Set([...working, ...latest])) {
      if (!this.watchers.has(id)) continue;
      const previous = this.current.get(id);
      if (!previous) {
        // The room's first snapshot is still loading; watch() reads again.
        mergeInto(this.missed, id, { working: working.includes(id), latest: latest.includes(id) });
        continue;
      }
      const next: AccountRoomActivity = { ...previous };
      if (working.includes(id)) {
        const presence = loadedWorking.get(id);
        next.working = presence?.agents ?? [];
        this.scheduleQuietCheck(id, presence?.oldestHeartbeatMs ?? null);
      }
      if (latest.includes(id)) {
        const message = loadedLatest.get(id);
        next.latest_message_id = message?.latest_message_id ?? null;
        next.latest_message_at = message?.latest_message_at ?? null;
      }
      if (sameActivity(previous, next)) continue;
      this.remember(id, next);
      for (const watcher of this.watchers.get(id) ?? []) {
        if (!watcher.ready) continue;
        try { watcher.onChange(next); }
        catch (error) { console.error("[account activity] watcher failed", error); }
      }
    }
  }

  private async load(ids: readonly string[], parts: Pending): Promise<Map<string, AccountRoomActivity>> {
    const [working, latest] = await Promise.all([
      parts.working ? this.loaders.loadWorking(ids, this.now() - this.presenceWindowMs) : Promise.resolve(new Map<string, WorkingPresence>()),
      parts.latest ? this.loaders.loadLatest(ids) : Promise.resolve(new Map()),
    ]);
    const result = new Map<string, AccountRoomActivity>();
    for (const id of ids) {
      const presence = working.get(id);
      this.scheduleQuietCheck(id, presence?.oldestHeartbeatMs ?? null);
      result.set(id, {
        room_id: id,
        latest_message_id: latest.get(id)?.latest_message_id ?? null,
        latest_message_at: latest.get(id)?.latest_message_at ?? null,
        working: presence?.agents ?? [],
      });
    }
    return result;
  }

  private remember(id: string, activity: AccountRoomActivity): void {
    this.current.set(id, activity);
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
  }

  /**
   * A working agent that stops sending heartbeats cannot announce it, so the
   * room is read again just after its first working agent would go quiet. A
   * heartbeat in the meantime simply moves the next check.
   */
  private scheduleQuietCheck(roomId: string, oldestHeartbeatMs: number | null): void {
    const existing = this.quietTimers.get(roomId);
    if (existing) this.clearTimer(existing);
    this.quietTimers.delete(roomId);
    if (oldestHeartbeatMs === null || !this.watchers.has(roomId)) return;
    const delay = Math.max(1_000, oldestHeartbeatMs + this.presenceWindowMs - this.now() + 1_000);
    this.quietTimers.set(roomId, this.setTimer(() => {
      this.quietTimers.delete(roomId);
      this.invalidate(roomId, { working: true, latest: false });
    }, delay));
  }
}

function mergeInto(target: Map<string, Pending>, roomId: string, parts: Pending): void {
  const pending = target.get(roomId) ?? { working: false, latest: false };
  pending.working ||= parts.working;
  pending.latest ||= parts.latest;
  target.set(roomId, pending);
}

function sameActivity(a: AccountRoomActivity, b: AccountRoomActivity): boolean {
  return a.latest_message_id === b.latest_message_id
    && a.latest_message_at === b.latest_message_at
    && a.working.length === b.working.length
    && a.working.every((agent, index) =>
      agent.agent_key === b.working[index].agent_key && agent.display_name === b.working[index].display_name);
}
