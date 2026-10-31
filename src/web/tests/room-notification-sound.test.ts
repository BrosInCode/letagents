import assert from 'node:assert/strict';
import test from 'node:test';
import { nextTick } from 'vue';

const events = new Map<string, Set<Function>>();
let played = 0;
class Audio {
  currentTime = 0; destination = {};
  createOscillator() { return { connect() {}, frequency: { setValueAtTime() {} }, start() { played++; }, stop() {} }; }
  createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
}
class Source {
  static latest: Source;
  listeners = new Map<string, Function>(); onopen = null; onerror = null;
  constructor(_url: string) { Source.latest = this; }
  addEventListener(name: string, fn: Function) { this.listeners.set(name, fn); }
  close() {}
  message(id: string, text: string) { this.listeners.get('message')!({ data: JSON.stringify({ id, text, source: 'browser', sender: 'Ada', timestamp: new Date().toISOString() }), lastEventId: '' }); }
}
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem() {} }, EventSource: Source,
  window: { AudioContext: Audio, addEventListener: (name: string, fn: Function) => { if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(fn); }, removeEventListener: (name: string, fn: Function) => events.get(name)?.delete(fn) },
});
const { room } = await import('../src/composables/room/state');
const { useAuth } = await import('../src/composables/useAuth');
const { createRoomStream } = await import('../src/composables/room/stream');
const { roomNotificationPreferences } = await import('../src/composables/room/notificationPreferences');
const { soundEnabled } = await import('../src/composables/room/sound');
const settle = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); };

test('web reads on open/focus and gates existing sound while message delivery stays unchanged', async t => {
  let preference: any = { level: 'muted', snoozed_until: null };
  let account = { id: 'a', login: 'ada' };
  const reads: string[] = [];
  t.mock.method(globalThis, 'fetch', async (path: any) => {
    if (path === '/auth/session') return Response.json({ authenticated: true, account });
    reads.push(String(path));
    if (preference instanceof Error) throw preference;
    return Response.json({ room_id: room.value?.identifier, ...preference });
  });
  await useAuth().checkSession();
  room.value = { identifier: 'room-a' } as any;
  await settle();
  assert.deepEqual(reads, ['/rooms/room-a/notification-preferences']);
  const delivered: string[] = [];
  const stream = createRoomStream({ setConnectionState() {}, setStreaming() {}, appendMessage: message => { delivered.push(message.id); return true; }, onGitHubMessage() {}, onGitHubEvent() {}, onTaskLifecycleMessage() {}, onArtifactUpdate() {}, onAgentActivityMessage() {}, onParticipantActivityMessage() {}, upsertTask() {}, upsertReasoningSession() {}, removeReasoningSession() {}, getMessageCursor: () => null, resyncMessages: async (_id, after) => ({ success: true, cursor: after }), reconcileFullState: async () => true });
  soundEnabled.value = true;
  stream.start('room-a');
  const focus = async () => { for (const listener of events.get('focus') ?? []) listener(); await settle(); };
  try {
    Source.latest.message('msg_1', '@ada'); await settle(); assert.equal(played, 0);
    preference = { level: 'mentions', snoozed_until: null }; await focus();
    Source.latest.message('msg_2', 'ordinary'); await settle(); assert.equal(played, 0);
    Source.latest.message('msg_3', '@ADA hello'); await settle(); assert.equal(played, 1);
    preference = { level: 'all', snoozed_until: new Date(Date.now() + 3600000).toISOString() }; await focus();
    Source.latest.message('msg_4', '@ada'); await settle(); assert.equal(played, 1);
    preference = { level: 'all', snoozed_until: new Date(Date.now() - 1000).toISOString() }; await focus();
    Source.latest.message('msg_5', 'expired'); await settle(); assert.equal(played, 2);
    preference = { level: 'muted', snoozed_until: null }; await focus();
    preference = new Error('offline'); await focus();
    Source.latest.message('msg_6', 'retain known mute'); await settle(); assert.equal(played, 2);
    assert.match(roomNotificationPreferences.state('room-a').error, /offline/);
    assert.deepEqual(delivered, ['msg_1', 'msg_2', 'msg_3', 'msg_4', 'msg_5', 'msg_6']);
    assert.equal(events.get('focus')?.size, 1);
    preference = { level: 'muted', snoozed_until: null }; account = { id: 'b', login: 'bea' };
    await useAuth().checkSession(); await settle(); assert.equal(roomNotificationPreferences.allows('room-a', 'hello'), false);
    room.value = { identifier: 'room-b' } as any; await settle(); assert.equal(reads.at(-1), '/rooms/room-b/notification-preferences');
    preference = new Error('offline');
    room.value = { identifier: 'room-c' } as any; await settle();
    assert.equal(roomNotificationPreferences.allows('room-c', 'first read fails open'), true);
  } finally { stream.stop(); room.value = null; await settle(); soundEnabled.value = false; }
  assert.equal(events.get('focus')?.size, 0);
});
