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
    createProjectWithName: dbModule.createProjectWithName,
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

    const current = await latestMessagesForRooms(roomIds);
    const previous = await previousLatestMessagesForRooms(roomIds);

    assert.deepEqual(
      new Map([...current].sort(([a], [b]) => a.localeCompare(b))),
      new Map([...previous].sort(([a], [b]) => a.localeCompare(b)))
    );

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
    }
    await pool.query("ANALYZE messages");

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
    const plan = await pool.query(`EXPLAIN ${text}`, values);
    const planText = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");

    assert.match(planText, /Index Scan Backward using messages_pk on messages/, planText);
    assert.match(planText, /Limit/, planText);
    assert.doesNotMatch(planText, /Seq Scan on messages/, planText);
    assert.doesNotMatch(planText, /Bitmap Heap Scan on messages/, planText);
  }
);
