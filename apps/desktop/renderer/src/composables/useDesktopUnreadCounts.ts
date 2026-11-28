import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import type { DesktopAuthAccount, DesktopRoomLatestMessage } from "../../../electron/ipc-types";
import type { DesktopServerRoomUnread } from "../../../electron/ipc-types/unread";
import { countUnreadRoomMessages, roomReadKey, type RoomReadMarkers, type RoomUnreadSnapshot } from "../domain/desktop-room-read-state";
import { sharedRoomMessagePages } from "../domain/shared-room-message-pages";
import { desktopIpc } from "../ipc";
import { githubEventsVisibilityRevision, readGitHubEventsVisible } from "../components/desktop/content/room-shell/preferences";

function messageNumber(id: string | null | undefined): number | null {
  if (!id || !/^msg_[1-9]\d*$/.test(id)) return null;
  const value = Number(id.slice(4));
  return Number.isSafeInteger(value) ? value : null;
}

/** A burst of changes (messages streaming in) asks the server once, this long after the last change… */
export const UNREAD_REFRESH_DEBOUNCE_MS = 300;
/** …and at most this long after the first. */
export const UNREAD_REFRESH_MAX_WAIT_MS = 2_000;
/** An own report not echoed back within this long is forgotten (a report that wrote no new range sends no frame). */
const OWN_REPORT_ECHO_MS = 60_000;

/**
 * The key the counts reset on: the storage settings, and the rooms whose
 * history is kept on this device, in a fixed order. The order of the sidebar
 * and the cloud rooms in it are not part of the key, so a room that moves, is
 * opened or is added does not clear every count.
 */
export function unreadStorageModeKey(
  settings: unknown,
  rooms: ReadonlyArray<readonly [roomIdentifier: string, mode: "cloud" | "local"]>,
): string {
  return JSON.stringify([settings, rooms.filter(([, mode]) => mode === "local").map(([identifier]) => identifier).sort()]);
}

/**
 * Unread counts for the sidebar and the dock badge.
 *
 * A cloud room whose read point the server holds takes its count from the
 * server (`/account/unread`): one request for every room, the same read state
 * on every device and on the web. Only a read this device can prove is
 * reported (`confirmedReads`: messages a person saw on screen in a focused
 * window, or "Mark as read"). A marker this device set by itself, such as the
 * baseline it gives a room it sees for the first time, is never reported, so
 * a new device never marks rooms read for the account's other devices; where
 * the server has a read point, the server's count wins over such a marker.
 * Local rooms, rooms the server has no read point for, and servers without the
 * route keep counting from room history here.
 */
