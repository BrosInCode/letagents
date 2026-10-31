import { allowsRoomNotification, DEFAULT_ROOM_NOTIFICATION_PREFERENCE } from './room-notification-preferences.mjs';

/** Personal cache shared by desktop and the read-only web sound gate. */
export function createRoomNotificationClient(api, changed = () => {}, normalizeKey = (id) => id) {
  let viewer = null;
  let epoch = 0;
  let listVersion = 0;
  let listLoading = false;
  const rooms = new Map();
  const pendingReads = new Map();
  let pendingList = null;
  function state(roomId) {
    roomId = normalizeKey(roomId);
    if (!rooms.has(roomId)) rooms.set(roomId, {
      preference: { ...DEFAULT_ROOM_NOTIFICATION_PREFERENCE }, ready: false, loading: false,
      busy: false, error: '', version: 0,
    });
    return rooms.get(roomId);
  }
  function setViewer(next) {
    if (viewer?.id === next?.id && viewer?.login === next?.login) return;
    viewer = next;
    epoch++;
    listVersion++;
    listLoading = false;
    rooms.clear();
    pendingReads.clear();
    pendingList = null;
    changed();
  }
  async function performRefresh(roomId) {
    if (!viewer || !roomId) return;
    const row = state(roomId);
    if (row.busy) return;
    const version = ++row.version;
    const currentEpoch = epoch;
    row.loading = true;
    changed();
    try {
      const preference = await api.get(roomId);
      if (epoch !== currentEpoch || row.version !== version) return;
      row.preference = preference;
      row.error = '';
    } catch (error) {
      if (epoch !== currentEpoch || row.version !== version) return;
      if (!row.ready) row.preference = { ...DEFAULT_ROOM_NOTIFICATION_PREFERENCE };
      row.error = error instanceof Error ? error.message : 'Notification settings could not be loaded.';
    } finally {
      if (epoch === currentEpoch && row.version === version) {
        row.loading = false;
        row.ready = true;
        changed();
      }
    }
  }
  function refresh(roomId) {
    roomId = normalizeKey(roomId);
    const pending = performRefresh(roomId);
    pendingReads.set(roomId, pending);
    void pending.then(() => { if (pendingReads.get(roomId) === pending) pendingReads.delete(roomId); });
    return pending;
  }
  async function performRefreshAll() {
    if (!viewer || !api.list) return;
    const currentEpoch = epoch;
    const version = ++listVersion;
    listLoading = true;
    const roomVersions = new Map([...rooms].map(([id, row]) => [id, row.version]));
    try {
      const result = await api.list();
      if (currentEpoch !== epoch || version !== listVersion) return;
      const entries = new Map(result.preferences.map((entry) => [normalizeKey(entry.room_id), entry]));
      for (const id of new Set([...rooms.keys(), ...entries.keys()])) {
        const row = state(id);
        if (row.version !== (roomVersions.get(id) ?? 0) || row.loading || row.busy) continue;
        if (!entries.has(id) && result.truncated) continue;
        row.preference = entries.get(id) ?? { ...DEFAULT_ROOM_NOTIFICATION_PREFERENCE };
        row.ready = true;
        row.error = '';
      }
    } catch (error) {
      if (currentEpoch !== epoch || version !== listVersion) return;
      for (const [id, row] of rooms) {
        if (row.version !== (roomVersions.get(id) ?? 0) || row.loading || row.busy) continue;
        if (!row.ready) row.preference = { ...DEFAULT_ROOM_NOTIFICATION_PREFERENCE };
        row.ready = true;
        row.error = error instanceof Error ? error.message : 'Notification settings could not be loaded.';
      }
    }
    if (version === listVersion && currentEpoch === epoch) listLoading = false;
    changed();
  }
  function refreshAll() {
    const pending = performRefreshAll();
    pendingList = pending;
    void pending.then(() => { if (pendingList === pending) pendingList = null; });
    return pending;
  }
  async function update(roomId, change) {
    roomId = normalizeKey(roomId);
    if (!viewer || !api.put) throw new Error('Sign in to manage your room notifications.');
    const row = state(roomId);
    if (row.busy) return;
    row.busy = true;
    row.loading = false;
    row.version++;
    listVersion++;
    listLoading = false;
    const currentEpoch = epoch;
    changed();
    try {
      const preference = await api.put(roomId, change);
      if (currentEpoch !== epoch) return;
      row.preference = preference;
      row.ready = true;
      row.error = '';
    } catch (error) {
      if (currentEpoch !== epoch) return;
      row.error = error instanceof Error ? error.message : 'Notification settings could not be saved.';
    } finally {
      if (currentEpoch === epoch) { row.busy = false; changed(); }
    }
  }
  function allows(roomId, text, now = Date.now()) {
    const row = state(roomId);
    if ((row.loading || listLoading) && !row.ready) return false;
    return allowsRoomNotification(row.preference, text, viewer?.login, now);
  }
  async function allowsAfterRead(roomId, text) {
    roomId = normalizeKey(roomId);
    const currentEpoch = epoch;
    while (currentEpoch === epoch && !state(roomId).ready) {
      const pending = pendingReads.get(roomId) ?? pendingList;
      if (!pending) break;
      await pending;
    }
    return currentEpoch === epoch && allows(roomId, text);
  }
  return { setViewer, state, refresh, refreshAll, update, allows, allowsAfterRead, signedIn: () => Boolean(viewer) };
}
