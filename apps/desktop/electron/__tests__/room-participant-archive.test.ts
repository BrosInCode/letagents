import assert from "node:assert/strict";
import test from "node:test";

test("archive sends exact participant keys to the selected route and rejects local rooms and old responses", async (t) => {
  const calls: { path: string; body: unknown }[] = [];
  let local = false;
  let response: unknown = { archived_participant_keys: ['old'], skipped_participant_keys: [] };
  t.mock.module('../main/auth.js', { namedExports: { apiFetch: async (path: string, init: RequestInit) => {
    assert.equal(init.method, 'POST'); calls.push({ path, body: JSON.parse(String(init.body)) }); return response;
  } } });
  t.mock.module('../main/rooms/local-store.js', { namedExports: {
    resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: local ? 'local' : 'cloud' }),
    cloudRoomIdentifierForStorage: (_storage: unknown, identifier: string) => identifier.trim(),
  } });
  const { archiveDesktopRoomAgents } = await import('../main/rooms/participants.js');
  assert.deepEqual(await archiveDesktopRoomAgents('github.com/org/repo', ['old', 'old']), { archivedParticipantKeys: ['old'], skippedParticipantKeys: [] });
  assert.deepEqual(calls, [{ path: '/rooms/github.com%2Forg%2Frepo/participants/archive-selected', body: { participant_keys: ['old'] } }]);
  for (const keys of [[], [' '], [1], Array(501).fill('old')]) await assert.rejects(archiveDesktopRoomAgents('room', keys as string[]));
  local = true;
  await assert.rejects(archiveDesktopRoomAgents('room', ['old']), /cloud room/);
  assert.equal(calls.length, 1);
  local = false;
  response = { cleared_count: 10 };
  await assert.rejects(archiveDesktopRoomAgents('room', ['old']), /could not confirm/);
  response = { archived_participant_keys: ['someone-else'], skipped_participant_keys: [] };
  await assert.rejects(archiveDesktopRoomAgents('room', ['old']), /could not confirm/);
});
