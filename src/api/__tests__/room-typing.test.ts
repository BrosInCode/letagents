import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ROOM_TYPING, TYPING, createTypingDisplay, createTypingReceiver, createTypingSender, parseTypingReport, parseTypingSignal, typingSentence, type TypingSignal } from '../../../shared/room-typing.mjs';
import { BridgedEventEmitter } from '../server/bridged-emitter.js';
import { createRoomTypingService, roomTyping } from '../server/room-typing.js';
import { registerRoomTypingRoute } from '../routes/rooms/messages/typing.js';

const report = (sequence = 1, typing = true, client_id = 'composer_source_1') => ({ client_id, sequence, typing, ttl_ms: typing ? TYPING.ttl : 0 });
const signal = (account_id = 'ada', sequence = 1, typing = true): TypingSignal => ({ ...report(sequence, typing), room_id: 'room_1', account_id, name: account_id, expires_at: 5000 });
function clock() {
  let time = 0, id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    schedule: (callback: () => void, ms: number) => { timers.set(++id, { at: time + ms, callback }); return id; },
    cancel: (key: number) => { timers.delete(key); },
    pending: () => timers.size,
    advance(ms: number) {
      const end = time + ms;
      while (true) {
        const next = [...timers].sort(([, a], [, b]) => a.at - b.at)[0];
        if (!next || next[1].at > end) break;
        time = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      time = end;
    },
  };
}

test('typing contract carries no draft or claimed identity; bounds and unknown fields are rejected', () => {
  assert.deepEqual(parseTypingReport(report()), report());
  for (const raw of [null, [], { ...report(), text: 'secret' }, { ...report(), account_id: 'someone' },
    { ...report(), ttl_ms: 5001 }, { ...report(), sequence: 0 }, { ...report(), sequence: Infinity },
    { ...report(), client_id: 'x' }, { ...report(), typing: 'yes' }, { ...report(), typing: false }]) {
    assert.equal(parseTypingReport(raw), null);
  }
  assert.deepEqual(parseTypingReport(report(2, false)), report(2, false));
  assert.equal(parseTypingSignal({ ...signal(), name: 'x'.repeat(TYPING.name + 1) }), null);
});

test('sender coalesces actual input, gives trailing pulses remaining TTL and stops after idle', () => {
  const time = clock();
  const sent: any[] = [];
  const sender = createTypingSender({ ...time, send: value => sent.push({ at: time.now(), ...value }), clientId: 'composer_source_1' });
  time.advance(6000);
  assert.equal(sent.length, 0, 'mounting/restoring a draft does not report');
  sender.input(true);
  for (let i = 0; i < 10; i++) { time.advance(100); sender.input(true); }
  assert.equal(sent.length, 1, 'one short keystroke burst');
  time.advance(1500);
  assert.equal(sent[1].ttl_ms, 3500, 'deadline belongs to last input, not timer time');
  time.advance(3500);
  assert.equal(sent.at(-1).typing, false);
  const count = sent.length;
  time.advance(10000);
  assert.equal(sent.length, count, 'no heartbeat from a merely nonempty draft');
  sender.stop();
});

test('empty/send/disposal stop once; restarting quickly cannot exceed the client active-pulse budget', () => {
  const time = clock(), sent: any[] = [];
  const sender = createTypingSender({ ...time, send: value => sent.push(value), clientId: 'composer_source_1' });
  sender.input(true); sender.input(false); sender.stop();
  sender.input(true); sender.input(false); sender.input(true);
  assert.equal(sent.filter(v => v.typing).length, 1);
  time.advance(TYPING.interval);
  assert.equal(sent.filter(v => v.typing).length, 2);
  sender.stop();
  const count = sent.length;
  time.advance(TYPING.ttl * 2);
  assert.equal(sent.length, count);
});

test('receiver expires a lost stop, deduplicates accounts/devices and rejects reordered starts', () => {
  const time = clock(), receiver = createTypingReceiver(time.now);
  receiver.receive(signal(), 'ada');
  assert.equal(receiver.label(), '', 'self on every device');
  receiver.receive(signal(), 'bea');
  receiver.receive({ ...signal(), client_id: 'composer_source_2' }, 'bea');
  assert.equal(receiver.label(), 'ada is typing…');
  receiver.receive(signal('ada', 2, false), 'bea');
  receiver.receive(signal('ada', 1), 'bea');
  assert.equal(receiver.label(), 'ada is typing…', 'second device stays active');
  receiver.receive(signal('cy'), 'bea');
  assert.equal(receiver.label(), 'ada and cy are typing…');
  receiver.receive(signal('di'), 'bea');
  assert.equal(receiver.label(), 'Several people are typing…');
  time.advance(TYPING.ttl);
  assert.equal(receiver.label(), '');
  receiver.receive(signal(), 'bea');
  assert.equal(receiver.label(), 'ada is typing…', 'the server clock does not control client expiry');
  receiver.receive({ ...signal(), expires_at: time.now() + TYPING.ttl }, 'bea');
  receiver.clear();
  assert.equal(receiver.label(), '', 'reconnect/account/room changes reset state');
});

