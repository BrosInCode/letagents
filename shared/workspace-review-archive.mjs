// The envelope lives in the supervisor row (and its encrypted recovery snapshot).
// The immutable file contains authenticated pages, so uploads need only one page
// of memory. Dropping a live reference drops its key as well.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, readSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertOwnerPrivateSync, createPrivateDirSync, openNoFollowSync, syncDirectorySync, writePrivateFileAtomicallySync } from './owner-private-fs.mjs';
import { REVIEW_LIMIT, REVIEW_PAGE_SIZE } from './workspace-review.mjs';

const prefix = '@review1:';
const tagSize = 16;
const folders = databasePath => [databasePath + '.reviews', databasePath + '.reviews-recovery'];
const filename = key => createHash('sha256').update(key).digest('hex') + '.review';
function invalid() { throw new Error('Invalid workspace review archive.'); }

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
  const descriptor = openNoFollowSync(join(directory, filename(reference.key)), constants.O_RDONLY);
  try {
    const info = fstatSync(descriptor);
    const expected = reference.size + Math.ceil(reference.size / REVIEW_PAGE_SIZE) * tagSize;
    if (!info.isFile() || info.nlink !== 1 || info.size !== expected) invalid();
    return callback(descriptor);
  } finally { closeSync(descriptor); }
}

function readPage(descriptor, reference, digest, index) {
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
  return plaintext;
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
    || createHash('sha256').update(data).digest('hex') !== digest || Buffer.byteLength(data) !== data.length) invalid();
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
  // The independent recovery copy is made once at capture. A v54+ supervisor
  // snapshot contains the envelope/key and refers to the sibling recovery
  // directory; later provider upgrades do not have to copy this object again.
  for (const directory of folders(databasePath)) {
    try { createPrivateDirSync(directory); syncDirectorySync(dirname(directory)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    assertOwnerPrivateSync(directory, { kind: 'directory' });
    writePrivateFileAtomicallySync(join(directory, filename(key)), bytes);
    const ref = { size: data.length, key };
    const verified = withArchive(directory, ref, descriptor => {
      const hash = createHash('sha256');
      for (let i = 0; i < pages; i++) hash.update(readPage(descriptor, ref, digest, i));
      return hash.digest('hex');
    });
    if (verified !== digest) invalid();
  }
  return prefix + data.length + ':' + key.toString('hex');
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
      const abandonedWrite = /^\.[0-9a-f-]{36}\.[a-f0-9]{64}\.review\.tmp$/.test(name);
      const unreferenced = !snapshotPresent && /^[a-f0-9]{64}\.review$/.test(name) && !retained.has(name);
      if (abandonedWrite || unreferenced) unlinkSync(join(directory, name));
    }
  }
}
