import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run DB-backed gone worker session tests";
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;

const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const dbApi = testDatabaseUrl ? await import("../db.js") : null;
const sessions = testDatabaseUrl ? await import("../db/auth/room-agent-sessions.js") : null;
const deletion = testDatabaseUrl ? await import("../db/content-deletion.js") : null;
const pool = dbClient?.pool;

test.beforeEach(async () => {
  if (!dbClient || !pool) return;
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(dbClient.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  sessions!.resetGoneWorkerSweepCursorForTests();
});

if (testDatabaseUrl) test.after(async () => { await pool?.end(); });

const MCP_INSTANCE = "worker_21a5c07a90fe4b93bd54f4b651a5e30f";

async function owner() {
  return dbApi!.upsertAccount({ provider: "github", provider_user_id: "gone-owner", login: "owner" });
}

async function worker(roomId: string, ownerAccountId: string, name: string, instance = `instance:${name}`) {
  return sessions!.createRoomAgentSession({
    room_id: roomId,
    session_kind: "worker",
    runtime: "claude-code",
    actor_label: `${name} | Owner's agent | Claude Code`,
    agent_key: `owner/${name}`,
    agent_instance_id: instance,
    display_name: name,
    requested_base_display_name: name,
    owner_account_id: ownerAccountId,
    owner_label: "Owner",
    ide_label: "Claude Code",
    process_host_id: "host_a",
  } as any);
}

/** The agent's process closed its connection this long ago and nothing was heard since. */
async function silentFor(sessionId: string, minutes: number) {
  await pool!.query(`UPDATE room_agent_sessions
      SET last_seen_at = now() - make_interval(mins => $2), agent_heard_at = now() - make_interval(mins => $2),
          process_seen_at = now() - make_interval(mins => $2), process_disconnected_at = now() - make_interval(mins => $2),
          process_connection_id = 'closed-connection', process_host_id = 'host_a'
    WHERE session_id = $1`, [sessionId, minutes]);
}

async function endedAt(sessionId: string): Promise<{ ended_at: string | null; end_reason: string | null }> {
  return (await pool!.query("SELECT ended_at, end_reason FROM room_agent_sessions WHERE session_id = $1", [sessionId])).rows[0];
}

test("the sweep ends workers whose process is gone and keeps the rest", { skip }, async () => {
  const account = await owner();
  const room = await dbApi!.createProjectWithName("gone-sweep");
  const gone = await worker(room.id, account.id, "Gone");
  const recent = await worker(room.id, account.id, "Recent");
  const waiting = await worker(room.id, account.id, "Waiting");
  const subscribed = await worker(room.id, account.id, "Subscribed");
  await silentFor(gone.session_id, 11);
  await silentFor(recent.session_id, 5);
  await silentFor(waiting.session_id, 11);
  await silentFor(subscribed.session_id, 11);
  // A rule made with an owner token, such as an MCP event subscription,
  // names the session that made it.
  await pool!.query(`INSERT INTO agent_wake_rules (id,room_id,agent_key,agent_name,event,arguments,identity_key,cursor_at,created_at,updated_at,
      delivery_kind,delivery_target,credential_kind,credential_ref,created_by_session_id,status)
    VALUES ('subscribed-rule',$1,'owner/Subscribed','Subscribed','room.message','{}','subscribed-rule',now(),now(),now(),'webhook','{"sealed":"unused"}',
      'token','owner-token',$2,'paused')`, [room.id, subscribed.session_id]);
  // An agent that asked to be woken while away is meant to be offline.
  await pool!.query(`INSERT INTO agent_wake_rules (id,room_id,agent_key,agent_name,event,arguments,identity_key,cursor_at,created_at,updated_at,
      delivery_kind,delivery_target,credential_kind,credential_ref,status)
    VALUES ('waiting-rule',$1,'owner/Waiting','Waiting','room.message','{}','waiting-rule',now(),now(),now(),'webhook','{"sealed":"unused"}',
      'agent_session',$2,'active')`, [room.id, waiting.session_id]);

  assert.deepEqual(await sessions!.endGoneWorkerSessions(), [gone.session_id]);
  const ended = await endedAt(gone.session_id);
  assert.ok(ended.ended_at);
  // Ended as if it left by itself: its task leases pass to its next session.
  assert.equal(ended.end_reason, null);
  assert.equal((await endedAt(recent.session_id)).ended_at, null);
  assert.equal((await endedAt(waiting.session_id)).ended_at, null);
  assert.equal((await endedAt(subscribed.session_id)).ended_at, null);
  assert.equal(
    (await pool!.query("SELECT status FROM agent_wake_rules WHERE id='waiting-rule'")).rows[0].status,
    "active",
  );
  // A second pass finds nothing more to end.
  assert.deepEqual(await sessions!.endGoneWorkerSessions(), []);
});

test("the sweep reads the evidence again under the row lock", { skip }, async () => {
  const account = await owner();
  const room = await dbApi!.createProjectWithName("gone-recheck");
  const back = await worker(room.id, account.id, "Back");
  await silentFor(back.session_id, 11);
  // The agent made a room call after the candidate list was read.
  const nowMs = Date.now();
  await pool!.query("UPDATE room_agent_sessions SET agent_heard_at = now() WHERE session_id = $1", [back.session_id]);
  assert.equal(await sessions!.endRoomAgentSession({ session_id: back.session_id, only_if_gone: { now_ms: nowMs } }), null);
  assert.equal((await endedAt(back.session_id)).ended_at, null);
});

test("an MCP worker ended by the sweep keeps its name when it comes back", { skip }, async () => {
  const account = await owner();
  const room = await dbApi!.createProjectWithName("gone-return");
  const first = await worker(room.id, account.id, "RiverFox", MCP_INSTANCE);
  await silentFor(first.session_id, 11);
  assert.deepEqual(await sessions!.endGoneWorkerSessions(), [first.session_id]);

  const again = await worker(room.id, account.id, "RiverFox", MCP_INSTANCE);
  assert.notEqual(again.session_id, first.session_id);
  assert.equal(again.display_name, "RiverFox");
  assert.equal(again.ended_at, null);
});

test("room deletion ends offline agents and names agents that are still there", { skip }, async () => {
  const account = await owner();
  const room = await dbApi!.createProjectWithName("delete-offline-agent");
  // Offline for a minute only: not yet gone, but the room shows it offline.
  const offline = await worker(room.id, account.id, "Offline");
  await silentFor(offline.session_id, 1);
  const running = await worker(room.id, account.id, "Running");
  await pool!.query(`UPDATE room_agent_sessions SET process_seen_at = now(), process_disconnected_at = NULL,
      process_connection_id = 'open-connection' WHERE session_id = $1`, [running.session_id]);

  await assert.rejects(deletion!.deleteRoomData(room.id), (error: any) => {
    assert.equal(error.status, 409);
    assert.equal(error.message, "Running is still in this room. Disconnect or retire it before deleting the room.");
    return true;
  });
  // A deletion that is refused ends no one.
  assert.equal((await endedAt(offline.session_id)).ended_at, null);
  assert.equal((await endedAt(running.session_id)).ended_at, null);

  await sessions!.endRoomAgentSession({ session_id: running.session_id, room_id: room.id });
  await deletion!.deleteRoomData(room.id);
  assert.equal((await pool!.query("SELECT id FROM rooms WHERE id = $1", [room.id])).rowCount, 0);
});

test("older MCP clients the rule never calls gone do not hold back the sweep", { skip }, async () => {
  const account = await owner();
  const room = await dbApi!.createProjectWithName("gone-legacy");
  // Older MCP clients: no process connection, no host id. They answer from
  // the session they hold until restarted, so silence never ends them.
  const legacy = [];
  for (let index = 0; index < 3; index += 1) {
    const session = await worker(room.id, account.id, `Legacy${index}`, `worker_${String(index).repeat(32)}`);
    await pool!.query(`UPDATE room_agent_sessions SET process_host_id = NULL, process_seen_at = NULL,
        last_seen_at = now() - interval '3 hours', agent_heard_at = now() - interval '3 hours' WHERE session_id = $1`, [session.session_id]);
    legacy.push(session);
  }
  const gone = await worker(room.id, account.id, "Gone");
  await silentFor(gone.session_id, 11);

  assert.deepEqual(await sessions!.endGoneWorkerSessions({ limit: 2 }), [gone.session_id]);
  for (const session of legacy) assert.equal((await endedAt(session.session_id)).ended_at, null);
});

test("a refused deletion ends no offline agent, and names up to three agents in a list", { skip }, async () => {
  const account = await owner();
  const room = await dbApi!.createProjectWithName("delete-refused");
  const offline = await worker(room.id, account.id, "Offline");
  await silentFor(offline.session_id, 1);
  await pool!.query(`INSERT INTO agent_asks (id,link_token_hash,room_id,asker_account_id,provider_id,model_label,expires_at)
    VALUES ('ask-1','hash-1',$1,$2,'claude','Claude',now() + interval '1 day')`, [room.id, account.id]);
  await assert.rejects(deletion!.deleteRoomData(room.id), (error: any) => error.status === 409 && /agent requests/.test(error.message));
  assert.equal((await endedAt(offline.session_id)).ended_at, null);

  await pool!.query("DELETE FROM agent_asks WHERE id='ask-1'");
  for (const name of ["Ash", "Birch", "Cedar"]) {
    const session = await worker(room.id, account.id, name);
    await pool!.query("UPDATE room_agent_sessions SET process_seen_at = now(), process_disconnected_at = NULL WHERE session_id = $1", [session.session_id]);
  }
  await assert.rejects(deletion!.deleteRoomData(room.id), (error: any) => {
    assert.equal(error.message, "Ash, Birch and Cedar are still in this room. Disconnect or retire them before deleting the room.");
    return true;
  });
});

async function supervise(sessionId: string, ownerAccountId: string, grantId: string, expiresIn: string, scopeKey = "owner") {
  await pool!.query(`INSERT INTO supervisor_host_grants (grant_id,owner_account_id,host_id,installation_id,token_hash,allowed_room_ids,allowed_agent_keys,
      issued_at,expires_at,created_at,updated_at,scope_key)
    VALUES ($1,$2,'host_'||$1,'install_'||$1,'hash_'||$1,'{}','{}',now() - interval '2 days',now() + $3::interval,now(),now(),$4)`,
  [grantId, ownerAccountId, expiresIn, scopeKey]);
  await pool!.query("UPDATE room_agent_sessions SET supervisor_grant_id = $2 WHERE session_id = $1", [sessionId, grantId]);
}

test("the sweep keeps desktop agents that may come back, and ends those that cannot", { skip }, async () => {
  const account = await owner();
  const room = await dbApi!.createProjectWithName("gone-supervised");
  const kept: string[] = [];
  const endedIds: string[] = [];
  const cases: Array<[string, string, string, "kept" | "ended", boolean?]> = [
    ["Current", "1 day", "owner", "kept"],
    // The owner's desktop brings an expired grant back under the same id.
    ["Closed", "-3 days", "owner", "kept"],
    ["Abandoned", "-31 days", "owner", "ended"],
    // A guest's desktop cannot renew an expired grant.
    ["Guest", "-1 day", "rental:rental_1", "ended"],
    ["Revoked", "1 day", "owner", "ended", true],
  ];
  for (const [name, expiresIn, scopeKey, outcome, revoked] of cases) {
    const session = await worker(room.id, account.id, name);
    await silentFor(session.session_id, 120);
    await supervise(session.session_id, account.id, `grant_${name}`, expiresIn, scopeKey);
    if (revoked) await pool!.query("UPDATE supervisor_host_grants SET revoked_at = now() WHERE grant_id = $1", [`grant_${name}`]);
    (outcome === "kept" ? kept : endedIds).push(session.session_id);
  }

  assert.deepEqual((await sessions!.endGoneWorkerSessions()).sort(), endedIds.sort());
  for (const sessionId of kept) assert.equal((await endedAt(sessionId)).ended_at, null);
});

test("room deletion waits for a desktop agent with a current grant, not one whose grant expired", { skip }, async () => {
  const account = await owner();
  const room = await dbApi!.createProjectWithName("delete-supervised");
  const current = await worker(room.id, account.id, "Current");
  const lapsed = await worker(room.id, account.id, "Lapsed");
  await silentFor(current.session_id, 120);
  await silentFor(lapsed.session_id, 120);
  await supervise(current.session_id, account.id, "grant_current", "1 day");
  await supervise(lapsed.session_id, account.id, "grant_lapsed", "-1 day");

  await assert.rejects(deletion!.deleteRoomData(room.id), (error: any) => {
    assert.equal(error.message, "Current is still in this room. Disconnect or retire it before deleting the room.");
    return true;
  });
  await pool!.query("UPDATE supervisor_host_grants SET revoked_at = now() WHERE grant_id = 'grant_current'");
  await deletion!.deleteRoomData(room.id);
  assert.equal((await pool!.query("SELECT id FROM rooms WHERE id = $1", [room.id])).rowCount, 0);
});
