import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PRESENCE_CHANGE_CHANNEL } from "../../shared/presence-change-channel.js";

process.env.DB_URL = process.env.TEST_DB_URL ?? "postgresql://test:test@127.0.0.1:1/test";
const url = process.env.TEST_DB_URL;
const { parseNativeActivitySummary, nativeHarnessPresenceForStatus } = await import("../db/presence/liveness.js");
const client = url ? await import("../db/client.js") : null;
const rooms = url ? await import("../db.js") : null;
const utils = url ? await import("../db/utils.js") : null;
const options = { skip: !url ? "Set TEST_DB_URL to run PostgreSQL integration tests." : false };
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { await client?.pool.end(); });

test("activity_summary: absent or null is none, controls go, overlong text is cut, only a non-string is refused", () => {
  assert.deepEqual(parseNativeActivitySummary(undefined), { ok: true, summary: null });
  assert.deepEqual(parseNativeActivitySummary(null), { ok: true, summary: null });
  assert.deepEqual(parseNativeActivitySummary("  \u0000‮  "), { ok: true, summary: null });
  assert.deepEqual(parseNativeActivitySummary(" Using\na\u0007 tool​ "), { ok: true, summary: "Using a tool" });
  assert.deepEqual(parseNativeActivitySummary(`  ${"x".repeat(120)}  `), { ok: true, summary: "x".repeat(120) });
  assert.deepEqual(parseNativeActivitySummary(` ${"y".repeat(300)}\n`), { ok: true, summary: `${"y".repeat(119)}…` });
  assert.deepEqual(parseNativeActivitySummary(`${"z".repeat(118)}😀😀`), { ok: true, summary: `${"z".repeat(118)}…` }, "never half an emoji");
  assert.equal(parseNativeActivitySummary(42).ok, false);
  assert.equal(parseNativeActivitySummary({ text: "x" }).ok, false);
  assert.deepEqual(nativeHarnessPresenceForStatus("working", "Using a tool"), { status: "working", status_text: "Using a tool" });
  assert.deepEqual(nativeHarnessPresenceForStatus("working", null), { status: "working", status_text: "Working" });
  assert.deepEqual(nativeHarnessPresenceForStatus("idle", "Using a tool"), { status: "idle", status_text: "Connected — listening" });
});

async function notificationsFrom(work: () => Promise<void>): Promise<string[]> {
  const listener = await client!.pool.connect();
  const heard: string[] = [];
  const onNotification = (message: { channel: string; payload?: string }) => {
    if (message.channel === PRESENCE_CHANGE_CHANNEL) heard.push(message.payload ?? "");
  };
  listener.on("notification", onNotification);
  try {
    await listener.query(`LISTEN ${PRESENCE_CHANGE_CHANNEL}`);
    await work();
    await new Promise(resolve => setTimeout(resolve, 150));
    return heard;
  } finally {
    listener.off("notification", onNotification);
    await listener.query(`UNLISTEN ${PRESENCE_CHANGE_CHANNEL}`);
    listener.release();
  }
}

test("a working agent's summary is its presence text, and idle restores the fixed text", options, async () => {
  const { createProjectWithName, createRoomAgentSession, markRoomAgentDeliveryConnected, recordNativeHarnessActivity,
    upsertAccount, getRoomAgentPresence } = rooms!;
  const room = await createProjectWithName(`native-summary-${Date.now()}`);
  const account = await upsertAccount({
    provider: "github", provider_user_id: `native-summary-${Date.now()}`, login: "EmmyMay", display_name: "EmmyMay",
  });
  const worker = await createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "codex",
    actor_label: "Oak | EmmyMay's agent | Codex", agent_key: "EmmyMay/oak", display_name: "Oak",
    owner_account_id: account.id, owner_label: "EmmyMay", ide_label: "Codex",
  });
  // A connected worker, as the daemon's is, so the live roster lists it.
  await markRoomAgentDeliveryConnected({
    room_id: room.id, actor_label: worker.actor_label, agent_session_id: worker.session_id,
    session_kind: "worker", display_name: worker.display_name,
    credential_fence: { kind: "session_token", token_hash: utils!.hashToken(worker.session_token) },
    transport: "long_poll",
  });
  let sequence = 0;
  const post = (status: "working" | "idle", activity_summary?: string | null) => recordNativeHarnessActivity({
    room_id: room.id, agent_session_id: worker.session_id, actor_label: worker.actor_label,
    agent_key: worker.agent_key, session_kind: "worker", runtime: worker.runtime,
    display_name: worker.display_name, owner_label: worker.owner_label, ide_label: worker.ide_label,
    repo_branch: null, provider_observed_at: new Date(Date.now() + ++sequence).toISOString(), sequence,
    method: "native_harness.activity_summary", status, activity_summary,
  });
  const text = async () => (await getRoomAgentPresence(room.id)).find(entry => entry.agent_session_id === worker.session_id)?.status_text;

  assert.deepEqual(await notificationsFrom(async () => { assert.equal((await post("working", "Using a tool")).accepted, true); }), [room.id],
    "starting work is announced, as before");
  assert.equal(await text(), "Using a tool", "the room presence read returns the line");

  // A new line is read by the members' next presence poll; it raises no notice of its own.
  await post("working", "Writing a response");
  assert.equal(await text(), "Writing a response");

  await post("working");
  assert.equal(await text(), "Working", "no line falls back to the fixed text");

  await post("working", "w".repeat(500));
  assert.equal(await text(), `${"w".repeat(119)}…`, "an overlong line from a heartbeat is cut, never refused");

  await post("working", "Thinking");
  assert.deepEqual(await notificationsFrom(async () => { await post("idle", "Thinking"); }), [room.id]);
  assert.equal(await text(), "Connected — listening", "an idle agent shows the fixed listening text, never a line");
});
