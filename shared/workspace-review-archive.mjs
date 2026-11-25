// The envelope lives in the supervisor row (and its encrypted recovery snapshot).
// The immutable file contains authenticated pages, so uploads need only one page
// of memory. Dropping a live reference drops its key as well.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, readSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertOwnerPrivateSync, createPrivateDirSync, openNoFollowSync, syncDirectorySync, writePrivateFileAtomicallySync } from './owner-private-fs.mjs';
import { REVIEW_LIMIT, REVIEW_PAGE_SIZE } from './workspace-review.mjs';

// On feat/modern-daemon (LAD1), legacy application_id=0 databases are moved
// aside by assertDaemonStateVersionSupported before reaching backup or store
// code. Externalized review archives begin at modern schema v5 (user_version 1005);
// earlier modern versions (1001..1004) never write @review1: references.
export const REVIEW_ARCHIVE_MIN_USER_VERSION = 1005;

const prefix = '@review1:';
const tagSize = 16;
const readRegular = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const folders = databasePath => [databasePath + '.reviews', databasePath + '.reviews-recovery'];
const filename = key => createHash('sha256').update(key).digest('hex') + '.review';
function invalid() { throw new Error('Invalid workspace review archive.'); }
export class InvalidInlineReviewError extends Error {
  constructor() { super('Invalid workspace review archive source data.'); }
}

export function reviewArchiveReference(value) {
  if (typeof value !== 'string' || !value.startsWith('@')) return null;
  const match = /^@review1:([1-9][0-9]{0,8}):([a-f0-9]{64})$/.exec(value);
  if (!match || Number(match[1]) > REVIEW_LIMIT) invalid();
  return { size: Number(match[1]), key: Buffer.from(match[2], 'hex') };
}

function nonce(index) {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32BE(index, 8);
  return bytes; // Every archive gets an independent, random 256-bit key.
}

function withArchive(directory, reference, callback) {
  assertOwnerPrivateSync(directory, { kind: 'directory' });
  const descriptor = openNoFollowSync(join(directory, filename(reference.key)), readRegular);
  try {
    const info = fstatSync(descriptor);
    const expected = reference.size + Math.ceil(reference.size / REVIEW_PAGE_SIZE) * tagSize;
    if (!info.isFile() || info.nlink !== 1 || info.size !== expected) invalid();
    return callback(descriptor);
  } finally { closeSync(descriptor); }
}

function readPage(descriptor, reference, digest, index, verifiedCiphertext) {
  const count = Math.min(REVIEW_PAGE_SIZE, reference.size - index * REVIEW_PAGE_SIZE);
  if (!Number.isSafeInteger(index) || index < 0 || count <= 0 || !/^[a-f0-9]{64}$/.test(digest)) invalid();
  const bytes = Buffer.allocUnsafe(count + tagSize);
  const position = index * (REVIEW_PAGE_SIZE + tagSize);
  for (let offset = 0; offset < bytes.length;) {
    const n = readSync(descriptor, bytes, offset, bytes.length - offset, position + offset);
    if (!n) invalid();
    offset += n;
  }
  const cipher = createDecipheriv('aes-256-gcm', reference.key, nonce(index));
  cipher.setAAD(Buffer.from(digest));
  cipher.setAuthTag(bytes.subarray(count));
  const plaintext = cipher.update(bytes.subarray(0, count));
  cipher.final();
  if (verifiedCiphertext) bytes.copy(verifiedCiphertext, position);
  return plaintext;
}

function checkPayload(descriptor, reference, digest, verifiedCiphertext) {
  const hash = createHash('sha256');
  for (let i = 0; i * REVIEW_PAGE_SIZE < reference.size; i++) hash.update(readPage(descriptor, reference, digest, i, verifiedCiphertext));
  if (hash.digest('hex') !== digest) invalid();
}

