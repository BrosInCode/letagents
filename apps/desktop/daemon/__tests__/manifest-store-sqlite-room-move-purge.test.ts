import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DAEMON_STATE_USER_VERSION } from "../daemon-state-database.js";
import {
  ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND,
  ROOM_WORK_PUBLISH_EFFECT_KIND,
} from "../effect-journal/index.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonManifestEntry } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { seedBoundedMcpEffectRow } from "./helpers/bounded-effect-seed.js";
import {
  TEST_PROVIDER_TURN_AUTHORITY,
  IMAGE_INPUT_UPDATE,
  entry,
  fixture,
  seedTerminalAttempt,
} from "./helpers/manifest-store-sqlite-fixture.js";

test("Inspector configuration revisions are optimistic, durable, and do not alter the flat manifest", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write([entry]);
    const original = await store.getAgentConfiguration(entry.id);
    assert.equal(original?.config_revision, 1);
    assert.equal(original?.runtime_configuration_revision, 1);
    const updated = await store.updateAgentConfiguration(1, {
      agentId: entry.id, expectedRevision: 1, model: "gpt-next", reasoningEffort: "high",
      charter: "Use the new charter on future turns.", permissionProfileId: "read_only", providerLaunchPolicy: { approvalPolicy: "ask" }, imageInput: false,
    });
    assert.equal(updated.outcome, "updated");
    assert.equal(updated.configuration?.config_revision, 2);
    assert.equal(updated.configuration?.runtime_configuration_revision, 1);
    const conflict = await store.updateAgentConfiguration(2, {
      agentId: entry.id, expectedRevision: 1, model: "ignored", reasoningEffort: null,
      charter: "ignored", permissionProfileId: null, providerLaunchPolicy: {}, imageInput: false,
    });
    assert.equal(conflict.outcome, "conflict");
    assert.equal((await store.load()).versions[entry.id], 2, "a revision conflict must not advance agent version");
    await store.replaceEntry(2, { ...entry, observed_state: "idle" });
    const afterLifecycleReplacement = await store.getAgentConfiguration(entry.id);
    assert.equal(afterLifecycleReplacement?.model, "gpt-next");
    assert.equal(afterLifecycleReplacement?.charter, "Use the new charter on future turns.");
    assert.equal(afterLifecycleReplacement?.config_revision, 2);
    assert.equal(afterLifecycleReplacement?.runtime_configuration_revision, 1);
    const manifest = await store.load();
    assert.equal(manifest.entries[0]?.model, "gpt-next");
    assert.equal(Object.hasOwn(manifest.entries[0]!, "config_revision"), false, "legacy manifest projection never leaks Inspector bookkeeping");
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("a new database stores image input as off and the flat manifest cannot turn it on", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write([{ ...entry, image_input: true } as DaemonManifestEntry]);
    assert.equal((await store.getAgentConfiguration(entry.id))?.image_input, false,
      "a flat manifest entry cannot create the owner's image input choice");
    const inspection = new DatabaseSync(env.databasePath);
    try {
      assert.equal(inspection.prepare("SELECT image_input FROM agents WHERE agent_id=?").get(entry.id)?.image_input, 0);
      assert.deepEqual({ ...inspection.prepare("SELECT type,\"notnull\" AS required,dflt_value FROM pragma_table_info('agents') WHERE name='image_input'").get() },
        { type: "INTEGER", required: 1, dflt_value: "0" });
      inspection.exec("PRAGMA foreign_keys=OFF");
      assert.throws(() => inspection.prepare("UPDATE agents SET image_input=2").run(), /CHECK/,
        "only 0 and 1 are accepted by the column itself");
      assert.throws(() => inspection.prepare("UPDATE agents SET image_input=NULL").run(), /NOT NULL/);
    } finally { inspection.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("a current database refuses an image input column that is missing, weakened or holds an invalid value", async () => {
  const cases: Array<{ name: string; sql: string; refusal: RegExp }> = [
    { name: "missing column", sql: "ALTER TABLE agents DROP COLUMN image_input", refusal: /schema mismatch/i },
    { name: "column that allows null", sql: "ALTER TABLE agents DROP COLUMN image_input; ALTER TABLE agents ADD COLUMN image_input INTEGER DEFAULT 0", refusal: /schema mismatch/i },
    { name: "column that defaults to on", sql: "ALTER TABLE agents DROP COLUMN image_input; ALTER TABLE agents ADD COLUMN image_input INTEGER NOT NULL DEFAULT 1", refusal: /schema mismatch/i },
    // SQLite's own integrity check sees the broken CHECK constraint first, so the open fails either way.
    { name: "value outside 0 and 1", sql: "PRAGMA ignore_check_constraints=ON; UPDATE agents SET image_input=2; PRAGMA ignore_check_constraints=OFF", refusal: /schema mismatch|failed SQLite integrity validation/i },
  ];
  for (const { name, sql, refusal } of cases) {
    const env = await fixture();
    const original = new ManifestStore(env.databasePath);
    try {
      await original.write([entry]);
      await original.close();
      const damaged = new DatabaseSync(env.databasePath);
      damaged.exec(sql);
      assert.equal(damaged.prepare("PRAGMA user_version").get()?.user_version, DAEMON_STATE_USER_VERSION, name);
      damaged.close();
      const reopened = new ManifestStore(env.databasePath);
      try {
        await assert.rejects(() => reopened.load(), refusal, name);
      } finally { await reopened.close(); }
      const inspection = new DatabaseSync(env.databasePath);
      try {
        assert.equal(inspection.prepare("PRAGMA user_version").get()?.user_version, DAEMON_STATE_USER_VERSION,
          `${name}: a refused open must not advance or repair the schema version`);
      } finally { inspection.close(); }
    } finally { await original.close(); await env.cleanup(); }
  }
});

test("image input is saved with the Inspector configuration and survives every manifest replacement", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write([entry]);
    assert.equal((await store.getAgentConfiguration(entry.id))?.image_input, false);
    const updated = await store.updateAgentConfiguration(1, IMAGE_INPUT_UPDATE(1, true));
    assert.equal(updated.outcome, "updated");
    assert.equal(updated.configuration?.image_input, true);
    assert.equal(updated.configuration?.config_revision, 2, "turning the choice on is a configuration change like any other");
    assert.equal(updated.configuration?.runtime_configuration_revision, 1);
    const stale = { ...entry, observed_state: "idle" as const };
    await store.replaceEntry(2, stale);
    assert.equal((await store.getAgentConfiguration(entry.id))?.image_input, true, "a lifecycle replacement keeps the choice");
    await store.replaceEntriesBatch({ [entry.id]: 3 }, [stale]);
    assert.equal((await store.getAgentConfiguration(entry.id))?.image_input, true, "a batch replacement keeps the choice");
    await store.write([stale]);
    assert.equal((await store.getAgentConfiguration(entry.id))?.image_input, true, "a full manifest write keeps the choice");
    assert.equal(Object.hasOwn((await store.load()).entries[0]!, "image_input"), false, "the flat manifest never carries the choice");
    const conflict = await store.updateAgentConfiguration((await store.load()).versions[entry.id]!, IMAGE_INPUT_UPDATE(1, false));
    assert.equal(conflict.outcome, "conflict");
    assert.equal((await store.getAgentConfiguration(entry.id))?.image_input, true, "a conflicting edit does not change the choice");
    await store.close();
    const reopened = new ManifestStore(env.databasePath);
    try {
      assert.equal((await reopened.getAgentConfiguration(entry.id))?.image_input, true, "the choice survives a restart");
      const version = (await reopened.load()).versions[entry.id]!;
      const off = await reopened.updateAgentConfiguration(version, IMAGE_INPUT_UPDATE(2, false));
      assert.equal(off.outcome, "updated");
      assert.equal(off.configuration?.image_input, false, "the owner can turn the choice off again");
    } finally { await reopened.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("room-move journal is request-idempotent and exact-generation phase fenced", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write([entry]);
    const cursorDatabase = new DatabaseSync(env.databasePath);
    try {
      cursorDatabase.prepare("INSERT INTO supervised_agent_ingress_cursors(agent_id,room_id,last_observed_message_id,updated_at) VALUES(?,?,?,?)")
        .run(entry.id, entry.room_id, "msg_17", "2026-07-19T00:00:00.000Z");
    } finally { cursorDatabase.close(); }
    const coordinates = {
      operation_id: "move_1", request_id: "request_1", agent_id: entry.id, source_room_id: entry.room_id,
      destination_room_id: "room_2", daemon_generation: 7, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      agent_session_id: "session_1", activating_inbox_item_id: null, provider_turn_id: null, effect_id: null, phase: "prepared" as const,
    };
    const prepared = await store.prepareRoomMove(coordinates);
    assert.equal(prepared.created, true);
    assert.equal(prepared.move.source_cursor_present, true);
    assert.equal(prepared.move.source_cursor, "msg_17");
    assert.equal(prepared.move.source_credentials_revoked, false);
    assert.equal((await store.prepareRoomMove(coordinates)).created, false);
    await assert.rejects(() => store.advanceRoomMove({ operationId: "move_1", agentId: entry.id, expectedDaemonGeneration: 8, expectedExecutionGenerationId: "run_1", from: ["prepared"], to: "waiting_for_current_turn" }), ManifestConflictError);
    const waiting = await store.advanceRoomMove({ operationId: "move_1", agentId: entry.id, expectedDaemonGeneration: 7, expectedExecutionGenerationId: "run_1", from: ["prepared"], to: "waiting_for_current_turn" });
    assert.equal(waiting.phase, "waiting_for_current_turn");
    const acknowledged = await store.advanceRoomMove({ operationId: "move_1", agentId: entry.id, expectedDaemonGeneration: 7, expectedExecutionGenerationId: "run_1", from: ["waiting_for_current_turn"], to: "waiting_for_current_turn", sourceCredentialsRevoked: true });
    assert.equal(acknowledged.source_credentials_revoked, true);
    await store.close();
    const reopened = new ManifestStore(env.databasePath);
    assert.equal((await reopened.pendingRoomMoves(entry.id))[0]?.operation_id, "move_1");
    assert.equal((await reopened.pendingRoomMoves(entry.id))[0]?.source_credentials_revoked, true);
    await reopened.close();
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("terminal mediated room-move edges atomically settle their exact join effect", async () => {
  for (const terminal of ["active", "failed"] as const) {
    const env = await fixture();
    const store = new ManifestStore(env.databasePath);
    const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T09:20:00.000Z");
    const moving: DaemonManifestEntry = { ...entry, condition: "none", delivery_mode: "daemon_inbox", turn_control: null };
    try {
      await store.write([moving]);
      const item = await inbox.enqueueCorrection({
        agent_id: moving.id,
        room_id: moving.room_id,
        source_message_id: `atomic-${terminal}-message`,
        source_message: { text: "move atomically" },
        activation: { decision: "activate" },
      });
      assert.equal((await inbox.claimHead(moving.id))?.inbox_item_id, item.inbox_item_id);
      await inbox.checkpointTurnStarted(item.inbox_item_id, `atomic-${terminal}-turn`, TEST_PROVIDER_TURN_AUTHORITY);
      const prepared = await inbox.prepareRoomMoveEffect({
        agent_id: moving.id,
        room_id: moving.room_id,
        effect_execution_generation_id: TEST_PROVIDER_TURN_AUTHORITY.origin_execution_generation_id,
        provider_turn_id: `atomic-${terminal}-turn`,
        mcp_request_id: `atomic-${terminal}-request`,
        request: { name: `atomic-${terminal}-destination` },
        destination_room_id: `atomic-${terminal}-destination`,
        daemon_generation: 1,
        work_attempt_id: moving.work_attempt_id!,
        execution_generation_id: moving.provider_ref!.execution_generation_id,
        provider_continuation_id: moving.provider_ref!.provider_continuation_id,
        agent_session_id: "session_1",
        activating_inbox_item_id: item.inbox_item_id,
      });
      const operationId = `room_move:${prepared.effect.effect_id}`;
      const readEffect = () => {
        const database = new DatabaseSync(env.databasePath);
        try {
          const row = database.prepare("SELECT state,outcome,last_error FROM effects WHERE id=?")
            .get(prepared.effect.effect_id) as { state: string; outcome: string | null; last_error: string | null };
          return { state: row.state, result: row.outcome ? JSON.parse(row.outcome) as unknown : null, error: row.last_error };
        } finally { database.close(); }
      };
      const priorPhase = terminal === "active" ? "bootstrapping_destination_tail" : "rollback_required";
      await store.advanceRoomMove({
        operationId,
        agentId: moving.id,
        expectedDaemonGeneration: 1,
        expectedExecutionGenerationId: moving.provider_ref!.execution_generation_id,
        from: ["prepared"],
        to: priorPhase,
        ...(terminal === "active" ? { remoteRoomId: `canonical-${terminal}-destination` } : {}),
      });
      const inspection = new DatabaseSync(env.databasePath);
      try {
        inspection.exec(`CREATE TRIGGER reject_atomic_${terminal}_effect
          BEFORE UPDATE OF state ON effects
          WHEN OLD.id='${prepared.effect.effect_id}' AND OLD.state='prepared'
          BEGIN SELECT RAISE(ABORT,'injected terminal effect failure'); END`);
      } finally { inspection.close(); }

      await assert.rejects(() => store.advanceRoomMove({
        operationId,
        agentId: moving.id,
        expectedDaemonGeneration: 1,
        expectedExecutionGenerationId: moving.provider_ref!.execution_generation_id,
        from: [priorPhase],
        to: terminal,
        ...(terminal === "active"
          ? { destinationCursor: "42" }
          : { error: "destination rollback completed" }),
      }), /injected terminal effect failure/);
      assert.equal((await store.getRoomMove(operationId))?.phase, priorPhase, "move phase rolls back with effect terminalization");
      assert.equal(readEffect().state, "prepared");

      const repair = new DatabaseSync(env.databasePath);
      try { repair.exec(`DROP TRIGGER reject_atomic_${terminal}_effect`); } finally { repair.close(); }
      const completed = await store.advanceRoomMove({
        operationId,
        agentId: moving.id,
        expectedDaemonGeneration: 1,
        expectedExecutionGenerationId: moving.provider_ref!.execution_generation_id,
        from: [priorPhase],
        to: terminal,
        ...(terminal === "active"
          ? { destinationCursor: "42" }
          : { error: "destination rollback completed" }),
      });
      const effect = readEffect();
      assert.equal(completed.phase, terminal);
      assert.equal(effect.state, terminal === "active" ? "completed" : "failed");
      if (terminal === "active") {
        assert.deepEqual(effect.result, {
          phase: "active",
          moved: true,
          old_room: moving.room_id,
          destination_room: "canonical-active-destination",
          destination_cursor: "42",
        });
      } else {
        assert.equal(effect.error, "destination rollback completed");
      }
    } finally {
      await inbox.close();
      await store.close();
      await env.cleanup();
    }
  }
});

test("lifecycle replacement atomically cancels only the exact pre-join mediated room move", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T09:30:00.000Z");
  const moving: DaemonManifestEntry = {
    ...entry,
    condition: "none",
    delivery_mode: "daemon_inbox",
    turn_control: null,
  };
  try {
    await store.write([moving]);
    const item = await inbox.enqueueCorrection({
      agent_id: moving.id,
      room_id: moving.room_id,
      source_message_id: "move-lifecycle-message",
      source_message: { text: "move me" },
      activation: { decision: "activate" },
    });
    assert.equal((await inbox.claimHead(moving.id))?.inbox_item_id, item.inbox_item_id);
    await inbox.checkpointTurnStarted(item.inbox_item_id, "move-lifecycle-turn", TEST_PROVIDER_TURN_AUTHORITY);
    const prepared = await inbox.prepareRoomMoveEffect({
      agent_id: moving.id,
      room_id: moving.room_id,
      effect_execution_generation_id: TEST_PROVIDER_TURN_AUTHORITY.origin_execution_generation_id,
      provider_turn_id: "move-lifecycle-turn",
      mcp_request_id: "move-lifecycle-request",
      request: { name: "destination-room" },
      destination_room_id: "destination-room",
      daemon_generation: 1,
      work_attempt_id: moving.work_attempt_id!,
      execution_generation_id: moving.provider_ref!.execution_generation_id,
      provider_continuation_id: moving.provider_ref!.provider_continuation_id,
      agent_session_id: "session_1",
      activating_inbox_item_id: item.inbox_item_id,
    });
    const operationId = `room_move:${prepared.effect.effect_id}`;
    const effectState = () => {
      const database = new DatabaseSync(env.databasePath);
      try {
        return (database.prepare("SELECT state FROM effects WHERE id=?")
          .get(prepared.effect.effect_id) as { state: string }).state;
      } finally { database.close(); }
    };
    const waiting = await store.advanceRoomMove({
      operationId,
      agentId: moving.id,
      expectedDaemonGeneration: 1,
      expectedExecutionGenerationId: moving.provider_ref!.execution_generation_id,
      from: ["prepared"],
      to: "waiting_for_current_turn",
    });
    assert.equal(waiting.phase, "waiting_for_current_turn");

    const inspection = new DatabaseSync(env.databasePath);
    try {
      inspection.exec(`CREATE TRIGGER reject_prejoin_effect_failure
        BEFORE UPDATE OF state ON effects
        WHEN OLD.id='${prepared.effect.effect_id}' AND OLD.state='prepared' AND NEW.state='failed'
        BEGIN SELECT RAISE(ABORT,'injected effect rollback'); END`);
    } finally { inspection.close(); }

    const paused = { ...moving, desired_state: "paused" as const };
    await assert.rejects(() => store.replaceEntry(1, paused, undefined, {
      agentId: moving.id,
      detail: "pause before destination join",
    }), /injected effect rollback/);
    assert.equal((await store.load()).versions[moving.id], 1, "agent version rolls back with the effect failure");
    assert.equal((await store.getEntry(moving.id))?.desired_state, "running");
    assert.equal((await store.getRoomMove(operationId))?.phase, "waiting_for_current_turn");
    assert.equal(effectState(), "prepared");
    assert.equal((await inbox.get(item.inbox_item_id))?.state, "dispatching");
    assert.equal((await inbox.providerTurnBinding(item.inbox_item_id))?.provider_turn_id, "move-lifecycle-turn");

    const corrupt = new DatabaseSync(env.databasePath);
    let savedRow!: Record<string, unknown>;
    try {
      corrupt.exec("DROP TRIGGER reject_prejoin_effect_failure");
      savedRow = corrupt.prepare("SELECT * FROM effects WHERE id=?").get(prepared.effect.effect_id) as Record<string, unknown>;
      const tamperedPayload = JSON.stringify({ ...(JSON.parse(String(savedRow.payload)) as Record<string, unknown>), room_id: "wrong-source-room" });
      corrupt.prepare("DELETE FROM effects WHERE id=?").run(prepared.effect.effect_id);
      corrupt.prepare(`INSERT INTO effects
        (id,agent_id,kind,idempotency_key,epoch,state,payload,outcome,retryable,attempt_count,max_attempts,next_attempt_at_ms,last_error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        savedRow.id, savedRow.agent_id, savedRow.kind, savedRow.idempotency_key, savedRow.epoch,
        savedRow.state, tamperedPayload, savedRow.outcome, savedRow.retryable, savedRow.attempt_count,
        savedRow.max_attempts, savedRow.next_attempt_at_ms, savedRow.last_error, savedRow.created_at, savedRow.updated_at,
      );
    } finally { corrupt.close(); }
    await assert.rejects(() => store.replaceEntry(1, paused, undefined, {
      agentId: moving.id,
      detail: "pause before destination join",
    }), /detached from its exact unresolved effect journal/i);
    assert.equal((await store.getEntry(moving.id))?.desired_state, "running");
    assert.equal((await store.getRoomMove(operationId))?.phase, "waiting_for_current_turn");

    const repair = new DatabaseSync(env.databasePath);
    try {
      repair.prepare("DELETE FROM effects WHERE id=?").run(prepared.effect.effect_id);
      repair.prepare(`INSERT INTO effects
        (id,agent_id,kind,idempotency_key,epoch,state,payload,outcome,retryable,attempt_count,max_attempts,next_attempt_at_ms,last_error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        savedRow.id, savedRow.agent_id, savedRow.kind, savedRow.idempotency_key, savedRow.epoch,
        savedRow.state, savedRow.payload, savedRow.outcome, savedRow.retryable, savedRow.attempt_count,
        savedRow.max_attempts, savedRow.next_attempt_at_ms, savedRow.last_error, savedRow.created_at, savedRow.updated_at,
      );
    } finally { repair.close(); }
    const committed = await store.replaceEntry(1, paused, undefined, {
      agentId: moving.id,
      detail: "pause before destination join",
    });
    assert.equal(committed.entry.desired_state, "paused");
    assert.equal((await store.getRoomMove(operationId))?.phase, "failed");
    assert.equal(effectState(), "failed");
    assert.equal((await inbox.get(item.inbox_item_id))?.state, "dispatching", "cancellation preserves activating FIFO evidence");
    assert.equal((await inbox.providerTurnBinding(item.inbox_item_id))?.provider_turn_id, "move-lifecycle-turn");
    assert.deepEqual(await store.pendingRoomMoves(moving.id), []);
  } finally {
    await inbox.close();
    await store.close();
    await env.cleanup();
  }
});

test("lifecycle replacement refuses an ambiguous joining room move", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const moving: DaemonManifestEntry = { ...entry, condition: "none", turn_control: null };
  try {
    await store.write([moving]);
    const prepared = (await store.prepareRoomMove({
      operation_id: "ambiguous-join",
      request_id: "ambiguous-join",
      agent_id: moving.id,
      source_room_id: moving.room_id,
      destination_room_id: "ambiguous-destination",
      daemon_generation: 1,
      work_attempt_id: moving.work_attempt_id,
      execution_generation_id: moving.provider_ref!.execution_generation_id,
      agent_session_id: "session_1",
      activating_inbox_item_id: null,
      provider_turn_id: null,
      effect_id: null,
      phase: "prepared",
    })).move;
    await store.advanceRoomMove({
      operationId: prepared.operation_id,
      agentId: moving.id,
      expectedDaemonGeneration: 1,
      expectedExecutionGenerationId: moving.provider_ref!.execution_generation_id,
      from: ["prepared"],
      to: "joining_destination",
    });
    await assert.rejects(() => store.replaceEntry(1, { ...moving, desired_state: "paused" }, undefined, {
      agentId: moving.id,
      detail: "must not cheap-cancel an ambiguous external join",
    }), /blocked while a room move may have changed destination membership/i);
    assert.equal((await store.load()).versions[moving.id], 1);
    assert.equal((await store.getEntry(moving.id))?.desired_state, "running");
    assert.equal((await store.getRoomMove(prepared.operation_id))?.phase, "joining_destination");
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("room moves and turn control exclude each other in both atomic admission orders", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const controlled: DaemonManifestEntry = {
    ...entry,
    condition: "none",
    delivery_mode: "daemon_inbox",
    provider_ref: {
      ...entry.provider_ref!,
      provider_connection: { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "codex:4311" },
    },
    turn_control: {
      ...entry.turn_control!,
      action_id: "move-exclusion-control",
      status: "retryable",
      correction_text: "durable correction",
      correction_strategy: "stop_then_resend",
      error: "safe retry",
    },
  };
  const move = {
    operation_id: "move-exclusion", request_id: "move-exclusion", agent_id: controlled.id,
    source_room_id: controlled.room_id, destination_room_id: "room-move-destination", daemon_generation: 1,
    work_attempt_id: "attempt_1", execution_generation_id: "run_1", agent_session_id: "session_1",
    activating_inbox_item_id: null, provider_turn_id: null, effect_id: null, phase: "prepared" as const,
  };
  try {
    await store.write([controlled]);
    await assert.rejects(() => store.prepareRoomMove(move), /blocked by unresolved turn-control/i);
    const completed = await store.replaceEntry(1, {
      ...controlled,
      turn_control: { ...controlled.turn_control!, status: "completed", error: null },
    });
    assert.equal((await store.prepareRoomMove(move)).created, true);
    await assert.rejects(() => store.prepareTurnControlState(completed.version, {
      agentId: controlled.id,
      roomId: controlled.room_id,
      actionId: "control-after-move",
      actionSequence: 2,
      workAttemptId: "attempt_1",
      executionGenerationId: "run_1",
      providerContinuationId: "thread_1",
      providerConnection: controlled.provider_ref!.provider_connection,
      deliveryMode: "daemon_inbox",
      hasCorrection: false,
      correctionText: null,
      correctionStrategy: null,
      capability: "native_interrupt",
      recordedAt: "2026-08-05T10:00:00.000Z",
    }), /blocked by a pending room move/i);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("purge proves preconditions and deletes local agent rows atomically without touching its worktree", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T12:00:00.000Z");
  const worktreeMarker = join(env.root, "preserved-worktree.txt");
  await writeFile(worktreeMarker, "keep");
  const attemptId = "attempt_purge";
  const executionId = "run_purge";
  const stopped: DaemonManifestEntry = {
    ...entry, id: "agent_purge", desired_state: "stopped", observed_state: "stopped", condition: "none", last_error: null,
    workspace_path: worktreeMarker, work_attempt_id: attemptId,
    provider_ref: {
      ...entry.provider_ref!, work_attempt_id: attemptId, execution_generation_id: executionId,
    },
    activity: [], turn_control: null, last_worker_binding: null,
    workplace_liveness: { state: "unknown", observed_at: null, detail: null }, native_liveness: { state: "unknown", observed_at: null, detail: null },
  };
  try {
    await store.write([stopped]);
    const cancelled = await inbox.enqueueCorrection({
      agent_id: stopped.id, room_id: stopped.room_id, source_message_id: "purge-cancelled-receipt",
      source_message: { text: "cancel before provider work" }, activation: { decision: "activate" },
    });
    await inbox.transition(cancelled.inbox_item_id, "blocked", { last_error: "safe pre-turn cancellation" });
    assert.equal((await inbox.skipBlocked(cancelled.inbox_item_id)).state, "cancelled_by_user",
      "a retained user-cancelled receipt is terminal purge history, not live work");
    await inbox.close();
    const beforePurge = new DatabaseSync(env.databasePath);
    assert.equal(Number((beforePurge.prepare("SELECT last_turn_control_sequence FROM agents WHERE agent_id=?").get(stopped.id) as { last_turn_control_sequence: number }).last_turn_control_sequence), 1);
    seedBoundedMcpEffectRow(beforePurge, {
      id: "uncertain-before-purge",
      agent_id: stopped.id,
      room_id: stopped.room_id,
      execution_generation_id: executionId,
      provider_turn_id: "retired-turn",
      mcp_request_id: "retired-request",
      tool_name: "send_message",
      request: {},
      mutation: true,
      state: "uncertain",
      error: "May already have completed; verify external state.",
      created_at: "2026-08-05T12:00:00.000Z",
      updated_at: "2026-08-05T12:00:00.000Z",
    });
    beforePurge.prepare(`INSERT INTO effect_tombstones
      (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
       tool_name,request_sha256,request_bytes,mutation,state,result_json,error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,'uncertain',NULL,?,?,?)`).run(
      "uncertain-tombstone-before-purge", stopped.id, stopped.room_id, executionId, "retired-turn-2",
      "retired-request-2", "send_message", "0".repeat(64), 2,
      "May already have completed; verify external state.",
      "2026-08-05T12:00:00.000Z", "2026-08-05T12:00:00.000Z",
    );
    beforePurge.close();
    seedTerminalAttempt(env.databasePath, attemptId, executionId, worktreeMarker);
    const prepared = await store.preparePurge(1, {
      operationId: "purge_1", requestId: "purge_1", agentId: stopped.id, daemonGeneration: 3,
      externalRevokeRequired: false, workerSessionAttestation: "not_required", agentSessionId: null,
    });
    assert.equal(prepared.purge.phase, "local_commit");
    assert.equal(prepared.purge.attached_work_attempt_id, attemptId);
    assert.equal(prepared.purge.preserved_workspace_path, worktreeMarker);
    await store.close(); // crash boundary after durable preparation
    const reopened = new ManifestStore(env.databasePath);
    const committed = await reopened.commitPurge(1, { operationId: "purge_1", agentId: stopped.id, daemonGeneration: 3 });
    assert.equal(committed.version, 2);
    assert.equal(committed.purge.phase, "complete");
    assert.equal(await reopened.getEntry(stopped.id), undefined);
    assert.equal(await readFile(worktreeMarker, "utf8"), "keep");
    const database = new DatabaseSync(env.databasePath);
    try {
      for (const [table, column, value] of [
        ["agents", "agent_id", stopped.id], ["worker_session_bindings", "entry_id", stopped.id], ["inbox_items", "agent_id", stopped.id],
        ["effects", "agent_id", stopped.id], ["effect_tombstones", "agent_id", stopped.id],
        ["supervised_worker_mint_states", "agent_id", stopped.id],
        ["work_attempts", "work_attempt_id", attemptId], ["work_attempt_lease_epochs", "work_attempt_id", attemptId],
        ["work_attempt_checkpoints", "work_attempt_id", attemptId], ["work_attempt_executions", "work_attempt_id", attemptId],
      ] as const) {
        assert.equal(Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`).get(value) as { count: number }).count), 0);
      }
      assert.equal((database.prepare("SELECT phase FROM agent_purge_operations WHERE operation_id='purge_1'").get() as { phase: string }).phase, "complete");
    } finally { database.close(); }
    await reopened.close();
  } finally {
    await inbox.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("purge of a given agent cancels the messages it never answered; an ordinary agent keeps them and is refused", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-10-26T12:00:00.000Z");
  const markers = { given: join(env.root, "given-worktree.txt"), ordinary: join(env.root, "ordinary-worktree.txt") };
  await writeFile(markers.given, "keep");
  await writeFile(markers.ordinary, "keep");
  const stoppedEntry = (id: string, attemptId: string, executionId: string, marker: string): DaemonManifestEntry => ({
    ...entry, id, desired_state: "stopped", observed_state: "stopped", condition: "none", last_error: null,
    workspace_path: marker, work_attempt_id: attemptId,
    provider_ref: { ...entry.provider_ref!, work_attempt_id: attemptId, execution_generation_id: executionId },
    activity: [], turn_control: null, last_worker_binding: null,
    workplace_liveness: { state: "unknown", observed_at: null, detail: null }, native_liveness: { state: "unknown", observed_at: null, detail: null },
  });
  const given = stoppedEntry("supervised_rental_ask_0123456789abcdef0123456789abcdef", "attempt_given", "run_given", markers.given);
  const ordinary = stoppedEntry("supervised_ordinary_agent", "attempt_ordinary", "run_ordinary", markers.ordinary);
  try {
    await store.write([given, ordinary]);
    seedTerminalAttempt(env.databasePath, "attempt_given", "run_given", markers.given);
    seedTerminalAttempt(env.databasePath, "attempt_ordinary", "run_ordinary", markers.ordinary);
    // Each agent was handed two room messages it never started on.
    const unanswered: Record<string, string[]> = {};
    for (const agent of [given, ordinary]) {
      unanswered[agent.id] = [];
      for (const message of ["first", "second"]) {
        const item = await inbox.enqueueCorrection({
          agent_id: agent.id, room_id: agent.room_id, source_message_id: `${agent.id}-${message}`,
          source_message: { text: `help with ${message}` }, activation: { decision: "activate" },
        });
        assert.equal(item.state, "pending");
        unanswered[agent.id]!.push(item.inbox_item_id);
      }
    }
    await inbox.close();

    await assert.rejects(store.preparePurge(1, {
      operationId: "purge_ordinary", requestId: "purge_ordinary", agentId: ordinary.id, daemonGeneration: 3,
      externalRevokeRequired: false, workerSessionAttestation: "not_required", agentSessionId: null,
    }), /blocker/, "an ordinary agent's unanswered messages still block its purge");

    const prepared = await store.preparePurge(1, {
      operationId: "purge_given", requestId: "purge_given", agentId: given.id, daemonGeneration: 3,
      externalRevokeRequired: false, workerSessionAttestation: "not_required", agentSessionId: null,
    });
    assert.equal(prepared.purge.phase, "local_commit");
    const database = new DatabaseSync(env.databasePath);
    try {
      for (const inboxItemId of unanswered[given.id]!) {
        const row = database.prepare("SELECT state,last_error FROM inbox_items WHERE inbox_item_id=?").get(inboxItemId) as { state: string; last_error: string | null };
        assert.equal(row.state, "cancelled_by_user");
        assert.equal(row.last_error, "The agent was removed before it answered.");
        assert.equal((database.prepare("SELECT phase FROM supervised_agent_inbox_events WHERE inbox_item_id=? ORDER BY event_sequence DESC LIMIT 1").get(inboxItemId) as { phase: string }).phase, "user_cancelled");
      }
      for (const inboxItemId of unanswered[ordinary.id]!) {
        assert.equal((database.prepare("SELECT state FROM inbox_items WHERE inbox_item_id=?").get(inboxItemId) as { state: string }).state, "pending",
          "the ordinary agent's messages are untouched");
      }
    } finally { database.close(); }
    const committed = await store.commitPurge(1, { operationId: "purge_given", agentId: given.id, daemonGeneration: 3 });
    assert.equal(committed.purge.phase, "complete");
    assert.equal(await store.getEntry(given.id), undefined);
    assert.notEqual(await store.getEntry(ordinary.id), undefined);
  } finally {
    await inbox.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("a rented guest's unanswered messages are settled too, and one that arrives after preparation is settled at commit", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-10-26T12:00:00.000Z");
  const marker = join(env.root, "rented-worktree.txt");
  await writeFile(marker, "keep");
  const rented: DaemonManifestEntry = {
    ...entry, id: "supervised_rental_0123456789abcdef0123456789abcdef", desired_state: "stopped", observed_state: "stopped", condition: "none", last_error: null,
    workspace_path: marker, work_attempt_id: "attempt_rented",
    provider_ref: { ...entry.provider_ref!, work_attempt_id: "attempt_rented", execution_generation_id: "run_rented" },
    activity: [], turn_control: null, last_worker_binding: null,
    workplace_liveness: { state: "unknown", observed_at: null, detail: null }, native_liveness: { state: "unknown", observed_at: null, detail: null },
  };
  try {
    await store.write([rented]);
    seedTerminalAttempt(env.databasePath, "attempt_rented", "run_rented", marker);
    const before = await inbox.enqueueCorrection({
      agent_id: rented.id, room_id: rented.room_id, source_message_id: "before-preparation",
      source_message: { text: "unanswered" }, activation: { decision: "activate" },
    });
    const prepared = await store.preparePurge(1, {
      operationId: "purge_rented", requestId: "purge_rented", agentId: rented.id, daemonGeneration: 3,
      externalRevokeRequired: false, workerSessionAttestation: "not_required", agentSessionId: null,
    });
    assert.equal(prepared.purge.phase, "local_commit");
    const late = await inbox.enqueueCorrection({
      agent_id: rented.id, room_id: rented.room_id, source_message_id: "after-preparation",
      source_message: { text: "arrived between preparation and commit" }, activation: { decision: "activate" },
    });
    assert.equal(late.state, "pending");
    await inbox.close();
    const committed = await store.commitPurge(1, { operationId: "purge_rented", agentId: rented.id, daemonGeneration: 3 });
    assert.equal(committed.purge.phase, "complete");
    assert.equal(await store.getEntry(rented.id), undefined);
    const database = new DatabaseSync(env.databasePath);
    try {
      for (const inboxItemId of [before.inbox_item_id, late.inbox_item_id]) {
        const row = database.prepare("SELECT COUNT(*) AS count FROM inbox_items WHERE inbox_item_id=?").get(inboxItemId) as { count: number };
        assert.equal(Number(row.count), 0, "the purge deleted the settled rows");
      }
    } finally { database.close(); }
  } finally {
    await inbox.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("a given agent's purge stops at the first message a provider turn touched", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-10-26T12:00:00.000Z");
  const marker = join(env.root, "guest-worktree-2.txt");
  await writeFile(marker, "keep");
  const given: DaemonManifestEntry = {
    ...entry, id: "supervised_rental_ask_fedcba9876543210fedcba9876543210", desired_state: "stopped", observed_state: "stopped", condition: "none", last_error: null,
    workspace_path: marker, work_attempt_id: "attempt_touched",
    provider_ref: { ...entry.provider_ref!, work_attempt_id: "attempt_touched", execution_generation_id: "run_touched" },
    activity: [], turn_control: null, last_worker_binding: null,
    workplace_liveness: { state: "unknown", observed_at: null, detail: null }, native_liveness: { state: "unknown", observed_at: null, detail: null },
  };
  try {
    await store.write([given]);
    seedTerminalAttempt(env.databasePath, "attempt_touched", "run_touched", marker);
    const touched = await inbox.enqueueCorrection({
      agent_id: given.id, room_id: given.room_id, source_message_id: "touched",
      source_message: { text: "a turn started on this" }, activation: { decision: "activate" },
    });
    // Another unanswered message behind it: the head would be cancelled first, then the refusal rolls that back.
    const behind = await inbox.enqueueCorrection({
      agent_id: given.id, room_id: given.room_id, source_message_id: "behind",
      source_message: { text: "still unanswered" }, activation: { decision: "activate" },
    });
    await inbox.close();
    const database = new DatabaseSync(env.databasePath);
    try {
      // A message a provider turn already took: not the daemon's to cancel on its own.
      database.prepare("UPDATE inbox_items SET state='dispatching',provider_turn_id='turn_1' WHERE inbox_item_id=?").run(touched.inbox_item_id);
      // Put the untouched message first in FIFO order, so the walk cancels it before it meets the touched one.
      database.prepare("UPDATE inbox_items SET fifo_sequence=fifo_sequence+100 WHERE inbox_item_id=?").run(touched.inbox_item_id);
    } finally { database.close(); }
    await assert.rejects(store.preparePurge(1, {
      operationId: "purge_touched", requestId: "purge_touched", agentId: given.id, daemonGeneration: 3,
      externalRevokeRequired: false, workerSessionAttestation: "not_required", agentSessionId: null,
    }), /blocker/);
    const database2 = new DatabaseSync(env.databasePath);
    try {
      assert.equal((database2.prepare("SELECT state FROM inbox_items WHERE inbox_item_id=?").get(touched.inbox_item_id) as { state: string }).state, "dispatching");
      assert.equal((database2.prepare("SELECT state FROM inbox_items WHERE inbox_item_id=?").get(behind.inbox_item_id) as { state: string }).state, "pending",
        "the refusal rolled the head's cancellation back");
      assert.equal(Number((database2.prepare("SELECT COUNT(*) AS count FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND phase='user_cancelled'").get(behind.inbox_item_id) as { count: number }).count), 0);
      assert.equal(await store.getPurge("purge_touched"), null);
    } finally { database2.close(); }
  } finally {
    await inbox.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("mint-state evidence is none only before an attempt, unknown across crashes, exact after recovery, and conflict-safe", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const bindings = new WorkerBindingStore(join(env.root, "legacy-worker-bindings.json"), undefined, env.databasePath);
  const stopped: DaemonManifestEntry = {
    ...entry,
    id: "agent_mint_state",
    delivery_mode: "daemon_inbox",
    desired_state: "stopped",
    observed_state: "stopped",
    condition: "none",
    workspace_path: null,
    work_attempt_id: null,
    provider_ref: null,
    activity: [],
    turn_control: null,
    last_worker_binding: null,
  };
  try {
    await store.write([stopped]);
    assert.equal((await bindings.supervisedWorkerMintState(stopped.id))?.phase, "never_minted");
    assert.deepEqual(await store.durablePurgeWorkerSessionAttestation(stopped.id), {
      workerSessionAttestation: "none",
      agentSessionId: null,
    });

    await bindings.beginSupervisedWorkerSessionMint({
      agent_id: stopped.id,
      room_id: stopped.room_id,
      agent_instance_id: `daemon:${stopped.id}`,
    });
    assert.deepEqual(await store.durablePurgeWorkerSessionAttestation(stopped.id), {
      workerSessionAttestation: "unknown",
      agentSessionId: null,
    }, "the committed pre-POST fence survives as unknown");

    await bindings.close();
    const recoveredBindings = new WorkerBindingStore(join(env.root, "legacy-worker-bindings.json"), undefined, env.databasePath);
    try {
      assert.equal((await recoveredBindings.supervisedWorkerMintState(stopped.id))?.phase, "minting_unknown");
      await recoveredBindings.recordExactSupervisedWorkerSessionMint({
        agent_id: stopped.id,
        room_id: stopped.room_id,
        agent_instance_id: `daemon:${stopped.id}`,
        agent_session_id: "session_exact_recovered",
      });
      assert.deepEqual(await store.durablePurgeWorkerSessionAttestation(stopped.id), {
        workerSessionAttestation: "exact",
        agentSessionId: "session_exact_recovered",
      }, "the exact recovered response outranks retained explicit none");

      const conflict = new DatabaseSync(env.databasePath);
      try {
        conflict.prepare(`INSERT INTO supervised_worker_sessions
          (agent_id,room_id,agent_session_id,execution_generation_id,credential_ref,expires_at,updated_at)
          VALUES (?,?,?,?,?,?,?)`)
          .run(stopped.id, stopped.room_id, "session_conflicting", "execution_conflicting", "opaque-public-id", null, new Date().toISOString());
      } finally { conflict.close(); }
      assert.deepEqual(await store.durablePurgeWorkerSessionAttestation(stopped.id), {
        workerSessionAttestation: "unknown",
        agentSessionId: null,
      }, "conflicting exact durable ids fail closed");

      const cleanup = new DatabaseSync(env.databasePath);
      try { cleanup.prepare("DELETE FROM supervised_worker_sessions WHERE agent_id=?").run(stopped.id); }
      finally { cleanup.close(); }
      await recoveredBindings.beginSupervisedWorkerSessionMint({
        agent_id: stopped.id,
        room_id: stopped.room_id,
        agent_instance_id: `daemon:${stopped.id}`,
      });
      assert.deepEqual(await store.durablePurgeWorkerSessionAttestation(stopped.id), {
        workerSessionAttestation: "unknown",
        agentSessionId: null,
      }, "a later mint attempt vetoes older exact evidence until its response is durable");
    } finally { await recoveredBindings.close(); }
  } finally {
    await bindings.close().catch(() => undefined);
    await store.close();
    await env.cleanup();
  }
});

test("purge generation adoption never substitutes for durable credential-revocation acknowledgement", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const stopped: DaemonManifestEntry = {
    ...entry, id: "agent_revoke", desired_state: "stopped", observed_state: "stopped", condition: "none", last_error: null,
    workspace_path: null, work_attempt_id: null, provider_ref: null, activity: [], turn_control: null, last_worker_binding: null,
    workplace_liveness: { state: "unknown", observed_at: null, detail: null }, native_liveness: { state: "unknown", observed_at: null, detail: null },
  };
  try {
    await store.write([stopped]);
    const prepared = await store.preparePurge(1, {
      operationId: "purge_revoke", requestId: "purge_revoke", agentId: stopped.id, daemonGeneration: 8,
      externalRevokeRequired: true, workerSessionAttestation: "exact", agentSessionId: "session_revoke",
    });
    assert.equal(prepared.purge.phase, "revoking_credentials");
    assert.equal(prepared.purge.agent_session_id, "session_revoke");
    await store.close(); // daemon crashes after prepare but before Electron revoke
    const reopened = new ManifestStore(env.databasePath);
    const adopted = await reopened.adoptPurgeDaemonGeneration({
      operationId: "purge_revoke", agentId: stopped.id, expectedDaemonGeneration: 8, daemonGeneration: 9,
    });
    assert.equal(adopted.daemon_generation, 9);
    assert.equal(adopted.phase, "revoking_credentials", "generation N+1 must still require an explicit durable revoke acknowledgement");
    const acknowledged = await reopened.markPurgeCredentialsRevoked({
      operationId: "purge_revoke", agentId: stopped.id, expectedDaemonGeneration: 9, agentSessionId: "session_revoke",
    });
    assert.equal(acknowledged.phase, "local_commit");
    await reopened.close();
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("purge commit rolls every agent and work-attempt deletion back on a late injected failure", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const worktreeMarker = join(env.root, "rollback-worktree");
  const attemptId = "attempt_rollback";
  const executionId = "run_rollback";
  const stopped: DaemonManifestEntry = {
    ...entry, id: "agent_rollback", desired_state: "stopped", observed_state: "stopped", condition: "none", last_error: null,
    workspace_path: worktreeMarker, work_attempt_id: attemptId,
    provider_ref: { ...entry.provider_ref!, work_attempt_id: attemptId, execution_generation_id: executionId },
    activity: [], turn_control: null, last_worker_binding: null,
    workplace_liveness: { state: "unknown", observed_at: null, detail: null }, native_liveness: { state: "unknown", observed_at: null, detail: null },
  };
  try {
    await store.write([stopped]);
    seedTerminalAttempt(env.databasePath, attemptId, executionId, worktreeMarker);
    await store.preparePurge(1, {
      operationId: "purge_rollback", requestId: "purge_rollback", agentId: stopped.id, daemonGeneration: 2, externalRevokeRequired: false,
      workerSessionAttestation: "not_required", agentSessionId: null,
    });
    const injector = new DatabaseSync(env.databasePath);
    try {
      injector.exec(`CREATE TRIGGER inject_purge_rollback BEFORE DELETE ON agents
        WHEN old.agent_id='agent_rollback' BEGIN SELECT RAISE(ABORT,'injected purge rollback'); END`);
    } finally { injector.close(); }
    await assert.rejects(
      () => store.commitPurge(1, { operationId: "purge_rollback", agentId: stopped.id, daemonGeneration: 2 }),
      /injected purge rollback/,
    );
    const database = new DatabaseSync(env.databasePath);
    try {
      assert.equal(Number((database.prepare("SELECT version FROM agents WHERE agent_id=?").get(stopped.id) as { version: number }).version), 1);
      assert.equal((database.prepare("SELECT phase FROM agent_purge_operations WHERE operation_id='purge_rollback'").get() as { phase: string }).phase, "local_commit");
      for (const [table, column, value] of [
        ["agents", "agent_id", stopped.id], ["work_attempts", "work_attempt_id", attemptId],
        ["work_attempt_lease_epochs", "work_attempt_id", attemptId], ["work_attempt_checkpoints", "work_attempt_id", attemptId],
        ["work_attempt_executions", "work_attempt_id", attemptId],
      ] as const) {
        assert.equal(Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`).get(value) as { count: number }).count), 1);
      }
    } finally { database.close(); }
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("purge rejection leaves generation, identity, and journal unchanged", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write([entry]);
    await assert.rejects(() => store.preparePurge(1, {
      operationId: "purge_blocked", requestId: "purge_blocked", agentId: entry.id, daemonGeneration: 1,
      externalRevokeRequired: true, workerSessionAttestation: "exact", agentSessionId: "session_1",
    }), /fully stopped/);
    assert.equal((await store.load()).versions[entry.id], 1);
    assert.ok(await store.getEntry(entry.id));
    assert.equal(await store.getPurge("purge_blocked"), null);
  } finally { await store.close(); await env.cleanup(); }
});

test("stopped-agent purge retires prepared room-work effects while preserving active-execution and unrelated effect blockers", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const stopped: DaemonManifestEntry = {
    ...entry, id: "agent_rw_purge", desired_state: "stopped", observed_state: "stopped", condition: "none", last_error: null,
    workspace_path: null, work_attempt_id: null, provider_ref: null, activity: [], turn_control: null, last_worker_binding: null,
    workplace_liveness: { state: "unknown", observed_at: null, detail: null }, native_liveness: { state: "unknown", observed_at: null, detail: null },
  };
  try {
    await store.write([stopped]);
    const db = new DatabaseSync(env.databasePath);
    try {
      const nowIso = "2026-10-02T00:00:00.000Z";
      db.prepare(`
        INSERT INTO effects (
          id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
          retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
        ) VALUES
          ('eff-rw-pub', ?, ?, 'rw:v1:purge-pub', 1, 'prepared', ?, NULL, 1, 1, 1000000, 1790900030000, 'publication_unavailable', ?, ?),
          ('eff-rw-grp', ?, ?, 'rwg:v1:purge-grp', 1, 'prepared', ?, NULL, 1, 1, 1000000, 1790900030000, 'publication_unavailable', ?, ?)
      `).run(
        stopped.id, ROOM_WORK_PUBLISH_EFFECT_KIND,
        JSON.stringify({
          attempt_id: "att-1", digest: "a".repeat(64), review_page_digest: null,
          review_page_index: null, review_page_total: null, revision: 1, room_id: stopped.room_id, source_message_id: "msg_1",
        }),
        nowIso, nowIso,
        stopped.id, ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND,
        JSON.stringify({ inbox_item_id: "inbox-1", room_id: stopped.room_id, source_message_id: "msg_2" }),
        nowIso, nowIso,
      );
      // 1. An unrelated prepared bounded_mcp_effect MUST still block purge and roll back room-work retirement.
      seedBoundedMcpEffectRow(db, {
        id: "eff-mcp-block",
        agent_id: stopped.id,
        room_id: stopped.room_id,
        execution_generation_id: "gen-1",
        provider_turn_id: "turn-1",
        mcp_request_id: "req-1",
        tool_name: "send_message",
        request: {},
        mutation: true,
        state: "prepared",
        created_at: nowIso,
        updated_at: nowIso,
      });
    } finally { db.close(); }

    await assert.rejects(() => store.preparePurge(1, {
      operationId: "purge_rw_blocked_mcp", requestId: "purge_rw_blocked_mcp", agentId: stopped.id, daemonGeneration: 2,
      externalRevokeRequired: false, workerSessionAttestation: "not_required", agentSessionId: null,
    }), /blocker/);

    const checkAfterMcpBlock = new DatabaseSync(env.databasePath);
    try {
      assert.equal((checkAfterMcpBlock.prepare("SELECT state FROM effects WHERE id='eff-rw-pub'").get() as { state: string }).state, "prepared", "failed purge must roll back room-work retirement");
      assert.equal((checkAfterMcpBlock.prepare("SELECT state FROM effects WHERE id='eff-rw-grp'").get() as { state: string }).state, "prepared");
      // Remove unrelated MCP blocker, then seed an actively executing room-work upload.
      checkAfterMcpBlock.prepare("DELETE FROM effects WHERE id='eff-mcp-block'").run();
      checkAfterMcpBlock.prepare(`
        INSERT INTO effects (
          id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
          retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
        ) VALUES ('eff-rw-live', ?, ?, 'rw:v1:purge-live', 2, 'executing', ?, NULL, 1, 1, 1000000, NULL, NULL, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')
      `).run(
        stopped.id, ROOM_WORK_PUBLISH_EFFECT_KIND,
        JSON.stringify({
          attempt_id: "att-1", digest: "b".repeat(64), review_page_digest: null,
          review_page_index: null, review_page_total: null, revision: 2, room_id: stopped.room_id, source_message_id: "msg_3",
        }),
      );
    } finally { checkAfterMcpBlock.close(); }

    // 2. An actively executing room-work effect MUST block purge and roll back prepared retirements.
    await assert.rejects(() => store.preparePurge(1, {
      operationId: "purge_rw_blocked_exec", requestId: "purge_rw_blocked_exec", agentId: stopped.id, daemonGeneration: 2,
      externalRevokeRequired: false, workerSessionAttestation: "not_required", agentSessionId: null,
    }), /blocker/);

    const settleLive = new DatabaseSync(env.databasePath);
    try {
      assert.equal((settleLive.prepare("SELECT state FROM effects WHERE id='eff-rw-pub'").get() as { state: string }).state, "prepared");
      assert.equal((settleLive.prepare("SELECT state FROM effects WHERE id='eff-rw-live'").get() as { state: string }).state, "executing");
      // Once the active execution settles back to prepared (e.g. failed upload retry), purge succeeds cleanly.
      settleLive.prepare("UPDATE effects SET state='prepared', next_attempt_at_ms=1790900030000, last_error='publication_unavailable', updated_at='2026-10-02T00:00:05.000Z' WHERE id='eff-rw-live'").run();
    } finally { settleLive.close(); }

    const prepared = await store.preparePurge(1, {
      operationId: "purge_rw_ok", requestId: "purge_rw_ok", agentId: stopped.id, daemonGeneration: 2,
      externalRevokeRequired: false, workerSessionAttestation: "not_required", agentSessionId: null,
    });
    assert.equal(prepared.purge.phase, "local_commit");

    const checkAfterPrepare = new DatabaseSync(env.databasePath);
    try {
      for (const id of ["eff-rw-pub", "eff-rw-grp", "eff-rw-live"]) {
        const row = checkAfterPrepare.prepare("SELECT state, last_error FROM effects WHERE id=?").get(id) as { state: string; last_error: string };
        assert.equal(row.state, "failed");
        assert.equal(row.last_error, "agent_purged");
      }
    } finally { checkAfterPrepare.close(); }

    const committed = await store.commitPurge(1, {
      operationId: "purge_rw_ok", agentId: stopped.id, daemonGeneration: 2,
    });
    assert.equal(committed.purge.phase, "complete");
    assert.equal(await store.getEntry(stopped.id), undefined);
    const verifyDeleted = new DatabaseSync(env.databasePath);
    try {
      assert.equal(Number((verifyDeleted.prepare("SELECT COUNT(*) AS n FROM effects WHERE agent_id=?").get(stopped.id) as { n: number }).n), 0);
    } finally { verifyDeleted.close(); }
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("advancing a room move to active atomically retires prepared source-room room-work effects", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write([entry]);
    await store.prepareRoomMove({
      operation_id: "move_rw_1",
      request_id: "move_rw_1",
      agent_id: entry.id,
      source_room_id: entry.room_id,
      destination_room_id: "room_dest",
      daemon_generation: 2,
      work_attempt_id: null,
      execution_generation_id: null,
      agent_session_id: null,
      activating_inbox_item_id: null,
      provider_turn_id: null,
      effect_id: null,
      phase: "prepared",
    });

    const db = new DatabaseSync(env.databasePath);
    try {
      const nowIso = "2026-10-02T00:00:00.000Z";
      db.prepare(`
        INSERT INTO effects (
          id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
          retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
        ) VALUES
          ('eff-move-old-pub', ?, ?, 'rw:v1:move-old-pub', 1, 'prepared', ?, NULL, 1, 1, 1000000, 1790900030000, 'publication_unavailable', ?, ?),
          ('eff-move-old-grp', ?, ?, 'rwg:v1:move-old-grp', 1, 'prepared', ?, NULL, 1, 1, 1000000, 1790900030000, 'publication_unavailable', ?, ?),
          ('eff-move-new-pub', ?, ?, 'rw:v1:move-new-pub', 2, 'prepared', ?, NULL, 1, 0, 1000000, NULL, NULL, ?, ?)
      `).run(
        entry.id, ROOM_WORK_PUBLISH_EFFECT_KIND,
        JSON.stringify({
          attempt_id: "att-1", digest: "c".repeat(64), review_page_digest: null,
          review_page_index: null, review_page_total: null, revision: 1, room_id: entry.room_id, source_message_id: "msg_1",
        }),
        nowIso, nowIso,
        entry.id, ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND,
        JSON.stringify({ inbox_item_id: "inbox-old", room_id: entry.room_id, source_message_id: "msg_2" }),
        nowIso, nowIso,
        entry.id, ROOM_WORK_PUBLISH_EFFECT_KIND,
        JSON.stringify({
          attempt_id: "att-2", digest: "d".repeat(64), review_page_digest: null,
          review_page_index: null, review_page_total: null, revision: 1, room_id: "room_dest", source_message_id: "msg_9",
        }),
        nowIso, nowIso,
      );
    } finally { db.close(); }

    const active = await store.advanceRoomMove({
      operationId: "move_rw_1",
      agentId: entry.id,
      expectedDaemonGeneration: 2,
      expectedExecutionGenerationId: null,
      from: ["prepared"],
      to: "active",
      remoteRoomId: "room_dest",
      destinationCursor: "msg_9",
    });
    assert.equal(active.phase, "active");

    const check = new DatabaseSync(env.databasePath);
    try {
      for (const id of ["eff-move-old-pub", "eff-move-old-grp"]) {
        const row = check.prepare("SELECT state, last_error FROM effects WHERE id=?").get(id) as { state: string; last_error: string };
        assert.equal(row.state, "failed");
        assert.equal(row.last_error, "room_moved");
      }
      assert.equal((check.prepare("SELECT state FROM effects WHERE id='eff-move-new-pub'").get() as { state: string }).state, "prepared");
    } finally { check.close(); }
  } finally {
    await store.close();
    await env.cleanup();
  }
});
