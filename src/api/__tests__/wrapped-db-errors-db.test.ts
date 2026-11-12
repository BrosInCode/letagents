/**
 * Real database errors reach these checks wrapped by Drizzle (the SQLSTATE is
 * on `error.cause`). Before this fix they read `error.code` and answered 500.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const client = url ? await import("../db/client.js") : null;
const api = url ? await import("../db.js") : null;
const schema = url ? await import("../db/schema.js") : null;
const store = url ? await import("../db/wake-rules.js") : null;
const service = url ? await import("../wake-rules/service.js") : null;
const reactions = url ? await import("../db/messages/reactions.js") : null;
const { pgErrorCode } = await import("../db/utils.js");
const { WakeRuleError } = await import("../../../shared/wake-rules.mjs");
const options = { skip: !url ? "Set TEST_DB_URL for PostgreSQL integration tests." : false };

if (url) {
  test.before(async () => { await migrate(client!.db, { migrationsFolder: resolve("drizzle") }); });
  test.after(async () => { await client!.pool.end(); });
}

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let sequence = 0;
const unique = (label: string) => `${label}-${suffix}-${++sequence}`;

async function seedAgent() {
  const room = await api!.createProjectWithName(unique("wrapped-errors"));
  const now = new Date().toISOString();
  const ownerId = unique("owner");
  await client!.db.insert(schema!.accounts).values({
    id: ownerId, provider: "github", provider_user_id: ownerId, login: ownerId, created_at: now, updated_at: now,
  });
  const session = await api!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "claude-code", actor_label: "Fable",
    agent_key: `${ownerId}/fable`, display_name: "Fable",
    owner_account_id: ownerId, owner_label: ownerId, ide_label: "Agent",
  });
  return {
    room,
    ownerId,
    agent: { agent_key: session.agent_key, agent_name: session.display_name, session_id: session.session_id },
  };
}

const timerBody = () => ({ event: "timer", arguments: { at: new Date(Date.now() + 3_600_000).toISOString() } });

test("undo of a wait the agent has set again answers 409, not 500", options, async () => {
  const { room, agent } = await seedAgent();
  const body = timerBody();
  const person = { kind: "human" as const, id: "acct", label: "EmmyMay" };
  const first = await service!.addWakeRuleForAgent({ roomId: room.id, agent, body });
  await service!.cancelWakeRuleAs(room.id, first.rule.id, person);
  // The same wait again: allowed, because the first one is cancelled.
  const second = await service!.addWakeRuleForAgent({ roomId: room.id, agent, body });
  assert.equal(second.created, true);

  // Undo of the first now collides with the second on the held-identity index.
  await assert.rejects(
    service!.restoreWakeRuleAs(room.id, first.rule.id, person),
    (error: unknown) =>
      error instanceof WakeRuleError
      && (error as { status?: number }).status === 409
      && /already has an active wake rule/.test((error as Error).message),
  );
});

test("a confirmation that collides with a unique index answers conflict, not 500", options, async () => {
  const { room, agent } = await seedAgent();
  const { rule } = await service!.addWakeRuleForAgent({ roomId: room.id, agent, body: timerBody() });
  const tokenHash = unique("token");
  await client!.pool.query(
    `UPDATE agent_wake_rules
        SET status = 'pending_confirmation', confirm_token_hash = $2, confirm_expires_at = now() + interval '1 hour'
      WHERE id = $1`,
    [rule.id, tokenHash],
  );
  // Make the confirming UPDATE fail as a duplicate key would: a real Postgres
  // 23505, thrown through Drizzle like any other.
  const fn = `wrapped_errors_dup_${suffix.replace(/[^a-z0-9]/g, "")}`;
  await client!.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.confirm_token_hash = '${tokenHash}' THEN
        RAISE EXCEPTION 'duplicate key value violates unique constraint "agent_wake_rules_held_identity_uq"' USING ERRCODE = '23505';
      END IF;
      RETURN NEW;
    END $$`);
  await client!.pool.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON agent_wake_rules FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    assert.deepEqual(await store!.confirmWakeEmailRule(tokenHash), { outcome: "conflict" });
  } finally {
    await client!.pool.query(`DROP TRIGGER ${fn} ON agent_wake_rules`);
    await client!.pool.query(`DROP FUNCTION ${fn}()`);
  }
});

test("a reaction to a message another transaction holds fails with a wrapped 55P03", options, async () => {
  const room = await api!.createProjectWithName(unique("busy-reaction"));
  const message = await api!.addMessage(room.id, "Sender", "Hello", { source: "browser" });
  const number = Number(String(message.id).replace("msg_", ""));
  const now = new Date().toISOString();
  const accountId = unique("reactor");
  await client!.db.insert(schema!.accounts).values({
    id: accountId, provider: "github", provider_user_id: accountId, login: accountId, created_at: now, updated_at: now,
  });

  const holder = new Pool({ connectionString: url, max: 1 });
  const held = await holder.connect();
  try {
    await held.query("BEGIN");
    await held.query("SELECT 1 FROM messages WHERE room_id = $1 AND number = $2 FOR UPDATE", [room.id, number]);
    const error = await reactions!.addMessageReaction({ roomId: room.id, messageNumber: number, accountId, emoji: "👍" })
      .then(() => null, (caught: unknown) => caught);
    assert.ok(error, "the reaction waits for the held row and gives up");
    assert.equal((error as { code?: string }).code, undefined, "Drizzle's wrapper has no code");
    assert.equal(pgErrorCode(error), "55P03", "the route maps this to 503 reaction_busy");
  } finally {
    await held.query("ROLLBACK");
    held.release();
    await holder.end();
  }
});
