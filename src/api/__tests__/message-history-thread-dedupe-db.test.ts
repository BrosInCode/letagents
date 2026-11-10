// History page thread summaries: the classic page stays exactly as before, the
// opt-in `thread_summaries=deduped` page expands back to it through the
// desktop's expander, and one page hydrates in fewer sequential round trips.
//
// Runs only when TEST_DB_URL is set. Each run drops and re-creates `public`.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { and, asc, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import express from "express";

const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;

const clientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;
const schema = testDatabaseUrl ? await import("../db/schema.js") : null;
const mappers = testDatabaseUrl ? await import("../db/mappers.js") : null;
const selections = testDatabaseUrl ? await import("../db/messages/selections.js") : null;
const routingModule = testDatabaseUrl ? await import("../db/messages/account-agent-routing.js") : null;
const reactionsModule = testDatabaseUrl ? await import("../db/messages/reactions.js") : null;
const summariesModule = testDatabaseUrl ? await import("../db/messages/history/thread-summaries.js") : null;
const historyModule = testDatabaseUrl ? await import("../db/messages/history/message-history.js") : null;
const routesModule = testDatabaseUrl ? await import("../routes/rooms/messages/history.js") : null;
const desktopMappers = await import("../../../apps/desktop/electron/main/rooms/messages/mappers.js");

const options = { skip: testDatabaseUrl ? false : "Set TEST_DB_URL to run PostgreSQL integration tests." };

type Executor = NonNullable<Parameters<NonNullable<typeof historyModule>["hydrateMessageReplies"]>[2]>["executor"];
type HydrationOptions = NonNullable<Parameters<NonNullable<typeof historyModule>["hydrateMessageReplies"]>[2]>;
type Row = Parameters<NonNullable<typeof historyModule>["hydrateMessageReplies"]>[1][number];

/**
 * The hydrator as it was on staging (e88e9c04f), kept verbatim apart from the
 * module handles: the parity oracle for the classic page.
 */
async function legacyHydrateMessageReplies(roomId: string, bounded: Row[], hydration?: HydrationOptions) {
  const { messages, message_attachments, accounts } = schema!;
  const { toMessageAttachment, toMessageReplyReference, toMessageWithReply } = mappers!;
  const { messageAttachmentSelection, messageReplySelection } = selections!;
  const { buildEmptyThreadSummariesForRoots, buildThreadSummariesForRoots } = summariesModule!;
  const executor = hydration?.executor ?? clientModule!.db;
  const accountRoutingPromise = hydration?.accountId && hydration.accountAgentRouting
    ? routingModule!.getMessageAccountAgentRouting(executor, roomId, hydration.accountId, bounded)
    : Promise.resolve(new Map());
  const replyToNumbers = Array.from(new Set(
    bounded.map((row) => row.reply_to_number).filter((value): value is number => value !== null),
  ));
  const replyMap = new Map();
  if (replyToNumbers.length > 0) {
    const replyRows = await executor
      .select(messageReplySelection)
      .from(messages)
      .where(and(eq(messages.room_id, roomId), inArray(messages.number, replyToNumbers)));
    for (const replyRow of replyRows) replyMap.set(replyRow.number, toMessageReplyReference(replyRow));
  }
  const messageNumbers = bounded.map((row) => row.number);
  const attachmentMap = new Map();
  if (messageNumbers.length > 0) {
    const attachmentRows = await executor
      .select(messageAttachmentSelection)
      .from(message_attachments)
      .where(and(eq(message_attachments.room_id, roomId), inArray(message_attachments.message_number, messageNumbers)))
      .orderBy(asc(message_attachments.message_number), asc(message_attachments.attachment_number));
    for (const attachmentRow of attachmentRows) {
      const list = attachmentMap.get(attachmentRow.message_number) ?? [];
      list.push(toMessageAttachment(attachmentRow));
      attachmentMap.set(attachmentRow.message_number, list);
    }
  }
  const { reactions: reactionMap } = await reactionsModule!.loadMessageReactions(executor, roomId, { numbers: messageNumbers });
  const materializedSummaries = hydration?.threadSummaries ?? await buildThreadSummariesForRoots(
    roomId,
    Array.from(new Set(bounded.map((row) => row.thread_root_number ?? row.number))),
    hydration?.accountId ?? null,
    executor,
  );
  const threadSummaries = new Map(materializedSummaries);
  const missingThreadRootNumbers = Array.from(new Set(
    bounded.filter((row) => row.thread_root_number !== null).map((row) => row.thread_root_number!)
      .filter((rootNumber) => !threadSummaries.has(rootNumber)),
  ));
  if (missingThreadRootNumbers.length > 0) {
    const emptySummaries = await buildEmptyThreadSummariesForRoots(
      roomId, missingThreadRootNumbers, hydration?.accountId ?? null, executor,
    );
    for (const [rootNumber, summary] of emptySummaries) threadSummaries.set(rootNumber, summary);
  }
  const publisherIds = [...new Set(bounded.filter((row) => row.source === "browser" && !row.publisher_agent_key)
    .map((row) => row.publisher_account_id).filter((id): id is string => Boolean(id)))];
  const profiles = publisherIds.length ? await executor.select({ id: accounts.id, login: accounts.login, avatar_url: accounts.avatar_url })
    .from(accounts).where(inArray(accounts.id, publisherIds)) : [];
  const profileById = new Map(profiles.map(({ id, login, avatar_url }) => [id, { login, avatar_url }]));
  const accountRouting = await accountRoutingPromise;
  return bounded.map((row) => {
    const threadRootNumber = row.thread_root_number ?? row.number;
    const threadSummary = threadSummaries.get(threadRootNumber) ?? null;
    const message = toMessageWithReply(
      row,
      row.reply_to_number ? replyMap.get(row.reply_to_number) ?? null : null,
      attachmentMap.get(row.number) ?? [],
      threadSummary && (threadSummary.reply_count > 0 || row.thread_root_number) ? threadSummary : null,
      reactionMap.get(row.number) ?? [],
    );
    if (row.source === "browser" && !row.publisher_agent_key) {
      message.sender_profile = profileById.get(row.publisher_account_id ?? "") ?? null;
    }
    return hydration?.accountId && hydration.accountAgentRouting
      ? { ...message, account_agent_routing: accountRouting.get(row.number) ?? null }
      : message;
  });
}

