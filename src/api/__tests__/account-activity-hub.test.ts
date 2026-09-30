import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { AccountActivityHub } = await import('../account-activity/hub.js');
const { PRESENCE_CHANGED, PRESENCE_RESYNC } = await import('../server/presence-change-events.js');
import type { AccountRoomActivity, WorkingPresence } from '../account-activity/hub.js';

const WINDOW = 90_000;

/** A world the hub reads from, a clock, and timers it can run on demand. */
function world() {
  let now = 1_000_000;
  const working = new Map<string, Array<{ agent_key: string; display_name: string; heartbeat: number }>>();
  const latest = new Map<string, { latest_message_id: string | null; latest_message_at: string | null }>();
  const reads = { working: [] as string[][], latest: [] as string[][] };
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 1;
  const presence = new EventEmitter();
  const messages = new EventEmitter();
  let failNextRead = false;
  let latestGate: Promise<void> | null = null;
  const hub = new AccountActivityHub({
    async loadWorking(roomIds, sinceMs) {
      reads.working.push([...roomIds]);
      if (failNextRead) { failNextRead = false; throw new Error('database unavailable'); }
      const result = new Map<string, WorkingPresence>();
      for (const id of roomIds) {
        const agents = (working.get(id) ?? []).filter(agent => agent.heartbeat > sinceMs);
        if (agents.length) result.set(id, {
          agents: agents.map(({ agent_key, display_name }) => ({ agent_key, display_name })),
          oldestHeartbeatMs: Math.min(...agents.map(agent => agent.heartbeat)),
        });
      }
      return result;
    },
    async loadLatest(roomIds) {
      reads.latest.push([...roomIds]);
      if (latestGate) { const gate = latestGate; latestGate = null; await gate; }
      return new Map(roomIds.filter(id => latest.has(id)).map(id => [id, latest.get(id)!]));
    },
  }, {
    coalesceMs: 10,
    presenceWindowMs: WINDOW,
    now: () => now,
    setTimer: (run, ms) => { const id = nextTimer++; timers.set(id, { at: now + ms, run }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
  });
  hub.attach({ presence, messages });
  return {
    hub, presence, messages, working, latest, reads, timers,
    failNextRead: () => { failNextRead = true; },
    /** Hold the next latest-message read until the returned function is called. */
    holdNextLatestRead() {
      let release!: () => void;
      latestGate = new Promise<void>(resolve => { release = resolve; });
      return release;
    },
    /** Move the clock and fire every timer that came due, as the event loop would. */
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id); timer.run();
      }
      await hub.settle();
    },
    get now() { return now; },
  };
}

test('a watcher starts with each room as it is', async () => {
  const w = world();
  w.working.set('room-a', [{ agent_key: 'k1', display_name: 'MapleRidge', heartbeat: w.now }]);
  w.latest.set('room-b', { latest_message_id: 'msg_7', latest_message_at: '2026-09-30T10:00:00.000Z' });
  const watch = await w.hub.watch(['room-a', 'room-b', 'room-a'], () => assert.fail('nothing changed'));
  assert.deepEqual(watch.snapshot, [
    { room_id: 'room-a', latest_message_id: null, latest_message_at: null, working: [{ agent_key: 'k1', display_name: 'MapleRidge' }] },
    { room_id: 'room-b', latest_message_id: 'msg_7', latest_message_at: '2026-09-30T10:00:00.000Z', working: [] },
  ]);
  watch.close();
});

test('an agent starting and stopping work is pushed, once each', async () => {
  const w = world();
  const seen: AccountRoomActivity[] = [];
  await w.hub.watch(['room-a'], activity => seen.push(activity));
  w.working.set('room-a', [{ agent_key: 'k1', display_name: 'MapleRidge', heartbeat: w.now }]);
  w.presence.emit(PRESENCE_CHANGED, 'room-a');
  await w.hub.settle();
  assert.deepEqual(seen.map(a => a.working.map(agent => agent.display_name)), [['MapleRidge']]);
  // A notification that changes nothing is not passed on.
  w.presence.emit(PRESENCE_CHANGED, 'room-a');
  await w.hub.settle();
  assert.equal(seen.length, 1);
  w.working.delete('room-a');
  w.presence.emit(PRESENCE_CHANGED, 'room-a');
  await w.hub.settle();
  assert.deepEqual(seen.map(a => a.working.length), [1, 0]);
});

