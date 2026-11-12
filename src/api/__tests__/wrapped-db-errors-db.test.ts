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

// ── Rental proposals: a concurrent insert with the same idempotency key ───

async function seedRentalSession(): Promise<string> {
  const renter = unique("renter");
  const provider = unique("provider");
  const listing = unique("listing");
  const sessionId = unique("rsess");
  const room = await api!.createProjectWithName(unique("rental-room"));
  await client!.pool.query(
    `INSERT INTO accounts (id, provider, provider_user_id, login, created_at, updated_at)
     VALUES ($1, 'github', $1, $1, now(), now()), ($2, 'github', $2, $2, now(), now())`,
    [renter, provider],
  );
  await client!.pool.query(
    "INSERT INTO rental_listings (id, provider_account_id, display_name, ide_kind) VALUES ($1, $2, 'Provider', 'codex')",
    [listing, provider],
  );
  await client!.pool.query(
    `INSERT INTO rental_sessions (id, listing_id, renter_account_id, provider_account_id, target_room_id, task_title, task_prompt, status)
     VALUES ($1, $2, $3, $4, $5, 'Task', 'Prompt', 'accepted')`,
    [sessionId, listing, renter, provider, room.id],
  );
  return sessionId;
}

type ProposalRow = Record<string, unknown>;

/** The row a call would insert, captured without touching the database. */
async function capture(run: (insert: (row: ProposalRow) => Promise<never>) => Promise<unknown>): Promise<ProposalRow> {
  let captured: ProposalRow | null = null;
  const stop = new Error("captured");
  await run(async (row) => { captured = row; throw stop; }).catch((error) => { if (error !== stop) throw error; });
  assert.ok(captured);
  return captured!;
}

/** Hold `row` (under another id) in an open transaction; commit it once `waiter` waits on the unique index. */
async function raceAgainstUncommittedProposal<T>(row: ProposalRow, waiter: () => Promise<T>): Promise<{ result: T | null; error: unknown; winnerId: string }> {
  const winnerId = unique("rpatch_winner");
  const holder = new Pool({ connectionString: url, max: 1 });
  const other = await holder.connect();
  try {
    await other.query("BEGIN");
    await other.query(
      `INSERT INTO rental_patch_proposals
         (id, session_id, source, diff_ref, summary, gate_status, risk_score, warnings, check_results, journal_entry, idempotency_key, request_hash, response_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13)`,
      [
        winnerId, row.session_id, row.source, row.diff_ref, row.summary, row.gate_status, row.risk_score,
        JSON.stringify(row.warnings ?? []), JSON.stringify(row.check_results ?? {}),
        row.journal_entry === null || row.journal_entry === undefined ? null : JSON.stringify(row.journal_entry),
        row.idempotency_key, row.request_hash, row.response_hash,
      ],
    );
    const pending = waiter().then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
    for (let i = 0; i < 100; i += 1) {
      const waiting = await client!.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
      );
      if (waiting.rowCount) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    await other.query("COMMIT");
    return { ...(await pending), winnerId };
  } finally {
    await other.query("ROLLBACK").catch(() => undefined);
    other.release();
    await holder.end();
  }
}

async function proposalCount(sessionId: string, key: string): Promise<number> {
  return (await client!.pool.query(
    "SELECT 1 FROM rental_patch_proposals WHERE session_id = $1 AND idempotency_key = $2", [sessionId, key],
  )).rowCount ?? 0;
}

test("signed change journal: a concurrent append with the same key returns the winner, or 409 for another edit", options, async () => {
  const journal = await import("../rental/signed-change-journal.js");
  const sessionId = await seedRentalSession();
  const key = unique("journal-key");
  const edit = { path: "src/index.ts", beforeContent: "a\n", afterContent: "b\n", summary: "Same edit" };
  const deps = journal.defaultSignedChangeJournalDeps;

  // Same key, same request: the caller gets the winner's row; one row exists.
  const same = await capture((insert) => journal.appendSignedChange({ sessionId, idempotencyKey: key, edit }, { ...deps, insertProposal: insert as never }));
  const raced = await raceAgainstUncommittedProposal(same, () => journal.appendSignedChange({ sessionId, idempotencyKey: key, edit }));
  assert.equal(raced.error, null);
  assert.equal(raced.result!.idempotent, true);
  assert.equal(raced.result!.proposal.id, raced.winnerId);
  assert.equal(await proposalCount(sessionId, key), 1);

  // Same key, another edit: 409 idempotency_conflict.
  const otherKey = unique("journal-key");
  const winnerEdit = await capture((insert) => journal.appendSignedChange(
    { sessionId, idempotencyKey: otherKey, edit: { ...edit, afterContent: "c\n" } }, { ...deps, insertProposal: insert as never }));
  const conflict = await raceAgainstUncommittedProposal(winnerEdit, () => journal.appendSignedChange({ sessionId, idempotencyKey: otherKey, edit }));
  assert.ok(conflict.error instanceof journal.SignedChangeJournalError);
  assert.deepEqual(
    [(conflict.error as { status: number }).status, (conflict.error as { code: string }).code],
    [409, "idempotency_conflict"],
  );
  assert.equal(await proposalCount(sessionId, otherKey), 1);
});

test("patch proposal: a concurrent proposal with the same key returns the winner, or the same 409 as outside a race", options, async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const proposals = await import("../rental/patch-proposal.js");
  const sessionId = await seedRentalSession();
  const workspace = await mkdtemp(join(tmpdir(), "patch-race-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");
  // The database parts are real; the workspace manifest is local.
  const deps = {
    ...proposals.createDefaultPatchProposalDeps(),
    getActiveManifest: async () => ({ id: "manifest", session_id: sessionId, workspace_path: workspace, retention_status: "active" }),
    isPathExposed: async () => true,
  };
  const input = (key: string, value: number) => ({
    sessionId,
    idempotencyKey: key,
    summary: "Update value",
    files: [{ path: "src/index.ts", operation: "modify" as const, content: `export const value = ${value};\n` }],
  });
  try {
    // Same key, same request.
    const key = unique("patch-key");
    const same = await capture((insert) => proposals.proposePatch({ ...deps, insertProposal: insert as never }, input(key, 2)));
    const raced = await raceAgainstUncommittedProposal(same, () => proposals.proposePatch(deps, input(key, 2)));
    assert.equal(raced.error, null);
    assert.equal(raced.result!.idempotent, true);
    assert.equal(raced.result!.proposal.id, raced.winnerId);
    assert.equal(await proposalCount(sessionId, key), 1);

    // Same key, another patch: the 409 the non-race path gives.
    const otherKey = unique("patch-key");
    const winner = await capture((insert) => proposals.proposePatch({ ...deps, insertProposal: insert as never }, input(otherKey, 3)));
    const conflict = await raceAgainstUncommittedProposal(winner, () => proposals.proposePatch(deps, input(otherKey, 2)));
    assert.ok(conflict.error instanceof proposals.PatchProposalError, String(conflict.error));
    assert.equal((conflict.error as { status: number }).status, 409);
    const outsideRace = await proposals.proposePatch(deps, input(otherKey, 2)).then(() => null, (error: unknown) => error);
    assert.ok(outsideRace instanceof proposals.PatchProposalError);
    assert.deepEqual(
      [(conflict.error as Error).message, (conflict.error as { status: number }).status],
      [(outsideRace as Error).message, (outsideRace as { status: number }).status],
    );
    assert.equal(await proposalCount(sessionId, otherKey), 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
