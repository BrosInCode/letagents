// Thread-inbox characterization suite (Phase B / PR 4 — SQLite engine).
//
// This locks the CURRENT thread-inbox semantics of the desktop SQLite store as
// an executable golden spec, so the Postgres SQL-aggregate rewrite (PR 5) can be
// proven behaviour-preserving. The expectations below are the contract; the
// Postgres runner (task_4 part 2, src/api/__tests__) must assert the SAME
// expected values against getMessageThreads / getMessageThread /
// markMessageThreadRead so the two engines stay in parity.
//
// Note: the MCP local-state store (src/mcp/local-state/local-chat.ts) does NOT
// expose a thread-inbox query surface (it only stores/reads messages), so it is
// intentionally excluded from this parity suite.

import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({
  prefix: "letagents-desktop-thread-parity-",
  paths: ["chatStorage", "localChatDb", "localProfile"],
});

const {
  addLocalChatMessage,
  getLocalMessageThreads,
  getLocalMessageThread,
  markLocalMessageThreadRead,
} = await import("../main/rooms/messages/local-store.js");

const READER = "account:parity";

/**
 * Seed a deterministic room. Returns the ids so expectations can reference them.
 * Layout (creation order fixes the ascending message numbers):
 *   rootA + replyA1 + replyA2            -> thread A (3 msgs, 2 replies)
 *   rootB + replyB1(empty text, visible) -> thread B (2 msgs, 1 reply)
 *   promptOnly (auto, empty)             -> excluded from every thread view
 *   loner (no replies)                   -> not a thread (never in the inbox)
 */
async function seedRoom(room: string) {
  const rootA = await addLocalChatMessage(room, { sender: "Human", text: "root A", source: "browser" });
  const replyA1 = await addLocalChatMessage(room, {
    sender: "Agent", text: "A reply 1", reply_to: rootA.id, thread_root_id: rootA.id, source: "agent",
  });
  const replyA2 = await addLocalChatMessage(room, {
    sender: "Agent", text: "A reply 2", reply_to: replyA1.id, thread_root_id: rootA.id, source: "agent",
  });
  const rootB = await addLocalChatMessage(room, { sender: "Human", text: "root B", source: "browser" });
  // Empty text but NOT an auto prompt -> visible (this is the empty-text-visible
  // case the task_1 P0 fix restored; visible purely because agent_prompt_kind is
  // null, independent of attachments). Must be counted in thread B.
  const replyB1 = await addLocalChatMessage(room, {
    sender: "Agent", text: "", reply_to: rootB.id, thread_root_id: rootB.id, source: "agent",
  });
  const promptOnly = await addLocalChatMessage(room, {
    sender: "Agent", text: "", agent_prompt_kind: "auto", source: "agent",
  });
  const loner = await addLocalChatMessage(room, { sender: "Human", text: "no replies here", source: "browser" });
  return { rootA, replyA1, replyA2, rootB, replyB1, promptOnly, loner };
}

test("SQLite thread inbox: ordering, reply counts, prompt-only exclusion, unread count", async () => {
  const room = "parity_all";
  const s = await seedRoom(room);

  const page = await getLocalMessageThreads(room, { readerKey: READER });

  // Only threaded roots appear; the loner and the prompt-only message do not.
  // Order is by latest reply, newest first: thread B's last reply (replyB1) is
  // newer than thread A's last reply (replyA2).
  assert.deepEqual(page.threads.map((t) => t.root.id), [s.rootB.id, s.rootA.id]);
  assert.equal(page.has_more, false);

  const summaryByRoot = new Map(page.threads.map((t) => [t.root.id, t.summary]));
  // Thread A: 2 replies. Thread B: 1 reply (the empty-text-but-visible one counts).
  assert.equal(summaryByRoot.get(s.rootA.id)?.reply_count, 2);
  assert.equal(summaryByRoot.get(s.rootB.id)?.reply_count, 1);

  // No reader cursor yet -> everything unread; both threads count as unread.
  assert.equal(summaryByRoot.get(s.rootA.id)?.unread_count, 2);
  assert.equal(summaryByRoot.get(s.rootB.id)?.unread_count, 1);
  assert.equal(page.unread_thread_count, 2);
});

test("SQLite thread inbox: reader-scoped unread at none / partial / latest", async () => {
  const room = "parity_reads";
  const s = await seedRoom(room);

  // none read
  let thread = await getLocalMessageThread(room, s.rootA.id, { readerKey: READER });
  assert.equal(thread?.summary.unread_count, 2);
  assert.equal(thread?.summary.last_read_message_id, null);

  // partial: read up to the first reply
  await markLocalMessageThreadRead(room, s.rootA.id, s.replyA1.id, { readerKey: READER });
  thread = await getLocalMessageThread(room, s.rootA.id, { readerKey: READER });
  assert.equal(thread?.summary.unread_count, 1);
  assert.equal(thread?.summary.last_read_message_id, s.replyA1.id);

  // latest: read up to the last reply
  await markLocalMessageThreadRead(room, s.rootA.id, s.replyA2.id, { readerKey: READER });
  thread = await getLocalMessageThread(room, s.rootA.id, { readerKey: READER });
  assert.equal(thread?.summary.unread_count, 0);
  assert.equal(thread?.summary.has_unread, false);

  // A different reader is unaffected (reads are per-reader).
  const other = await getLocalMessageThread(room, s.rootA.id, { readerKey: "account:other" });
  assert.equal(other?.summary.unread_count, 2);
});

