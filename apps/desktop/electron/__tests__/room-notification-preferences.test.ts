import assert from 'node:assert/strict';
import test from 'node:test';
async function load(t: test.TestContext, local = false) {
  const calls: any[] = [];
  t.mock.module('../main/auth.js', { namedExports: { apiFetch: async (path: string, init?: RequestInit) => { calls.push([path, init?.method ?? 'GET', init?.body ? JSON.parse(String(init.body)) : null]); return {}; } } });
  t.mock.module('../main/rooms/local-store.js', { namedExports: { resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: local ? 'local' : 'cloud' }), cloudRoomIdentifierForStorage: () => 'github.com/org/repo' } });
  const subject = await import(new URL(`../main/rooms/notification-preferences.js?${t.name}`, import.meta.url).href) as typeof import('../main/rooms/notification-preferences.js');
  return { subject, calls };
}
test('personal preference IPC API uses canonical encoded room paths and preserves partial updates', async t => {
  const { subject, calls } = await load(t);
  await subject.getDesktopRoomNotificationPreference('alias');
  await subject.setDesktopRoomNotificationPreference('alias', { level: 'mentions' });
  await subject.setDesktopRoomNotificationPreference('alias', { snoozed_until: null });
  await subject.listDesktopRoomNotificationPreferences();
  const path = '/rooms/github.com%2Forg%2Frepo/notification-preferences';
  assert.deepEqual(calls, [[path, 'GET', null], [path, 'PUT', { level: 'mentions' }], [path, 'PUT', { snoozed_until: null }], ['/account/room-notification-preferences', 'GET', null]]);
});
test('local-only and empty room preferences do not make a server request', async t => {
  const { subject, calls } = await load(t, true);
  await assert.rejects(subject.getDesktopRoomNotificationPreference('local-room'), /cloud room/);
  await assert.rejects(subject.setDesktopRoomNotificationPreference('local-room', { level: 'muted' }), /cloud room/);
  await assert.rejects(subject.getDesktopRoomNotificationPreference(' '), /Choose a room/);
  assert.deepEqual(calls, []);
});
