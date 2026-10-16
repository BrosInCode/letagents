import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { REVIEW_PAGE_SIZE } from '../../../../shared/workspace-review.mjs';
import { RoomWorkspaceStore } from '../room-workspace-store.js';

for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) {
  test(`review paging keeps exact bytes and skips completed page reads in ${encoding}`, () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`PRAGMA encoding='${encoding}'; CREATE TABLE room_workspace_reviews (
        agent_id TEXT, room_id TEXT, source_message_id TEXT, digest TEXT, data TEXT, uploaded_pages INTEGER)`);
      const data = 'A'.repeat(REVIEW_PAGE_SIZE) + 'B'.repeat(REVIEW_PAGE_SIZE) + 'C'.repeat(17);
      const digest = 'd'.repeat(64);
      db.prepare('INSERT INTO room_workspace_reviews VALUES(?,?,?,?,?,0)')
        .run('agent', 'room', 'msg_1', digest, data);
      let pageReads = 0;
      db.function('substr', (value: string, start: number, count: number) => {
        pageReads++;
        return value.slice(start - 1, start - 1 + count);
      });
      const store = new RoomWorkspaceStore(db);
      assert.equal(store.pendingPage('missing', 'room', 'msg_1'), null);
      for (let index = 0; index < 3; index++) {
        const page = store.pendingPage('agent', 'room', 'msg_1')!;
        assert.deepEqual(page, { digest, index, total: 3,
          data: data.slice(index * REVIEW_PAGE_SIZE, (index + 1) * REVIEW_PAGE_SIZE) });
        assert.deepEqual(store.pendingPage('agent', 'room', 'msg_1'), page, 'unacknowledged pages survive retries');
        store.acknowledgePage('agent', 'room', 'msg_1', { ...page, digest: 'e'.repeat(64) });
        store.acknowledgePage('agent', 'room', 'msg_1', { ...page, index: index + 1 });
        assert.deepEqual(store.pendingPage('agent', 'room', 'msg_1'), page, 'stale acknowledgments cannot advance');
        store.acknowledgePage('agent', 'room', 'msg_1', page);
        store.acknowledgePage('agent', 'room', 'msg_1', page);
      }
      const before = pageReads;
      assert.equal(store.pendingPage('agent', 'room', 'msg_1'), null);
      assert.equal(new RoomWorkspaceStore(db).pendingPage('agent', 'room', 'msg_1'), null);
      assert.equal(pageReads, before, 'completed reviews never evaluate the page substring');
      assert.equal(db.prepare('SELECT data FROM room_workspace_reviews').get()!.data, data);
    } finally { db.close(); }
  });
}