/**
 * A seam over the query executor. Each query is held for a few milliseconds so
 * overlapping reads really overlap; a "wave" starts when a query begins while
 * no other query is in flight, which counts the sequential round trips.
 */
function countingExecutor(base: NonNullable<Executor>) {
  const stats = { queries: 0, waves: 0, inFlight: 0, maxInFlight: 0 };
  const track = <T>(run: () => PromiseLike<T>): Promise<T> => {
    stats.queries += 1;
    if (stats.inFlight === 0) stats.waves += 1;
    stats.inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    return Promise.resolve(run())
      .then((value) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 5)))
      .finally(() => { stats.inFlight -= 1; });
  };
  const wrap = (target: any): any => new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (property === "then" && typeof value === "function") {
        return (onFulfilled?: any, onRejected?: any) =>
          track(() => ({ then: (resolve: any, reject: any) => value.call(object, resolve, reject) }))
            .then(onFulfilled, onRejected);
      }
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = value.apply(object, args);
        return result && typeof result === "object" && result !== object ? wrap(result) : result === object ? wrap(object) : result;
      };
    },
  });
  const executor = {
    select: (...args: unknown[]) => wrap((base.select as any)(...args)),
    execute: (query: unknown) => track(() => (base.execute as any)(query)),
  } as unknown as NonNullable<Executor>;
  return { executor, stats };
}

let fixture: {
  roomId: string;
  readerId: string;
  rows: Row[];
  ids: Record<string, string>;
  project: any;
} | null = null;

