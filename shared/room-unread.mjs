const MAX_ROOMS = 500;
export const unreadRoomKey = (room) => String(room ?? "").trim().toLowerCase();

// This is a personal local bookmark, never receipt or notification evidence.
// Resolve storage inside each try block: even the localStorage getter can throw.
export function createRoomUnreadStore({ storage, namespace, changed = () => {} }) {
  const key = (account) => `${namespace}:${encodeURIComponent(account)}`;
  function read(account) {
    if (!account) return [];
    try {
      const rows = JSON.parse(storage().getItem(key(account)) || "[]");
      return Array.isArray(rows) ? rows.filter(row => row
        && typeof row.room === "string" && row.room
        && typeof row.messageId === "string" && row.messageId
        && typeof row.revision === "string" && row.revision
        && Number.isFinite(row.markedAt)).slice(-MAX_ROOMS) : [];
    } catch { return []; }
  }
  function write(account, rows) {
    try {
      storage().setItem(key(account), JSON.stringify(rows.slice(-MAX_ROOMS)));
      changed();
      return true;
    } catch { changed(); return false; }
  }
  function get(account, room) {
    return read(account).find(row => row.room === unreadRoomKey(room)) ?? null;
  }
  return {
    get,
    mark(account, room, messageId) {
      room = unreadRoomKey(room);
      if (!account || !room || !messageId || messageId.startsWith("pending:")) return null;
      const markedAt = Date.now();
      let revision = `${markedAt}-${Math.random()}`;
      try { revision = globalThis.crypto?.randomUUID?.() ?? revision; } catch { /* Plain HTTP may lack secure crypto. */ }
      const row = { room, messageId, markedAt, revision };
      return write(account, [...read(account).filter(item => item.room !== room), row]) ? row : null;
    },
    clear(account, room, revision) {
      const rows = read(account);
      const current = rows.find(row => row.room === unreadRoomKey(room));
      if (!current || current.revision !== revision) return false;
      return write(account, rows.filter(row => row !== current));
    },
    acceptsStorageEvent(eventKey) {
      return eventKey === null || eventKey.startsWith(namespace + ":");
    },
  };
}

// Capture once at entry, before loading history. A mark made during this visit
// (including one from another tab) can never match this captured revision.
export function canClearUnreadBookmark({ enteredRevision, current, revealed, atBottom, visible, focused }) {
  return Boolean(enteredRevision && current?.revision === enteredRevision
    && revealed && atBottom && visible && focused);
}