test('receiver and display expose one stable name per account for the live strip', () => {
  const time = clock(), receiver = createTypingReceiver(time.now), seen: string[][] = [];
  const display = createTypingDisplay((_label, names) => seen.push(names), time);
  for (const target of [receiver, display]) {
    target.receive(signal('cy'), 'bea');
    target.receive(signal('ada'), 'bea');
    target.receive({ ...signal('ada'), client_id: 'composer_source_2' }, 'bea');
    target.receive(signal('bea'), 'bea');
  }
  assert.deepEqual(receiver.names(), ['ada', 'cy'], 'sorted by account, self and second devices excluded');
  assert.deepEqual(seen.at(-1), ['ada', 'cy']);
  display.receive(signal('cy', 2, false), 'bea');
  assert.deepEqual(seen.at(-1), ['ada'], 'a stop removes just that person');
  time.advance(TYPING.ttl);
  assert.deepEqual(seen.at(-1), []);
  assert.deepEqual(receiver.names(), []);
});

test('the sentence emphasises names and counts the rest', () => {
  const text = (names: string[]) => typingSentence(names).map(part => part.name ? `[${part.text}]` : part.text).join('');
  assert.equal(text([]), '');
  assert.equal(text(['Ada']), '[Ada] is typing');
  assert.equal(text(['Ada', 'Cy']), '[Ada] and [Cy] are typing');
  assert.equal(text(['Ada', 'Cy', 'Di']), '[Ada], [Cy] and 1 other are typing');
  assert.equal(text(['Ada', 'Cy', 'Di', 'Eve']), '[Ada], [Cy] and 2 others are typing');
  assert.equal(text(['<b>x</b>']), '[<b>x</b>] is typing', 'names stay plain text for the view to escape');
});

test('display schedules just the earliest active expiry, with no timer while idle or cleared', () => {
  const time = clock(), labels: string[] = [];
  const display = createTypingDisplay(label => labels.push(label), time);
  assert.equal(time.pending(), 0, 'a mounted idle composer has no receiver timer');
  display.receive(signal('bea'), 'bea');
  assert.equal(time.pending(), 0, 'self cannot start a timer');
  display.receive({ ...signal(), ttl_ms: 1200 }, 'bea');
  assert.equal(time.pending(), 1);
  time.advance(100);
  display.receive(signal('cy'), 'bea');
  assert.equal(time.pending(), 1, 'two sources share one timeout');
  time.advance(100);
  display.receive(signal(), 'bea');
  time.advance(1000);
  assert.equal(labels.at(-1), 'cy is typing…', 'a duplicate cannot extend the earliest deadline');
  assert.equal(time.pending(), 1);
  time.advance(3900);
  assert.equal(labels.at(-1), '');
  assert.equal(time.pending(), 0, 'last expiry retires the timeout');
  display.receive(signal('cy', 2), 'bea');
  display.receive(signal('cy', 3, false), 'bea');
  assert.equal(time.pending(), 0, 'last stop retires the timeout');
  display.receive(signal('cy', 4), 'bea');
  display.clear();
  assert.equal(labels.at(-1), '');
  assert.equal(time.pending(), 0, 'room/account/disposal clear retires it too');
  const count = labels.length;
  time.advance(3600000);
  assert.equal(labels.length, count, 'no idle work');
});

test('receiver uses relative TTL with client clocks sixty seconds ahead or behind the server', () => {
  for (const skew of [-60000, 60000]) {
    let clientNow = 100000 + skew;
    const receiver = createTypingReceiver(() => clientNow);
    receiver.receive({ ...signal(), ttl_ms: 1200, expires_at: 101200 }, 'bea');
    assert.equal(receiver.label(), 'ada is typing…', `signal accepted at clock skew ${skew}`);
    clientNow += 1199;
    assert.equal(receiver.label(), 'ada is typing…');
    clientNow++;
    assert.equal(receiver.label(), '', 'expiry is 1200ms after receipt on either clock');
  }
});

test('synchronous bridge failures and rejected reports never interrupt composer cleanup', async () => {
  const time = clock();
  for (const send of [() => { throw new Error('bridge missing'); }, () => Promise.reject(new Error('offline'))]) {
    const sender = createTypingSender({ ...time, send, clientId: 'composer_source_1' });
    assert.doesNotThrow(() => { sender.input(true); sender.stop(); });
  }
  await Promise.resolve();
});

