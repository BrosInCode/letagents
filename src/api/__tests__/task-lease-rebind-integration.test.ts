import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = "true";
process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "true";

const client = testDatabaseUrl ? await import("../db/client.js") : null;
const db = testDatabaseUrl ? await import("../db.js") : null;
const schema = testDatabaseUrl ? await import("../db/schema.js") : null;
const { rebindTaskLease, assertLeaseEpochCurrentTx, recordRebindAttestation } = await import("../db/coordination/lease-rebind.js");
const { applyTaskWorkLeaseAction } = await import("../db/coordination/work-lease-actions.js");
const { releaseTaskLease } = await import("../db/coordination/task-leases.js");
const { upsertStaleTaskPromptMute, getStaleTaskPromptMutes } = await import("../db/coordination/stale-task-prompt-mutes.js");
const { createFocusRoomForTask, getActiveFocusRoomForTask, concludeFocusRoom } = await import("../db/focus-rooms.js");

async function reset(): Promise<void> {
  if (!client) throw new Error("DB-backed rebind tests require TEST_DB_URL");
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

if (!requiresDatabase) {
  test.beforeEach(reset);
  test.after(async () => { await client?.pool.end(); });
}

let ordinal = 0;

async function seed(options: { endFrom?: boolean; successorUnderGrant?: boolean; recordAttestation?: boolean } = {}) {
  const n = ++ordinal;
  const ownerId = `owner_rebind_${n}`;
  await client!.db.insert(schema!.accounts).values({
    id: ownerId, provider: "github", provider_user_id: ownerId, login: ownerId, display_name: ownerId,
    avatar_url: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const room = await db!.createProjectWithName(`rebind-room-${n}`);
  const agentKey = `owner/rebind-agent-${n}`;

  const grant = (await db!.createSupervisorHostGrant({
    owner_account_id: ownerId, host_id: `host_${n}`, installation_id: `install_${n}`,
    allowed_room_ids: [room.id], allowed_agent_keys: [agentKey],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  })).grant;

  // Both predecessor and successor are minted UNDER this grant (the supervised
  // path). The wrong-host case omits the successor's supervisor_grant_id so the
  // rebind must reject it.
  const from = await db!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "codex",
    actor_label: `From${n} | Owner's agent | Agent`, agent_key: agentKey, agent_instance_id: `inst_from_${n}`,
    display_name: `From${n}`, owner_account_id: ownerId, owner_label: "Owner", ide_label: "Agent",
    supervisor_grant_id: grant.grant_id,
  });
  const to = await db!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "codex",
    actor_label: `To${n} | Owner's agent | Agent`, agent_key: agentKey, agent_instance_id: `inst_to_${n}`,
    display_name: `To${n}`, owner_account_id: ownerId, owner_label: "Owner", ide_label: "Agent",
    supervisor_grant_id: options.successorUnderGrant === false ? null : grant.grant_id,
  });

  const lease = await db!.createTaskLease({
    room_id: room.id, task_id: `task_${n}`, kind: "work", agent_key: agentKey,
    actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
  });

  if (options.endFrom !== false) {
    await db!.endRoomAgentSession({ session_id: from.session_id });
  }

  const fence = { grant_id: grant.grant_id, generation: grant.current_generation, token_version: grant.token_version };

  // A rebind now requires the EXACT terminal attestation for the predecessor
  // tuple. Record the matching one by default (through the real accessor, which
  // validates authority in-tx) so the success paths exercise the full
  // require+match+consume flow; negative tests pass recordAttestation:false and
  // craft their own (missing / stale-generation / wrong-tuple) case. Recording
  // is only possible for a terminal predecessor, so endFrom:false skips it.
  const workAttemptId = randomUUID();
  const executionGenerationId = randomUUID();
  let attestation: { id: string } | null = null;
  if (options.recordAttestation !== false && options.endFrom !== false) {
    const recorded = await recordRebindAttestation({
      lease_id: lease.id, epoch: 0, from_agent_session_id: from.session_id,
      supervisor_grant_fence: fence,
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId, cause: "crashed",
    });
    assert.equal(recorded.ok, true, `seed attestation recorded: ${JSON.stringify(recorded)}`);
    attestation = (recorded as { ok: true; attestation: { id: string } }).attestation;
  }

  return { room, ownerId, agentKey, from, to, grant, lease, fence, attestation, workAttemptId, executionGenerationId };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

// The full rebind input for a seeded scenario; individual tests override the
// fields under attack.
function rebindArgs(s: Seeded, over: Record<string, unknown> = {}) {
  return {
    lease_id: s.lease.id, expected_epoch: 0,
    from_agent_session_id: s.from.session_id, to_agent_session_id: s.to.session_id,
    supervisor_grant_fence: s.fence,
    attestation_id: s.attestation?.id ?? "tlra_absent",
    work_attempt_id: s.workAttemptId, execution_generation_id: s.executionGenerationId,
    ...over,
  } as Parameters<typeof rebindTaskLease>[0];
}

