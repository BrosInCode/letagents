import type { PoolClient } from 'pg';

import type { ActorPrincipal } from '../../../shared/api/actor.mjs';
import { ApiError } from '../../../shared/api/core.mjs';
import { DATA_LIMITS, type DataScope } from '../../../shared/api/data.mjs';
import { pool } from './client.js';
import { inTransaction } from './room-members.js';

// The store behind the data.* API methods (shared/api/data.mjs). It knows
// rows, caps and revisions; who may name which scope id is decided before it
// is called (src/api/v1/documents.ts). room_id is part of every statement.
//
// A delete keeps the row as a tombstone (deleted, empty data, size 0) and
// adds one to its revision, so a doc id's revisions never repeat: a client
// that read revision 3 before a delete and a re-create cannot write over the
// new document with ifRevision 3. Reads never show tombstones and the caps
// never count them.

export interface ApiDocumentScope {
  roomId: string;
  scope: DataScope;
  /** viewer: `<page id>:<account id>`; page: the page id; room: ''. */
  scopeId: string;
}

export interface ApiDocumentKey extends ApiDocumentScope {
  collection: string;
  docId: string;
}

export interface ApiDocumentRow {
  room_id: string;
  scope: DataScope;
  scope_id: string;
  collection: string;
  doc_id: string;
  data: Record<string, unknown>;
  size_bytes: number;
  revision: number;
  deleted: boolean;
  updated_by_kind: ActorPrincipal['kind'];
  updated_by_id: string;
  updated_at: Date;
}

export type ApiDocumentWriter = Pick<ActorPrincipal, 'kind' | 'id'>;

/** A tombstone older than this may go: a client holding a revision that old reads again anyway. */
const TOMBSTONE_KEEP = '30 days';
const TOMBSTONE_PURGE_BATCH = 100;

const COLUMNS = `room_id, scope, scope_id, collection, doc_id, data, size_bytes, revision, deleted, updated_by_kind, updated_by_id, updated_at`;
const KEY_MATCH = `room_id = $1 AND scope = $2 AND scope_id = $3 AND collection = $4 AND doc_id = $5`;

const keyParams = (key: ApiDocumentKey) => [key.roomId, key.scope, key.scopeId, key.collection, key.docId];

/** The size the caps count: the document's JSON text in UTF-8. */
export function documentBytes(data: unknown): number {
  return Buffer.byteLength(JSON.stringify(data), 'utf8');
}

export async function getApiDocument(key: ApiDocumentKey): Promise<ApiDocumentRow | null> {
  const { rows } = await pool.query<ApiDocumentRow>(
    `SELECT ${COLUMNS} FROM api_documents WHERE ${KEY_MATCH} AND NOT deleted`,
    keyParams(key),
  );
  return rows[0] ?? null;
}

/**
 * One page of a collection in doc id order. A page stops early once it holds
 * DATA_LIMITS.listBytes, so 100 large documents never make one huge answer.
 */
export async function listApiDocuments(
  input: ApiDocumentScope & { collection: string; after?: string; limit: number },
): Promise<{ rows: ApiDocumentRow[]; nextAfter: string | null }> {
  const { rows } = await pool.query<ApiDocumentRow>(
    `SELECT ${COLUMNS} FROM api_documents
      WHERE room_id = $1 AND scope = $2 AND scope_id = $3 AND collection = $4 AND NOT deleted AND ($5::text IS NULL OR doc_id > $5)
      ORDER BY doc_id
      LIMIT $6`,
    [input.roomId, input.scope, input.scopeId, input.collection, input.after ?? null, input.limit + 1],
  );
  const page: ApiDocumentRow[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, input.limit)) {
    if (page.length > 0 && bytes + row.size_bytes > DATA_LIMITS.listBytes) break;
    page.push(row);
    bytes += row.size_bytes;
  }
  const more = page.length < rows.length;
  return { rows: page, nextAfter: more ? page[page.length - 1]!.doc_id : null };
}

export interface ApiDocumentWrite {
  /** `set` replaces the document; `update` merges top-level fields into an existing one. */
  mode: 'set' | 'update';
  data: Record<string, unknown>;
  ifRevision?: number;
  writer: ApiDocumentWriter;
}

/**
 * Creates, replaces or merges one document. Every write in a room locks the
 * room's usage row first, so the revision check and all the caps (scope,
 * viewer, room) are exact under concurrent writers.
 * Throws ApiError `conflict`, `too_large` or (update only) `not_found`.
 */
