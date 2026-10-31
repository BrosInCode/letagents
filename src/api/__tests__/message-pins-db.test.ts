import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { toAgentReadableMessages } from "../../mcp/server/runtime/messages.js";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import("../db/client.js") : null;
const schema = url ? await import("../db/schema.js") : null;
const rooms = url ? await import("../db.js") : null;
const store = url ? await import("../db/messages/pins.js") : null;
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { await client?.pool.end(); });
const options = { skip: !url ? "Set TEST_DB_URL for PostgreSQL integration tests." : false };
let sequence = 0;
const unique = () => `pins-${Date.now()}-${++sequence}`;
async function fixture(count = 1) {
  const login = unique();
  const account = await rooms!.upsertAccount({ provider: "github", provider_user_id: login, login, display_name: "Ada" });
  const room = await rooms!.createProjectWithName(unique());
  for (let i = 1; i <= count; i++) await rooms!.addMessage(room.id, "Sender", `Message ${i}`, { source: "browser" });
  const change = (messageNumber: number, pinned = true, accountId = account.id) =>
    store!.setMessagePin({ roomId: room.id, messageNumber, accountId, pinned });
  return { room, account, change };
}
test("idempotence retains attribution, cross-person unpin works, list is newest first", options, async () => {
  const { room, account, change } = await fixture(2);
  assert.equal(await change(1), "changed");
  const first = (await store!.getMessagePins(room.id))[0]!;
  assert.equal(await change(2), "changed");
  assert.equal(await change(1), "unchanged");
  const list = await store!.getMessagePins(room.id);
  assert.deepEqual(list.map((pin) => pin.message_id), ["msg_2", "msg_1"]);
  assert.deepEqual(list[1], first);
  const other = await fixture();
  assert.equal(await change(1, false, other.account.id), "changed");
  assert.equal(await change(1, false, account.id), "unchanged");
});
test("two concurrent different-message pins at 49 cannot exceed 50; a duplicate at 50 succeeds", options, async () => {
  const { room, change } = await fixture(51);
  for (let i = 1; i <= 49; i++) await change(i);
  const result = await Promise.all([change(50), change(51)]);
  assert.deepEqual(result.sort(), ["changed", "pin_limit"]);
  assert.equal((await store!.getMessagePins(room.id)).length, 50);
  assert.equal(await change(1), "unchanged");
  const [count] = await client!.db.select({ n: sql<number>`count(*)::int` }).from(schema!.message_pins)
    .where(eq(schema!.message_pins.room_id, room.id));
  assert.equal(count!.n, 50);
});
test("hidden messages disappear; snippets use displayed text; message/account/room deletions cascade", options, async () => {
  const { room, account, change } = await fixture(3);
  for (let i = 1; i <= 3; i++) await change(i);
  await client!.db.update(schema!.messages).set({ display_text: "Shown\ncontent" })
    .where(and(eq(schema!.messages.room_id, room.id), eq(schema!.messages.number, 1)));
  assert.equal((await store!.getMessagePins(room.id)).find((p) => p.message_id === "msg_1")?.snippet, "Shown content");
  await client!.db.update(schema!.messages).set({ agent_prompt_kind: "auto", text: "" })
    .where(and(eq(schema!.messages.room_id, room.id), eq(schema!.messages.number, 1)));
  assert.equal(await change(1), "message_not_found");
  assert.deepEqual((await store!.getMessagePins(room.id)).map((p) => p.message_id), ["msg_3", "msg_2"]);
  await client!.db.delete(schema!.messages).where(and(eq(schema!.messages.room_id, room.id), eq(schema!.messages.number, 2)));
  assert.equal((await store!.getMessagePins(room.id)).length, 1);
  await client!.db.delete(schema!.accounts).where(eq(schema!.accounts.id, account.id));
  assert.deepEqual(await store!.getMessagePins(room.id), []);
  const other = await fixture(); await other.change(1);
  await client!.db.delete(schema!.rooms).where(eq(schema!.rooms.id, other.room.id));
  const [count] = await client!.db.select({ n: sql<number>`count(*)::int` }).from(schema!.message_pins)
    .where(eq(schema!.message_pins.room_id, other.room.id));
  assert.equal(count!.n, 0);
});
test("pins do not change history, single-message, thread or agent-readable payloads", options, async () => {
  const { room, change } = await fixture();
  await rooms!.addMessage(room.id, "Reply", "Thread reply", { source: "browser", thread_root_message_id: "msg_1" });
  const read = async () => ({
    history: await rooms!.getMessages(room.id),
    single: await rooms!.getMessageById(room.id, "msg_1"),
    thread: await rooms!.getMessageThread(room.id, "msg_1"),
  });
  const before = await read();
  assert.deepEqual(before.thread?.replies.map((message) => message.id), ["msg_2"]);
  const agentBefore = toAgentReadableMessages(before.history.messages);
  await change(1); await change(2);
  assert.deepEqual(await read(), before);
  assert.deepEqual(toAgentReadableMessages((await read()).history.messages), agentBefore);
  await change(1, false); await change(2, false);
  assert.deepEqual(await read(), before);
});
test("the pins-only advisory lock times out after 3 seconds but does not block sending", options, async () => {
  const { room, change } = await fixture();
  const lock = await client!.pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [store!.MESSAGE_PINS_LOCK_NAMESPACE, room.id]);
    await lock.query("SET LOCAL statement_timeout = '1s'");
    // Sending uses id_sequences, not the pins namespace.
    const sent = await rooms!.addMessage(room.id, "Sender", "Sent during a pin lock", { source: "browser" });
    assert.equal(sent.id, "msg_2");
    const started = Date.now();
    await assert.rejects(change(1), (error: any) => (error?.cause?.code ?? error?.code) === "55P03");
    assert.ok(Date.now() - started >= 2800);
  } finally { await lock.query("ROLLBACK"); lock.release(); }
  assert.equal(await change(1), "changed");
});
