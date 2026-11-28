import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope, nextTick, ref } from 'vue';
import { createRoomNotificationClient } from '../../../../shared/room-notification-client.mjs';
import { allowsRoomNotification, mentionsPerson, roomNotificationSnoozeUntil } from '../../../../shared/room-notification-preferences.mjs';
import { roomNotificationMenuItems, roomNotificationMenuChange } from '../src/domain/room-notification-menu';
import { roomMentionCandidates } from '../src/domain/participants';
import { watchRoomNotifications } from '../src/components/desktop/content/room-shell/useDesktopRoomPreferences';

const all = { room_id: 'r', level: 'all' as const, snoozed_until: null };
const muted = { ...all, level: 'muted' as const };
const deferred = <T = any>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { await nextTick(); await nextTick(); };

test('literal person login has token boundaries, case folding and no broadcast interpretation', () => {
  for (const text of ['@Ada', 'Hello (@ADA)!', '@ada.', 'x'.repeat(1100) + ' @ada']) assert.equal(mentionsPerson(text, 'ada'), true, text);
  for (const text of ['@adam', '@ada-extra', 'mail@ada', '@ada/agent', '@agent:ada', '@ada.name', '@ada_name', '@everyone']) assert.equal(mentionsPerson(text, 'ada'), false, text);
  assert.equal(mentionsPerson('@p.+(x)', 'p.+(x)'), true);
  assert.equal(mentionsPerson('@p.zzx', 'p.+(x)'), false);
  assert.equal(mentionsPerson('@ada', null), false);
});

test('snooze expiry restores the chosen level and tomorrow uses local calendar time across DST', () => {
  const until = '2026-10-03T09:00:00Z';
  const now = Date.parse(until);
  const preference = { level: 'mentions' as const, snoozed_until: until };
  assert.equal(allowsRoomNotification(preference, '@ada', 'ada', now - 1), false);
  assert.equal(allowsRoomNotification(preference, '@ada', 'ada', now), true);
  assert.equal(allowsRoomNotification(preference, 'ordinary', 'ada', now), false);
  assert.equal(allowsRoomNotification({ ...preference, level: 'muted' }, '@ada', 'ada', now), false);
  const old = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    for (const [input, expected] of [['2026-03-07T17:00:00Z', '2026-03-08T13:00:00.000Z'], ['2026-10-31T16:00:00Z', '2026-11-01T14:00:00.000Z'], ['2026-12-31T17:00:00Z', '2027-01-01T14:00:00.000Z']]) {
      assert.equal(roomNotificationSnoozeUntil('tomorrow', new Date(input)), expected);
    }
    assert.equal(roomNotificationSnoozeUntil('1h', new Date('2026-03-08T06:30:00Z')), '2026-03-08T07:30:00.000Z');
    assert.equal(roomNotificationSnoozeUntil('8h', new Date('2026-11-01T04:30:00Z')), '2026-11-01T12:30:00.000Z');
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});

test('initial read holds an alert, and a failed read releases it at the default level (mentions only)', async () => {
  const read = deferred();
  const client = createRoomNotificationClient({ get: () => read.promise });
  client.setViewer({ id: 'a', login: 'ada' });
  const pending = client.refresh('r');
  assert.equal(client.allows('r', '@ada hello'), false);
  let finished = false;
  const decision = client.allowsAfterRead('r', '@ada hello').then(value => { finished = true; return value; });
  const plain = client.allowsAfterRead('r', 'hello');
  await tick(); assert.equal(finished, false);
  read.reject(new Error('offline')); await pending;
  assert.equal(await decision, true);
  assert.equal(await plain, false);
  assert.equal(client.state('r').preference.level, 'mentions');
  assert.match(client.state('r').error, /offline/);
});

test('a room the person never set takes each client\'s own default: mentions on the desktop, all messages on the web', async () => {
  const unsaved = { room_id: 'r', level: 'mentions' as const, snoozed_until: null, saved: false as const };
  const desktop = createRoomNotificationClient({ get: async () => unsaved });
  const web = createRoomNotificationClient({ get: async () => unsaved }, undefined, undefined, { defaultLevel: 'all' });
  for (const client of [desktop, web]) { client.setViewer({ id: 'a', login: 'ada' }); await client.refresh('r'); }
  assert.equal(desktop.state('r').preference.level, 'mentions');
  assert.equal(desktop.allows('r', 'hello'), false);
  assert.equal(desktop.allows('r', '@ada hello'), true);
  assert.equal(web.state('r').preference.level, 'all');
  assert.equal(web.allows('r', 'hello'), true);
  // A saved level is the same for both.
  const saved = { room_id: 'r', level: 'mentions' as const, snoozed_until: null };
  const webSaved = createRoomNotificationClient({ get: async () => saved }, undefined, undefined, { defaultLevel: 'all' });
  webSaved.setViewer({ id: 'a', login: 'ada' }); await webSaved.refresh('r');
  assert.equal(webSaved.allows('r', 'hello'), false);
  // A signed-out web viewer has no saved levels: the chime plays for every message.
  const signedOut = createRoomNotificationClient({ get: async () => saved }, undefined, undefined, { defaultLevel: 'all' });
  assert.equal(signedOut.allows('r', 'hello room'), true);
  assert.equal(createRoomNotificationClient({ get: async () => saved }).allows('r', 'hello room'), false);
});

