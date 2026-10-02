import { ROOM_TYPING, TYPING, parseTypingSignal, type TypingReport, type TypingSignal } from '../../../shared/room-typing.mjs';
import { createBridgedEmitter, type BridgedEventEmitter } from './bridged-emitter.js';

export function createRoomTypingService(emitter: BridgedEventEmitter, now = Date.now) {
  const people = new Map<string, { room: string; last: number; sources: Map<string, { sequence: number; active: boolean; expires: number }> }>();
  const counts = new Map<string, number>();
  const listeners = new Map<string, Set<(signal: TypingSignal) => void>>();
  // Remote signals go only to listeners: limiter/sequence state is local.
  const receive = (raw: unknown) => {
    const signal = parseTypingSignal(raw);
    if (!signal || signal.expires_at <= now()) return;
    for (const listener of listeners.get(signal.room_id) ?? []) listener(signal);
  };
  emitter.on(ROOM_TYPING, receive);
  const sweep = setInterval(() => {
    for (const [key, person] of people) {
      for (const [id, source] of person.sources) if (source.expires <= now()) person.sources.delete(id);
      if (!person.sources.size && now() - person.last >= TYPING.ttl) {
        people.delete(key);
        const count = (counts.get(person.room) ?? 1) - 1;
        if (count) counts.set(person.room, count); else counts.delete(person.room);
      }
    }
  }, TYPING.sweep);
  sweep.unref();
  return {
    report(room: string, account: string, name: string, input: TypingReport) {
      const key = `${room}\n${account}`;
      let person = people.get(key);
      if (!person) {
        if (people.size >= TYPING.entries || (counts.get(room) ?? 0) >= TYPING.people) return;
        person = { room, last: -Infinity, sources: new Map() };
        people.set(key, person);
        counts.set(room, (counts.get(room) ?? 0) + 1);
      }
      const previous = person.sources.get(input.client_id);
      if (previous && previous.sequence >= input.sequence) return;
      if (!previous && person.sources.size >= TYPING.sources) return;
      if (!input.typing) {
        person.sources.set(input.client_id, { sequence: input.sequence, active: false, expires: now() + TYPING.ttl });
        if (!previous?.active) return;
      }
      if (input.typing && now() - person.last < TYPING.interval) return;
      if (input.typing) person.last = now();
      person.sources.set(input.client_id, { sequence: input.sequence, active: input.typing, expires: now() + TYPING.ttl });
      emitter.emit(ROOM_TYPING, { ...input, room_id: room, account_id: account,
        name: name.slice(0, TYPING.name), expires_at: now() + (input.ttl_ms || TYPING.ttl) });
    },
    subscribe(room: string, self: string, callback: (signal: TypingSignal) => void) {
      const set = listeners.get(room) ?? new Set();
      const listener = (signal: TypingSignal) => { if (signal.account_id !== self) callback(signal); };
      set.add(listener);
      listeners.set(room, set);
      return () => { set.delete(listener); if (!set.size) listeners.delete(room); };
    },
    close() { clearInterval(sweep); emitter.off(ROOM_TYPING, receive); people.clear(); counts.clear(); listeners.clear(); },
  };
}

export const roomTyping = createRoomTypingService(createBridgedEmitter(ROOM_TYPING));
