// Thread-inbox parity suite — Postgres engine (Phase B / PR 4, part 2).
//
// This is the Postgres half of the parity safety net. It asserts the SAME
// golden expectations as the desktop-SQLite spec
// (apps/desktop/electron/__tests__/thread-inbox-parity-sqlite.test.ts), so the
// two engines are provably in parity and the PR-5 SQL-aggregate rewrite of
// getMessageThreads can be proven behaviour-preserving.
//
// KEEP IN SYNC with thread-inbox-parity-sqlite.test.ts: the scenarios and
// expected values below are the shared contract. If you change one engine's
// expectations, change the other (or the parity guarantee is void).
//
// Runs only when TEST_DB_URL is set (CI's integration-tests job provisions a
// Postgres service). Skips cleanly otherwise — importing the db client without
// DB_URL throws, so all db imports are gated behind the TEST_DB_URL check.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const addMessage = dbModule?.addMessage;
const createProjectWithName = dbModule?.createProjectWithName;
const upsertAccount = dbModule?.upsertAccount;
const getMessageThread = dbModule?.getMessageThread;
const getMessageThreads = dbModule?.getMessageThreads;
const markMessageThreadRead = dbModule?.markMessageThreadRead;

async function resetDatabase(): Promise<void> {
  if (!db || !pool) {
    throw new Error("DB-backed thread-inbox parity tests require TEST_DB_URL");
  }
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

test.beforeEach(async () => {
  if (!requiresDatabase) {
    await resetDatabase();
  }
});

if (!requiresDatabase) {
  test.after(async () => {
    await pool?.end();
  });
}

const runOptions = {
  concurrency: false,
  skip: requiresDatabase ? "set TEST_DB_URL to run the Postgres thread-inbox parity suite" : false,
};

let accountSeq = 0;
async function newReader(): Promise<string> {
  if (!upsertAccount) throw new Error("requires TEST_DB_URL");
  accountSeq += 1;
  const account = await upsertAccount({
    provider: "test",
    provider_user_id: `parity-reader-${accountSeq}`,
    login: `parity-reader-${accountSeq}`,
  });
  return account.id;
}

/**
 * Mirror of the SQLite spec's seedRoom, creation order fixes ascending numbers:
 *   rootA + replyA1 + replyA2            -> thread A (2 replies)
 *   rootB + replyB1(empty text, visible) -> thread B (1 reply)
 *   promptOnly (auto, empty, no thread)  -> excluded everywhere
 *   loner (no replies)                   -> not a thread
 */
async function seedRoom(roomId: string) {
  if (!addMessage) throw new Error("requires TEST_DB_URL");
  const rootA = await addMessage(roomId, "Human", "root A", { source: "browser" });
  const replyA1 = await addMessage(roomId, "Agent", "A reply 1", {
    source: "agent", reply_to_message_id: rootA.id, thread_root_message_id: rootA.id,
  });
  const replyA2 = await addMessage(roomId, "Agent", "A reply 2", {
    source: "agent", reply_to_message_id: replyA1.id, thread_root_message_id: rootA.id,
  });
  const rootB = await addMessage(roomId, "Human", "root B", { source: "browser" });
  // Empty text but NOT an auto prompt -> visible (the empty-text-visible case the
  // task_1 P0 fix restored; visible because agent_prompt_kind is null).
  const replyB1 = await addMessage(roomId, "Agent", "", {
    source: "agent", reply_to_message_id: rootB.id, thread_root_message_id: rootB.id,
  });
  const promptOnly = await addMessage(roomId, "Agent", "", {
    source: "agent", agent_prompt_kind: "auto",
  });
  const loner = await addMessage(roomId, "Human", "no replies here", { source: "browser" });
  return { rootA, replyA1, replyA2, rootB, replyB1, promptOnly, loner };
}

test("PG thread inbox: ordering, reply counts, prompt-only exclusion, unread count", runOptions, async () => {
  const room = await createProjectWithName!("parity_all");
  const reader = await newReader();
  const s = await seedRoom(room.id);

  const page = await getMessageThreads!(room.id, { account_id: reader });

  assert.deepEqual(page.threads.map((t) => t.root.id), [s.rootB.id, s.rootA.id]);
  assert.equal(page.has_more, false);

  const byRoot = new Map(page.threads.map((t) => [t.root.id, t.summary]));
  assert.equal(byRoot.get(s.rootA.id)?.reply_count, 2);
  assert.equal(byRoot.get(s.rootB.id)?.reply_count, 1);
  assert.equal(byRoot.get(s.rootA.id)?.unread_count, 2);
  assert.equal(byRoot.get(s.rootB.id)?.unread_count, 1);
  assert.equal(page.unread_thread_count, 2);
});

test("PG thread inbox: reader-scoped unread at none / partial / latest", runOptions, async () => {
  const room = await createProjectWithName!("parity_reads");
  const reader = await newReader();
  const s = await seedRoom(room.id);

  let thread = await getMessageThread!(room.id, s.rootA.id, { account_id: reader });
  assert.equal(thread?.summary.unread_count, 2);
  assert.equal(thread?.summary.last_read_message_id, null);

  await markMessageThreadRead!(room.id, s.rootA.id, reader, { message_id: s.replyA1.id });
  thread = await getMessageThread!(room.id, s.rootA.id, { account_id: reader });
  assert.equal(thread?.summary.unread_count, 1);
  assert.equal(thread?.summary.last_read_message_id, s.replyA1.id);

  await markMessageThreadRead!(room.id, s.rootA.id, reader, { message_id: s.replyA2.id });
  thread = await getMessageThread!(room.id, s.rootA.id, { account_id: reader });
  assert.equal(thread?.summary.unread_count, 0);
  assert.equal(thread?.summary.has_unread, false);

  // A different reader is unaffected (reads are per-account).
  const other = await newReader();
  const otherThread = await getMessageThread!(room.id, s.rootA.id, { account_id: other });
  assert.equal(otherThread?.summary.unread_count, 2);
});

test("PG thread inbox: unread filter and global-vs-page unread_thread_count", runOptions, async () => {
  const room = await createProjectWithName!("parity_filter");
  const reader = await newReader();
  const s = await seedRoom(room.id);

  await markMessageThreadRead!(room.id, s.rootB.id, reader, { message_id: s.replyB1.id });

  const unread = await getMessageThreads!(room.id, { filter: "unread", account_id: reader });
  assert.deepEqual(unread.threads.map((t) => t.root.id), [s.rootA.id]);
  assert.equal(unread.unread_thread_count, 1);

  const all = await getMessageThreads!(room.id, { filter: "all", account_id: reader });
  assert.deepEqual(all.threads.map((t) => t.root.id), [s.rootB.id, s.rootA.id]);
  assert.equal(all.unread_thread_count, 1);
});

test("PG thread inbox: prompt-only (auto/empty) replies are excluded from thread aggregation", runOptions, async () => {
  const room = await createProjectWithName!("parity_promptonly_reply");
  const reader = await newReader();
  const rootC = await addMessage!(room.id, "Human", "root C", { source: "browser" });
  const visibleReply = await addMessage!(room.id, "Agent", "real reply", {
    source: "agent", reply_to_message_id: rootC.id, thread_root_message_id: rootC.id,
  });
  await addMessage!(room.id, "Agent", "", {
    source: "agent", agent_prompt_kind: "auto",
    reply_to_message_id: visibleReply.id, thread_root_message_id: rootC.id,
  });

  const thread = await getMessageThread!(room.id, rootC.id, { account_id: reader });
  assert.equal(thread?.summary.reply_count, 1);
  assert.equal(thread?.summary.latest_reply?.id, visibleReply.id);
  assert.equal(thread?.summary.unread_count, 1);

  const rootD = await addMessage!(room.id, "Human", "root D", { source: "browser" });
  await addMessage!(room.id, "Agent", "", {
    source: "agent", agent_prompt_kind: "auto",
    reply_to_message_id: rootD.id, thread_root_message_id: rootD.id,
  });
  const page = await getMessageThreads!(room.id, { account_id: reader });
  assert.deepEqual(page.threads.map((t) => t.root.id), [rootC.id]);
});

test("PG thread inbox: participant aggregation (dedup, counts, latest-first)", runOptions, async () => {
  const room = await createProjectWithName!("parity_participants");
  const reader = await newReader();
  const s = await seedRoom(room.id);

  const thread = await getMessageThread!(room.id, s.rootA.id, { account_id: reader });
  const participants = thread?.summary.participants ?? [];
  assert.deepEqual(
    participants.map((p) => ({ sender: p.sender, source: p.source, count: p.message_count })),
    [
      { sender: "Agent", source: "agent", count: 2 },
      { sender: "Human", source: "browser", count: 1 },
    ],
  );
  assert.equal(participants[0]?.latest_message_id, s.replyA2.id);
  assert.equal(participants[1]?.latest_message_id, s.rootA.id);
});

test("PG thread inbox: a reply id resolves to its thread root for read + fetch", runOptions, async () => {
  const room = await createProjectWithName!("parity_root_resolution");
  const reader = await newReader();
  const s = await seedRoom(room.id);

  const viaReply = await getMessageThread!(room.id, s.replyA1.id, { account_id: reader });
  assert.equal(viaReply?.root.id, s.rootA.id);
  assert.equal(viaReply?.summary.reply_count, 2);

  await markMessageThreadRead!(room.id, s.replyA1.id, reader, { message_id: s.replyA2.id });
  const afterRead = await getMessageThread!(room.id, s.rootA.id, { account_id: reader });
  assert.equal(afterRead?.summary.unread_count, 0);
});

test("PG thread inbox: cursor pagination across a page boundary", runOptions, async () => {
  const room = await createProjectWithName!("parity_cursor");
  const reader = await newReader();
  const s = await seedRoom(room.id);

  const first = await getMessageThreads!(room.id, { limit: 1, account_id: reader });
  assert.deepEqual(first.threads.map((t) => t.root.id), [s.rootB.id]);
  assert.equal(first.has_more, true);

  const cursor = first.threads[0]?.summary.latest_reply?.id ?? null;
  assert.ok(cursor, "expected a latest_reply cursor");
  const second = await getMessageThreads!(room.id, { limit: 1, before: cursor!, account_id: reader });
  assert.deepEqual(second.threads.map((t) => t.root.id), [s.rootA.id]);
  assert.equal(second.has_more, false);
});

// Perf/scale baseline: ~2,000 threaded messages. Records elapsed time and the
// pool query count for a single bounded getMessageThreads page. This is the
// before/after evidence for PR 5's O(room)->bounded claim; today the query
// hydrates every reply of every thread, so this establishes the current cost.
test("PG thread inbox: bounded page over a ~2,000-message room (perf baseline)", runOptions, async () => {
  const room = await createProjectWithName!("parity_perf");
  const reader = await newReader();

  const threadCount = 200;
  const repliesPerThread = 9; // 200 * (1 root + 9 replies) = 2,000 messages
  for (let t = 0; t < threadCount; t += 1) {
    const root = await addMessage!(room.id, "Human", `root ${t}`, { source: "browser" });
    let prev = root.id;
    for (let r = 0; r < repliesPerThread; r += 1) {
      const reply = await addMessage!(room.id, "Agent", `reply ${t}.${r}`, {
        source: "agent", reply_to_message_id: prev, thread_root_message_id: root.id,
      });
      prev = reply.id;
    }
  }

  const limit = 50;
  let queryCount = 0;
  const originalQuery = pool!.query.bind(pool!);
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    queryCount += 1;
    return (originalQuery as (...a: unknown[]) => unknown)(...args);
  };
  const startedAt = Date.now();
  let page;
  try {
    page = await getMessageThreads!(room.id, { limit, account_id: reader });
  } finally {
    (pool as unknown as { query: unknown }).query = originalQuery;
  }
  const elapsedMs = Date.now() - startedAt;

  // The returned page must be bounded to the requested limit regardless of room size.
  assert.equal(page.threads.length, limit);
  assert.equal(page.has_more, true);
  assert.equal(page.unread_thread_count, threadCount);
  assert.ok(queryCount > 0, "expected at least one pool query");
  // eslint-disable-next-line no-console
  console.log(`[perf] getMessageThreads over ${threadCount * (repliesPerThread + 1)} messages: ${elapsedMs}ms, ${queryCount} pool queries`);
});