test("SQLite thread inbox: unread filter and global-vs-page unread_thread_count", async () => {
  const room = "parity_filter";
  const s = await seedRoom(room);

  // Read thread B fully; only thread A stays unread.
  await markLocalMessageThreadRead(room, s.rootB.id, s.replyB1.id, { readerKey: READER });

  const unread = await getLocalMessageThreads(room, { filter: "unread", readerKey: READER });
  assert.deepEqual(unread.threads.map((t) => t.root.id), [s.rootA.id]);

  // unread_thread_count is a global count (independent of the filter/cursor).
  assert.equal(unread.unread_thread_count, 1);

  const all = await getLocalMessageThreads(room, { filter: "all", readerKey: READER });
  assert.deepEqual(all.threads.map((t) => t.root.id), [s.rootB.id, s.rootA.id]);
  assert.equal(all.unread_thread_count, 1);
});

test("SQLite thread inbox: prompt-only (auto/empty) replies are excluded from thread aggregation", async () => {
  // This is the highest-risk clause for the PR-5 rewrite: the visibility filter
  // must apply INSIDE reply aggregation, not only to top-level candidacy.
  const room = "parity_promptonly_reply";
  const rootC = await addLocalChatMessage(room, { sender: "Human", text: "root C", source: "browser" });
  const visibleReply = await addLocalChatMessage(room, {
    sender: "Agent", text: "real reply", reply_to: rootC.id, thread_root_id: rootC.id, source: "agent",
  });
  // Newest message in the thread, but auto+empty -> must be invisible everywhere.
  await addLocalChatMessage(room, {
    sender: "Agent", text: "", agent_prompt_kind: "auto", reply_to: visibleReply.id, thread_root_id: rootC.id, source: "agent",
  });

  const thread = await getLocalMessageThread(room, rootC.id, { readerKey: READER });
  // reply_count and latest_reply must ignore the auto/empty reply...
  assert.equal(thread?.summary.reply_count, 1);
  assert.equal(thread?.summary.latest_reply?.id, visibleReply.id);
  // ...and unread must not count it either.
  assert.equal(thread?.summary.unread_count, 1);

  // A thread whose ONLY reply is prompt-only has no visible replies, so it must
  // drop out of the inbox candidate set entirely.
  const rootD = await addLocalChatMessage(room, { sender: "Human", text: "root D", source: "browser" });
  await addLocalChatMessage(room, {
    sender: "Agent", text: "", agent_prompt_kind: "auto", reply_to: rootD.id, thread_root_id: rootD.id, source: "agent",
  });
  const page = await getLocalMessageThreads(room, { readerKey: READER });
  assert.deepEqual(page.threads.map((t) => t.root.id), [rootC.id]);
});

test("SQLite thread inbox: participant aggregation (dedup, counts, latest-first)", async () => {
  const room = "parity_participants";
  const s = await seedRoom(room);

  const thread = await getLocalMessageThread(room, s.rootA.id, { readerKey: READER });
  // Thread A: Human/browser root + two Agent/agent replies. Deduped by
  // sender+source, ordered by most-recent message first.
  const participants = thread?.summary.participants ?? [];
  assert.deepEqual(
    participants.map((p) => ({ sender: p.sender, source: p.source, count: p.message_count })),
    [
      { sender: "Agent", source: "agent", count: 2 },
      { sender: "Human", source: "browser", count: 1 },
    ],
  );
  // Latest message id per participant is tracked.
  assert.equal(participants[0]?.latest_message_id, s.replyA2.id);
  assert.equal(participants[1]?.latest_message_id, s.rootA.id);
});

test("SQLite thread inbox: a reply id resolves to its thread root for read + fetch", async () => {
  const room = "parity_root_resolution";
  const s = await seedRoom(room);

  // Passing a REPLY id (not the root) must resolve to the root thread.
  const viaReply = await getLocalMessageThread(room, s.replyA1.id, { readerKey: READER });
  assert.equal(viaReply?.root.id, s.rootA.id);
  assert.equal(viaReply?.summary.reply_count, 2);

  // markLocalMessageThreadRead accepts a reply id and normalizes to the root.
  await markLocalMessageThreadRead(room, s.replyA1.id, s.replyA2.id, { readerKey: READER });
  const afterRead = await getLocalMessageThread(room, s.rootA.id, { readerKey: READER });
  assert.equal(afterRead?.summary.unread_count, 0);
});

test("SQLite thread inbox: cursor pagination across a page boundary", async () => {
  const room = "parity_cursor";
  const s = await seedRoom(room);

  // limit 1 -> newest thread (B) first, has_more true.
  const first = await getLocalMessageThreads(room, { limit: 1, readerKey: READER });
  assert.deepEqual(first.threads.map((t) => t.root.id), [s.rootB.id]);
  assert.equal(first.has_more, true);

  // Page by the latest reply id of the last returned thread.
  const cursor = first.threads[0]?.summary.latest_reply?.id ?? null;
  assert.ok(cursor, "expected a latest_reply cursor");
  const second = await getLocalMessageThreads(room, { limit: 1, before: cursor, readerKey: READER });
  assert.deepEqual(second.threads.map((t) => t.root.id), [s.rootA.id]);
  assert.equal(second.has_more, false);
});
