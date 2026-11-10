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

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

function deps() {
  assert.ok(dbClientModule && dbModule && schemaModule && visibilityModule && listModule);
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
  };
}

async function resetDatabase(): Promise<void> {
  const { db, pool } = deps();
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder });
}

/** The query the room list ran before it walked messages_pk: the reference result. */
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

/** Sets the room's message counter, as nextRoomScopedNumber keeps it; null removes it. */
async function setMessageCounter(roomId: string, value: number | null): Promise<void> {
  const { pool } = deps();
  await pool.query("DELETE FROM id_sequences WHERE name = $1", [`messages:${roomId}`]);
  if (value !== null) {
    await pool.query("INSERT INTO id_sequences (name, value) VALUES ($1, $2)", [`messages:${roomId}`, value]);
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

if (!requiresDatabase) {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.after(async () => {
    await deps().pool.end();
  });
}

test(
  "latestMessagesForRooms returns the same ids and timestamps as the previous MAX query",
  { skip: requiresDatabase },
  async () => {
    const { createProjectWithName, latestMessagesForRooms } = deps();

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

    // No counters: every room takes the exact MAX(timestamp) path.
    await assertSameAsPrevious(roomIds);

    // Counters at the top number, as the writer leaves them: the fast path.
    await setMessageCounter(visible.id, 3);
    await setMessageCounter(newestHidden.id, 4);
    await setMessageCounter(onlyHidden.id, 2);
    await setMessageCounter(blankVisible.id, 1);
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
  }
);

test(
  "latestMessagesForRooms keeps MAX(timestamp) when a lower number holds a newer message",
  { skip: requiresDatabase },
  async () => {
    const { createProjectWithName } = deps();

    // #1 arrived after #2 (a vacant number handed out again); the counter is behind.
    const behind = await createProjectWithName("latest-counter-behind");
    await insertMessages(behind.id, [
      { number: 1, text: "newer, lower number", timestamp: "2026-11-05T11:00:00.000Z" },
      { number: 2, text: "older, higher number", timestamp: "2026-11-05T10:00:00.000Z" },
      { number: 3, text: "", agent_prompt_kind: "auto", timestamp: "2026-11-05T10:30:00.000Z" },
    ]);
    await setMessageCounter(behind.id, 1);

    // The same rows with no counter row at all.
    const missing = await createProjectWithName("latest-counter-missing");
    await insertMessages(missing.id, [
      { number: 1, text: "newer, lower number", timestamp: "2026-11-06T11:00:00.000Z" },
      { number: 2, text: "older, higher number", timestamp: "2026-11-06T10:00:00.000Z" },
    ]);

    const current = await assertSameAsPrevious([behind.id, missing.id]);
    assert.equal(current.get(behind.id)?.latest_message_id, "msg_2");
    assert.equal(Date.parse(current.get(behind.id)?.latest_message_at ?? ""), Date.parse("2026-11-05T11:00:00.000Z"));
    assert.equal(current.get(missing.id)?.latest_message_id, "msg_2");
    assert.equal(Date.parse(current.get(missing.id)?.latest_message_at ?? ""), Date.parse("2026-11-06T11:00:00.000Z"));
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
  "latestMessagesForRooms walks messages_pk backward per room instead of reading every message",
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
      await setMessageCounter(room.id, 3000);
    }
    await pool.query("ANALYZE messages");
    await pool.query("ANALYZE id_sequences");

    // Capture the SQL that latestMessagesForRooms sends, then ask Postgres for its plan.
    const captured: Array<{ text: string; values: unknown[] }> = [];
    const originalQuery = pool.query;
    pool.query = function patchedQuery(this: typeof pool, ...args: unknown[]) {
      const [config, values] = args as [string | { text: string; values?: unknown[] }, unknown[] | undefined];
      if (typeof config === "string") captured.push({ text: config, values: values ?? [] });
      else captured.push({ text: config.text, values: values ?? config.values ?? [] });
      return (originalQuery as (...input: unknown[]) => unknown).apply(this, args);
    } as typeof pool.query;
    let latest;
    try {
      latest = await latestMessagesForRooms(roomIds);
    } finally {
      pool.query = originalQuery;
    }

    assert.equal(latest.size, 4);
    for (const roomId of roomIds) {
      // Every seventh message is a hidden blank auto prompt; 3000 % 7 = 4, so 3000 is visible.
      assert.equal(latest.get(roomId)?.latest_message_id, "msg_3000");
    }

    const messageQueries = captured.filter((entry) => /\bmessages\b/.test(entry.text));
    assert.equal(messageQueries.length, 1, "one query reads messages");
    const [{ text, values }] = messageQueries;
    const plan = await pool.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${text}`, values);
    const planText = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");

    assert.match(planText, /Index Scan Backward using messages_pk on messages/, planText);
    assert.match(planText, /Limit/, planText);
    assert.doesNotMatch(planText, /Seq Scan on messages/, planText);
    // With healthy counters every read of messages that runs is a backward walk
    // of messages_pk; the exact MAX(timestamp) fallback never runs.
    const messageReads = planText.split("\n").filter((line) => / on messages\b/.test(line));
    assert.ok(messageReads.length > 0, planText);
    for (const line of messageReads) {
      assert.ok(
        /Backward using messages_pk on messages/.test(line) || /\(never executed\)/.test(line),
        `unexpected read of messages:\n${line}\n\n${planText}`
      );
    }
  }
);