// Adversarial attestation rows are inserted directly: the accessor now
// default-denies forged tuples/generations, so crafting hostile DB state must
// bypass it — the point is that rebind rejects such rows however they arrived.
async function insertAttestationRow(values: {
  room_id: string; lease_id: string; epoch: number; from_agent_session_id: string;
  grant_id: string; supervisor_generation: number;
  work_attempt_id?: string; execution_generation_id?: string; cause?: string;
}) {
  const now = new Date().toISOString();
  const row = {
    id: `tlra_test_${++ordinal}`,
    work_attempt_id: randomUUID(), execution_generation_id: randomUUID(), cause: "crashed",
    ...values,
    attested_at: now, consumed_at: null, consumed_by_epoch: null, created_at: now, updated_at: now,
  };
  await client!.db.insert(schema!.task_lease_rebind_attestations).values(row);
  return row;
}

async function leaseRow(id: string) {
  const [row] = await client!.db.select().from(schema!.task_leases).where(eq(schema!.task_leases.id, id)).limit(1);
  return row;
}

async function attestationRow(id: string) {
  const [row] = await client!.db.select().from(schema!.task_lease_rebind_attestations).where(eq(schema!.task_lease_rebind_attestations.id, id)).limit(1);
  return row;
}

test("rebind moves the lease, bumps epoch, revokes the predecessor, and stale epoch loses", { skip: requiresDatabase }, async () => {
  const s = await seed();
  const first = await rebindTaskLease(rebindArgs(s));
  assert.equal(first.ok, true);
  const row = await leaseRow(s.lease.id);
  assert.equal(row.epoch, 1);
  assert.equal(row.agent_session_id, s.to.session_id);
  assert.equal(row.agent_key, s.to.agent_key);
  // The terminal attestation was consumed exactly once, stamped with the new epoch.
  const att = await attestationRow(s.attestation!.id);
  assert.ok(att.consumed_at, "attestation marked consumed");
  assert.equal(att.consumed_by_epoch, 1, "consumed_by_epoch records the resulting epoch");
  // A second attempt at the now-stale epoch loses the CAS.
  const stale = await rebindTaskLease(rebindArgs(s));
  assert.equal(stale.ok, false);
  assert.equal((stale as { reason: string }).reason, "lost_race");
});

test("a non-terminal (still-running) predecessor cannot be displaced", { skip: requiresDatabase }, async () => {
  // endFrom:false → the predecessor session is NOT ended. Reachability is not
  // termination, so the rebind must refuse — only a genuinely ended predecessor
  // may be replaced (§4.5 conservative floor).
  const s = await seed({ endFrom: false });
  const result = await rebindTaskLease(rebindArgs(s));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "predecessor_live");
});

test("a same-room/same-key successor NOT minted under this grant is rejected (wrong host/authority)", { skip: requiresDatabase }, async () => {
  // successorUnderGrant:false → the `to` session has the same agent_key/room/owner
  // but no supervisor_grant_id binding it to this grant, i.e. a session another
  // host registered under the same canonical key. Must not receive the lease.
  const s = await seed({ successorUnderGrant: false });
  const result = await rebindTaskLease(rebindArgs(s));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "session_mismatch");
  assert.equal((await leaseRow(s.lease.id)).agent_session_id, s.from.session_id, "lease stayed with the predecessor");
});

test("a grant that does not cover the room+agent identity is rejected", { skip: requiresDatabase }, async () => {
  const s = await seed();
  // Forge a fence for a grant scoped to nothing relevant (different agent key).
  const otherOwner = `owner_scope_${ordinal}`;
  await client!.db.insert(schema!.accounts).values({
    id: otherOwner, provider: "github", provider_user_id: otherOwner, login: otherOwner, display_name: otherOwner,
    avatar_url: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const wrong = (await db!.createSupervisorHostGrant({
    owner_account_id: otherOwner, host_id: "host_x", installation_id: "install_x",
    allowed_room_ids: ["room_nope"], allowed_agent_keys: ["owner/nope"],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  })).grant;
  const result = await rebindTaskLease(rebindArgs(s, {
    supervisor_grant_fence: { grant_id: wrong.grant_id, generation: wrong.current_generation, token_version: wrong.token_version },
  }));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "grant_scope");
});

test("a stale grant fence (wrong generation) is rejected", { skip: requiresDatabase }, async () => {
  const s = await seed();
  const result = await rebindTaskLease(rebindArgs(s, { supervisor_grant_fence: { ...s.fence, generation: s.fence.generation + 1 } }));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "grant_fence_stale");
});

test("concurrent rebinds resolve to exactly one winner", { skip: requiresDatabase }, async () => {
  const s = await seed();
  const results = await Promise.allSettled([
    rebindTaskLease(rebindArgs(s)),
    rebindTaskLease(rebindArgs(s)),
  ]);
  const oks = results.filter((r) => r.status === "fulfilled" && (r.value as { ok: boolean }).ok).length;
  const lost = results.filter((r) => r.status === "fulfilled" && !(r.value as { ok: boolean }).ok && (r.value as { reason?: string }).reason === "lost_race").length;
  assert.equal(oks, 1);
  assert.equal(lost, 1);
  assert.equal((await leaseRow(s.lease.id)).epoch, 1);
});

