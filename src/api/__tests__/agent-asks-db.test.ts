import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const dbm = url ? await import("../db/client.js") : null;
const core = url ? await import("../db.js") : null;
const asks = url ? await import("../agent-asks/store.js") : null;
const pool = dbm?.pool;
const options = { skip: !url, concurrency: false };
if (url) {
  test.beforeEach(async () => {
    await pool!.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
    await migrate(dbm!.db, { migrationsFolder: path.resolve("drizzle") });
  });
  test.after(() => pool!.end());
}

const opus = { providerId: "claude-code", model: "claude-opus-5-5", modelLabel: "Claude Opus 5.5" };

async function seed() {
  const room = await core!.createProjectWithName("ask-room");
  const sam = await core!.upsertAccount({ provider: "github", provider_user_id: "1", login: "sam" });
  const john = await core!.upsertAccount({ provider: "github", provider_user_id: "2", login: "john" });
  const ada = await core!.upsertAccount({ provider: "github", provider_user_id: "3", login: "ada" });
  const agent = await core!.registerAgentIdentity({ owner_account_id: john.id, owner_login: "john", owner_label: "john", name: "helper" });
  return { room, sam, john, ada, agent };
}

async function ask(s: Awaited<ReturnType<typeof seed>>, extra: Partial<Parameters<NonNullable<typeof asks>["createAsk"]>[0]> = {}) {
  const created = await asks!.createAsk({ askerAccountId: s.sam.id, roomId: s.room.id, ...opus, amountPercent: null, note: "", ...extra });
  assert.equal(created.error, null);
  return { row: created.ask!, token: created.token! };
}

async function fresh(id: string) { return (await asks!.getAskById(id))!; }

async function launch(s: Awaited<ReturnType<typeof seed>>, row: { id: string }, given = opus) {
  const claimed = await asks!.claimAsk(await fresh(row.id), s.john.id);
  assert.ok(claimed);
  const { grant } = await asks!.createAskLaunchAuthority(claimed, {
    giverAccountId: s.john.id, hostId: "host", installationId: "install", agentKey: s.agent.canonical_key,
    givenProviderId: given.providerId, givenModel: given.model, givenModelLabel: given.modelLabel, givenAmountPercent: 10,
  });
  const worker = await core!.createRoomAgentSession({
    room_id: s.room.id, session_kind: "worker", runtime: "test", actor_label: "helper", agent_key: s.agent.canonical_key,
    agent_instance_id: "entry", display_name: "helper", owner_account_id: s.john.id, owner_label: "john", ide_label: "Claude",
    supervisor_grant_id: grant.grant_id,
  });
  const joined = await asks!.acknowledgeAskJoin(await fresh(row.id), { giverAccountId: s.john.id, roomAgentSessionId: worker.session_id });
  return { grant, worker, joined };
}

async function grantRevoked(grantId: string) {
  return (await pool!.query("SELECT revoked_at FROM supervisor_host_grants WHERE grant_id=$1", [grantId])).rows[0].revoked_at !== null;
}

async function roomText(roomId: string) {
  return (await pool!.query("SELECT text FROM messages WHERE room_id=$1 ORDER BY number", [roomId])).rows.map(r => r.text as string);
}

test("asking posts a silent room line, and a person can have at most five open asks", options, async () => {
  const s = await seed();
  for (let i = 0; i < 5; i += 1) await ask(s);
  const sixth = await asks!.createAsk({ askerAccountId: s.sam.id, roomId: s.room.id, ...opus, amountPercent: null, note: "" });
  assert.equal(sixth.error, "ask_limit");
  assert.ok((await roomText(s.room.id)).includes("sam asked for a Claude Opus 5.5 agent."));
});

test("the first giver to tap wins; the same giver can renew; releasing gives the link back", options, async () => {
  const s = await seed(); const { row } = await ask(s);
  const [a, b] = await Promise.all([asks!.claimAsk(row, s.john.id), asks!.claimAsk(row, s.ada.id)]);
  assert.equal([a, b].filter(Boolean).length, 1);
  const winner = a ? s.john : s.ada;
  assert.ok(await asks!.claimAsk(await fresh(row.id), winner.id));
  assert.ok(await asks!.releaseClaim(await fresh(row.id), winner.id, true));
  assert.equal((await fresh(row.id)).state, "open");
  assert.ok((await roomText(s.room.id)).some(text => text.includes("can't add an agent right now")));
});