async function seed() {
  if (fixture) return fixture;
  const { db, pool } = clientModule!;
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });

  const { addMessage, createProjectWithName, upsertAccount, markMessageThreadRead } = dbModule!;
  const reader = await upsertAccount({ provider: "github", provider_user_id: "dedupe-reader", login: "dedupe-reader", display_name: "Reader" });
  const room = await createProjectWithName("thread-dedupe-room");
  const ids: Record<string, string> = {};
  // A thread whose root falls outside the page window.
  ids.outsideRoot = (await addMessage(room.id, "Ada", "Old root outside the page")).id;
  ids.outsideReplyEarly = (await addMessage(room.id, "Bo", "Early reply", {
    reply_to_message_id: ids.outsideRoot, thread_root_message_id: ids.outsideRoot,
  })).id;
  ids.filler = (await addMessage(room.id, "Cy", "Filler that the page cuts off")).id;
  // Page window starts here.
  ids.rootA = (await addMessage(room.id, "Ada", "Root A ".repeat(40), { source: "browser", account_id: reader.id })).id;
  ids.replyA1 = (await addMessage(room.id, "Bo", "Reply A1 ".repeat(30), {
    reply_to_message_id: ids.rootA, thread_root_message_id: ids.rootA,
  })).id;
  ids.replyA2 = (await addMessage(room.id, "Cy", "Quoted reply A2", {
    reply_to_message_id: ids.replyA1, thread_root_message_id: ids.rootA,
  })).id;
  ids.plain = (await addMessage(room.id, "Ada", "Plain message with a reaction and a file")).id;
  ids.rootB = (await addMessage(room.id, "Bo", "Root B without replies")).id;
  ids.outsideReplyLate = (await addMessage(room.id, "Cy", "Late reply to the old root", {
    reply_to_message_id: ids.outsideRoot, thread_root_message_id: ids.outsideRoot,
  })).id;
  ids.rootC = (await addMessage(room.id, "Ada", "Root C, summary row removed")).id;
  ids.replyC = (await addMessage(room.id, "Bo", "Reply C", {
    reply_to_message_id: ids.rootC, thread_root_message_id: ids.rootC,
  })).id;
  ids.quotePlain = (await addMessage(room.id, "Cy", "Quotes the plain message", {
    reply_to_message_id: ids.plain,
  })).id;

  const number = (id: string) => Number(id.slice(4));
  await reactionsModule!.addMessageReaction({ roomId: room.id, messageNumber: number(ids.plain), accountId: reader.id, emoji: "👍" });
  await reactionsModule!.addMessageReaction({ roomId: room.id, messageNumber: number(ids.replyA1), accountId: reader.id, emoji: "🎉" });
  const upload = "upl_dedupe_1";
  await pool.query(`INSERT INTO message_attachment_uploads (upload_id, room_id, filename, content_type, byte_size,
      storage_provider, bucket, object_key, status, expires_at, attached_message_number, created_at, attached_at)
    VALUES ($1, $2, 'notes.txt', 'text/plain', 12, 's3', 'letagents-test', 'rooms/x/notes.txt', 'attached', now() + interval '1 hour', $3, now(), now())`,
  [upload, room.id, number(ids.plain)]);
  await pool.query(`INSERT INTO message_attachments (room_id, message_number, attachment_number, upload_id, filename,
      content_type, byte_size, storage_provider, bucket, object_key, created_at)
    VALUES ($1, $2, 1, $3, 'notes.txt', 'text/plain', 12, 's3', 'letagents-test', 'rooms/x/notes.txt', now())`,
  [room.id, number(ids.plain), upload]);
  await markMessageThreadRead(room.id, ids.rootA, reader.id, { message_id: ids.replyA1 });
  // Force the empty-summary branch for thread C.
  await pool.query("DELETE FROM message_thread_summaries WHERE room_id = $1 AND thread_root_number = $2",
    [room.id, number(ids.rootC)]);

  const rows = await db.select(selections!.messageRowSelection).from(schema!.messages)
    .where(eq(schema!.messages.room_id, room.id)).orderBy(asc(schema!.messages.number));
  const project = (await pool.query("SELECT * FROM rooms WHERE id = $1", [room.id])).rows[0];
  fixture = { roomId: room.id, readerId: reader.id, rows, ids, project };
  return fixture;
}

test.after(async () => { await clientModule?.pool.end(); });

test("classic hydration equals the staging hydrator for roots, replies, quotes, reactions and attachments", options, async () => {
  const { roomId, readerId, rows } = await seed();
  for (const hydration of [
    undefined,
    { accountId: readerId },
    { accountId: readerId, accountAgentRouting: true },
  ] as HydrationOptions[]) {
    const expected = await legacyHydrateMessageReplies(roomId, rows, hydration);
    const actual = await historyModule!.hydrateMessageReplies(roomId, rows, hydration);
    assert.deepEqual(actual, expected);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), "same bytes, same key order");
    const window = rows.slice(3);
    assert.deepEqual(
      await historyModule!.hydrateMessageReplies(roomId, window, hydration),
      await legacyHydrateMessageReplies(roomId, window, hydration),
    );
  }
  const hydrated = await historyModule!.hydrateMessageReplies(roomId, rows, { accountId: readerId });
  assert.ok(hydrated.some((message) => message.attachments.length > 0), "fixture has an attachment");
  assert.ok(hydrated.some((message) => message.reactions.length > 0), "fixture has a reaction");
  assert.ok(hydrated.some((message) => message.thread?.latest_reply === null && message.thread_root_id), "fixture has an empty summary");
  assert.ok(hydrated.some((message) => message.sender_profile), "fixture has a sender profile");
});

test("thread pages still hydrate exactly as the staging hydrator does", options, async () => {
  const { roomId, readerId, rows, ids } = await seed();
  const page = await dbModule!.getMessageThread(roomId, ids.rootA, { account_id: readerId, account_agent_routing: true } as any);
  assert.ok(page);
  const rootNumber = Number(ids.rootA.slice(4));
  const threadRows = rows.filter((row) => row.number === rootNumber || row.thread_root_number === rootNumber);
  const expected = await legacyHydrateMessageReplies(roomId, threadRows, {
    accountId: readerId,
    accountAgentRouting: true,
    threadSummaries: new Map([[rootNumber, page.summary]]),
  });
  assert.deepEqual([page.root, ...page.replies], expected);

  const inbox = await dbModule!.getMessageThreads(roomId, { account_id: readerId, account_agent_routing: true, filter: "all" } as any);
  const summaries = new Map(inbox.threads.map((item: any) => [Number(item.root.id.slice(4)), item.summary]));
  const rootRows = inbox.threads.map((item: any) => rows.find((row) => row.number === Number(item.root.id.slice(4)))!);
  assert.deepEqual(
    inbox.threads.map((item: any) => item.root),
    await legacyHydrateMessageReplies(roomId, rootRows, { accountId: readerId, accountAgentRouting: true, threadSummaries: summaries }),
  );
});

