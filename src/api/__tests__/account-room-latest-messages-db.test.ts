import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { and, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
} else {
  process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;
const schemaModule = testDatabaseUrl ? await import("../db/schema.js") : null;
const visibilityModule = testDatabaseUrl ? await import("../db/messages/visibility.js") : null;
const listModule = testDatabaseUrl ? await import("../account-room-membership/list.js") : null;
const rolloutModule = testDatabaseUrl ? await import("../db/message-latest-time-rollout.js") : null;

const migrationsFolder = path.resolve(process.cwd(), "drizzle");
const TIMESTAMP_INDEX = "messages_room_timestamp_idx";

function deps() {
  assert.ok(dbClientModule && dbModule && schemaModule && visibilityModule && listModule && rolloutModule);
  return {
    db: dbClientModule.db,
    pool: dbClientModule.pool,
    addMessage: dbModule.addMessage,
    createProjectWithName: dbModule.createProjectWithName,
    migrateGitHubRepositoryCanonicalRoom: dbModule.migrateGitHubRepositoryCanonicalRoom,
    upsertGitHubRepositoryLink: dbModule.upsertGitHubRepositoryLink,
    messages: schemaModule.messages,
    visibleMessageCondition: visibilityModule.visibleMessageCondition,
    latestMessagesForRooms: listModule.latestMessagesForRooms,
    reconcileMessageLatestTimeRollout: rolloutModule.reconcileMessageLatestTimeRollout,
  };
}

/** Fresh schema from the SQL migrations, then the post-migration index rollout, as `npm run db:migrate` does. */
async function resetDatabase(): Promise<void> {
  const { db, pool, reconcileMessageLatestTimeRollout } = deps();
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder });
  await reconcileMessageLatestTimeRollout(pool, { log: () => {} });
}

async function indexState(): Promise<"valid" | "invalid" | "missing"> {
  const { rows } = await deps().pool.query<{ valid: boolean }>(
    `SELECT pg_index.indisvalid AS valid FROM pg_index
       JOIN pg_class ON pg_class.oid = pg_index.indexrelid
      WHERE pg_class.relname = $1`,
    [TIMESTAMP_INDEX],
  );
  if (!rows[0]) return "missing";
  return rows[0].valid ? "valid" : "invalid";
}

/** The query the room list ran before it walked indexes: the reference result. */
async function previousLatestMessagesForRooms(roomIds: string[]) {
  const { db, messages, visibleMessageCondition } = deps();
  const uniqueRoomIds = [...new Set(roomIds.filter(Boolean))];
  if (!uniqueRoomIds.length) return new Map();
  const rows = await db
    .select({
      room_id: messages.room_id,
      latest_number: sql<number | null>`MAX(${messages.number})::int`,
      latest_message_at: sql<string | null>`MAX(${messages.timestamp})`,
    })
    .from(messages)
    .where(and(inArray(messages.room_id, uniqueRoomIds), visibleMessageCondition()))
    .groupBy(messages.room_id);
  return new Map(rows.map((row) => [
    row.room_id,
    {
      latest_message_id: row.latest_number ? `msg_${row.latest_number}` : null,
      latest_message_at: row.latest_message_at,
    },
  ]));
}

type SeedMessage = {
  number: number;
  text: string;
  agent_prompt_kind?: "join" | "inline" | "auto" | null;
  timestamp: string;
};

async function insertMessages(roomId: string, rows: SeedMessage[]): Promise<void> {
  const { pool } = deps();
  for (const row of rows) {
    await pool.query(
      `INSERT INTO messages (room_id, number, sender, text, agent_prompt_kind, timestamp)
       VALUES ($1, $2, 'seed', $3, $4, $5)`,
      [roomId, row.number, row.text, row.agent_prompt_kind ?? null, row.timestamp]
    );
  }
}