test("a review lease is not rebindable — the generic route rejects the non-work kind", { skip: requiresDatabase }, async () => {
  // A review lease's authority cannot be proven by the work-attempt terminal
  // attestation the rebind consumes (§4.5). The rebind must refuse it outright
  // so a dead reviewer's review lease is released, never silently moved.
  const s = await seed();
  const reviewLease = await db!.createTaskLease({
    room_id: s.room.id, task_id: `task_review_${ordinal}`, kind: "review", agent_key: s.from.agent_key,
    actor_label: s.from.actor_label, created_by: s.from.actor_label, agent_session_id: s.from.session_id,
  });
  const result = await rebindTaskLease(rebindArgs(s, { lease_id: reviewLease.id }));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "kind_not_rebindable");
  assert.equal((await leaseRow(reviewLease.id)).agent_session_id, s.from.session_id, "review lease stayed put");
});

test("a rebind without a terminal attestation is rejected", { skip: requiresDatabase }, async () => {
  // Session-ended alone is not enough (§4.5): with no persisted attestation for
  // the predecessor tuple, the rebind must refuse — the supervisor never
  // attested the termination.
  const s = await seed({ recordAttestation: false });
  const result = await rebindTaskLease(rebindArgs(s));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "attestation_missing");
  assert.equal((await leaseRow(s.lease.id)).agent_session_id, s.from.session_id, "lease stayed with the predecessor");
});

test("an attestation authored at a stale grant generation is rejected", { skip: requiresDatabase }, async () => {
  // The attestation binds to the grant generation that authored it. A rebind
  // presenting the CURRENT fence must reject an attestation minted at a
  // different generation — otherwise a rotated-out supervisor's stale proof
  // could still move a lease. (The row is force-inserted: the accessor refuses
  // to author such evidence, but rebind must reject it however it arrived.)
  const s = await seed({ recordAttestation: false });
  const stale = await insertAttestationRow({
    room_id: s.room.id, lease_id: s.lease.id, epoch: 0, from_agent_session_id: s.from.session_id,
    grant_id: s.grant.grant_id, supervisor_generation: s.fence.generation + 1,
  });
  const result = await rebindTaskLease(rebindArgs(s, {
    attestation_id: stale.id, work_attempt_id: stale.work_attempt_id, execution_generation_id: stale.execution_generation_id,
  }));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "attestation_stale");
  assert.equal((await leaseRow(s.lease.id)).agent_session_id, s.from.session_id, "lease stayed with the predecessor");
});

test("an attestation for a different predecessor tuple does not authorize the rebind", { skip: requiresDatabase }, async () => {
  // The attestation is bound to {lease, epoch, from-session}. One recorded for a
  // different session (here the successor's) is not a match, so the rebind of
  // the real predecessor finds no un-consumed proof and refuses.
  const s = await seed({ recordAttestation: false });
  const other = await insertAttestationRow({
    room_id: s.room.id, lease_id: s.lease.id, epoch: 0, from_agent_session_id: s.to.session_id,
    grant_id: s.grant.grant_id, supervisor_generation: s.fence.generation,
  });
  const result = await rebindTaskLease(rebindArgs(s, {
    attestation_id: other.id, work_attempt_id: other.work_attempt_id, execution_generation_id: other.execution_generation_id,
  }));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "attestation_missing");
});

test("the rebind must present the EXACT pending proof — wrong id/attempt/generation is rejected un-consumed", { skip: requiresDatabase }, async () => {
  // §4.5 exact-tuple: naming a different attestation id, work attempt, or
  // execution generation than the pending proof must fail — a rebind may never
  // consume "whichever pending proof happens to exist". Includes the cross-lease
  // case: lease B's real pending attestation id presented against lease A.
  const s = await seed();
  const other = await seed(); // second scenario with its own pending attestation

  for (const over of [
    { attestation_id: other.attestation!.id, work_attempt_id: other.workAttemptId, execution_generation_id: other.executionGenerationId },
    { attestation_id: `tlra_forged_${ordinal}` },
    { work_attempt_id: randomUUID() },
    { execution_generation_id: randomUUID() },
  ]) {
    const result = await rebindTaskLease(rebindArgs(s, over));
    assert.equal(result.ok, false, `rejected for ${JSON.stringify(over)}`);
    assert.equal((result as { reason: string }).reason, "attestation_mismatch");
  }
  // Nothing was consumed and the lease did not move.
  assert.equal((await attestationRow(s.attestation!.id)).consumed_at, null, "proof not consumed by any mismatched attempt");
  assert.equal((await attestationRow(other.attestation!.id)).consumed_at, null, "other lease's proof untouched");
  assert.equal((await leaseRow(s.lease.id)).agent_session_id, s.from.session_id);

  // The exact tuple still works afterwards.
  const exact = await rebindTaskLease(rebindArgs(s));
  assert.equal(exact.ok, true);
});