test('a new message updates only the latest message', async () => {
  const w = world();
  const seen: AccountRoomActivity[] = [];
  await w.hub.watch(['room-a'], activity => seen.push(activity));
  const workingReads = w.reads.working.length;
  w.latest.set('room-a', { latest_message_id: 'msg_9', latest_message_at: '2026-09-30T10:05:00.000Z' });
  w.messages.emit('message:created', { projectId: 'room-a' });
  await w.hub.settle();
  assert.equal(seen.at(-1)?.latest_message_id, 'msg_9');
  assert.equal(w.reads.working.length, workingReads, 'a message does not re-read who is working');
});

test('rooms nobody watches cost nothing', async () => {
  const w = world();
  await w.hub.watch(['room-a'], () => undefined);
  const before = { working: w.reads.working.length, latest: w.reads.latest.length };
  w.presence.emit(PRESENCE_CHANGED, 'room-z');
  w.messages.emit('message:created', { projectId: 'room-z' });
  await w.hub.settle();
  assert.deepEqual({ working: w.reads.working.length, latest: w.reads.latest.length }, before);
  assert.equal(w.hub.watches('room-z'), false);
  assert.equal(w.hub.watches('room-a'), true);
});

test('a burst of changes in several rooms is read once', async () => {
  const w = world();
  await w.hub.watch(['room-a', 'room-b'], () => undefined);
  const before = w.reads.working.length;
  for (let i = 0; i < 20; i++) w.presence.emit(PRESENCE_CHANGED, i % 2 ? 'room-a' : 'room-b');
  await w.hub.settle();
  assert.equal(w.reads.working.length, before + 1);
  assert.deepEqual([...w.reads.working.at(-1)!].sort(), ['room-a', 'room-b']);
});

test('an agent that stops sending heartbeats stops being shown as working', async () => {
  const w = world();
  const seen: AccountRoomActivity[] = [];
  w.working.set('room-a', [{ agent_key: 'k1', display_name: 'MapleRidge', heartbeat: w.now }]);
  await w.hub.watch(['room-a'], activity => seen.push(activity));
  assert.equal(w.timers.size, 1, 'one timer, for when the agent would go quiet');
  await w.advance(WINDOW - 5_000);
  assert.equal(seen.length, 0, 'still inside the window');
  await w.advance(10_000);
  assert.deepEqual(seen.map(a => a.working.length), [0]);
  assert.equal(w.timers.size, 0, 'nobody is working, so nothing is scheduled');
});

test('a heartbeat moves the quiet check instead of dropping the agent', async () => {
  const w = world();
  const seen: AccountRoomActivity[] = [];
  const agent = { agent_key: 'k1', display_name: 'MapleRidge', heartbeat: w.now };
  w.working.set('room-a', [agent]);
  await w.hub.watch(['room-a'], activity => seen.push(activity));
  await w.advance(60_000);
  agent.heartbeat = w.now;
  await w.advance(35_000);
  assert.equal(seen.length, 0, 'the check re-read the room and found the agent still working');
  assert.equal(w.timers.size, 1, 'and set the next check from the new heartbeat');
});

test('after the listener reconnects, every watched room is read again', async () => {
  const w = world();
  const seen: AccountRoomActivity[] = [];
  await w.hub.watch(['room-a', 'room-b'], activity => seen.push(activity));
  w.working.set('room-b', [{ agent_key: 'k2', display_name: 'CedarRidge', heartbeat: w.now }]);
  w.presence.emit(PRESENCE_RESYNC);
  await w.hub.settle();
  assert.deepEqual(seen.map(a => a.room_id), ['room-b']);
});

test('a failed read keeps what was shown, then reads again by itself', async () => {
  const w = world();
  const seen: AccountRoomActivity[] = [];
  await w.hub.watch(['room-a'], activity => seen.push(activity));
  w.working.set('room-a', [{ agent_key: 'k1', display_name: 'MapleRidge', heartbeat: w.now }]);
  w.failNextRead();
  const original = console.error; console.error = () => undefined;
  try {
    w.presence.emit(PRESENCE_CHANGED, 'room-a');
    await w.hub.settle();
  } finally { console.error = original; }
  assert.equal(seen.length, 0, 'what was shown stays');
  // A working agent sends no further change, so the hub must not wait for one.
  await w.advance(2_000);
  assert.deepEqual(seen.map(a => a.working.map(agent => agent.display_name)), [['MapleRidge']]);
});

