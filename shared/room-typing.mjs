export const ROOM_TYPING = 'room_typing_v1';
export const TYPING = Object.freeze({ ttl: 5000, interval: 2500, sweep: 1000, sources: 4, people: 512, entries: 10000, name: 80 });

export function parseTypingReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { client_id, sequence, typing, ttl_ms } = value;
  if (Object.keys(value).sort().join() !== 'client_id,sequence,ttl_ms,typing'
    || typeof client_id !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(client_id)
    || !Number.isSafeInteger(sequence) || sequence < 1 || typeof typing !== 'boolean'
    || !Number.isInteger(ttl_ms) || ttl_ms < 0 || ttl_ms > TYPING.ttl
    || typing !== (ttl_ms > 0)) return null;
  return { client_id, sequence, typing, ttl_ms };
}

export function parseTypingSignal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { room_id, account_id, name, expires_at, ...report } = value;
  if (!parseTypingReport(report) || ![room_id, account_id, name].every(v => typeof v === 'string' && v.length > 0)
    || room_id.length > 512 || account_id.length > 128 || name.length > TYPING.name
    || !Number.isSafeInteger(expires_at)) return null;
  return value;
}

/** No drafts enter this controller: input is only a nonempty/empty bit. */
export function createTypingSender({ send, clientId, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  let sequence = 0, lastSent = -Infinity, lastInput = 0, active = false, reported = false, dirty = false, timer = null;
  function report(typing) {
    lastSent = now();
    reported = typing;
    dirty = false;
    try {
      void Promise.resolve(send({ client_id: clientId, sequence: ++sequence, typing,
        ttl_ms: typing ? Math.max(1, TYPING.ttl - (now() - lastInput)) : 0 })).catch(() => {});
    } catch { /* Reporting cannot interrupt composing, sending, or cleanup. */ }
  }
  function stop() {
    if (timer !== null) cancel(timer);
    timer = null;
    if (reported) report(false);
    active = false;
  }
  function tick() {
    timer = null;
    if (now() - lastInput >= TYPING.ttl) return stop();
    if (dirty && now() - lastSent >= TYPING.interval) report(true);
    timer = schedule(tick, Math.min(TYPING.interval, TYPING.ttl - (now() - lastInput)));
  }
  return {
    input(nonempty) {
      if (!nonempty) return stop();
      lastInput = now();
      dirty = true;
      if (!active) {
        active = true;
        if (now() - lastSent >= TYPING.interval) report(true);
      }
      if (timer === null) timer = schedule(tick, TYPING.interval);
    },
    stop,
  };
}

/** Plain-text sentence for assistive technology and compact surfaces. */
export function typingLabel(names) {
  if (names.length > 2) return 'Several people are typing…';
  return names.length ? `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} typing…` : '';
}

/** The same sentence as parts, so a view can emphasise names without building HTML. */
export function typingSentence(names) {
  const name = text => ({ text, name: true }), plain = text => ({ text, name: false });
  if (names.length === 1) return [name(names[0]), plain(' is typing')];
  if (names.length === 2) return [name(names[0]), plain(' and '), name(names[1]), plain(' are typing')];
  if (names.length < 3) return [];
  const others = names.length - 2;
  return [name(names[0]), plain(', '), name(names[1]), plain(` and ${others} ${others === 1 ? 'other' : 'others'} are typing`)];
}

/** Sequence guards survive stops briefly; no snapshot or replay. */
export function createTypingReceiver(now = Date.now) {
  const sources = new Map();
  return {
    receive(raw, self) {
      const value = parseTypingSignal(raw);
      if (!value || value.account_id === self) return;
      const key = `${value.account_id}:${value.client_id}`;
      const previous = sources.get(key);
      if (previous && previous.sequence >= value.sequence) return;
      if (!previous && sources.size >= TYPING.people * TYPING.sources) return;
      sources.set(key, { ...value, until: now() + Math.min(value.ttl_ms, TYPING.ttl), forget: now() + TYPING.ttl });
    },
    clear() { sources.clear(); },
    nextExpiry() {
      let earliest = Infinity;
      for (const value of sources.values()) {
        if (value.typing && value.until > now()) earliest = Math.min(earliest, value.until);
      }
      return Number.isFinite(earliest) ? earliest : null;
    },
    /** One name per account, in a stable order, so a row does not reshuffle between refreshes. */
    names() {
      const people = new Map();
      for (const [key, value] of sources) {
        if (value.forget <= now()) sources.delete(key);
        else if (value.typing && value.until > now()) people.set(value.account_id, value.name);
      }
      return [...people].sort(([a], [b]) => a.localeCompare(b)).map(([, name]) => name);
    },
    label() { return typingLabel(this.names()); },
  };
}

/** A single receiver timeout, and no timer at all when nobody is typing. */
export function createTypingDisplay(update, { now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const receiver = createTypingReceiver(now);
  let timer = null;
  function refresh() {
    if (timer !== null) cancel(timer);
    timer = null;
    const names = receiver.names();
    update(typingLabel(names), names);
    const expiry = receiver.nextExpiry();
    if (expiry !== null) timer = schedule(refresh, Math.max(0, expiry - now()));
  }
  return {
    receive(raw, self) { receiver.receive(raw, self); refresh(); },
    clear() { receiver.clear(); refresh(); },
  };
}