test("a consumed attestation cannot authorize a second rebind (one-time consumption)", { skip: requiresDatabase }, async () => {
  // The one-time guard is independent of the epoch CAS. After a successful
  // rebind consumes the attestation, we contrive the lease back to the
  // predecessor at epoch 0 (as if the CAS would pass again). The spent
  // attestation must STILL block the replay.
  const s = await seed();
  const first = await rebindTaskLease(rebindArgs(s));
  assert.equal(first.ok, true);
  await client!.db.update(schema!.task_leases)
    .set({ agent_session_id: s.from.session_id, epoch: 0 })
    .where(eq(schema!.task_leases.id, s.lease.id));
  const replay = await rebindTaskLease(rebindArgs(s));
  assert.equal(replay.ok, false);
  assert.equal((replay as { reason: string }).reason, "attestation_missing");
});

test("a lost final lease CAS ROLLS BACK the consumption and revocation (rollback-does-not-consume)", { skip: requiresDatabase }, async () => {
  // msg_938 blocker 3: consumption/revocation run before the final lease CAS.
  // If that CAS matches no row, the transaction must ROLL BACK — a plain
  // `return {ok:false}` would COMMIT the consumed proof and revoked bearer
  // without moving the lease, permanently burning the one-time attestation.
  //
  // Interleaving: a raw connection UPDATEs the lease row (taking its ROW lock,
  // not the advisory lock) and holds the transaction open. The rebind's
  // validating SELECTs proceed under MVCC (they see the committed epoch-0 row),
  // it revokes the bearer and consumes the attestation, then its final lease
  // UPDATE blocks on the row lock. When the raw transaction commits epoch 1,
  // the rebind's UPDATE re-evaluates its WHERE, matches 0 rows, and the
  // rollback sentinel aborts the whole transaction.
  const s = await seed();
  const holder = await client!.pool.connect();
  let result: Awaited<ReturnType<typeof rebindTaskLease>>;
  try {
    await holder.query("BEGIN");
    await holder.query("UPDATE task_leases SET epoch = epoch + 1, updated_at = now() WHERE id = $1", [s.lease.id]);
    const rebindPromise = rebindTaskLease(rebindArgs(s));
    // Let the rebind pass validation + consumption and block on the row lock.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await holder.query("COMMIT");
    result = await rebindPromise;
  } finally {
    holder.release();
  }
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "lost_race");
  // The one-time proof survived the lost race — nothing was consumed…
  assert.equal((await attestationRow(s.attestation!.id)).consumed_at, null, "attestation NOT consumed by the failed rebind");
  // …and the lease did not move to the successor.
  const row = await leaseRow(s.lease.id);
  assert.equal(row.agent_session_id, s.from.session_id, "lease still with the predecessor");
  assert.equal(row.epoch, 1, "only the raw writer's epoch bump landed");
  // The exact proof is still spendable once the supervisor re-reads state:
  // re-attest is unnecessary — the pending row can authorize a rebind at the
  // epoch it names only; here it names epoch 0, so a fresh flow would re-attest.
});

test("attestation evidence is immutable: identical retry is idempotent, conflicting retry is refused", { skip: requiresDatabase }, async () => {
  // msg_938 blocker 1: recorded evidence is never overwritten. An identical
  // retry returns the original row untouched; a retry with ANY differing
  // evidence fails and leaves the original in place.
  const s = await seed();
  const before = await attestationRow(s.attestation!.id);

  const identical = await recordRebindAttestation({
    lease_id: s.lease.id, epoch: 0, from_agent_session_id: s.from.session_id,
    supervisor_grant_fence: s.fence,
    work_attempt_id: s.workAttemptId, execution_generation_id: s.executionGenerationId, cause: "crashed",
  });
  assert.equal(identical.ok, true);
  assert.equal((identical as { created: boolean }).created, false, "identical retry did not create a new row");
  assert.equal((identical as { attestation: { id: string } }).attestation.id, s.attestation!.id);

  const conflicting = await recordRebindAttestation({
    lease_id: s.lease.id, epoch: 0, from_agent_session_id: s.from.session_id,
    supervisor_grant_fence: s.fence,
    work_attempt_id: s.workAttemptId, execution_generation_id: randomUUID(), cause: "killed",
  });
  assert.equal(conflicting.ok, false);
  assert.equal((conflicting as { reason: string }).reason, "evidence_conflict");

  const after = await attestationRow(s.attestation!.id);
  assert.deepEqual(after, before, "the recorded evidence is byte-identical after both retries");
});