function ensureArchiveDirectory(directory) {
  try { createPrivateDirSync(directory); syncDirectorySync(dirname(directory)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  assertOwnerPrivateSync(directory, { kind: 'directory' });
}

// The optional receipt describes the exact authenticated recovery file on this
// volume. Copying it to a new inode or changing its contents invalidates it.
// Filesystems without reliable file IDs/change times always pay for a full check.
function verificationStamp(descriptor, reference, digest) {
  const stat = fstatSync(descriptor, { bigint: true });
  if (!stat.ino || !stat.ctimeNs || !(stat.ctimeNs % 1_000_000_000n)) return null;
  return createHmac('sha256', reference.key)
    .update(['letagents-review-mirror-v1', digest, reference.size, stat.dev, stat.ino,
      stat.size, stat.ctimeNs, stat.mtimeNs].join('/')).digest();
}

function receiptMatches(path, expected) {
  let fd;
  try {
    fd = openNoFollowSync(path, readRegular);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.length) return false;
    const stored = Buffer.alloc(expected.length);
    return readSync(fd, stored, 0, stored.length, 0) === stored.length && stored.equals(expected);
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function verifyMirror(directory, reference, digest, useReceipt) {
  const receipt = join(directory, filename(reference.key) + '.verified');
  withArchive(directory, reference, descriptor => {
    const before = verificationStamp(descriptor, reference, digest);
    if (useReceipt && before && receiptMatches(receipt, before)) return;
    checkPayload(descriptor, reference, digest);
    if (before) {
      if (!before.equals(verificationStamp(descriptor, reference, digest) ?? Buffer.alloc(0))) invalid();
      // A receipt is an optimization; a valid read-only recovery set (e.g. a
      // restored archive) still verifies even if the cache cannot be renewed.
      try { writePrivateFileAtomicallySync(receipt, before); } catch { /* verify again next time */ }
    }
  });
}

/** Caller holds the original source transaction. An envelope alone cannot
 * supersede an existing recovery set until all of its archive refs resolve. */
export function verifyWorkspaceReviewRecoverySet(databasePath, database) {
  if (Number(database.prepare('PRAGMA user_version').get()?.user_version) < REVIEW_ARCHIVE_MIN_USER_VERSION
    || !database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='room_workspace_reviews'").get()) return;
  const [primary, recovery] = folders(databasePath);
  for (const row of database.prepare("SELECT digest,data FROM room_workspace_reviews WHERE data GLOB '@*'").iterate()) {
    const reference = reviewArchiveReference(row.data);
    if (!reference || !/^[a-f0-9]{64}$/.test(row.digest)) invalid();
    try { verifyMirror(recovery, reference, row.digest, true); }
    catch {
      // Authenticate the primary first. A relocated primary or recovery copy
      // needs no original inode or receipt; the envelope key authenticates it.
      const bytes = withArchive(primary, reference, descriptor => {
        const copy = Buffer.allocUnsafe(reference.size + Math.ceil(reference.size / REVIEW_PAGE_SIZE) * tagSize);
        checkPayload(descriptor, reference, row.digest, copy);
        return copy;
      });
      ensureArchiveDirectory(recovery);
      writePrivateFileAtomicallySync(join(recovery, filename(reference.key)), bytes);
      verifyMirror(recovery, reference, row.digest, false);
    }
  }
}

function readArchive(databasePath, reference, read) {
  const [primary, recovery] = folders(databasePath);
  try { return withArchive(primary, reference, read); }
  catch { return withArchive(recovery, reference, read); }
}

export function readArchivedReviewPage(databasePath, reference, digest, index) {
  return readArchive(databasePath, reference, descriptor => readPage(descriptor, reference, digest, index).toString('ascii'));
}

export function readArchivedReview(databasePath, reference, digest) {
  return readArchive(databasePath, reference, descriptor => {
    const data = Buffer.allocUnsafe(reference.size);
    for (let i = 0; i * REVIEW_PAGE_SIZE < reference.size; i++) {
      readPage(descriptor, reference, digest, i).copy(data, i * REVIEW_PAGE_SIZE);
    }
    return data.toString('ascii');
  });
}

export function archiveWorkspaceReview(databasePath, data, digest) {
  if (typeof data !== 'string' || !data.length || data.length > REVIEW_LIMIT
    || createHash('sha256').update(data).digest('hex') !== digest || Buffer.byteLength(data) !== data.length) throw new InvalidInlineReviewError();
  const key = randomBytes(32);
  const pages = Math.ceil(data.length / REVIEW_PAGE_SIZE);
  const bytes = Buffer.allocUnsafe(data.length + tagSize * pages);
  let offset = 0;
  for (let index = 0; index < pages; index++) {
    const cipher = createCipheriv('aes-256-gcm', key, nonce(index));
    cipher.setAAD(Buffer.from(digest));
    const start = index * REVIEW_PAGE_SIZE;
    offset += cipher.update(data.slice(start, start + REVIEW_PAGE_SIZE), 'ascii').copy(bytes, offset);
    cipher.final();
    offset += cipher.getAuthTag().copy(bytes, offset);
  }
  // The independent recovery copy is made once at capture. A modern v5+
  // (user_version 1005+) supervisor snapshot contains the envelope/key and
  // refers to the sibling recovery directory; later upgrades do not have to
  // copy this object again.
  const reference = prefix + data.length + ':' + key.toString('hex');
  try {
    const [primary, recovery] = folders(databasePath);
    ensureArchiveDirectory(primary);
    writePrivateFileAtomicallySync(join(primary, filename(key)), bytes);
    const ref = { size: data.length, key };
    withArchive(primary, ref, descriptor => checkPayload(descriptor, ref, digest));
    ensureArchiveDirectory(recovery);
    writePrivateFileAtomicallySync(join(recovery, filename(key)), bytes);
    verifyMirror(recovery, ref, digest, false);
  } catch (error) {
    discardUncommittedReviewArchive(databasePath, reference);
    throw error;
  }
  return reference;
}

/** Only the originating writer knows this fresh envelope. Call after a
 * confirmed rollback, or before returning an envelope to SQLite. */
export function discardUncommittedReviewArchive(databasePath, value) {
  const reference = reviewArchiveReference(value);
  if (!reference) return;
  for (const directory of folders(databasePath)) {
    try {
      assertOwnerPrivateSync(directory, { kind: 'directory' });
      const path = join(directory, filename(reference.key));
      try { unlinkSync(path + '.verified'); } catch { /* A receipt is optional. */ }
      unlinkSync(path);
    } catch { /* An unavailable volume can be swept once recovery releases it. */ }
  }
}
/** Caller holds the supervisor database write lock. A retained or interrupted
 * recovery point may reference objects since cleared from live history. Keep
 * their ciphertext through its entire lifetime, including unvalidated backups. */
export function pruneUnreferencedReviewArchives(databasePath, references) {
  const snapshotPresent = ['.recovery.enc', '.recovery.enc.pending'].some(suffix => {
    try { lstatSync(databasePath + suffix); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
  });
  const retained = new Set();
  if (!snapshotPresent) {
    for (const row of references()) {
      const ref = reviewArchiveReference(row.data);
      if (ref) retained.add(filename(ref.key));
    }
  }
  for (const directory of folders(databasePath)) {
    try { assertOwnerPrivateSync(directory, { kind: 'directory' }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const name of readdirSync(directory)) {
      const abandonedWrite = /^\.[0-9a-f-]{36}\.[a-f0-9]{64}\.review(?:\.verified)?\.tmp$/.test(name);
      const object = /^([a-f0-9]{64}\.review)(?:\.verified)?$/.exec(name);
      const unreferenced = !snapshotPresent && object && !retained.has(object[1]);
      if (abandonedWrite || unreferenced) unlinkSync(join(directory, name));
    }
  }
}