test("an exact match joins active with an intro that carries the note", options, async () => {
  const s = await seed(); const { row } = await ask(s, { note: "finish the auth fix" });
  const { joined } = await launch(s, row);
  assert.equal(joined.state, "active");
  assert.ok((await roomText(s.room.id)).includes("Hi, I'm Claude Opus 5.5, added by john. You asked for help with: finish the auth fix. Say when to start."));
  assert.equal(await asks!.isAskGrantActive({ askId: row.id, ownerAccountId: s.john.id, grantId: joined.grant_id! }), true);
});

test("a substitute waits on hold; declining removes it and reopens the link", options, async () => {
  const s = await seed(); const { row } = await ask(s);
  const { joined, grant } = await launch(s, row, { providerId: "claude-code", model: "claude-sonnet-5-5", modelLabel: "Claude Sonnet 5.5" });
  assert.equal(joined.state, "on_hold");
  const declined = await asks!.declineSubstitute(joined);
  assert.equal(declined?.state, "open");
  assert.equal(declined?.giver_account_id, null);
  assert.equal(await grantRevoked(grant.grant_id), true);
});

test("accepting a substitute makes it active", options, async () => {
  const s = await seed(); const { row } = await ask(s);
  const { joined } = await launch(s, row, { providerId: "claude-code", model: "claude-sonnet-5-5", modelLabel: "Claude Sonnet 5.5" });
  assert.equal((await asks!.acceptSubstitute(joined))?.state, "active");
});

test("ending revokes the grant and ends the agent's room session", options, async () => {
  const s = await seed(); const { row } = await ask(s);
  const { grant, worker } = await launch(s, row);
  const ended = await asks!.endAsk(await fresh(row.id), "amount_used");
  assert.equal(ended?.ended_reason, "amount_used");
  assert.equal(await grantRevoked(grant.grant_id), true);
  assert.notEqual((await pool!.query("SELECT ended_at FROM room_agent_sessions WHERE session_id=$1", [worker.session_id])).rows[0].ended_at, null);
  assert.ok((await roomText(s.room.id)).includes("john's agent used the 10% john gave and has left."));
  assert.equal(await asks!.endAsk(await fresh(row.id), "amount_used"), null);
});

test("the sweep expires old links, frees stale claims, and pauses, resumes and ends offline agents", options, async () => {
  const s = await seed();
  const old = await ask(s);
  await pool!.query("UPDATE agent_asks SET expires_at = now() - interval '1 second' WHERE id=$1", [old.row.id]);
  const stale = await ask(s);
  await asks!.claimAsk(stale.row, s.john.id);
  await pool!.query("UPDATE agent_asks SET claim_expires_at = now() - interval '1 second' WHERE id=$1", [stale.row.id]);
  const running = await ask(s);
  const { worker } = await launch(s, running.row);
  await pool!.query("UPDATE room_agent_sessions SET last_seen_at = now() - interval '10 minutes' WHERE session_id=$1", [worker.session_id]);

  await asks!.sweepAgentAsks();
  assert.equal((await fresh(old.row.id)).state, "expired");
  assert.equal((await fresh(stale.row.id)).state, "open");
  assert.equal((await fresh(running.row.id)).state, "paused");

  await pool!.query("UPDATE room_agent_sessions SET last_seen_at = now() WHERE session_id=$1", [worker.session_id]);
  await asks!.sweepAgentAsks();
  assert.equal((await fresh(running.row.id)).state, "active");

  await pool!.query("UPDATE room_agent_sessions SET last_seen_at = now() - interval '10 minutes' WHERE session_id=$1", [worker.session_id]);
  await asks!.sweepAgentAsks();
  await pool!.query("UPDATE agent_asks SET paused_at = now() - interval '25 hours' WHERE id=$1", [running.row.id]);
  await asks!.sweepAgentAsks();
  const done = await fresh(running.row.id);
  assert.equal(done.state, "ended");
  assert.equal(done.ended_reason, "offline");
  const text = await roomText(s.room.id);
  for (const line of ["john's agent is offline.", "john's agent is back.", "john's agent was offline for a day and has left."]) assert.ok(text.includes(line), line);
});

test("a cancelled or expired link can't be claimed", options, async () => {
  const s = await seed(); const { row, token } = await ask(s);
  await asks!.cancelAsk(row);
  assert.equal((await asks!.getAskByToken(token))?.state, "cancelled");
  assert.equal(await asks!.claimAsk(await fresh(row.id), s.john.id), null);
});