test("recordRebindAttestation default-denies internally: cause enum, UUID ids, lease/holder/epoch, terminal predecessor, grant scope", { skip: requiresDatabase }, async () => {
  // msg_938/msg_944: the persistence helper itself validates authority inside
  // the locked transaction — even a direct internal caller cannot persist
  // arbitrary cause/from/epoch under an otherwise-scoped grant.
  const s = await seed({ recordAttestation: false });
  const base = {
    lease_id: s.lease.id, epoch: 0, from_agent_session_id: s.from.session_id,
    supervisor_grant_fence: s.fence,
    work_attempt_id: s.workAttemptId, execution_generation_id: s.executionGenerationId, cause: "crashed",
  };
  const expectReason = async (input: typeof base, reason: string) => {
    const result = await recordRebindAttestation(input);
    assert.equal(result.ok, false, `${reason}: rejected`);
    assert.equal((result as { reason: string }).reason, reason);
  };

  await expectReason({ ...base, cause: "sdf" }, "invalid_cause");
  await expectReason({ ...base, work_attempt_id: "wa_not_a_uuid" }, "invalid_execution_identity");
  await expectReason({ ...base, execution_generation_id: "42" }, "invalid_execution_identity");
  await expectReason({ ...base, lease_id: "tl_nope" }, "lease_not_found");
  await expectReason({ ...base, epoch: 5 }, "lease_mismatch");
  await expectReason({ ...base, from_agent_session_id: s.to.session_id }, "lease_mismatch");
  await expectReason({ ...base, supervisor_grant_fence: { ...s.fence, generation: s.fence.generation + 1 } }, "grant_fence_stale");

  // A live (not ended) predecessor cannot be attested terminal.
  const live = await seed({ endFrom: false, recordAttestation: false });
  await expectReason({
    ...base, lease_id: live.lease.id, from_agent_session_id: live.from.session_id, supervisor_grant_fence: live.fence,
  }, "predecessor_live");

  // A grant that does not scope the lease's room/agent cannot author evidence.
  await expectReason({ ...base, supervisor_grant_fence: live.fence }, "grant_scope");

  // A review lease is not attestable work state.
  const reviewLease = await db!.createTaskLease({
    room_id: s.room.id, task_id: `task_att_review_${ordinal}`, kind: "review", agent_key: s.from.agent_key,
    actor_label: s.from.actor_label, created_by: s.from.actor_label, agent_session_id: s.from.session_id,
  });
  await expectReason({ ...base, lease_id: reviewLease.id }, "lease_mismatch");

  // Nothing above persisted a row.
  const rows = await client!.db.select().from(schema!.task_lease_rebind_attestations);
  assert.equal(rows.length, 0, "no attestation rows written by denied calls");

  // And the untouched valid tuple still records.
  const ok = await recordRebindAttestation(base);
  assert.equal(ok.ok, true);
});

test("acquireLeaseFenceTx accepts the current tuple and rejects a rebound-away predecessor", { skip: requiresDatabase }, async () => {
  const s = await seed();
  const { acquireLeaseFenceTx } = await import("../db/coordination/lease-rebind.js");
  // Before rebind: the predecessor's full tuple at epoch 0 is valid.
  await client!.db.transaction(async (tx) => {
    const row = await acquireLeaseFenceTx(tx, { lease_id: s.lease.id, room_id: s.room.id, task_id: s.lease.task_id, kind: "work", expected_epoch: 0, agent_session_id: s.from.session_id });
    assert.ok(row, "current holder's tuple is accepted");
  });
  await rebindTaskLease(rebindArgs(s));
  await client!.db.transaction(async (tx) => {
    // Predecessor tuple (old session, epoch 0) is now stale → null.
    const stale = await acquireLeaseFenceTx(tx, { lease_id: s.lease.id, room_id: s.room.id, task_id: s.lease.task_id, kind: "work", expected_epoch: 0, agent_session_id: s.from.session_id });
    assert.equal(stale, null, "rebound-away predecessor is rejected");
    // Successor tuple (new session, epoch 1) is valid.
    const current = await acquireLeaseFenceTx(tx, { lease_id: s.lease.id, room_id: s.room.id, task_id: s.lease.task_id, kind: "work", expected_epoch: 1, agent_session_id: s.to.session_id });
    assert.ok(current, "successor's current tuple is accepted");
  });
});

test("the epoch guard rejects a partitioned predecessor's stale epoch after rebind", { skip: requiresDatabase }, async () => {
  const s = await seed();
  await rebindTaskLease(rebindArgs(s));
  await client!.db.transaction(async (tx) => {
    // Predecessor still believes it holds epoch 0 on its old session → rejected.
    assert.equal(await assertLeaseEpochCurrentTx(tx, { lease_id: s.lease.id, expected_epoch: 0, agent_session_id: s.from.session_id }), false);
    // The successor at the current epoch is accepted.
    assert.equal(await assertLeaseEpochCurrentTx(tx, { lease_id: s.lease.id, expected_epoch: 1, agent_session_id: s.to.session_id }), true);
  });
});

