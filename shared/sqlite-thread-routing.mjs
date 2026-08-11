import {
  routingAliasHash,
  routingIdentityAliases,
  routingSenderAliasRows,
} from "./routing-aliases.mjs";

export const LOCAL_THREAD_ROUTING_BACKFILL_BATCH_SIZE = 100;
export const LOCAL_THREAD_ROUTING_LOOKUP_BATCH_SIZE = 64;
export const LOCAL_THREAD_ROUTING_BACKFILL_TIME_BUDGET_MS = 12;
const LOCAL_THREAD_ROUTING_MAX_REQUESTED_ROOTS = 500;
const LOCAL_THREAD_ROUTING_REQUESTED_REPAIR_SLICE = 64;
const LOCAL_THREAD_ROUTING_INVALIDATION_DELETE_BATCH_SIZE = 100;
const LOCAL_THREAD_ROUTING_MAX_IDENTITY_ALIASES = 25_000;
const LOCAL_THREAD_ROUTING_MAX_RESULT_KEYS = 25_000;
const LOCAL_THREAD_ROUTING_LOCK_RETRY_INITIAL_MS = 10;
const LOCAL_THREAD_ROUTING_LOCK_RETRY_MAX_MS = 250;
const LOCAL_THREAD_ROUTING_LOCK_RETRY_DEADLINE_MS = 2_000;
const LOCAL_THREAD_ROUTING_FOREGROUND_REPAIR_BUDGET_MS = 75;

const scheduledDatabases = new WeakMap();
const publisherKeyColumnByDatabase = new WeakMap();
const sourceColumnByDatabase = new WeakMap();

function publisherAgentKeySelect(database, qualifier = "") {
  let hasColumn = publisherKeyColumnByDatabase.get(database);
  if (hasColumn === undefined) {
    hasColumn = database.prepare("PRAGMA table_info(local_chat_messages)")
      .all()
      .some((column) => String(column.name) === "publisher_agent_key");
    publisherKeyColumnByDatabase.set(database, hasColumn);
  }
  return hasColumn
    ? `${qualifier}publisher_agent_key AS publisher_agent_key`
    : "NULL AS publisher_agent_key";
}

function messageSourceSelect(database, qualifier = "") {
  let hasColumn = sourceColumnByDatabase.get(database);
  if (hasColumn === undefined) {
    hasColumn = database.prepare("PRAGMA table_info(local_chat_messages)")
      .all()
      .some((column) => String(column.name) === "source");
    sourceColumnByDatabase.set(database, hasColumn);
  }
  return hasColumn ? `${qualifier}source AS source` : "NULL AS source";
}