test('service caps sources, people and total entries; the background sweep releases capacity', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const time = clock(), emitter = new BridgedEventEmitter('test-typing-bounds');
  const service = createRoomTypingService(emitter, time.now);
  const received: TypingSignal[] = [];
  emitter.on(ROOM_TYPING, value => received.push(value));
  try {
    for (let i = 0; i < TYPING.sources; i++) service.report('sources', 'ada', 'Ada', report(1, false, `composer_source_${i}`));
    service.report('sources', 'ada', 'Ada', report(1, true, 'composer_overflow'));
    assert.equal(received.length, 0, 'source cap includes short-lived sequence guards');
    for (let i = 0; i < TYPING.people; i++) service.report('people', `person_${i}`, 'Ada', report());
    service.report('people', 'overflow', 'Ada', report());
    assert.equal(received.length, TYPING.people, 'room cap');
    for (let i = TYPING.people + 1; i < TYPING.entries; i++) service.report(`room_${i}`, 'ada', 'Ada', report(1, false));
    service.report('overflow', 'ada', 'Ada', report());
    assert.equal(received.length, TYPING.people, 'process cap');
    time.advance(TYPING.ttl + 1);
    context.mock.timers.tick(TYPING.sweep);
    service.report('overflow', 'ada', 'Ada', report(2));
    service.report('sources', 'ada', 'Ada', report(2, true, 'composer_overflow'));
    assert.equal(received.length, TYPING.people + 2, 'expired entries are reclaimed off the request path');
  } finally { service.close(); }
});

test('service limits by account/room, filters self on all subscriptions and keeps devices independent', () => {
  const time = clock(), emitter = new BridgedEventEmitter('test-typing');
  const service = createRoomTypingService(emitter, time.now), others: TypingSignal[] = [], self: TypingSignal[] = [];
  service.subscribe('room_1', 'bea', value => others.push(value));
  service.subscribe('room_1', 'ada', value => self.push(value));
  service.subscribe('room_1', 'ada', value => self.push(value));
  try {
    service.report('room_1', 'ada', 'Ada', report());
    service.report('room_1', 'ada', 'Ada', report(2));
    service.report('room_1', 'ada', 'Ada', report(1, true, 'composer_source_2'));
    assert.equal(others.length, 1);
    assert.equal(self.length, 0);
    time.advance(TYPING.interval);
    service.report('room_1', 'ada', 'Ada', report(2, true, 'composer_source_2'));
    service.report('room_1', 'ada', 'Ada', report(3, false));
    service.report('room_1', 'ada', 'Ada', report(2));
    assert.equal(others.length, 3);
    assert.equal(others.at(-1)?.client_id, 'composer_source_1');
    assert.equal(others[1]?.typing, true, 'stop is source-specific');
    service.report('room_1', 'cy', 'Cy', report(2, false));
    service.report('room_1', 'cy', 'Cy', report(1));
    assert.equal(others.length, 3, 'stop before delayed start fences the start');
    emitter.emitLocal(ROOM_TYPING, { ...signal('di'), expires_at: time.now() + 5000 });
    service.report('room_1', 'di', 'Di', report());
    assert.equal(others.length, 5, 'remote observations do not replicate the local limiter');
  } finally { service.close(); }
});

test('report route rejects agent/owner/anonymous credentials, names the session and excludes rentals', async () => {
  let handler: any;
  let denied = false, rental = false;
  const name = `typing-route-${Date.now()}`;
  registerRoomTypingRoute({ post(_path: unknown, fn: any) { handler = fn; } } as any, {
    resolveCanonicalRoomRequestId: async () => name,
    resolveRoomOrReply: async () => ({ id: name, focus_key: rental ? 'rental:one' : null }),
    requireParticipant: async (_req: unknown, res: any) => { if (denied) res.status(403).end(); return !denied; },
    emitProjectMessage: () => { throw new Error('No messages or agent delivery'); },
  } as any);
  const signals: TypingSignal[] = [];
  const stop = roomTyping.subscribe(name, 'bea', value => signals.push(value));
  const request = async (authKind: any, input: any = report(), room = 'alias') => {
    const res = { code: 200, status(code: number) { this.code = code; return this; }, json() { return this; }, end() {} };
    await handler({ authKind, body: input, params: { 0: room }, sessionAccount: { account_id: name, login: 'ada', display_name: 'Ada' } }, res);
    return res.code;
  };
  try {
    for (const auth of ['owner_token', 'agent_session', 'supervisor']) assert.equal(await request(auth), 403);
    assert.equal(await request(undefined), 401);
    assert.equal(await request('session', { ...report(), text: 'secret' }), 400);
    denied = true; assert.equal(await request('session'), 403); denied = false;
    rental = true; assert.equal(await request('session'), 204); rental = false;
    assert.equal(signals.length, 0);
    assert.equal(await request('session'), 204);
    assert.equal(await request('session', report(2), 'another-alias'), 204);
    assert.equal(signals.length, 1, 'aliases share canonical limiter');
    assert.equal(signals[0]?.name, 'Ada');
    assert.equal(signals[0]?.account_id, name);
  } finally { stop(); }
});

test('typing implementation has no durable store, message/push/receipt/presence event path', () => {
  for (const path of ['../server/room-typing.ts', '../routes/rooms/messages/typing.ts']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:db\.|pool\.|INSERT|UPDATE|emitProjectMessage|message:created|message:routed|push|receipt|presenceEvents)/);
  }
});