/** Asserts the new answer equals the previous query's answer exactly, and returns it. */
async function assertSameAsPrevious(roomIds: string[]) {
  const { latestMessagesForRooms } = deps();
  const current = await latestMessagesForRooms(roomIds);
  const previous = await previousLatestMessagesForRooms(roomIds);
  assert.deepEqual(
    new Map([...current].sort(([a], [b]) => a.localeCompare(b))),
    new Map([...previous].sort(([a], [b]) => a.localeCompare(b)))
  );
  return current;
}

/** Captures the SQL latestMessagesForRooms sends and returns its EXPLAIN ANALYZE text. */
async function explainLatestMessages(roomIds: string[]): Promise<string> {
  const { pool, latestMessagesForRooms } = deps();
  const captured: Array<{ text: string; values: unknown[] }> = [];
  const originalQuery = pool.query;
  pool.query = function patchedQuery(this: typeof pool, ...args: unknown[]) {
    const [config, values] = args as [string | { text: string; values?: unknown[] }, unknown[] | undefined];
    if (typeof config === "string") captured.push({ text: config, values: values ?? [] });
    else captured.push({ text: config.text, values: values ?? config.values ?? [] });
    return (originalQuery as (...input: unknown[]) => unknown).apply(this, args);
  } as typeof pool.query;
  try {
    await latestMessagesForRooms(roomIds);
  } finally {
    pool.query = originalQuery;
  }
  const messageQueries = captured.filter((entry) => /\bmessages\b/.test(entry.text));
  assert.equal(messageQueries.length, 1, "one query reads messages");
  const [{ text, values }] = messageQueries;
  const plan = await pool.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${text}`, values);
  return plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

if (!requiresDatabase) {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.after(async () => {
    await deps().pool.end();
  });
}

test(
  "latestMessagesForRooms returns the same ids and timestamps as the previous MAX query, with and without the index",
  { skip: requiresDatabase },
  async () => {
    const { pool, createProjectWithName, latestMessagesForRooms } = deps();

    const visible = await createProjectWithName("latest-visible");
    await insertMessages(visible.id, [
      { number: 1, text: "first", timestamp: "2026-11-01T10:00:00.000Z" },
      { number: 2, text: "join prompt", agent_prompt_kind: "join", timestamp: "2026-11-01T10:01:00.000Z" },
      { number: 3, text: "auto with text", agent_prompt_kind: "auto", timestamp: "2026-11-01T10:02:00.123Z" },
    ]);

    const newestHidden = await createProjectWithName("latest-newest-hidden");
    await insertMessages(newestHidden.id, [
      { number: 1, text: "hello", timestamp: "2026-11-02T09:00:00.000Z" },
      { number: 2, text: "still visible", agent_prompt_kind: "inline", timestamp: "2026-11-02T09:05:00.000Z" },
      { number: 3, text: "", agent_prompt_kind: "auto", timestamp: "2026-11-02T09:10:00.000Z" },
      { number: 4, text: "    ", agent_prompt_kind: "auto", timestamp: "2026-11-02T09:15:00.000Z" },
    ]);

    const onlyHidden = await createProjectWithName("latest-only-hidden");
    await insertMessages(onlyHidden.id, [
      { number: 1, text: "", agent_prompt_kind: "auto", timestamp: "2026-11-03T08:00:00.000Z" },
      { number: 2, text: "   ", agent_prompt_kind: "auto", timestamp: "2026-11-03T08:01:00.000Z" },
    ]);

    const empty = await createProjectWithName("latest-empty");

    const blankVisible = await createProjectWithName("latest-blank-not-auto");
    await insertMessages(blankVisible.id, [
      { number: 1, text: "", timestamp: "2026-11-04T07:00:00.000Z" },
    ]);

    const roomIds = [
      visible.id,
      newestHidden.id,
      onlyHidden.id,
      empty.id,
      blankVisible.id,
      "latest-no-such-room",
      "",
      visible.id,
    ];

    assert.equal(await indexState(), "valid");
    const current = await assertSameAsPrevious(roomIds);

    assert.equal(current.size, 3);
    assert.equal(current.get(visible.id)?.latest_message_id, "msg_3");
    assert.equal(current.get(newestHidden.id)?.latest_message_id, "msg_2");
    assert.equal(
      Date.parse(current.get(newestHidden.id)?.latest_message_at ?? ""),
      Date.parse("2026-11-02T09:05:00.000Z")
    );
    assert.equal(current.get(blankVisible.id)?.latest_message_id, "msg_1");
    assert.equal(current.has(onlyHidden.id), false);
    assert.equal(current.has(empty.id), false);
    assert.equal(current.has("latest-no-such-room"), false);
    assert.deepEqual(await latestMessagesForRooms([]), new Map());

    // Before the rollout has built the index (or after a failed build), the
    // answer is the same; Postgres only takes another plan.
    await pool.query(`DROP INDEX ${TIMESTAMP_INDEX}`);
    assert.equal(await indexState(), "missing");
    assert.deepEqual(await latestMessagesForRooms(roomIds), current);
  }
);

test(
  "latestMessagesForRooms returns the true latest time when a higher number has an older timestamp",
  { skip: requiresDatabase },
  async () => {
    const { createProjectWithName } = deps();

    // A clock that stepped back: #2 was written after #1 but carries an earlier time.
    const clockStep = await createProjectWithName("latest-clock-step");
    await insertMessages(clockStep.id, [
      { number: 1, text: "written first", timestamp: "2026-11-05T10:00:00.500Z" },
      { number: 2, text: "written second, clock stepped back", timestamp: "2026-11-05T10:00:00.000Z" },
      { number: 3, text: "", agent_prompt_kind: "auto", timestamp: "2026-11-05T10:30:00.000Z" },
    ]);
    await deps().pool.query("INSERT INTO id_sequences (name, value) VALUES ($1, 3)", [`messages:${clockStep.id}`]);

    // A reused lower number with a newer message.
    const reused = await createProjectWithName("latest-reused-number");
    await insertMessages(reused.id, [
      { number: 1, text: "newer, lower number", timestamp: "2026-11-06T11:00:00.000Z" },
      { number: 2, text: "older, higher number", timestamp: "2026-11-06T10:00:00.000Z" },
    ]);

    const current = await assertSameAsPrevious([clockStep.id, reused.id]);
    assert.equal(current.get(clockStep.id)?.latest_message_id, "msg_2");
    assert.equal(Date.parse(current.get(clockStep.id)?.latest_message_at ?? ""), Date.parse("2026-11-05T10:00:00.500Z"));
    assert.equal(current.get(reused.id)?.latest_message_id, "msg_2");
    assert.equal(Date.parse(current.get(reused.id)?.latest_message_at ?? ""), Date.parse("2026-11-06T11:00:00.000Z"));
  }
);

test(
  "latestMessagesForRooms matches the previous query in a repo room renamed before counters moved",
  { skip: requiresDatabase },
  async () => {
    const {
      pool,
      addMessage,
      createProjectWithName,
      migrateGitHubRepositoryCanonicalRoom,
      upsertGitHubRepositoryLink,
    } = deps();

    const oldRoomId = "github.com/latest-org/old-name";
    const newRoomId = "github.com/latest-org/new-name";
    await createProjectWithName(oldRoomId);
    await upsertGitHubRepositoryLink({
      github_repo_id: "repo-latest-rename",
      room_id: oldRoomId,
      owner_login: "latest-org",
      repo_name: "old-name",
    });

    assert.equal((await addMessage(oldRoomId, "agent", "", { agent_prompt_kind: "auto" })).id, "msg_1");
    const visibleTwo = await addMessage(oldRoomId, "alice", "visible two");
    assert.equal(visibleTwo.id, "msg_2");
    // A new blank auto prompt from the same sender removes the earlier one (#1).
    assert.equal((await addMessage(oldRoomId, "agent", "", { agent_prompt_kind: "auto" })).id, "msg_3");
    const { rows: remaining } = await pool.query(
      "SELECT number FROM messages WHERE room_id = $1 ORDER BY number",
      [oldRoomId]
    );
    assert.deepEqual(remaining.map((row) => row.number), [2, 3]);

    await migrateGitHubRepositoryCanonicalRoom({
      github_repo_id: "repo-latest-rename",
      owner_login: "latest-org",
      repo_name: "new-name",
    });
    // Before #1917 a rename left the counter under the old room id. Put it back
    // there to reproduce a room renamed by that code.
    await pool.query("UPDATE id_sequences SET name = $1 WHERE name = $2", [
      `messages:${oldRoomId}`,
      `messages:${newRoomId}`,
    ]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const newerOne = await addMessage(newRoomId, "alice", "newer visible message");
    assert.equal(newerOne.id, "msg_1", "the renamed room reuses the vacant number 1");
    assert.ok(Date.parse(newerOne.timestamp) > Date.parse(visibleTwo.timestamp));

    const current = await assertSameAsPrevious([newRoomId]);
    assert.equal(current.get(newRoomId)?.latest_message_id, "msg_2");
    assert.equal(Date.parse(current.get(newRoomId)?.latest_message_at ?? ""), Date.parse(newerOne.timestamp));
  }
);

test(
  "latestMessagesForRooms matches the previous query after a pre-#1917 rename A -> B -> A",
  { skip: requiresDatabase },
  async () => {
    const { pool, addMessage, createProjectWithName } = deps();

    const roomA = "github.com/latest-org/round-trip";
    const roomB = "github.com/latest-org/round-trip-renamed";
    await createProjectWithName(roomA);
    assert.equal((await addMessage(roomA, "agent", "", { agent_prompt_kind: "auto" })).id, "msg_1");
    assert.equal((await addMessage(roomA, "alice", "visible two")).id, "msg_2");
    assert.equal((await addMessage(roomA, "agent", "", { agent_prompt_kind: "auto" })).id, "msg_3");
    // Model elapsed time: the old messages are two days old.
    await pool.query(
      "UPDATE messages SET timestamp = now() - INTERVAL '48 hours' WHERE room_id = $1",
      [roomA]
    );

    // The rename before #1917 changed rooms.id (messages follow by cascade)
    // and left every counter under its old name.
    await pool.query("UPDATE rooms SET id = $1 WHERE id = $2", [roomB, roomA]);
    const current = await addMessage(roomB, "alice", "current visible message");
    assert.equal(current.id, "msg_1", "room B reuses the vacant number 1");
    await pool.query("UPDATE rooms SET id = $1 WHERE id = $2", [roomA, roomB]);

    const counters = await pool.query(
      "SELECT name, value FROM id_sequences WHERE name LIKE 'messages:%' ORDER BY name"
    );
    assert.deepEqual(counters.rows, [
      { name: `messages:${roomA}`, value: 3 },
      { name: `messages:${roomB}`, value: 1 },
    ]);

    const latest = await assertSameAsPrevious([roomA]);
    assert.equal(latest.get(roomA)?.latest_message_id, "msg_2");
    assert.equal(Date.parse(latest.get(roomA)?.latest_message_at ?? ""), Date.parse(current.timestamp));
    // The desktop "Needs you" list reads pending board requests only for a
    // room whose latest message is under 24 hours old.
    assert.ok(Date.now() - Date.parse(latest.get(roomA)?.latest_message_at ?? "") < 24 * 60 * 60 * 1000);
  }
);

test(
  "latestMessagesForRooms walks messages_pk and the timestamp index backward instead of reading every message",
  { skip: requiresDatabase },
  async () => {
    const { pool, createProjectWithName, latestMessagesForRooms } = deps();

    const roomIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const room = await createProjectWithName(`latest-plan-${index}`);
      roomIds.push(room.id);
      await pool.query(
        `INSERT INTO messages (room_id, number, sender, text, agent_prompt_kind, timestamp)
         SELECT $1, n, 'seed',
                CASE WHEN n % 7 = 0 THEN '' ELSE 'message ' || n END,
                CASE WHEN n % 7 = 0 THEN 'auto' ELSE NULL END,
                TIMESTAMPTZ '2026-01-01T00:00:00Z' + n * INTERVAL '1 second'
         FROM generate_series(1, 3000) AS n`,
        [room.id]
      );
    }
    await pool.query("ANALYZE messages");

    const latest = await latestMessagesForRooms(roomIds);
    assert.equal(latest.size, 4);
    for (const roomId of roomIds) {
      // Every seventh message is a hidden blank auto prompt; 3000 % 7 = 4, so 3000 is visible.
      assert.equal(latest.get(roomId)?.latest_message_id, "msg_3000");
    }

    const planText = await explainLatestMessages(roomIds);
    assert.match(planText, /Index Scan Backward using messages_pk on messages/, planText);
    assert.match(planText, new RegExp(`Index Scan Backward using ${TIMESTAMP_INDEX} on messages`), planText);
    assert.doesNotMatch(planText, /Seq Scan on messages/, planText);
    assert.doesNotMatch(planText, /Bitmap Heap Scan on messages/, planText);
    assert.doesNotMatch(planText, /Sort/, planText);
  }
);

test(
  "the post-migration rollout builds the timestamp index, skips a valid one and replaces an invalid shell",
  { skip: requiresDatabase },
  async () => {
    const { pool, reconcileMessageLatestTimeRollout } = deps();

    assert.equal(await indexState(), "valid");
    assert.deepEqual(await reconcileMessageLatestTimeRollout(pool), [], "a second run builds nothing");

    await pool.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${TIMESTAMP_INDEX}'::regclass`);
    assert.equal(await indexState(), "invalid");
    assert.deepEqual(await reconcileMessageLatestTimeRollout(pool), [TIMESTAMP_INDEX]);
    assert.equal(await indexState(), "valid");

    await pool.query(`DROP INDEX ${TIMESTAMP_INDEX}`);
    assert.deepEqual(await reconcileMessageLatestTimeRollout(pool), [TIMESTAMP_INDEX]);
    assert.equal(await indexState(), "valid");

    const fs = await import("node:fs");
    for (const file of fs.readdirSync(migrationsFolder).filter((name) => name.endsWith(".sql"))) {
      assert.doesNotMatch(
        fs.readFileSync(path.join(migrationsFolder, file), "utf8"),
        new RegExp(TIMESTAMP_INDEX),
        `${file}: the index is built only by the rollout, outside the migration transaction`,
      );
    }
  }
);