test('a room with no saved level alerts only for a mention of the viewer', () => {
  assert.equal(allowsRoomNotification(undefined, 'hello', 'ada'), false);
  assert.equal(allowsRoomNotification(undefined, 'hi @Ada', 'ada'), true);
  assert.equal(allowsRoomNotification({ level: 'all', snoozed_until: null }, 'hello', 'ada'), true);
});

test('account switches discard reads, bulk responses, writes and held alerts from the previous person', async () => {
  const read = deferred(), list = deferred(), write = deferred();
  const client = createRoomNotificationClient({ get: () => read.promise, list: () => list.promise, put: () => write.promise });
  client.setViewer({ id: 'a', login: 'ada' });
  const pending = client.refresh('r');
  const held = client.allowsAfterRead('r', 'hello');
  const bulk = client.refreshAll();
  const mutation = client.update('r', { level: 'muted' });
  client.setViewer({ id: 'b', login: 'bea' });
  read.resolve(muted); list.resolve({ preferences: [muted], truncated: false }); write.resolve(muted);
  await Promise.all([pending, bulk, mutation]);
  assert.equal(await held, false);
  assert.equal(client.allows('r', '@bea hello'), true);
  assert.equal(client.allows('r', 'hello'), false);
  assert.equal(client.state('r').preference.level, 'mentions');
});

test('newer reads and writes survive stale responses; failed refreshes retain known settings', async () => {
  const reads = [deferred(), deferred(), deferred()]; let n = 0;
  const list = deferred();
  const client = createRoomNotificationClient({ get: () => reads[n++].promise, list: () => list.promise, put: async () => muted });
  client.setViewer({ id: 'a', login: 'ada' });
  const first = client.refresh('r'), second = client.refresh('r');
  reads[1].resolve(muted); await second;
  reads[0].resolve(all); await first;
  assert.equal(client.allows('r', 'hello'), false);
  const bulk = client.refreshAll(); await client.update('r', { level: 'muted' });
  list.resolve({ preferences: [], truncated: false }); await bulk;
  assert.equal(client.allows('r', 'hello'), false);
  const failed = client.refresh('r'); reads[2].reject(new Error('offline')); await failed;
  assert.equal(client.allows('r', 'hello'), false);
  assert.equal(client.state('r').preference.level, 'muted', 'a failed read keeps the known level');
  assert.match(client.state('r').error, /offline/);
});

test('focus bulk refresh resets missing defaults, respects truncation and retains known settings on failure', async () => {
  let result: any = { preferences: [muted], truncated: false };
  const client = createRoomNotificationClient({ get: async () => muted, list: async () => { if (result instanceof Error) throw result; return result; } });
  client.setViewer({ id: 'a', login: 'ada' });
  await client.refreshAll(); assert.equal(client.allows('r', 'hello'), false);
  result = { preferences: [], truncated: true }; await client.refreshAll(); assert.equal(client.allows('r', 'hello'), false);
  assert.equal(client.state('r').preference.level, 'muted', 'a truncated list keeps a room it does not include');
  result = { preferences: [], truncated: false }; await client.refreshAll(); assert.equal(client.allows('r', '@ada hello'), true);
  assert.equal(client.allows('r', 'hello'), false);
  await client.refresh('r');
  client.state('unknown');
  result = new Error('offline'); await client.refreshAll();
  assert.equal(client.allows('r', 'hello'), false);
  assert.equal(client.state('r').preference.level, 'muted', 'a failed list keeps the known level');
  assert.match(client.state('r').error, /offline/);
  assert.equal(client.allows('unknown', '@ada hello'), true);
  assert.match(client.state('unknown').error, /offline/);
});

test('single and bulk failures preserve mute, mentions and snooze; successful refresh clears the error', async () => {
  for (const preference of [muted, { ...all, level: 'mentions' as const }, { ...all, snoozed_until: new Date(Date.now() + 3600000).toISOString() }]) {
    for (const bulk of [false, true]) {
      let failed = false;
      const client = createRoomNotificationClient({
        get: async () => { if (failed) throw new Error('offline'); return preference; },
        list: async () => { if (failed) throw new Error('offline'); return { preferences: [preference], truncated: false }; },
      });
      client.setViewer({ id: 'a', login: 'ada' });
      const refresh = () => bulk ? client.refreshAll() : client.refresh('r');
      await refresh(); failed = true; await refresh();
      assert.deepEqual(client.state('r').preference, preference);
      assert.equal(client.allows('r', 'ordinary'), false);
      assert.match(client.state('r').error, /offline/);
      failed = false; await refresh(); assert.equal(client.state('r').error, '');
    }
  }
});