export async function writeApiDocument(key: ApiDocumentKey, write: ApiDocumentWrite): Promise<ApiDocumentRow> {
  return inTransaction(async (client) => {
    const usage = await lockRoomUsage(client, key.roomId);
    const stored = await selectForWrite(client, key);
    const live = stored && !stored.deleted ? stored : null;
    checkRevision(live, write.ifRevision);
    if (write.mode === 'update' && !live) throw new ApiError('not_found', 'No document with this id in this collection.');

    const data = write.mode === 'update' ? mergeTopLevel(live!.data, write.data) : write.data;
    const size = documentBytes(data);
    if (size > DATA_LIMITS.docBytes) {
      throw new ApiError('too_large', `A document holds at most ${DATA_LIMITS.docBytes} bytes of JSON; this one is ${size}.`);
    }
    if (!live) {
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM api_documents WHERE room_id = $1 AND scope = $2 AND scope_id = $3 AND NOT deleted`,
        [key.roomId, key.scope, key.scopeId],
      );
      if ((rows[0]?.count ?? 0) >= DATA_LIMITS.docsPerScope) {
        throw new ApiError('too_large', `This scope already holds ${DATA_LIMITS.docsPerScope} documents. Delete some first.`);
      }
      if (usage.docs >= DATA_LIMITS.docsPerRoom) {
        throw new ApiError('too_large', `This room already holds ${DATA_LIMITS.docsPerRoom} documents. Delete some first.`);
      }
    }
    const growth = size - (live?.size_bytes ?? 0);
    if (usage.bytes + growth > DATA_LIMITS.bytesPerRoom) {
      throw new ApiError('too_large', `The documents in one room hold at most ${DATA_LIMITS.bytesPerRoom} bytes in all. Delete some first.`);
    }
    if (key.scope === 'viewer') {
      const { rows } = await client.query<{ total: number }>(
        `SELECT COALESCE(sum(size_bytes), 0)::int AS total FROM api_documents
          WHERE room_id = $1 AND scope = $2 AND scope_id = $3 AND NOT deleted`,
        [key.roomId, key.scope, key.scopeId],
      );
      const total = (rows[0]?.total ?? 0) + growth;
      if (total > DATA_LIMITS.viewerBytesPerPage) {
        throw new ApiError(
          'too_large',
          `Your own data for one page holds at most ${DATA_LIMITS.viewerBytesPerPage} bytes in all; this write would make it ${total}.`,
        );
      }
    }

    // A tombstone comes back to life with the next revision, never with 1.
    const { rows } = await client.query<ApiDocumentRow>(
      `INSERT INTO api_documents (room_id, scope, scope_id, collection, doc_id, data, size_bytes, revision, deleted, updated_by_kind, updated_by_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 1, false, $8, $9, now())
       ON CONFLICT (room_id, scope, scope_id, collection, doc_id) DO UPDATE
         SET data = EXCLUDED.data, size_bytes = EXCLUDED.size_bytes, revision = api_documents.revision + 1, deleted = false,
             updated_by_kind = EXCLUDED.updated_by_kind, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()
       RETURNING ${COLUMNS}`,
      [...keyParams(key), JSON.stringify(data), size, write.writer.kind, write.writer.id],
    );
    await client.query(`UPDATE api_document_usage SET docs = docs + $2, bytes = bytes + $3 WHERE room_id = $1`, [
      key.roomId,
      live ? 0 : 1,
      growth,
    ]);
    return rows[0]!;
  });
}

/**
 * Leaves a tombstone with the next revision. Returns false when there was no
 * such document. Throws ApiError `conflict` on a revision mismatch.
 */
export async function deleteApiDocument(
  key: ApiDocumentKey,
  options: { ifRevision?: number; writer: ApiDocumentWriter },
): Promise<boolean> {
  return inTransaction(async (client) => {
    await lockRoomUsage(client, key.roomId);
    const stored = await selectForWrite(client, key);
    const live = stored && !stored.deleted ? stored : null;
    checkRevision(live, options.ifRevision);
    if (!live) return false;
    await client.query(
      `UPDATE api_documents
          SET data = '{}'::jsonb, size_bytes = 0, revision = revision + 1, deleted = true,
              updated_by_kind = $6, updated_by_id = $7, updated_at = now()
        WHERE ${KEY_MATCH}`,
      [...keyParams(key), options.writer.kind, options.writer.id],
    );
    await client.query(`UPDATE api_document_usage SET docs = docs - 1, bytes = bytes - $2 WHERE room_id = $1`, [
      key.roomId,
      live.size_bytes,
    ]);
    // Old tombstones go a few at a time, so a room that churns ids keeps no growing pile.
    await client.query(
      `DELETE FROM api_documents
        WHERE (room_id, scope, scope_id, collection, doc_id) IN (
          SELECT room_id, scope, scope_id, collection, doc_id FROM api_documents
           WHERE room_id = $1 AND deleted AND updated_at < now() - $2::interval
           LIMIT $3)`,
      [key.roomId, TOMBSTONE_KEEP, TOMBSTONE_PURGE_BATCH],
    );
    return true;
  });
}

/** The room's usage row, locked until the transaction ends; made on the room's first write. */
async function lockRoomUsage(client: PoolClient, roomId: string): Promise<{ docs: number; bytes: number }> {
  await client.query(`INSERT INTO api_document_usage (room_id) VALUES ($1) ON CONFLICT (room_id) DO NOTHING`, [roomId]);
  const { rows } = await client.query<{ docs: number; bytes: number }>(
    `SELECT docs, bytes::float8 AS bytes FROM api_document_usage WHERE room_id = $1 FOR UPDATE`,
    [roomId],
  );
  return rows[0] ?? { docs: 0, bytes: 0 };
}

async function selectForWrite(client: PoolClient, key: ApiDocumentKey): Promise<ApiDocumentRow | null> {
  const { rows } = await client.query<ApiDocumentRow>(`SELECT ${COLUMNS} FROM api_documents WHERE ${KEY_MATCH}`, keyParams(key));
  return rows[0] ?? null;
}

/** `ifRevision` 0 means "only if it does not exist", which a tombstone does not. */
function checkRevision(live: ApiDocumentRow | null, ifRevision: number | undefined): void {
  if (ifRevision === undefined) return;
  const current = live?.revision ?? 0;
  if (current !== ifRevision) {
    throw new ApiError(
      'conflict',
      current === 0
        ? `The document does not exist, not revision ${ifRevision}. Read it again and retry.`
        : `The document is at revision ${current}, not ${ifRevision}. Read it again and retry.`,
    );
  }
}

/**
 * A field in the patch replaces that field; a field set to null is removed.
 * The input schema already refused "__proto__", "constructor" and
 * "prototype" keys; fromEntries keeps every key a plain own field anyway.
 */
function mergeTopLevel(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const fields = new Map(Object.entries(current));
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) fields.delete(field);
    else fields.set(field, value);
  }
  return Object.fromEntries(fields);
}