test(
  "when an open write transaction blocks the build, the rollout gives up without failing and a later run builds it",
  { skip: requiresDatabase },
  async () => {
    const { pool, createProjectWithName, reconcileMessageLatestTimeRollout } = deps();

    await pool.query(`DROP INDEX ${TIMESTAMP_INDEX}`);
    const room = await createProjectWithName("latest-held-write");
    const other = await pool.connect();
    const lines: string[] = [];
    try {
      await other.query("BEGIN");
      await other.query(
        `INSERT INTO messages (room_id, number, sender, text, timestamp) VALUES ($1, 1, 'held', 'held', now())`,
        [room.id]
      );
      const built = await reconcileMessageLatestTimeRollout(pool, {
        lockTimeout: "100ms",
        lockRetryDelaysMs: [20],
        log: (line) => lines.push(line),
      });
      assert.deepEqual(built, []);
    } finally {
      await other.query("COMMIT");
      other.release();
    }
    assert.ok(lines.some((line) => /waiting for an older transaction; retry 1/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => new RegExp(`${TIMESTAMP_INDEX} was not built`).test(line)), lines.join("\n"));
    // The drop of the unfinished shell waits for the same transaction, so it
    // may be left invalid; the queries ignore an invalid index.
    assert.notEqual(await indexState(), "valid");
    assert.deepEqual(await deps().latestMessagesForRooms([room.id]), await previousLatestMessagesForRooms([room.id]));

    assert.deepEqual(await reconcileMessageLatestTimeRollout(pool, { log: () => {} }), [TIMESTAMP_INDEX]);
    assert.equal(await indexState(), "valid");
  }
);