test("updateTask fence aborts a stale write when a rebind commits first (barrier) — zero side effect, current epoch succeeds", { skip: requiresDatabase }, async () => {
  // Barrier per §4.5: an authenticated worker's task write and a supervisor
  // rebind race for the same lease. Both take the `task_lease:<id>` advisory
  // lock, so they linearize. We force "rebind first" deterministically by
  // holding that exact lock on a dedicated connection before firing the write,
  // so updateTask blocks at acquireLeaseFenceTx; we commit the rebind under the
  // held lock, release, and the resumed write must observe the advanced epoch
  // and abort with LeaseFenceStaleError, leaving the task untouched.
  const { updateTask } = await import("../db/tasks.js");
  const { room, from, to } = await seed();
  const task = await db!.createTask(room.id, "fenced task", from.actor_label);
  const lease = await db!.createTaskLease({
    room_id: room.id, task_id: task.id, kind: "work", agent_key: from.agent_key,
    actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
  });
  const leaseFence = {
    lease_id: lease.id, room_id: room.id, task_id: task.id, kind: "work" as const,
    expected_epoch: 0, agent_session_id: from.session_id,
  };
  const initialPrUrl = task.pr_url ?? null;

  const holder = await client!.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`task_lease:${lease.id}`]);

    // Fire the guarded write; it progresses to the fence and blocks on the lock.
    const writePromise = updateTask(room.id, task.id, { pr_url: "https://example.com/pr/stale" }, { leaseFence });

    // A rebind commits while the write waits: repoint to the successor, bump epoch.
    await holder.query(
      "UPDATE task_leases SET agent_session_id = $1, epoch = epoch + 1, updated_at = now() WHERE id = $2",
      [to.session_id, lease.id],
    );
    await holder.query("COMMIT"); // releases the lock

    await assert.rejects(writePromise, (err: Error) => err.name === "LeaseFenceStaleError");
  } finally {
    holder.release();
  }

  // Zero side effect: the stale write never landed. (tasks has no `id` column —
  // canonical id is scoped/derived — so read back through getTaskById.)
  const taskRow = await db!.getTaskById(room.id, task.id);
  assert.equal(taskRow?.pr_url ?? null, initialPrUrl, "the rebound-away predecessor's write did not land");

  // The successor, presenting the current fence, writes successfully.
  const ok = await updateTask(room.id, task.id, { pr_url: "https://example.com/pr/successor" }, {
    leaseFence: { lease_id: lease.id, room_id: room.id, task_id: task.id, kind: "work", expected_epoch: 1, agent_session_id: to.session_id },
  });
  assert.equal(ok?.pr_url, "https://example.com/pr/successor");
});

test("publishWorkerArtifactFenced aborts atomically when a rebind commits first (barrier) — no artifact, no link", { skip: requiresDatabase }, async () => {
  // Same barrier as the task-write test, applied to the artifact upsert+link:
  // the two writes must be atomic AND fenced, so a rebind committing mid-publish
  // leaves neither an orphan artifact nor a stale task binding.
  const { publishWorkerArtifactFenced } = await import("../db/room-shared-artifacts.js");
  const { room, from, to } = await seed();
  const task = await db!.createTask(room.id, "artifact task", from.actor_label);
  const lease = await db!.createTaskLease({
    room_id: room.id, task_id: task.id, kind: "work", agent_key: from.agent_key,
    actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
  });
  const leaseFence = {
    lease_id: lease.id, room_id: room.id, task_id: task.id, kind: "work" as const,
    expected_epoch: 0, agent_session_id: from.session_id,
  };
  const artifact = { provider: "github" as const, kind: "commit" as const, id: "sha_barrier" };

  const holder = await client!.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`task_lease:${lease.id}`]);
    const publishPromise = publishWorkerArtifactFenced({ leaseFence, room_id: room.id, artifact, linked_task_id: task.id });
    await holder.query(
      "UPDATE task_leases SET agent_session_id = $1, epoch = epoch + 1, updated_at = now() WHERE id = $2",
      [to.session_id, lease.id],
    );
    await holder.query("COMMIT");
    await assert.rejects(publishPromise, (err: Error) => err.name === "LeaseFenceStaleError");
  } finally {
    holder.release();
  }

  const arts = await client!.db.select().from(schema!.room_shared_artifacts).where(eq(schema!.room_shared_artifacts.room_id, room.id));
  assert.equal(arts.length, 0, "no artifact upserted by the aborted publish");
  const links = await client!.db.select().from(schema!.room_shared_artifact_tasks).where(eq(schema!.room_shared_artifact_tasks.room_id, room.id));
  assert.equal(links.length, 0, "no task link by the aborted publish");

  const ok = await publishWorkerArtifactFenced({
    leaseFence: { ...leaseFence, expected_epoch: 1, agent_session_id: to.session_id },
    room_id: room.id, artifact, linked_task_id: task.id,
  });
  assert.ok(ok.identity_key, "successor at the current epoch publishes");
});