test("a history page hydrates in fewer sequential round trips with equal results", options, async (t) => {
  const { roomId, readerId, rows } = await seed();
  const hydration = { accountId: readerId, accountAgentRouting: true };
  const legacy = countingExecutor(clientModule!.db);
  const current = countingExecutor(clientModule!.db);
  const expected = await legacyHydrateMessageReplies(roomId, rows, { ...hydration, executor: legacy.executor });
  const actual = await historyModule!.hydrateMessageReplies(roomId, rows, { ...hydration, executor: current.executor });
  assert.deepEqual(actual, expected);
  t.diagnostic(`staging: ${JSON.stringify(legacy.stats)}; this branch: ${JSON.stringify(current.stats)}`);
  assert.equal(current.stats.queries, legacy.stats.queries, "the same reads, only reordered");
  assert.ok(legacy.stats.waves >= 6, `staging hydrator waves: ${legacy.stats.waves}`);
  assert.ok(current.stats.waves <= 4, `hydrator waves: ${current.stats.waves} (staging ${legacy.stats.waves})`);
  assert.ok(current.stats.maxInFlight <= 8, `fan-out stays small: ${current.stats.maxInFlight}`);
});

async function withHistoryServer<T>(run: (get: (query: string) => Promise<any>) => Promise<T>): Promise<T> {
  const { roomId, readerId, project } = await seed();
  const app = express();
  app.use((req: any, _res, next) => {
    req.authKind = "session";
    req.sessionAccount = { account_id: readerId, login: "dedupe-reader" };
    next();
  });
  routesModule!.registerMessageHistoryRoutes(app, {
    resolveCanonicalRoomRequestId: async (id: string) => id,
    resolveRoomOrReply: async () => project,
    requireParticipant: async () => true,
    shouldIncludePromptOnlyMessages: () => false,
  } as any);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(async (query) => {
      const response = await fetch(`http://127.0.0.1:${port}/rooms/${encodeURIComponent(roomId)}/messages?${query}`);
      assert.equal(response.status, 200);
      return response.json();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the deduped page carries each summary once and expands back to the classic page", options, async () => {
  const { ids } = await seed();
  await withHistoryServer(async (get) => {
    for (const cursor of ["before=latest&limit=8", `before=${ids.quotePlain}&limit=150`, "limit=150", `after=${ids.filler}&limit=150`]) {
      const classic = await get(cursor);
      const compact = await get(`${cursor}&thread_summaries=deduped`);
      assert.equal(classic.thread_summaries, undefined, "classic page is unchanged without the opt-in");
      assert.equal(classic.threads, undefined);
      assert.equal(compact.thread_summaries, "deduped");
      const keyed = Object.keys(compact.threads);
      assert.equal(new Set(keyed).size, keyed.length);
      for (const message of compact.messages) {
        assert.ok(message.thread === null || typeof message.thread === "string", "no inline copy for a keyed thread");
      }
      assert.deepEqual(desktopMappers.expandRoomMessageHistoryPage(compact), classic, cursor);
      assert.ok(JSON.stringify(compact).length < JSON.stringify(classic).length);
    }
    const other = await get("before=latest&limit=8&thread_summaries=full");
    assert.equal(other.thread_summaries, undefined, "an unknown value keeps the classic page");
  });
});

test("dedupeThreadSummaries keeps a differing summary inline", options, () => {
  const summary = (replyCount: number) => ({
    root_message_id: "msg_1", reply_count: replyCount, unread_count: 0, has_unread: false,
    latest_reply: null, participants: [], participant_count: 0, participants_truncated: false, last_read_message_id: null,
  });
  const input = [
    { id: "msg_1", thread: summary(2) },
    { id: "msg_2", thread: summary(3) },
    { id: "msg_3", thread: null },
  ];
  const result = summariesModule!.dedupeThreadSummaries(input);
  assert.deepEqual(result.threads, { msg_1: summary(2) });
  assert.deepEqual(result.messages, [
    { id: "msg_1", thread: "msg_1" },
    { id: "msg_2", thread: summary(3) },
    { id: "msg_3", thread: null },
  ]);
  assert.deepEqual(
    desktopMappers.expandRoomMessageHistoryPage({ thread_summaries: "deduped", threads: result.threads, messages: result.messages as any }).messages,
    input,
  );
});
