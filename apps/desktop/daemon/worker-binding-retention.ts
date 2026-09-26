import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

/**
 * Finalized publication rows retained per entry.
 *
 * `worker_binding_publications` is an append-only reservation journal: every
 * running agent republishes its worker binding roughly every 30 s, so one
 * long-lived agent adds ~2 900 rows a day. On a measured machine the table had
 * grown to ~907 000 rows (236 MB of data plus ~170 MB of indexes) and the
 * daemon's synchronous `node:sqlite` reads were spending most of the main
 * thread on page-cache misses against it.
 *
 * Nothing reads the interior of that journal. Only three things about it are
 * ever read:
 *   - the newest sequence per entry (the "is my reservation still the latest"
 *     check in `finalizePublication`, and the v5 watermark derivation),
 *   - the still-open `reserved` rows (a reservation in flight must stay
 *     finalizable by `reservation_id`),
 *   - the distinct `(execution_generation_id, agent_session_id)` pairs the
 *     legacy `executionPredecessors` union reconstructs for pre-receipt
 *     clients.
 * Retention preserves all three exactly; see `partitionRetainedPublications`.
 */
export const RETAINED_WORKER_BINDING_PUBLICATIONS_PER_ENTRY = 64;

/**
 * How many publications an entry may add before its journal is compacted again.
 * Compaction is driven by the writes that cause the growth rather than by a
 * timer, so an idle daemon does no work at all.
 */
export const WORKER_BINDING_PUBLICATIONS_PRUNE_INTERVAL = 256;

/**
 * Rows examined for one entry in one pass. A machine that has never pruned can
 * hold tens of thousands of rows for a single entry; bounding the pass keeps
 * each transaction (and its WAL frames) small, and the caller simply prunes
 * that entry again on the next pass.
 */
export const WORKER_BINDING_PUBLICATIONS_PRUNE_SCAN_LIMIT = 20_000;

type PublicationRow = {
  reservation_id: string;
  sequence: number;
  state: string;
  execution_generation_id: string;
  agent_session_id: string;
};

/** Entries whose finalized journal has grown past the retention limit. */
export function entriesOverPublicationRetention(
  database: DatabaseSync,
  retained = RETAINED_WORKER_BINDING_PUBLICATIONS_PER_ENTRY,
): string[] {
  const rows = database.prepare(
    `SELECT entry_id FROM worker_binding_publications GROUP BY entry_id HAVING COUNT(*) > ? ORDER BY COUNT(*) DESC`,
  ).all(Math.max(1, retained)) as Row[];
  return rows.map((row) => String(row.entry_id));
}

/**
 * Classify one entry's newest rows into the ones retention keeps and the ones
 * it may delete. Exported for tests: the retained set is the invariant, not the
 * SQL that implements it.
 *
 * `rows` must be ordered newest sequence first.
 */
export function partitionRetainedPublications(
  rows: readonly PublicationRow[],
  retained = RETAINED_WORKER_BINDING_PUBLICATIONS_PER_ENTRY,
): { retainedIds: string[]; deletableIds: string[] } {
  const keepNewest = Math.max(1, retained);
  const seenGenerations = new Set<string>();
  const retainedIds: string[] = [];
  const deletableIds: string[] = [];
  rows.forEach((row, index) => {
    const generation = `${row.execution_generation_id}\u0000${row.agent_session_id}`;
    // Newest-first order makes the first sighting of a pair its newest row, so
    // the legacy predecessor union keeps every distinct generation it could
    // previously produce. The newest `keepNewest` rows protect the maximum
    // sequence (and therefore the watermark derivation), and an unfinalized
    // reservation is never removable because its finalizer addresses it by id.
    const keep = index < keepNewest || row.state === "reserved" || !seenGenerations.has(generation);
    seenGenerations.add(generation);
    (keep ? retainedIds : deletableIds).push(row.reservation_id);
  });
  return { retainedIds, deletableIds };
}

/**
 * Compact one entry's publication journal. The caller owns the transaction.
 * Returns how many rows were deleted and whether the scan limit truncated the
 * pass (so the caller can decide to come back).
 */
export function prunePublicationsForEntry(
  database: DatabaseSync,
  entryId: string,
  retained = RETAINED_WORKER_BINDING_PUBLICATIONS_PER_ENTRY,
  scanLimit = WORKER_BINDING_PUBLICATIONS_PRUNE_SCAN_LIMIT,
): { deleted: number; truncated: boolean } {
  const bounded = Math.max(Math.max(1, retained) + 1, scanLimit);
  const rows = database.prepare(
    `SELECT reservation_id, sequence, state, execution_generation_id, agent_session_id
     FROM worker_binding_publications WHERE entry_id=? ORDER BY sequence DESC LIMIT ?`,
  ).all(entryId, bounded) as Row[];
  if (rows.length <= Math.max(1, retained)) return { deleted: 0, truncated: false };
  const { deletableIds } = partitionRetainedPublications(rows.map((row) => ({
    reservation_id: String(row.reservation_id),
    sequence: Number(row.sequence),
    state: String(row.state),
    execution_generation_id: String(row.execution_generation_id),
    agent_session_id: String(row.agent_session_id),
  })), retained);
  let deleted = 0;
  for (let index = 0; index < deletableIds.length; index += 256) {
    const chunk = deletableIds.slice(index, index + 256);
    const statement = database.prepare(
      `DELETE FROM worker_binding_publications
       WHERE entry_id=? AND state<>'reserved' AND reservation_id IN (${chunk.map(() => "?").join(",")})`,
    );
    deleted += Number(statement.run(...[entryId, ...chunk] as never[]).changes ?? 0);
  }
  return { deleted, truncated: rows.length >= bounded };
}