test("stale-prompt mute + focus-room open honor the work-lease fence (stale tuple aborts with no write)", { skip: requiresDatabase }, async () => {
  const { room, from } = await seed();
  const task = await db!.createTask(room.id, "fenced surface task", from.actor_label);
  await db!.createTaskLease({
    room_id: room.id, task_id: task.id, kind: "work", agent_key: from.agent_key,
    actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
  });
  const staleFence = { lease_id: "tl_missing", room_id: room.id, task_id: task.id, kind: "work" as const, expected_epoch: 9, agent_session_id: from.session_id };
  const current = async () => {
    const [lease] = await db!.getActiveTaskLeases(room.id, task.id);
    return { lease_id: lease.id, room_id: room.id, task_id: task.id, kind: "work" as const, expected_epoch: lease.epoch, agent_session_id: from.session_id };
  };

  // stale-prompt mute
  await assert.rejects(upsertStaleTaskPromptMute({ room_id: room.id, task_id: task.id, task_updated_at: task.updated_at, muted_by: from.actor_label }, staleFence), (e: Error) => e.name === "LeaseFenceStaleError");
  assert.equal((await getStaleTaskPromptMutes(room.id, [task.id])).length, 0, "no mute row from the aborted write");
  await upsertStaleTaskPromptMute({ room_id: room.id, task_id: task.id, task_updated_at: task.updated_at, muted_by: from.actor_label }, await current());
  assert.equal((await getStaleTaskPromptMutes(room.id, [task.id])).length, 1, "current fence writes the mute");

  // focus-room open
  await assert.rejects(createFocusRoomForTask(room.id, task.id, { leaseFence: staleFence }), (e: Error) => e.name === "LeaseFenceStaleError");
  assert.equal(await getActiveFocusRoomForTask(room.id, task.id), undefined, "no focus room from the aborted open");
  const opened = await createFocusRoomForTask(room.id, task.id, { leaseFence: await current() });
  assert.equal(opened?.created, true, "current fence opens the focus room");
});

test("concludeFocusRoom honors the work-lease fence (stale tuple aborts, room stays active; current tuple concludes)", { skip: requiresDatabase }, async () => {
  const { room, from } = await seed();
  const task = await db!.createTask(room.id, "focus conclude task", from.actor_label);
  await db!.createTaskLease({
    room_id: room.id, task_id: task.id, kind: "work", agent_key: from.agent_key,
    actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
  });
  const [lease] = await db!.getActiveTaskLeases(room.id, task.id);
  const currentFence = { lease_id: lease.id, room_id: room.id, task_id: task.id, kind: "work" as const, expected_epoch: lease.epoch, agent_session_id: from.session_id };
  const staleFence = { ...currentFence, expected_epoch: 99 };

  const opened = await createFocusRoomForTask(room.id, task.id, { leaseFence: currentFence });
  assert.equal(opened?.created, true);

  // Stale fence → conclude aborts, room remains active.
  await assert.rejects(concludeFocusRoom(room.id, task.id, "done", null, staleFence), (e: Error) => e.name === "LeaseFenceStaleError");
  assert.equal((await getActiveFocusRoomForTask(room.id, task.id))?.focus_status, "active", "focus room still active after aborted conclude");

  // Current fence → concludes.
  const concluded = await concludeFocusRoom(room.id, task.id, "done", null, currentFence);
  assert.equal(concluded?.updated, true);
  assert.equal(await getActiveFocusRoomForTask(room.id, task.id), undefined, "no active focus room after conclude");
});

test("releaseTaskLease fence: only the current active holder tuple releases; stale/mismatch is a no-op", { skip: requiresDatabase }, async () => {
  // review-lease release surface: the CAS + advisory lock make a stale or
  // double release a no-op (null) instead of acting on moved/gone state.
  const { room, from, to } = await seed();
  const task = await db!.createTask(room.id, "review task", from.actor_label);
  const lease = await db!.createTaskLease({
    room_id: room.id, task_id: task.id, kind: "review", agent_key: from.agent_key,
    actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
  });

  // Wrong epoch → no-op.
  assert.equal(await releaseTaskLease(room.id, lease.id, { kind: "review", expected_epoch: 1, expected_agent_session_id: from.session_id }), null);
  // Wrong session → no-op.
  assert.equal(await releaseTaskLease(room.id, lease.id, { kind: "review", expected_epoch: 0, expected_agent_session_id: to.session_id }), null);
  // Wrong kind → no-op.
  assert.equal(await releaseTaskLease(room.id, lease.id, { kind: "work", expected_epoch: 0, expected_agent_session_id: from.session_id }), null);
  assert.equal((await leaseRow(lease.id)).status, "active", "no mismatched call touched the lease");

  // Correct tuple → releases.
  const ok = await releaseTaskLease(room.id, lease.id, { kind: "review", expected_epoch: 0, expected_agent_session_id: from.session_id });
  assert.equal(ok?.status, "released");
  // Double release (now inactive) → no-op.
  assert.equal(await releaseTaskLease(room.id, lease.id, { kind: "review", expected_epoch: 0, expected_agent_session_id: from.session_id }), null);
});