export function useDesktopUnreadCounts(options: {
  account: Readonly<Ref<DesktopAuthAccount | null>>;
  rooms: Readonly<Ref<DesktopRoomLatestMessage[]>>;
  readMarkers: Readonly<Ref<RoomReadMarkers>>;
  storageMode: Readonly<Ref<string>>;
  /** Whether a room's history lives on the server or only on this device. Defaults to the server. */
  historyMode?: (roomIdentifier: string) => "cloud" | "local";
  /** Moves when the account records reads on any device (account activity stream). Read inside a watcher. */
  readRevision?: () => number;
  /** Reads this device can prove, by room key: the only reads ever reported to the server. */
  confirmedReads?: Readonly<Ref<Record<string, string>>>;
  /** The read behind the latest `readRevision` (room and newest message), so an echo of this device's own report is known. */
  lastRead?: () => { roomId: string; lastMessageId: string | null } | null;
  /** Every read since the last call, in order (null for a read the frame did not name); preferred over `lastRead`. */
  takeReads?: () => Array<{ roomId: string; lastMessageId: string | null } | null>;
  /**
   * Read markers this device kept before it reported reads to the server. They
   * are never reported (they cannot be proven), but where one is ahead of the
   * server's read point the room shows the lower of the two counts.
   */
  legacyReadMarkers?: () => RoomReadMarkers;
  /**
   * The room a person is reading right now (open, shown, focused), as a room
   * identifier, or null. It shows no count, as before: the server's count can
   * land a moment before this device's proof of what is on screen.
   */
  readingRoom?: () => string | null;
}) {
  const snapshots = ref<Record<string, RoomUnreadSnapshot>>({});
  /** The server's answer, by room key; null until read, or when the server has no such route. */
  const server = ref<Record<string, DesktopServerRoomUnread> | null>(null);
  /** False from a reset until the server has answered, or failed to, once: cloud rooms show no local count meanwhile. */
  const serverSettled = ref(false);
  /**
   * The last read point the server gave for a room it now answers no count for
   * (its access check cannot say yes right now), by room key. Such a room is
   * counted here from the later of this point and this device's confirmed read.
   */
  /** The server's last counts for those rooms, shown until the local count from the read point has loaded. */
  const staleCounts = ref<Record<string, { count: number; github: number; mentions: number }>>({});
  const staleReads = ref<Record<string, string>>({});
  /** The newest read other devices or the web reported, by room key (from `room_read` frames). */
  const elsewhereReads = ref<Record<string, number>>({});
  /** The highest message number this device reported per room, so a report is sent once. */
  const reported = new Map<string, number>();
  /** This device's reports: each comes back at most once as a `room_read` frame naming the same room and message. */
  const ownReports: Array<{ key: string; messageId: string; at: number }> = [];
  let serverDirty = true;
  /** Set by the debounce timer: only then does a refresh talk to the server. */
  let serverDue = false;
  let revision = 0;
  /** Moves only when the account or the storage settings change: an answer from before that is dropped, any other answer is applied. */
  let generation = 0;
  /** A slow or silent server hides cloud badges at most this long. */
  const GATE_FALLBACK_MS = 5_000;
  let gateTimer: ReturnType<typeof setTimeout> | null = null;
  function armGate(): void {
    if (gateTimer) clearTimeout(gateTimer);
    gateTimer = setTimeout(() => { gateTimer = null; serverSettled.value = true; }, GATE_FALLBACK_MS);
  }
  armGate();
  let disposed = false;
  let running: Promise<void> | null = null;
  let refreshPending = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let firstChangeAt: number | null = null;
  const historyMode = (roomIdentifier: string) => options.historyMode?.(roomIdentifier) ?? "cloud";
  const confirmed = (key: string) => messageNumber(options.confirmedReads?.value[key]);

  /** Where the local count of a room starts: its own marker, or, for a room the server stopped counting, the later of the last server read point and a confirmed read. */
  function localMarker(key: string): string | undefined {
    const stale = staleReads.value[key];
    if (!stale) return options.readMarkers.value[key];
    const best = Math.max(messageNumber(stale) ?? 0, confirmed(key) ?? 0, elsewhereReads.value[key] ?? 0);
    return `msg_${best}`;
  }

  /** The server's entry for a room it counts, or null when the room is counted here. */
  function serverRoom(room: DesktopRoomLatestMessage): DesktopServerRoomUnread | null {
    const key = roomReadKey(room.roomIdentifier);
    if (!key || !server.value || historyMode(room.roomIdentifier) !== "cloud") return null;
    const entry = server.value[key];
    return entry?.readMessageId && entry.unreadCount !== null ? entry : null;
  }

  /**
   * The marker kept before this version for a room the server counts, while it
   * is still ahead of the server's read point: the room is also counted here
   * from that saved marker (never from the current one, which moves without
   * proof). Once the server's read point reaches it, it is no longer used.
   */
  function legacyMarkerFor(room: DesktopRoomLatestMessage): string | null {
    const key = roomReadKey(room.roomIdentifier);
    const remote = serverRoom(room);
    const saved = key ? options.legacyReadMarkers?.()[key] ?? null : null;
    const savedNumber = messageNumber(saved);
    if (!remote || savedNumber === null) return null;
    return savedNumber > (messageNumber(remote.readMessageId) ?? 0) ? saved : null;
  }

  /** Each room's unread count, and how many of those messages mention the account, in one pass. */
  const roomState = computed(() => {
    const counts: Record<string, number> = {};
    const mentions: Record<string, number> = {};
    const result = { counts, mentions };
    if (!options.account.value) return result;
    void githubEventsVisibilityRevision.value;
    const reading = roomReadKey(options.readingRoom?.() ?? null);
    for (const room of options.rooms.value) {
      const key = roomReadKey(room.roomIdentifier);
      if (!key) continue;
      const marker = localMarker(key);
      const remote = serverRoom(room);
      if (remote) {
        if (key === reading) { counts[key] = 0; mentions[key] = 0; continue; }
        // Seen here just now and not yet on the server: nothing is unread.
        const seen = confirmed(key);
        const latest = messageNumber(room.latestMessageId);
        const fromServer = (remote.unreadCount ?? 0) + (readGitHubEventsVisible(room.roomIdentifier) ? remote.githubUnreadCount ?? 0 : 0);
        const snapshot = snapshots.value[key];
        // Read here before this version, on the web long ago: the lower count.
        const saved = legacyMarkerFor(room);
        const fromHere = saved && snapshot?.readMessageId === saved
          ? (saved === room.latestMessageId ? 0 : snapshot.count) : null;
        const seenAll = seen !== null && latest !== null && seen >= latest;
        counts[key] = seenAll ? 0 : fromHere === null ? fromServer : Math.min(fromServer, fromHere);
        // A server that sends no mention count (older) shows none.
        const mentionsFromServer = remote.mentionUnreadCount ?? 0;
        mentions[key] = seenAll ? 0
          : fromHere === null ? mentionsFromServer : Math.min(mentionsFromServer, snapshot?.mentionCount ?? mentionsFromServer);
        continue;
      }
      // A cloud room waits for the server's first answer instead of flashing a local count.
      if (historyMode(room.roomIdentifier) === "cloud" && !serverSettled.value && desktopIpc.room?.getAccountUnread) {
        counts[key] = 0;
        mentions[key] = 0;
        continue;
      }
      const snapshot = snapshots.value[key];
      const last = staleCounts.value[key];
      const unread = Boolean(marker && marker !== room.latestMessageId);
      const fromSnapshot = unread && snapshot?.readMessageId === marker ? snapshot : null;
      const fromLast = unread && !fromSnapshot ? last : undefined;
      counts[key] = fromSnapshot ? fromSnapshot.count
        : fromLast ? fromLast.count + (readGitHubEventsVisible(room.roomIdentifier) ? fromLast.github : 0) : 0;
      mentions[key] = fromSnapshot ? fromSnapshot.mentionCount ?? 0 : fromLast?.mentions ?? 0;
    }
    return result;
  });
  const roomCounts = computed(() => roomState.value.counts);
  const roomMentionCounts = computed(() => roomState.value.mentions);
  const totalCount = computed(() => Object.values(roomCounts.value).reduce((sum, count) => sum + count, 0));

  /**
   * The reports this device owes the server: one per cloud room where a read
   * it proved is past the server's read point and was not sent yet.
   */
  function pendingReports(isCurrent: () => boolean, accountId: string): Array<() => Promise<void>> {
    const report = desktopIpc.room?.reportRoomRead;
    if (!report || !server.value) return [];
    const sends: Array<() => Promise<void>> = [];
    for (const room of options.rooms.value) {
      const key = roomReadKey(room.roomIdentifier);
      if (!key || historyMode(room.roomIdentifier) !== "cloud") continue;
      const entry = server.value[key];
      const seen = confirmed(key);
      // Only a room the server answered for, and a read this device proved.
      if (!entry || seen === null) continue;
      const remote = messageNumber(entry.readMessageId);
      if (seen <= (remote ?? 0) || (reported.get(key) ?? 0) >= seen) continue;
      reported.set(key, seen);
      // The messages after the server's read point were seen here. Without a
      // server read point only the seen message itself is claimed.
      const from = remote === null ? null : `msg_${remote + 1}`;
      const seenId = `msg_${seen}`;
      sends.push(async () => {
        // An account switch during the batch: never send one account's read with another's sign-in.
        if (!isCurrent() || options.account.value?.id !== accountId) { reported.delete(key); return; }
        try {
          ownReports.push({ key, messageId: seenId, at: Date.now() });
          await report(room.roomIdentifier, seenId, from);
          const current = server.value?.[key];
          if (!current || !isCurrent()) return;
          const latest = messageNumber(room.latestMessageId);
          if (latest !== null && seen >= latest) {
            // Read to the end: nothing is unread, without asking again.
            server.value = { ...server.value, [key]: { ...current, readMessageId: seenId, unreadCount: 0, githubUnreadCount: 0, mentionUnreadCount: 0 } };
          } else {
            // Read part of the way: only the server knows how many are left. Ask once.
            server.value = { ...server.value, [key]: { ...current, readMessageId: seenId } };
            serverDirty = true;
            scheduleRefresh();
          }
        } catch {
          reported.delete(key);
        }
      });
    }
    return sends;
  }

  /** Reads the server's counts when they may have changed, then reports the reads this device proved. */
  async function syncServer(isCurrent: () => boolean, sameGeneration: () => boolean): Promise<void> {
    const accountId = options.account.value?.id;
    if (!accountId) return;
    const read = desktopIpc.room?.getAccountUnread;
    if (!read) { server.value = null; serverSettled.value = true; return; }
    if (serverDirty) {
      serverDirty = false;
      const answer = await read();
      // A different account or storage setting: this answer is dropped. Rooms or markers
      // that moved meanwhile do not drop it; the server is asked again for them.
      if (!sameGeneration()) { serverDirty = true; return; }
      if (!isCurrent()) serverDirty = true;
      if (!answer) { server.value = null; serverSettled.value = true; return; }
      const previous = server.value;
      const nextStale: Record<string, string> = {};
      const nextCounts: Record<string, { count: number; github: number; mentions: number }> = {};
      const nextServer = Object.fromEntries(answer.rooms.flatMap((room) => {
        const key = roomReadKey(room.roomId);
        if (!key) return [];
        // No count right now (the access check could not say yes): keep the last server entry, not a local count.
        if (room.unreadCount === null) {
          const point = room.readMessageId ?? (previous?.[key]?.unreadCount !== null ? previous?.[key]?.readMessageId : null) ?? staleReads.value[key];
          if (point) nextStale[key] = point;
          const before = previous?.[key];
          const last = before && before.unreadCount !== null
            ? { count: before.unreadCount, github: before.githubUnreadCount ?? 0, mentions: before.mentionUnreadCount ?? 0 } : staleCounts.value[key];
          if (last) nextCounts[key] = last;
        }
        return [[key, room]];
      }));
      staleReads.value = nextStale;
      staleCounts.value = nextCounts;
      server.value = nextServer;
      serverSettled.value = true;
    }
    const sends = pendingReports(isCurrent, accountId);
    // At most four at a time.
    for (let index = 0; index < sends.length; index += 4) await Promise.all(sends.slice(index, index + 4).map((send) => send()));
  }

  async function refresh(): Promise<void> {
    refreshPending = true;
    if (running) return running;
    running = (async () => {
      while (refreshPending && !disposed) {
        refreshPending = false;
        const currentRevision = revision;
        const account = options.account.value;
        const loadPage = desktopIpc.room?.getMessagesAfter;
        if (!account) continue;
        const isCurrent = () => !disposed && revision === currentRevision;
        const currentGeneration = generation;
        const sameGeneration = () => !disposed && generation === currentGeneration;
        if (serverDue) {
          serverDue = false;
          try {
            await syncServer(isCurrent, sameGeneration);
          } catch {
            // Keep the last answer; the next change asks again.
            serverDirty = true;
            if (sameGeneration()) serverSettled.value = true;
          }
        }
        if (!loadPage || !isCurrent()) continue;
        const rooms = [...new Map(options.rooms.value.map((room) => [roomReadKey(room.roomIdentifier), room])).values()]
          .filter((room) => !serverRoom(room) || legacyMarkerFor(room) !== null);
        // Only changed rooms need history, with at most four concurrent lookups.
        for (let index = 0; index < rooms.length && isCurrent(); index += 4) {
          await Promise.all(rooms.slice(index, index + 4).map(async (room) => {
            const key = roomReadKey(room.roomIdentifier);
            if (!key || !room.latestMessageId) return;
            const readMessageId = legacyMarkerFor(room) ?? localMarker(key);
            if (!readMessageId) return;
            const previous = snapshots.value[key];
            if (previous?.readMessageId === readMessageId && previous.latestMessageId === room.latestMessageId) return;
            try {
              const snapshot = await countUnreadRoomMessages({
                readMessageId,
                latestMessageId: room.latestMessageId,
                previous,
                ownSenderNames: [account.login, account.displayName || ""],
                mentionLogin: account.login,
                githubEventsVisible: readGitHubEventsVisible(room.roomIdentifier),
                loadPage: (after) => sharedRoomMessagePages.load({
                  accountId: account.id, reader: "unread", roomIdentifier: room.roomIdentifier, afterMessageId: after,
                  latestMessageId: room.latestMessageId, loadPage,
                }),
                isCurrent,
              });
              if (snapshot && isCurrent()) snapshots.value = { ...snapshots.value, [key]: snapshot };
            } catch {
              // Preserve the last known count on transient failure; the next tick retries.
            }
          }));
        }
      }
    })().finally(() => { running = null; });
    return running;
  }

  /** One refresh per burst: after a quiet moment, or at the latest UNREAD_REFRESH_MAX_WAIT_MS after the first change. */
  function scheduleRefresh(): void {
    if (disposed) return;
    const now = Date.now();
    firstChangeAt ??= now;
    if (debounceTimer) clearTimeout(debounceTimer);
    const wait = Math.max(0, Math.min(UNREAD_REFRESH_DEBOUNCE_MS, firstChangeAt + UNREAD_REFRESH_MAX_WAIT_MS - now));
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      firstChangeAt = null;
      serverDue = true;
      void refresh();
    }, wait);
  }

  // A GitHub-events toggle only recounts the local snapshots (below).
  watch(() => githubEventsVisibilityRevision.value, () => { revision += 1; snapshots.value = {}; }, { flush: "sync" });
  // A GitHub-events toggle is not here: the server's entry holds both counts, and
  // each local snapshot knows the visibility it was counted with.
  watch(() => [options.account.value?.id, options.storageMode.value], () => {
    revision += 1;
    generation += 1;
    snapshots.value = {};
    server.value = null;
    staleReads.value = {};
    staleCounts.value = {};
    elsewhereReads.value = {};
    serverSettled.value = false;
    armGate();
    reported.clear();
    ownReports.length = 0;
  }, { flush: "sync" });
  // A new message changes the server's counts: ask it again (debounced). A
  // read here changes nothing on the server until it is reported, and its
  // count is already shown here. Rooms counted here recount at once, as before.
  let lastRoomsKey = "";
  watch(() => JSON.stringify([options.account.value?.id, options.storageMode.value, options.rooms.value, options.readMarkers.value,
    options.confirmedReads?.value ?? {}, githubEventsVisibilityRevision.value]), () => {
    revision += 1;
    const roomsKey = JSON.stringify([options.account.value?.id, options.storageMode.value, options.rooms.value, githubEventsVisibilityRevision.value]);
    if (roomsKey !== lastRoomsKey) { lastRoomsKey = roomsKey; serverDirty = true; }
    scheduleRefresh();
    void refresh();
  }, { immediate: true });
  // A read on another device or the web. This device's own report comes back
  // the same way once; that echo is not news.
  watch(() => options.readRevision?.() ?? 0, (next, previous) => {
    if (next === previous) return;
    const now = Date.now();
    while (ownReports.length && now - ownReports[0]!.at > OWN_REPORT_ECHO_MS) ownReports.shift();
    const reads = options.takeReads ? options.takeReads() : [options.lastRead?.() ?? null];
    let news = reads.length === 0;
    for (const read of reads) {
      const echo = read ? ownReports.findIndex((own) => own.key === roomReadKey(read.roomId) && own.messageId === read.lastMessageId) : -1;
      if (echo >= 0) ownReports.splice(echo, 1);
      else {
        news = true;
        // A read elsewhere in a room the server cannot count right now moves its read point.
        const key = read ? roomReadKey(read.roomId) : null;
        const number = messageNumber(read?.lastMessageId);
        if (key && number !== null && number > (elsewhereReads.value[key] ?? 0)) {
          elsewhereReads.value = { ...elsewhereReads.value, [key]: number };
        }
      }
    }
    if (!news) return;
    serverDirty = true;
    scheduleRefresh();
  });
  // Closing the window or quitting: send the reads still owed, best effort, without asking for counts.
  const flushReports = () => {
    const accountId = options.account.value?.id;
    if (!accountId || disposed) return;
    for (const send of pendingReports(() => !disposed, accountId)) void send();
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", flushReports);
    window.addEventListener("beforeunload", flushReports);
  }
  watch(totalCount, (count) => {
    void desktopIpc.notifications?.setBadgeCount?.(count).catch(() => undefined);
  }, { immediate: true });
  onScopeDispose(() => {
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("pagehide", flushReports);
      window.removeEventListener("beforeunload", flushReports);
    }
    disposed = true;
    revision += 1;
    if (gateTimer) clearTimeout(gateTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
  });
  return { roomCounts, roomMentionCounts, totalCount, refresh, flushReports };
}
