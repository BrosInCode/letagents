import assert from 'node:assert/strict';
import test from 'node:test';

for (const local of [false, true]) test(`typing transport validates metadata and ${local ? 'skips local storage' : 'uses the app credential'}`, async t => {
  const calls: unknown[][] = [];
  t.mock.module('../main/auth.js', { namedExports: { apiFetch: async (...args: unknown[]) => { calls.push(args); } } });
  t.mock.module('../main/rooms/local-store.js', { namedExports: {
    resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: local ? 'local' : 'cloud' }),
    cloudRoomIdentifierForStorage: () => 'room_1',
  } });
  const { reportDesktopRoomTyping } = await import(new URL(`../main/rooms/typing.js?${local}`, import.meta.url).href);
  await reportDesktopRoomTyping('room_1', { text: 'secret' });
  assert.equal(calls.length, 0);
  const input = { client_id: 'composer_ipc_test', sequence: 1, typing: true, ttl_ms: 5000 };
  await reportDesktopRoomTyping('room_1', input);
  assert.equal(calls.length, local ? 0 : 1);
  if (!local) assert.deepEqual(calls[0], ['/rooms/room_1/typing', { method: 'POST', body: JSON.stringify(input) }, { credential: 'app', timeoutMs: 2500 }]);
});
