/** Session-only delivery state. History is a baseline, not a notification. */
export function createActivityUnread() {
  let scope: string | null = null;
  const rooms = new Map<string, { baseline: boolean; known: Set<string>; unread: Set<string> }>();
  const subscribers = new Set<() => void>();
  const changed = () => { for (const listener of subscribers) listener(); };
  function state(room: string) {
    if (!scope || !room) return null;
    if (!rooms.has(room)) rooms.set(room, { baseline: false, known: new Set(), unread: new Set() });
    return rooms.get(room)!;
  }
  function receive(room: string, ids: readonly string[]) {
    const entry = state(room);
    if (!entry) return;
    const before = entry.unread.size;
    for (const id of ids) {
      if (!id || entry.known.has(id)) continue;
      entry.known.add(id);
      entry.unread.add(id);
    }
    if (entry.unread.size !== before) changed();
  }
  return {
    get scope() { return scope; },
    subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    setScope(next: string | null) {
      if (scope === next) return;
      rooms.clear();
      scope = next;
      changed();
    },
    receive,
    observeLatest(room: string, ids: readonly string[]) {
      const entry = state(room);
      if (!entry) return;
      if (entry.baseline) receive(room, ids);
      else for (const id of ids) if (id) entry.known.add(id);
      // Do not clear deliveries that arrived while the initial page loaded.
      entry.baseline = true;
    },
    observeHistory(room: string, ids: readonly string[]) {
      const entry = state(room);
      if (entry) for (const id of ids) if (id) entry.known.add(id);
    },
    acknowledge(room: string, ids: readonly string[]) {
      const entry = state(room);
      if (!entry) return;
      const before = entry.unread.size;
      for (const id of ids) entry.unread.delete(id);
      if (entry.unread.size !== before) changed();
    },
    count(room: string) { return scope ? rooms.get(room)?.unread.size ?? 0 : 0; },
  };
}

export const activityUnread = createActivityUnread();