test('the real watcher holds alerts through replacement single and bulk reads, including fail-open errors', async () => {
  for (const bulk of [false, true]) for (const fails of [false, true]) {
    const reads = [deferred(), deferred()]; let n = 0;
    const client = createRoomNotificationClient({ get: () => reads[n++].promise, list: () => reads[n++].promise });
    client.setViewer({ id: 'a', login: 'ada' });
    const refresh = () => bulk ? client.refreshAll() : client.refresh('r');
    const first = refresh();
    const messages = ref<any[]>([]), alerts: string[] = [], sounds: string[] = [];
    const scope = effectScope();
    scope.run(() => watchRoomNotifications({ visibleMessages: messages, ownMessageIds: new Set(), playRoomSound: kind => sounds.push(kind), showRoomNotification: m => alerts.push(m.id), shouldNotify: m => client.allowsAfterRead('r', m.text) }));
    try {
      messages.value = [{ id: 'history', text: 'history' }]; await tick();
      messages.value = [...messages.value, { id: 'incoming', text: '@ada hello' }]; await tick();
      const second = refresh();
      reads[0].resolve(bulk ? { preferences: [], truncated: false } : all); await first; await tick();
      assert.deepEqual(alerts, []); assert.deepEqual(sounds, []);
      if (fails) reads[1].reject(new Error('offline'));
      else reads[1].resolve(bulk ? { preferences: [], truncated: false } : all);
      await second; await tick();
      assert.deepEqual(alerts, ['incoming']); assert.deepEqual(sounds, ['notification']);
    } finally { scope.stop(); }
  }
});

test('the real message watcher gates both fallback and chime, preserves own-message and bootstrap suppression', async () => {
  const messages = ref<any[]>([]), alerts: string[] = [], sounds: string[] = [];
  const client = createRoomNotificationClient({ get: async () => ({ ...all, level: 'mentions' }) });
  client.setViewer({ id: 'a', login: 'ada' }); await client.refresh('r');
  const scope = effectScope();
  scope.run(() => watchRoomNotifications({ visibleMessages: messages, ownMessageIds: new Set(['own']), playRoomSound: kind => sounds.push(kind), showRoomNotification: m => alerts.push(m.id), shouldNotify: m => client.allowsAfterRead('r', m.text) }));
  for (const [id, text] of [['history', '@ada'], ['ordinary', 'hello'], ['own', '@ada'], ['mention', '@ADA']]) {
    messages.value = [...messages.value, { id, text }]; await tick();
  }
  scope.stop();
  assert.deepEqual(alerts, ['mention']); assert.deepEqual(sounds, ['notification']);
});

test('menu choices keep level and snooze independent; local-only choices can all be disabled', () => {
  const items = roomNotificationMenuItems({ ...muted, snoozed_until: new Date(Date.now() + 3600000).toISOString() });
  assert.deepEqual(items.filter(i => i.role === 'menuitemradio').map(i => [i.id, i.checked]), [['notification-level-all', false], ['notification-level-mentions', false], ['notification-level-muted', true]]);
  assert.deepEqual(roomNotificationMenuChange('notification-level-all'), { level: 'all' });
  assert.deepEqual(roomNotificationMenuChange('notification-resume'), { snoozed_until: null });
  assert.ok(Date.parse(roomNotificationMenuChange('notification-snooze-1h')!.snoozed_until!) > Date.now());
  assert.equal(roomNotificationMenuChange('unrelated'), null);
  assert.ok(roomNotificationMenuItems(all, true).every(i => i.disabled));
});

test('human autocomplete inserts the login and retains the display label; agent handles stay unchanged', () => {
  const participant = { activityState: 'active', hiddenAt: null, sourceFlags: [], ownerLabel: null, actorLabel: null };
  const people: any[] = [{ ...participant, participantKey: 'h', kind: 'human', displayName: 'Ada Lovelace', githubLogin: 'ada-login' }, { ...participant, participantKey: 'a', kind: 'agent', displayName: 'Oak', githubLogin: 'ada-login', agentKey: 'ada-login/oak' }];
  const [human] = roomMentionCandidates(people, 'ada-login');
  assert.equal(human.insertText, 'ada-login'); assert.equal(human.displayName, 'Ada Lovelace'); assert.equal(human.label, 'Human');
  const [agent] = roomMentionCandidates(people, 'oak'); assert.equal(agent.insertText, 'Oak');
});