test('reads that keep failing back off, and one success resets the pause', async () => {
  const w = world();
  await w.hub.watch(['room-a'], () => undefined);
  const original = console.error; console.error = () => undefined;
  try {
    w.failNextRead();
    w.presence.emit(PRESENCE_CHANGED, 'room-a');
    await w.hub.settle();
    const readsAfterFirstFailure = w.reads.working.length;
    w.failNextRead();
    await w.advance(2_000);
    assert.equal(w.reads.working.length, readsAfterFirstFailure + 1, 'first retry after 2 s');
    await w.advance(3_999);
    assert.equal(w.reads.working.length, readsAfterFirstFailure + 1, 'second retry waits 4 s');
    await w.advance(1);
    assert.equal(w.reads.working.length, readsAfterFirstFailure + 2);
  } finally { console.error = original; }
  assert.equal([...w.timers.values()].some(timer => timer.at > w.now + 90_000), false, 'no retry left once a read succeeds');
});

test('a change that lands while the first snapshot of a room loads is read again', async () => {
  const w = world();
  const seen: AccountRoomActivity[] = [];
  const release = w.holdNextLatestRead();
  // Nobody watched room-a before, so there is nothing yet to update.
  const pending = w.hub.watch(['room-a'], activity => seen.push(activity));
  await new Promise(resolve => setImmediate(resolve));
  w.working.set('room-a', [{ agent_key: 'k1', display_name: 'MapleRidge', heartbeat: w.now }]);
  w.presence.emit(PRESENCE_CHANGED, 'room-a');
  await w.hub.settle();
  release();
  const watch = await pending;
  assert.deepEqual(watch.snapshot[0].working, [], 'the snapshot was read before the change');
  await w.hub.settle();
  assert.deepEqual(seen.map(a => a.working.map(agent => agent.display_name)), [['MapleRidge']]);
  watch.close();
});

test('a watcher that throws does not stop later changes', async () => {
  const w = world();
  const seen: AccountRoomActivity[] = [];
  await w.hub.watch(['room-a'], () => { throw new Error('broken watcher'); });
  await w.hub.watch(['room-a'], activity => seen.push(activity));
  const original = console.error; console.error = () => undefined;
  try {
    w.working.set('room-a', [{ agent_key: 'k1', display_name: 'MapleRidge', heartbeat: w.now }]);
    w.presence.emit(PRESENCE_CHANGED, 'room-a');
    await w.hub.settle();
    w.working.delete('room-a');
    w.presence.emit(PRESENCE_CHANGED, 'room-a');
    await w.hub.settle();
  } finally { console.error = original; }
  assert.equal(seen.length, 2);
});

test('closing a watch stops its pushes and its timers when it was the last', async () => {
  const w = world();
  w.working.set('room-a', [{ agent_key: 'k1', display_name: 'MapleRidge', heartbeat: w.now }]);
  const seenA: AccountRoomActivity[] = []; const seenB: AccountRoomActivity[] = [];
  const a = await w.hub.watch(['room-a'], activity => seenA.push(activity));
  const b = await w.hub.watch(['room-a'], activity => seenB.push(activity));
  a.close();
  w.working.delete('room-a');
  w.presence.emit(PRESENCE_CHANGED, 'room-a');
  await w.hub.settle();
  assert.equal(seenA.length, 0);
  assert.equal(seenB.length, 1, 'another watcher of the same room is still told');
  b.close();
  assert.equal(w.hub.watches('room-a'), false);
  assert.equal(w.timers.size, 0);
});

test('a change that lands while a snapshot loads is not lost', async () => {
  const w = world();
  const first: AccountRoomActivity[] = [];
  await w.hub.watch(['room-a'], activity => first.push(activity));
  // The second watcher's snapshot read starts, then a change is pushed before it finishes.
  w.working.set('room-a', [{ agent_key: 'k1', display_name: 'MapleRidge', heartbeat: w.now }]);
  const pending = w.hub.watch(['room-a'], () => undefined);
  w.presence.emit(PRESENCE_CHANGED, 'room-a');
  await w.hub.settle();
  const second = await pending;
  assert.deepEqual(second.snapshot[0].working.map(a => a.display_name), ['MapleRidge']);
});