function runWithBusyTimeout(database, timeoutMs, work) {
  const previousBusyTimeout = Number(database.prepare("PRAGMA busy_timeout").get()?.timeout ?? 0);
  database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeoutMs))}`);
  try {
    return work();
  } finally {
    database.exec(`PRAGMA busy_timeout = ${Math.max(0, previousBusyTimeout)}`);
  }
}

/** Install only bounded metadata/DDL. Historical rows are projected later. */
export function ensureLocalThreadRoutingProjectionSchema(database) {
  return runNonblockingImmediateTransaction(database, () => {
    // Feature-preview builds used an incompatible aliases table. A versioned,
    // empty projection avoids ALTER/CREATE INDEX scans of historical rows and
    // makes the complete schema cutover crash-atomic.
    database.exec(`
      CREATE TABLE IF NOT EXISTS local_chat_thread_routing_aliases_v2 (
        alias_id INTEGER PRIMARY KEY,
        room_id TEXT NOT NULL,
        thread_root_number INTEGER NOT NULL,
        participant_hash TEXT NOT NULL DEFAULT '',
        participant_text TEXT NOT NULL DEFAULT '',
        alias_hash TEXT NOT NULL CHECK (LENGTH(alias_hash) = 32),
        alias_text TEXT NOT NULL,
        is_full INTEGER NOT NULL DEFAULT 0 CHECK (is_full IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS local_chat_thread_routing_alias_lookup_v2_idx
        ON local_chat_thread_routing_aliases_v2 (room_id, alias_hash, thread_root_number);
      CREATE INDEX IF NOT EXISTS local_chat_thread_routing_alias_root_lookup_v2_idx
        ON local_chat_thread_routing_aliases_v2 (room_id, thread_root_number, alias_hash);
      CREATE INDEX IF NOT EXISTS local_chat_thread_routing_participant_lookup_v2_idx
        ON local_chat_thread_routing_aliases_v2 (
          room_id, thread_root_number, participant_hash
        );
      CREATE TABLE IF NOT EXISTS local_chat_thread_routing_agents_v2 (
        agent_id INTEGER PRIMARY KEY,
        room_id TEXT NOT NULL,
        thread_root_number INTEGER NOT NULL,
        participant_hash TEXT NOT NULL,
        participant_text TEXT NOT NULL,
        agent_key_hash TEXT NOT NULL CHECK (LENGTH(agent_key_hash) = 32),
        agent_key TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_chat_thread_routing_agent_lookup_v2_idx
        ON local_chat_thread_routing_agents_v2 (
          room_id, thread_root_number, agent_key_hash
        );
      CREATE INDEX IF NOT EXISTS local_chat_thread_routing_agent_participant_v2_idx
        ON local_chat_thread_routing_agents_v2 (
          room_id, thread_root_number, participant_hash
        );
      CREATE TABLE IF NOT EXISTS local_chat_thread_routing_projection_state_v2 (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        room_cursor TEXT NOT NULL DEFAULT '',
        message_cursor INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1))
      );
      INSERT OR IGNORE INTO local_chat_thread_routing_projection_state_v2 (singleton)
      VALUES (1);
      CREATE TABLE IF NOT EXISTS local_chat_thread_routing_root_state_v2 (
        room_id TEXT NOT NULL,
        thread_root_number INTEGER NOT NULL,
        through_message_number INTEGER NOT NULL,
        PRIMARY KEY (room_id, thread_root_number)
      );
      CREATE TABLE IF NOT EXISTS local_chat_thread_routing_invalidated_roots_v2 (
        room_id TEXT NOT NULL,
        thread_root_number INTEGER NOT NULL,
        cleanup_completed INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_completed IN (0, 1)),
        PRIMARY KEY (room_id, thread_root_number)
      );
    `);
  });
}

/** Retry projection DDL without ever sleeping synchronously on SQLite's lock. */
export async function ensureLocalThreadRoutingProjectionSchemaAsync(database, options) {
  await retrySqliteBusy(
    () => ensureLocalThreadRoutingProjectionSchema(database),
    options,
  );
}

function participantIdentity(sender) {
  const participantText = String(sender ?? "");
  return {
    participantText,
    participantHash: routingAliasHash(participantText),
  };
}

function participantProjectionStatements(database) {
  return {
    existing: database.prepare(`
      SELECT 1 FROM local_chat_thread_routing_aliases_v2
      WHERE room_id = ? AND thread_root_number = ?
        AND participant_hash = ? AND participant_text = ?
        AND alias_hash = ? AND alias_text = ? AND is_full = ?
      LIMIT 1
    `),
    insert: database.prepare(`
      INSERT INTO local_chat_thread_routing_aliases_v2 (
        room_id, thread_root_number, participant_hash, participant_text,
        alias_hash, alias_text, is_full
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM local_chat_thread_routing_aliases_v2
        WHERE room_id = ? AND thread_root_number = ?
          AND participant_hash = ? AND participant_text = ?
          AND alias_hash = ? AND alias_text = ? AND is_full = ?
      )
    `),
    existingAgent: database.prepare(`
      SELECT 1 FROM local_chat_thread_routing_agents_v2
      WHERE room_id = ? AND thread_root_number = ?
        AND participant_hash = ? AND participant_text = ?
        AND agent_key_hash = ? AND agent_key = ?
      LIMIT 1
    `),
    insertAgent: database.prepare(`
      INSERT INTO local_chat_thread_routing_agents_v2 (
        room_id, thread_root_number, participant_hash, participant_text,
        agent_key_hash, agent_key
      )
      SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM local_chat_thread_routing_agents_v2
        WHERE room_id = ? AND thread_root_number = ?
          AND participant_hash = ? AND participant_text = ?
          AND agent_key_hash = ? AND agent_key = ?
      )
    `),
  };
}

function projectLocalThreadRoutingSenderWithStatements(
  statements,
  roomId,
  threadRootNumber,
  sender,
  source,
) {
  // Alias authority is positive, not inferred from "not browser". Imported
  // legacy/anonymous rows with a NULL source remain display-only; authenticated
  // durable publisher keys are projected by the separate agent-key path.
  if (String(source ?? "").trim() !== "agent") return;
  const aliases = routingSenderAliasRows(sender);
  if (aliases.length === 0) return;
  const { participantHash, participantText } = participantIdentity(sender);
  const sentinel = aliases.find(({ isFull }) => isFull) ?? aliases[0];
  const existing = statements.existing.get(
    roomId,
    threadRootNumber,
    participantHash,
    participantText,
    routingAliasHash(sentinel.alias),
    sentinel.alias,
    sentinel.isFull ? 1 : 0,
  );
  if (existing) return;

  for (const { alias, isFull } of aliases) {
    const hash = routingAliasHash(alias);
    const full = isFull ? 1 : 0;
    statements.insert.run(
      roomId, threadRootNumber, participantHash, participantText, hash, alias, full,
      roomId, threadRootNumber, participantHash, participantText, hash, alias, full,
    );
  }
}

function projectLocalThreadRoutingAgentWithStatements(
  statements,
  roomId,
  threadRootNumber,
  sender,
  agentKeyInput,
) {
  const agentKey = String(agentKeyInput ?? "").trim();
  if (!agentKey) return;
  const { participantHash, participantText } = participantIdentity(sender);
  const agentKeyHash = routingAliasHash(agentKey);
  if (statements.existingAgent.get(
    roomId, threadRootNumber, participantHash, participantText, agentKeyHash, agentKey,
  )) return;
  statements.insertAgent.run(
    roomId, threadRootNumber, participantHash, participantText, agentKeyHash, agentKey,
    roomId, threadRootNumber, participantHash, participantText, agentKeyHash, agentKey,
  );
}

export function projectLocalThreadRoutingMessage(database, row) {
  const threadRootNumber = Number(row?.thread_root_number ?? 0);
  if (!threadRootNumber) return;
  const invalidated = database.prepare(`
    SELECT 1 FROM local_chat_thread_routing_invalidated_roots_v2
    WHERE room_id = ? AND thread_root_number = ?
  `).get(row.room_id, threadRootNumber);
  // A corrected root is rebuilt from its authoritative rows by the bounded
  // repair lane. Live writes during that window remain in local_chat_messages
  // and are picked up by the same replay; they must not advance across the
  // invalidated generation or expose a partial replacement.
  if (invalidated) return;
  const statements = participantProjectionStatements(database);
  const root = database.prepare(`
    SELECT sender, ${messageSourceSelect(database)}, ${publisherAgentKeySelect(database)}
    FROM local_chat_messages WHERE room_id = ? AND number = ?
  `).get(row.room_id, threadRootNumber);
  if (root?.sender !== undefined) {
    projectLocalThreadRoutingSenderWithStatements(
      statements, row.room_id, threadRootNumber, root.sender, root.source,
    );
    projectLocalThreadRoutingAgentWithStatements(
      statements, row.room_id, threadRootNumber, root.sender, root.publisher_agent_key,
    );
  }
  projectLocalThreadRoutingSenderWithStatements(
    statements, row.room_id, threadRootNumber, row.sender, row.source,
  );
  projectLocalThreadRoutingAgentWithStatements(
    statements, row.room_id, threadRootNumber, row.sender, row.publisher_agent_key,
  );
  const currentState = database.prepare(`
    SELECT through_message_number
    FROM local_chat_thread_routing_root_state_v2
    WHERE room_id = ? AND thread_root_number = ?
  `).get(row.room_id, threadRootNumber);
  const priorReply = database.prepare(`
    SELECT MAX(number) AS number
    FROM local_chat_messages
    WHERE room_id = ? AND thread_root_number = ? AND number < ?
  `).get(row.room_id, threadRootNumber, Number(row.number));
  const coveredThrough = Math.max(
    Number(currentState?.through_message_number ?? 0),
    root?.sender !== undefined ? threadRootNumber : 0,
  );
  const precedingMessage = Math.max(
    root?.sender !== undefined && threadRootNumber < Number(row.number) ? threadRootNumber : 0,
    Number(priorReply?.number ?? 0),
  );
  // A legacy process may have inserted the predecessor without maintaining
  // this projection. Never advance across that gap: the bounded lazy/background
  // repair will replay every row after the last proven contiguous cursor.
  const throughMessageNumber = precedingMessage <= coveredThrough
    ? Math.max(coveredThrough, Number(row.number))
    : coveredThrough;
  if (throughMessageNumber <= 0) return;
  database.prepare(`
    INSERT INTO local_chat_thread_routing_root_state_v2 (
      room_id, thread_root_number, through_message_number
    ) VALUES (?, ?, ?)
    ON CONFLICT(room_id, thread_root_number) DO UPDATE SET
      through_message_number = MAX(through_message_number, excluded.through_message_number)
  `).run(row.room_id, threadRootNumber, throughMessageNumber);
}

function rollbackQuietly(database) {
  try { database.exec("ROLLBACK"); } catch { /* transaction did not begin */ }
}

function isSqliteBusy(error) {
  const code = String(error?.code ?? "");
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || /\bdatabase (?:is )?(?:busy|locked)\b/i.test(String(error));
}

function isTransientSqliteIo(error) {
  const code = String(error?.code ?? "");
  return code === "SQLITE_IOERR"
    || code.startsWith("SQLITE_IOERR_")
    || /\bdisk I\/O error\b/i.test(String(error));
}

/**
 * Maintenance work must never inherit the foreground connection's multi-second
 * busy timeout. Try the writer lock once, restore the caller's timeout, and let
 * the async scheduler decide when to retry.
 */
function runNonblockingImmediateTransaction(database, work) {
  return runWithBusyTimeout(database, 0, () => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
  });
}

/** One committed batch; callers schedule another turn instead of looping. */
export function runLocalThreadRoutingBackfillBatch(
  database,
  batchSize = LOCAL_THREAD_ROUTING_BACKFILL_BATCH_SIZE,
) {
  const boundedBatchSize = Math.max(
    1,
    Math.min(LOCAL_THREAD_ROUTING_BACKFILL_BATCH_SIZE, Math.floor(Number(batchSize) || LOCAL_THREAD_ROUTING_BACKFILL_BATCH_SIZE)),
  );
  const initialState = database.prepare(`
    SELECT completed FROM local_chat_thread_routing_projection_state_v2 WHERE singleton = 1
  `).get();
  if (Number(initialState?.completed ?? 0) === 1) return { processed: 0, completed: true };
  return runNonblockingImmediateTransaction(database, () => {
    const state = database.prepare(`
      SELECT room_cursor, message_cursor, completed
      FROM local_chat_thread_routing_projection_state_v2 WHERE singleton = 1
    `).get();
    if (Number(state?.completed ?? 0) === 1) {
      return { processed: 0, completed: true };
    }
    const roomCursor = String(state?.room_cursor ?? "");
    const messageCursor = Number(state?.message_cursor ?? 0);
    const rows = database.prepare(`
      SELECT room_id, number, thread_root_number, sender,
             ${messageSourceSelect(database)},
             ${publisherAgentKeySelect(database)}
      FROM local_chat_messages
      WHERE thread_root_number IS NOT NULL
        AND (room_id > ? OR (room_id = ? AND number > ?))
      ORDER BY room_id, number
      LIMIT ?
    `).all(roomCursor, roomCursor, messageCursor, boundedBatchSize);
    const startedAt = performance.now();
    let processed = 0;
    for (const row of rows) {
      if (processed > 0 && performance.now() - startedAt >= LOCAL_THREAD_ROUTING_BACKFILL_TIME_BUDGET_MS) break;
      projectLocalThreadRoutingMessage(database, row);
      processed += 1;
    }
    const last = rows[processed - 1];
    const completed = processed === rows.length && rows.length < boundedBatchSize;
    database.prepare(`
      UPDATE local_chat_thread_routing_projection_state_v2
      SET room_cursor = ?, message_cursor = ?, completed = ? WHERE singleton = 1
    `).run(
      last ? String(last.room_id) : roomCursor,
      last ? Number(last.number) : messageCursor,
      completed ? 1 : 0,
    );
    return { processed, completed };
  });
}

/** Yield between batches so opening a 50k-message local database stays fast. */
export function scheduleLocalThreadRoutingBackfill(database, options = {}) {
  if (scheduledDatabases.has(database)) return;
  const state = { failures: 0 };
  scheduledDatabases.set(database, state);
  const scheduleImmediate = options.setImmediate ?? setImmediate;
  const scheduleTimeout = options.setTimeout ?? setTimeout;
  const onError = options.onError ?? ((error, delayMs) => {
    const disposition = delayMs === null
      ? "parked until process restart"
      : `retrying in ${delayMs}ms`;
    console.error(`Local thread routing backfill failed; ${disposition}`, error);
  });
  const unref = (handle) => handle?.unref?.();
  const run = () => {
    let result;
    try {
      result = runLocalThreadRoutingBackfillBatch(database);
    } catch (error) {
      // Busy/locked is ordinary cross-process contention. I/O errors get a
      // bounded retry window; programmer/schema/corruption failures are parked
      // after one durable diagnostic instead of waking and logging forever.
      state.failures += 1;
      const delayMs = Math.min(5_000, 25 * (2 ** Math.min(state.failures - 1, 8)));
      const busy = isSqliteBusy(error);
      const retryableIo = isTransientSqliteIo(error) && state.failures <= 8;
      if (busy || retryableIo) {
        if (retryableIo && state.failures === 1) onError(error, delayMs);
        unref(scheduleTimeout(run, delayMs));
        return;
      }
      onError(error, null);
      return;
    }
    state.failures = 0;
    if (result.completed) {
      scheduledDatabases.delete(database);
      return;
    }
    unref(scheduleImmediate(run));
  };
  unref(scheduleImmediate(run));
}

function yieldToEventLoop(unref = false) {
  return new Promise((resolve) => {
    const handle = setImmediate(resolve);
    if (unref) handle.unref?.();
  });
}

export class LocalThreadRoutingProjectionUnavailableError extends Error {
  constructor() {
    super("Local thread routing projection is still repairing; retry shortly.");
    this.name = "LocalThreadRoutingProjectionUnavailableError";
  }
}

function lockRetryDelay(attempt, random) {
  const ceiling = Math.min(
    LOCAL_THREAD_ROUTING_LOCK_RETRY_MAX_MS,
    LOCAL_THREAD_ROUTING_LOCK_RETRY_INITIAL_MS * (2 ** Math.min(attempt, 8)),
  );
  return Math.max(1, Math.floor(ceiling * (0.5 + (0.5 * random()))));
}

async function retrySqliteBusy(work, options = {}) {
  const maxWaitMs = Math.max(
    0,
    Math.floor(Number(options.maxWaitMs ?? LOCAL_THREAD_ROUTING_LOCK_RETRY_DEADLINE_MS)),
  );
  const random = options.random ?? Math.random;
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  for (;;) {
    try {
      return work();
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      const remaining = deadline - Date.now();
      const delayMs = Math.min(remaining, lockRetryDelay(attempt, random));
      if (delayMs <= 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }
}

/**
 * Run foreground schema/write maintenance without inheriting a multi-second
 * SQLite busy timeout. Each lock attempt is synchronous and immediate; waits
 * happen only through bounded asynchronous backoff between attempts.
 */
export async function runLocalSqliteWriteTransactionAsync(database, work, options) {
  return await retrySqliteBusy(
    () => runNonblockingImmediateTransaction(database, work),
    options,
  );
}

function requestedRootProjectionStatements(database) {
  return {
    ranges: database.prepare(`
      WITH requested_root AS (
        SELECT DISTINCT CAST(value AS INTEGER) AS thread_root_number
          FROM json_each(?)
      ), latest AS (
        SELECT requested_root.thread_root_number,
               MAX(message.number) AS latest_number
          FROM requested_root
          LEFT JOIN local_chat_messages AS message
            ON message.room_id = ?
           AND ((message.number = requested_root.thread_root_number
             AND message.thread_root_number IS NULL)
             OR message.thread_root_number = requested_root.thread_root_number)
         GROUP BY requested_root.thread_root_number
      )
      SELECT latest.thread_root_number,
             COALESCE(latest.latest_number, 0) AS latest_number,
             COALESCE(state.through_message_number, 0) AS through_message_number
        FROM latest
        LEFT JOIN local_chat_thread_routing_root_state_v2 AS state
          ON state.room_id = ?
         AND state.thread_root_number = latest.thread_root_number
    `),
    rows: database.prepare(`
      WITH requested_root AS (
        SELECT DISTINCT CAST(value AS INTEGER) AS thread_root_number
          FROM json_each(?)
      )
      SELECT requested_root.thread_root_number, message.number, message.sender,
             ${messageSourceSelect(database, "message.")},
             ${publisherAgentKeySelect(database, "message.")}
        FROM requested_root
        JOIN local_chat_messages AS message
          ON message.room_id = ?
         AND ((message.number = requested_root.thread_root_number
           AND message.thread_root_number IS NULL)
           OR message.thread_root_number = requested_root.thread_root_number)
        LEFT JOIN local_chat_thread_routing_root_state_v2 AS state
          ON state.room_id = ?
         AND state.thread_root_number = requested_root.thread_root_number
       WHERE message.number > COALESCE(state.through_message_number, 0)
       ORDER BY requested_root.thread_root_number, message.number
       LIMIT ?
    `),
    state: database.prepare(`
      INSERT INTO local_chat_thread_routing_root_state_v2 (
        room_id, thread_root_number, through_message_number
      ) VALUES (?, ?, ?)
      ON CONFLICT(room_id, thread_root_number) DO UPDATE SET
        through_message_number = MAX(through_message_number, excluded.through_message_number)
    `),
    invalidated: database.prepare(`
      SELECT thread_root_number
        FROM local_chat_thread_routing_invalidated_roots_v2
       WHERE room_id = ?
         AND cleanup_completed = 0
         AND thread_root_number IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
    `),
    deleteInvalidatedAliases: database.prepare(`
      DELETE FROM local_chat_thread_routing_aliases_v2
       WHERE alias_id IN (
         SELECT alias.alias_id
           FROM local_chat_thread_routing_aliases_v2 AS alias
           JOIN json_each(?) AS requested
             ON alias.thread_root_number = CAST(requested.value AS INTEGER)
          WHERE alias.room_id = ?
          LIMIT ?
       )
    `),
    deleteInvalidatedAgents: database.prepare(`
      DELETE FROM local_chat_thread_routing_agents_v2
       WHERE agent_id IN (
         SELECT agent.agent_id
           FROM local_chat_thread_routing_agents_v2 AS agent
           JOIN json_each(?) AS requested
             ON agent.thread_root_number = CAST(requested.value AS INTEGER)
          WHERE agent.room_id = ?
          LIMIT ?
       )
    `),
    completeCleanup: database.prepare(`
      UPDATE local_chat_thread_routing_invalidated_roots_v2 AS invalidated
         SET cleanup_completed = 1
       WHERE invalidated.room_id = ?
         AND invalidated.cleanup_completed = 0
         AND invalidated.thread_root_number IN (
           SELECT CAST(value AS INTEGER) FROM json_each(?)
         )
         AND NOT EXISTS (
           SELECT 1 FROM local_chat_thread_routing_aliases_v2 AS alias
            WHERE alias.room_id = invalidated.room_id
              AND alias.thread_root_number = invalidated.thread_root_number
         )
         AND NOT EXISTS (
           SELECT 1 FROM local_chat_thread_routing_agents_v2 AS agent
            WHERE agent.room_id = invalidated.room_id
              AND agent.thread_root_number = invalidated.thread_root_number
         )
      RETURNING thread_root_number
    `),
    resetCleanedState: database.prepare(`
      DELETE FROM local_chat_thread_routing_root_state_v2
       WHERE room_id = ? AND thread_root_number = ?
    `),
    finalizeInvalidations: database.prepare(`
      DELETE FROM local_chat_thread_routing_invalidated_roots_v2 AS invalidated
       WHERE invalidated.room_id = ?
         AND invalidated.cleanup_completed = 1
         AND invalidated.thread_root_number IN (
           SELECT CAST(value AS INTEGER) FROM json_each(?)
         )
         AND COALESCE((
           SELECT state.through_message_number
             FROM local_chat_thread_routing_root_state_v2 AS state
            WHERE state.room_id = invalidated.room_id
              AND state.thread_root_number = invalidated.thread_root_number
         ), 0) >= COALESCE((
           SELECT MAX(message.number)
             FROM local_chat_messages AS message
            WHERE message.room_id = invalidated.room_id
              AND ((message.number = invalidated.thread_root_number
                AND message.thread_root_number IS NULL)
                OR message.thread_root_number = invalidated.thread_root_number)
         ), 0)
    `),
    participant: participantProjectionStatements(database),
  };
}

function pendingRequestedRoots(statements, roomId, rootNumbersJson) {
  return statements.ranges.all(rootNumbersJson, roomId, roomId)
    .filter((row) => Number(row.latest_number) > Number(row.through_message_number))
    .map((row) => Number(row.thread_root_number));
}

function projectRequestedRootBatch(database, statements, roomId, rootNumbersJson) {
  return runNonblockingImmediateTransaction(database, () => {
    const invalidatedRoots = statements.invalidated
      .all(roomId, rootNumbersJson)
      .map((row) => Number(row.thread_root_number));
    if (invalidatedRoots.length > 0) {
      const invalidatedJson = JSON.stringify(invalidatedRoots);
      const aliasesDeleted = Number(statements.deleteInvalidatedAliases.run(
        invalidatedJson,
        roomId,
        LOCAL_THREAD_ROUTING_INVALIDATION_DELETE_BATCH_SIZE,
      ).changes ?? 0);
      const agentsDeleted = Number(statements.deleteInvalidatedAgents.run(
        invalidatedJson,
        roomId,
        LOCAL_THREAD_ROUTING_INVALIDATION_DELETE_BATCH_SIZE,
      ).changes ?? 0);
      if (aliasesDeleted + agentsDeleted > 0) {
        return { processed: aliasesDeleted + agentsDeleted };
      }
      const cleaned = statements.completeCleanup.all(roomId, invalidatedJson);
      for (const row of cleaned) {
        statements.resetCleanedState.run(roomId, Number(row.thread_root_number));
      }
    }
    const rows = statements.rows.all(
      rootNumbersJson,
      roomId,
      roomId,
      LOCAL_THREAD_ROUTING_BACKFILL_BATCH_SIZE,
    );
    const startedAt = performance.now();
    let processed = 0;
    const throughByRoot = new Map();
    for (const row of rows) {
      if (processed > 0 && performance.now() - startedAt >= LOCAL_THREAD_ROUTING_BACKFILL_TIME_BUDGET_MS) break;
      const rootNumber = Number(row.thread_root_number);
      projectLocalThreadRoutingSenderWithStatements(
        statements.participant,
        roomId,
        rootNumber,
        String(row.sender ?? ""),
        row.source,
      );
      projectLocalThreadRoutingAgentWithStatements(
        statements.participant,
        roomId,
        rootNumber,
        String(row.sender ?? ""),
        row.publisher_agent_key,
      );
      throughByRoot.set(rootNumber, Number(row.number));
      processed += 1;
    }
    for (const [rootNumber, throughMessageNumber] of throughByRoot) {
      statements.state.run(roomId, rootNumber, throughMessageNumber);
    }
    statements.finalizeInvalidations.run(roomId, rootNumbersJson);
    return { processed };
  });
}

const scheduledRequestedRepairs = new WeakMap();

function scheduleRequestedRootsRepair(database, roomId, rootNumbers) {
  let roomRepairs = scheduledRequestedRepairs.get(database);
  if (!roomRepairs) {
    roomRepairs = new Map();
    scheduledRequestedRepairs.set(database, roomRepairs);
  }
  const existing = roomRepairs.get(roomId);
  if (existing) {
    for (const rootNumber of rootNumbers) {
      if (existing.roots.size >= LOCAL_THREAD_ROUTING_MAX_REQUESTED_ROOTS) break;
      existing.roots.add(rootNumber);
    }
    return;
  }
  const state = {
    roots: new Set(rootNumbers.slice(0, LOCAL_THREAD_ROUTING_MAX_REQUESTED_ROOTS)),
    failures: 0,
  };
  roomRepairs.set(roomId, state);
  const unref = (handle) => handle?.unref?.();
  const run = async () => {
    const batchRoots = [...state.roots].slice(0, LOCAL_THREAD_ROUTING_REQUESTED_REPAIR_SLICE);
    for (const rootNumber of batchRoots) state.roots.delete(rootNumber);
    try {
      await ensureRequestedRootsProjected(database, roomId, batchRoots, {
        foregroundTimeBudgetMs: Number.POSITIVE_INFINITY,
        scheduleOnTimeout: false,
        unrefYields: true,
      });
      state.failures = 0;
    } catch (error) {
      state.failures += 1;
      if ((isSqliteBusy(error) || isTransientSqliteIo(error)) && state.failures <= 8) {
        for (const rootNumber of batchRoots) {
          if (state.roots.size >= LOCAL_THREAD_ROUTING_MAX_REQUESTED_ROOTS) break;
          state.roots.add(rootNumber);
        }
        const delayMs = Math.min(5_000, 25 * (2 ** Math.min(state.failures - 1, 8)));
        unref(setTimeout(() => void run(), delayMs));
        return;
      }
      roomRepairs.delete(roomId);
      console.error("Local requested-root routing repair failed; parked until retry", error);
      return;
    }
    if (state.roots.size > 0) {
      unref(setImmediate(() => void run()));
    } else {
      roomRepairs.delete(roomId);
    }
  };
  unref(setImmediate(() => void run()));
}

/** Queue bounded asynchronous repair for roots invalidated by an import/update. */
export function scheduleLocalThreadRoutingRootsRepair(database, roomId, rootNumbersInput) {
  const rootNumbers = [...new Set(rootNumbersInput
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))];
  if (rootNumbers.length > LOCAL_THREAD_ROUTING_MAX_REQUESTED_ROOTS) {
    throw new LocalThreadRoutingProjectionUnavailableError();
  }
  if (rootNumbers.length > 0) scheduleRequestedRootsRepair(database, roomId, rootNumbers);
}

/**
 * Invalidate projected roots in constant rows. Old-generation projection rows
 * stay hidden behind the marker and are deleted in bounded async batches.
 * Call this from the transaction that commits the authoritative correction.
 */
export function invalidateLocalThreadRoutingRoots(database, roomId, rootNumbersInput) {
  const rootNumbers = [...new Set(rootNumbersInput
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))];
  if (rootNumbers.length > LOCAL_THREAD_ROUTING_MAX_REQUESTED_ROOTS) {
    throw new LocalThreadRoutingProjectionUnavailableError();
  }
  const invalidate = database.prepare(`
    INSERT INTO local_chat_thread_routing_invalidated_roots_v2 (
      room_id, thread_root_number, cleanup_completed
    ) VALUES (?, ?, 0)
    ON CONFLICT(room_id, thread_root_number) DO UPDATE SET cleanup_completed = 0
  `);
  const resetState = database.prepare(`
    DELETE FROM local_chat_thread_routing_root_state_v2
     WHERE room_id = ? AND thread_root_number = ?
  `);
  for (const rootNumber of rootNumbers) {
    invalidate.run(roomId, rootNumber);
    resetState.run(roomId, rootNumber);
  }
}

async function ensureRequestedRootsProjected(database, roomId, rootNumbers, options = {}) {
  if (rootNumbers.length > LOCAL_THREAD_ROUTING_MAX_REQUESTED_ROOTS) {
    throw new LocalThreadRoutingProjectionUnavailableError();
  }
  const statements = requestedRootProjectionStatements(database);
  const rootNumbersJson = JSON.stringify(rootNumbers);
  const foregroundTimeBudgetMs = Number(
    options.foregroundTimeBudgetMs ?? LOCAL_THREAD_ROUTING_FOREGROUND_REPAIR_BUDGET_MS,
  );
  const scheduleOnTimeout = options.scheduleOnTimeout !== false;
  const foregroundStartedAt = performance.now();
  let processedSinceYield = 0;
  let workStartedAt = performance.now();
  for (;;) {
    if (options.signal?.aborted) {
      throw new LocalThreadRoutingProjectionUnavailableError();
    }
    const pendingRoots = pendingRequestedRoots(statements, roomId, rootNumbersJson);
    if (pendingRoots.length === 0) break;
    const remainingForegroundMs = foregroundTimeBudgetMs === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(0, foregroundTimeBudgetMs - (performance.now() - foregroundStartedAt));
    if (remainingForegroundMs <= 0) {
      if (scheduleOnTimeout) scheduleRequestedRootsRepair(database, roomId, rootNumbers);
      throw new LocalThreadRoutingProjectionUnavailableError();
    }
    let batch;
    try {
      batch = await retrySqliteBusy(
        () => projectRequestedRootBatch(
          database,
          statements,
          roomId,
          JSON.stringify(pendingRoots),
        ),
        {
          maxWaitMs: remainingForegroundMs === Number.POSITIVE_INFINITY
            ? LOCAL_THREAD_ROUTING_LOCK_RETRY_DEADLINE_MS
            : remainingForegroundMs,
        },
      );
    } catch (error) {
      if (isSqliteBusy(error) && foregroundTimeBudgetMs !== Number.POSITIVE_INFINITY) {
        if (scheduleOnTimeout) scheduleRequestedRootsRepair(database, roomId, rootNumbers);
        throw new LocalThreadRoutingProjectionUnavailableError();
      }
      throw error;
    }
    processedSinceYield += batch.processed;
    const exhaustedSharedBudget = processedSinceYield >= LOCAL_THREAD_ROUTING_BACKFILL_BATCH_SIZE
      || performance.now() - workStartedAt >= LOCAL_THREAD_ROUTING_BACKFILL_TIME_BUDGET_MS;
    if (batch.processed > 0 && exhaustedSharedBudget) {
      await yieldToEventLoop(options.unrefYields === true);
      processedSinceYield = 0;
      workStartedAt = performance.now();
    }
    if (batch.processed === 0) break;
    if (performance.now() - foregroundStartedAt >= foregroundTimeBudgetMs) {
      if (scheduleOnTimeout) scheduleRequestedRootsRepair(database, roomId, rootNumbers);
      throw new LocalThreadRoutingProjectionUnavailableError();
    }
  }
}

/**
 * Resolve all requested durable identities together. A participant full-label
 * match wins over pipe segments globally; ambiguous aliases activate nobody.
 */
export async function getLocalThreadRoutingAgentKeysForRoots(
  database,
  roomId,
  rootNumbersInput,
  identities,
  options = {},
) {
  const rootNumbers = [...new Set(rootNumbersInput
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))];
  if (rootNumbers.length === 0 || identities.length === 0) return new Map();
  await ensureRequestedRootsProjected(database, roomId, rootNumbers, options);

  const keysByHash = new Map();
  const durableKeysByHash = new Map();
  for (const identity of identities) {
    const agentKey = String(identity?.agentKey ?? identity?.agent_key ?? "").trim();
    if (!agentKey) continue;
    const durableHash = routingAliasHash(agentKey);
    const durableKeys = durableKeysByHash.get(durableHash) ?? new Set();
    durableKeys.add(agentKey);
    durableKeysByHash.set(durableHash, durableKeys);
    for (const alias of routingIdentityAliases(identity)) {
      const hash = routingAliasHash(alias);
      const aliases = keysByHash.get(hash) ?? new Map();
      const keys = aliases.get(alias) ?? new Set();
      keys.add(agentKey);
      aliases.set(alias, keys);
      keysByHash.set(hash, aliases);
    }
  }
  if (keysByHash.size === 0) return new Map();

  const result = new Map();
  const rootNumbersJson = JSON.stringify(rootNumbers);
  const durableLookup = database.prepare(`
    WITH candidate AS MATERIALIZED (
      SELECT thread_root_number, agent_key_hash, agent_key
        FROM local_chat_thread_routing_agents_v2
       WHERE room_id = ?
         AND agent_key_hash IN (SELECT value FROM json_each(?))
         AND thread_root_number IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
       LIMIT ${LOCAL_THREAD_ROUTING_MAX_RESULT_KEYS + 1}
    )
    SELECT DISTINCT thread_root_number, agent_key_hash, agent_key, 0 AS overflow
      FROM candidate
    UNION ALL
    SELECT NULL, NULL, NULL, 1 AS overflow
     WHERE (SELECT COUNT(*) FROM candidate) > ${LOCAL_THREAD_ROUTING_MAX_RESULT_KEYS}
    LIMIT ${LOCAL_THREAD_ROUTING_MAX_RESULT_KEYS + 2}
  `);
  const durableHashes = [...durableKeysByHash.keys()];
  let resultRowsConsumed = 0;
  for (
    let hashOffset = 0;
    hashOffset < durableHashes.length;
    hashOffset += LOCAL_THREAD_ROUTING_LOOKUP_BATCH_SIZE
  ) {
    const durableRows = durableLookup.all(
      roomId,
      JSON.stringify(durableHashes.slice(
        hashOffset,
        hashOffset + LOCAL_THREAD_ROUTING_LOOKUP_BATCH_SIZE,
      )),
      rootNumbersJson,
    );
    if (durableRows.some((row) => Number(row.overflow) === 1)) {
      throw new LocalThreadRoutingProjectionUnavailableError();
    }
    resultRowsConsumed += durableRows.length;
    if (resultRowsConsumed > LOCAL_THREAD_ROUTING_MAX_RESULT_KEYS) {
      throw new LocalThreadRoutingProjectionUnavailableError();
    }
    for (const row of durableRows) {
      const exactKeys = durableKeysByHash.get(String(row.agent_key_hash));
      const agentKey = String(row.agent_key ?? "");
      if (!exactKeys?.has(agentKey)) continue;
      const root = Number(row.thread_root_number);
      const keys = result.get(root) ?? new Set();
      keys.add(agentKey);
      result.set(root, keys);
    }
    await yieldToEventLoop();
  }

  const aliasInputs = [];
  for (const [aliasHash, aliases] of keysByHash) {
    for (const [aliasText, agentKeys] of aliases) {
      for (const agentKey of agentKeys) {
        aliasInputs.push({ alias_hash: aliasHash, alias_text: aliasText, agent_key: agentKey });
        if (aliasInputs.length > LOCAL_THREAD_ROUTING_MAX_IDENTITY_ALIASES) {
          throw new LocalThreadRoutingProjectionUnavailableError();
        }
      }
    }
  }
  const lookup = database.prepare(`
    WITH input_alias AS MATERIALIZED (
      SELECT json_extract(value, '$.alias_hash') AS alias_hash,
             json_extract(value, '$.alias_text') AS alias_text,
             json_extract(value, '$.agent_key') AS agent_key
        FROM json_each(?)
    ), input_root AS MATERIALIZED (
      SELECT CAST(value AS INTEGER) AS thread_root_number
        FROM json_each(?)
    ), matched AS MATERIALIZED (
      SELECT alias.thread_root_number, alias.participant_hash, alias.participant_text,
             alias.is_full, input_alias.agent_key
        FROM input_root
        CROSS JOIN local_chat_thread_routing_aliases_v2 AS alias
          INDEXED BY local_chat_thread_routing_alias_root_lookup_v2_idx
        JOIN input_alias
          ON input_alias.alias_hash = alias.alias_hash
         AND input_alias.alias_text = alias.alias_text
       WHERE alias.room_id = ?
         AND alias.thread_root_number = input_root.thread_root_number
         AND alias.participant_text <> ''
         AND NOT EXISTS (
           SELECT 1 FROM local_chat_thread_routing_agents_v2 AS durable
            WHERE durable.room_id = alias.room_id
              AND durable.thread_root_number = alias.thread_root_number
              AND durable.participant_hash = alias.participant_hash
              AND durable.participant_text = alias.participant_text
         )
       LIMIT ${LOCAL_THREAD_ROUTING_MAX_RESULT_KEYS + 1}
    ), ranked AS (
      SELECT matched.*,
             MAX(is_full) OVER (
               PARTITION BY thread_root_number, participant_hash, participant_text
             ) AS preferred_is_full
        FROM matched
    ), preferred AS (
      SELECT * FROM ranked WHERE is_full = preferred_is_full
    ), unique_participant AS (
      SELECT thread_root_number, participant_hash, participant_text,
             MIN(agent_key) AS agent_key
        FROM preferred
       GROUP BY thread_root_number, participant_hash, participant_text
      HAVING COUNT(DISTINCT agent_key) = 1
    )
    SELECT DISTINCT thread_root_number, agent_key, 0 AS overflow
      FROM unique_participant
    UNION ALL
    SELECT NULL, NULL, 1 AS overflow
     WHERE (SELECT COUNT(*) FROM matched) > ${LOCAL_THREAD_ROUTING_MAX_RESULT_KEYS}
    LIMIT ${LOCAL_THREAD_ROUTING_MAX_RESULT_KEYS + 2}
  `);
  const aliasInputsJson = JSON.stringify(aliasInputs);
  for (
    let rootOffset = 0;
    rootOffset < rootNumbers.length;
    rootOffset += LOCAL_THREAD_ROUTING_MAX_REQUESTED_ROOTS
  ) {
    const rows = lookup.all(
      aliasInputsJson,
      JSON.stringify(rootNumbers.slice(
        rootOffset,
        rootOffset + LOCAL_THREAD_ROUTING_MAX_REQUESTED_ROOTS,
      )),
      roomId,
    );
    if (rows.some((row) => Number(row.overflow) === 1)) {
      throw new LocalThreadRoutingProjectionUnavailableError();
    }
    resultRowsConsumed += rows.length;
    if (resultRowsConsumed > LOCAL_THREAD_ROUTING_MAX_RESULT_KEYS) {
      throw new LocalThreadRoutingProjectionUnavailableError();
    }
    for (const row of rows) {
      const root = Number(row.thread_root_number);
      const agentKey = String(row.agent_key ?? "");
      if (!agentKey) continue;
      const keys = result.get(root) ?? new Set();
      keys.add(agentKey);
      result.set(root, keys);
    }
    await yieldToEventLoop();
  }
  return result;
}
