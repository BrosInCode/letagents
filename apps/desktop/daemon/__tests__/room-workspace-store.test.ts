import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArchivedReview, reviewArchiveReference } from '../../../../shared/workspace-review-archive.mjs';
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

test('historical reviews move durably, resume the same page and survive clear through snapshot retention', t => {
  const dir = mkdtempSync(join(tmpdir(), 'review-archives-'));
  const path = join(dir, 'state.sqlite');
  const folder = path + '.reviews';
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec(`PRAGMA user_version=54; CREATE TABLE room_workspace_reviews (
    agent_id TEXT, room_id TEXT, source_message_id TEXT, digest TEXT, data TEXT, uploaded_pages INTEGER)`);
  const data = 'A'.repeat(REVIEW_PAGE_SIZE) + 'B'.repeat(REVIEW_PAGE_SIZE) + 'LAST';
  const digest = createHash('sha256').update(data).digest('hex');
  db.prepare("INSERT INTO room_workspace_reviews VALUES('a','r','m',?,?,1)").run(digest, data);
  let store = new RoomWorkspaceStore(db);
  assert.deepEqual(store.pendingPage('a','r','m'), { digest, index: 1, total: 3, data: 'B'.repeat(REVIEW_PAGE_SIZE) });

  writeFileSync(path + '.recovery.enc', 'retained snapshot');
  writeFileSync(path + '.reviews-recovery', 'unavailable mirror');
  for (const now of [0, 30_001]) {
    assert.throws(() => store.maintainArchives(now));
    assert.deepEqual(readdirSync(folder), [], 'failed mirror cannot accumulate completed primary files');
    assert.equal(db.prepare('SELECT data FROM room_workspace_reviews').get()!.data, data);
  }
  unlinkSync(path + '.reviews-recovery');
  db.exec("CREATE TRIGGER fail_commit BEFORE UPDATE ON room_workspace_reviews BEGIN SELECT RAISE(ABORT,'interrupt'); END;");
  for (const now of [60_002, 90_003]) {
    assert.throws(() => store.maintainArchives(now), /interrupt/);
    assert.deepEqual(readdirSync(folder), []);
    assert.deepEqual(readdirSync(path + '.reviews-recovery'), [], 'confirmed rollback frees both newly created files');
    assert.equal(db.prepare('SELECT data FROM room_workspace_reviews').get()!.data, data);
  }
  db.exec('DROP TRIGGER fail_commit');
  assert.equal(store.maintainArchives(90_004), false, 'failed storage gets a bounded retry delay');
  assert.equal(store.maintainArchives(120_004), true, 'same process retries the interrupted move');
  assert.equal(store.maintainArchives(120_005), false);
  const files = readdirSync(folder);
  assert.equal(files.length, 1, 'uncommitted candidate was discarded');
  const blob = join(folder, files[0]);
  const ciphertext = readFileSync(blob);
  assert.equal(ciphertext.includes(Buffer.from('B'.repeat(100))), false);
  const ref = reviewArchiveReference(db.prepare('SELECT data FROM room_workspace_reviews').get()!.data)!;
  assert.equal(readArchivedReview(path, ref, digest), data);
  store = new RoomWorkspaceStore(db);
  const next = store.pendingPage('a','r','m')!;
  assert.equal(next.index, 1);
  assert.equal(next.data, 'B'.repeat(REVIEW_PAGE_SIZE));
  store.acknowledgePage('a','r','m',next);
  ciphertext[ciphertext.length-1] ^= 1;
  writeFileSync(blob, ciphertext);
  assert.equal(store.pendingPage('a','r','m')!.data, 'LAST', 'damaged primary recovers from its independent copy');
  const mirror = join(path + '.reviews-recovery', files[0]);
  writeFileSync(mirror, ciphertext);
  assert.throws(() => store.pendingPage('a','r','m'));
  assert.equal(db.prepare('SELECT uploaded_pages FROM room_workspace_reviews').get()!.uploaded_pages, 2);
  ciphertext[ciphertext.length-1] ^= 1;
  writeFileSync(mirror, ciphertext);
  unlinkSync(blob);
  assert.equal(store.pendingPage('a','r','m')!.data, 'LAST');

  writeFileSync(path + '.recovery.enc','retained snapshot');
  db.exec('DELETE FROM room_workspace_reviews');
  new RoomWorkspaceStore(db).maintainArchives(2);
  assert.equal(readArchivedReview(path, ref, digest), data, 'an earlier recovery point may still reference the object');
  unlinkSync(path + '.recovery.enc');
  new RoomWorkspaceStore(db).maintainArchives(3);
  assert.deepEqual(readdirSync(folder), []);
  assert.deepEqual(readdirSync(path + '.reviews-recovery'), []);
});

test('a missing or invalid historical digest leaves its only local bytes intact', t => {
  const dir = mkdtempSync(join(tmpdir(), 'review-archive-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, 'state.sqlite'));
  t.after(() => db.close());
  db.exec(`PRAGMA user_version=54; CREATE TABLE room_workspace_reviews (
    agent_id TEXT, room_id TEXT, source_message_id TEXT, digest TEXT, data TEXT, uploaded_pages INTEGER);
    INSERT INTO room_workspace_reviews VALUES('a','r','m','invalid','retained',0)`);
  assert.throws(() => new RoomWorkspaceStore(db).maintainArchives(0), /Invalid workspace review archive/);
  assert.equal(db.prepare('SELECT data FROM room_workspace_reviews').get()!.data, 'retained');
});