test("updateTask fenced side-effects (task + lease ref + artifacts) roll back atomically on a mid-write rebind", { skip: requiresDatabase }, async () => {
  // Blocker 2: the pr_url lease-ref bind and the shared-artifact upsert/link now
  // run inside the fenced tx. A rebind committing mid-write must abort ALL of
  // them together — no task pr_url, no lease ref, no artifact, no link.
  const { updateTask } = await import("../db/tasks.js");
  const { room, from, to } = await seed();
  const task = await db!.createTask(room.id, "atomic task", from.actor_label);
  const lease = await db!.createTaskLease({
    room_id: room.id, task_id: task.id, kind: "work", agent_key: from.agent_key,
    actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
  });
  const leaseFence = {
    lease_id: lease.id, room_id: room.id, task_id: task.id, kind: "work" as const,
    expected_epoch: 0, agent_session_id: from.session_id,
  };

  const holder = await client!.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`task_lease:${lease.id}`]);
    const writePromise = updateTask(
      room.id, task.id,
      {
        pr_url: "https://example.com/pr/atomic",
        workflow_artifacts: [{ provider: "github", kind: "pull_request", url: "https://example.com/pr/atomic" }],
      },
      { leaseFence },
    );
    await holder.query(
      "UPDATE task_leases SET agent_session_id = $1, epoch = epoch + 1, updated_at = now() WHERE id = $2",
      [to.session_id, lease.id],
    );
    await holder.query("COMMIT");
    await assert.rejects(writePromise, (err: Error) => err.name === "LeaseFenceStaleError");
  } finally {
    holder.release();
  }

  const taskRow = await db!.getTaskById(room.id, task.id);
  assert.equal(taskRow?.pr_url ?? null, null, "task pr_url not written");
  const leaseAfter = await leaseRow(lease.id);
  assert.equal(leaseAfter.pr_url ?? null, null, "lease pr_url ref not bound");
  const arts = await client!.db.select().from(schema!.room_shared_artifacts).where(eq(schema!.room_shared_artifacts.room_id, room.id));
  assert.equal(arts.length, 0, "no artifact upserted");
  const links = await client!.db.select().from(schema!.room_shared_artifact_tasks).where(eq(schema!.room_shared_artifact_tasks.room_id, room.id));
  assert.equal(links.length, 0, "no artifact-task link");
});

test("a stale-epoch lease-action cannot release the successor's rebound lease, but the current epoch can", { skip: requiresDatabase }, async () => {
  const s = await seed();
  // A real task row is required — applyTaskWorkLeaseAction resolves the task by
  // {room_id, number} and returns task_not_found otherwise. Bind the lease to it.
  const task = await db!.createTask(s.room.id, "lease-action task", s.from.actor_label);
  const lease = await db!.createTaskLease({
    room_id: s.room.id, task_id: task.id, kind: "work", agent_key: s.from.agent_key,
    actor_label: s.from.actor_label, created_by: s.from.actor_label, agent_session_id: s.from.session_id,
  });
  // This test creates its own lease (not the seed's), so attest its predecessor
  // through the real accessor.
  const wa = randomUUID();
  const eg = randomUUID();
  const recorded = await recordRebindAttestation({
    lease_id: lease.id, epoch: 0, from_agent_session_id: s.from.session_id,
    supervisor_grant_fence: s.fence, work_attempt_id: wa, execution_generation_id: eg, cause: "crashed",
  });
  assert.equal(recorded.ok, true);
  // Predecessor observed epoch 0; rebind commits epoch 1 to the successor.
  const rebind = await rebindTaskLease({
    lease_id: lease.id, expected_epoch: 0, from_agent_session_id: s.from.session_id, to_agent_session_id: s.to.session_id,
    supervisor_grant_fence: s.fence,
    attestation_id: (recorded as { attestation: { id: string } }).attestation.id, work_attempt_id: wa, execution_generation_id: eg,
  });
  assert.equal(rebind.ok, true);

  // The predecessor's release, carrying its stale epoch 0, must not touch the
  // successor's epoch-1 lease — the destructive UPDATE CAS matches 0 rows.
  const stale = await applyTaskWorkLeaseAction({
    room_id: s.room.id, task_id: task.id, active_lease_id: lease.id,
    expected_lease_epoch: 0, disposition_status: "released", task_updates: {},
  });
  assert.equal(stale.conflict, "lease_not_active");
  assert.equal(stale.released_lease, null);
  const stillActive = await leaseRow(lease.id);
  assert.equal(stillActive.status, "active");
  assert.equal(stillActive.agent_session_id, s.to.session_id);

  // The successor, presenting the current epoch, can release it.
  const current = await applyTaskWorkLeaseAction({
    room_id: s.room.id, task_id: task.id, active_lease_id: lease.id,
    expected_lease_epoch: 1, disposition_status: "released", task_updates: {},
  });
  assert.equal(current.conflict, null);
  assert.equal(current.released_lease?.id, lease.id);
});
