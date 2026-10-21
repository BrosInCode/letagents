import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DAEMON_STATE_SCHEMA_VERSION } from "../daemon-state-database.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonManifestEntry } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import {
  TEST_PROVIDER_TURN_AUTHORITY,
  IMAGE_INPUT_UPDATE,
  entry,
  fixture,
  seedTerminalAttempt,
} from "./helpers/manifest-store-sqlite-fixture.js";

test("polling custody is internal, survives every manifest replacement and does not depend on cutover history", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const spoofed = { ...entry, polling_contract: "custodial_polling_v1" };
    await store.write(0, [spoofed]);
    assert.equal((await store.getAgentConfiguration(entry.id))?.polling_contract, null,
      "the flat projection cannot create polling custody");
    const database = (store as unknown as { database: DatabaseSync }).database;
    database.prepare("UPDATE agent_configurations SET polling_contract='custodial_polling_v1' WHERE agent_id=?").run(entry.id);
    database.prepare(`INSERT INTO execution_cutover_v2
      (operation_id,request_id,agent_id,execution_generation_id,from_mode,to_mode,strategy,phase,created_at_ms,updated_at_ms)
      VALUES('completed-reverse','completed-reverse',?,'run_1','daemon_inbox','mcp_polling','drain','complete',1,2)`).run(entry.id);
    const stale = { ...entry, polling_contract: null };
    await store.replaceEntry(1, stale);
    assert.equal((await store.getAgentConfiguration(entry.id))?.polling_contract, "custodial_polling_v1");
    await store.replaceEntriesBatch(2, [stale]);
    assert.equal((await store.getAgentConfiguration(entry.id))?.polling_contract, "custodial_polling_v1");
    await store.write(3, [stale]);
    assert.equal((await store.getAgentConfiguration(entry.id))?.polling_contract, "custodial_polling_v1");
    const updated = await store.updateAgentConfiguration(4, {
      agentId: entry.id, expectedRevision: 1, model: "new-model", reasoningEffort: null,
      charter: "Updated charter", permissionProfileId: "full_access", providerLaunchPolicy: { approvalPolicy: "never" }, imageInput: false,
    });
    assert.equal(updated.outcome, "updated");
    assert.equal(updated.configuration?.polling_contract, "custodial_polling_v1");
    const before = await store.load();
    assert.equal(Object.hasOwn(before.entries[0]!, "polling_contract"), false);
    assert.equal(Object.hasOwn((await store.getEntry(entry.id))!, "polling_contract"), false);
    await assert.rejects(() => store.replaceEntry(5, { ...entry, delivery_mode: "daemon_inbox" }), /CHECK/,
      "an unrelated replacement cannot silently downgrade custodial polling");
    assert.deepEqual(await store.load(), before, "failed replacement rolls back identity deletion and generation");
    assert.equal((await store.getAgentConfiguration(entry.id))?.polling_contract, "custodial_polling_v1");
    database.exec("DELETE FROM execution_cutover_v2 WHERE operation_id='completed-reverse'");
    await store.close();
    const reopened = new ManifestStore(env.databasePath);
    try {
      assert.equal((await reopened.getAgentConfiguration(entry.id))?.polling_contract, "custodial_polling_v1",
        "history pruning or daemon restart cannot erase current custody");
      assert.deepEqual(await reopened.load(), before);
      await reopened.removeEntry(before.generation, entry.id);
      assert.equal(await reopened.getAgentConfiguration(entry.id), undefined);
    } finally { await reopened.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("Inspector configuration revisions are optimistic, durable, and do not alter the flat manifest", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write(0, [entry]);
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
    assert.equal((await store.load()).generation, 2, "a revision conflict must not advance manifest generation");
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
    await store.write(0, [{ ...entry, image_input: true } as DaemonManifestEntry]);
    assert.equal((await store.getAgentConfiguration(entry.id))?.image_input, false,
      "a flat manifest entry cannot create the owner's image input choice");
    const inspection = new DatabaseSync(env.databasePath);
    try {
      assert.equal(inspection.prepare("SELECT image_input FROM agent_configurations WHERE agent_id=?").get(entry.id)?.image_input, 0);
      assert.deepEqual({ ...inspection.prepare("SELECT type,\"notnull\" AS required,dflt_value FROM pragma_table_info('agent_configurations') WHERE name='image_input'").get() },
        { type: "INTEGER", required: 1, dflt_value: "0" });
      inspection.exec("PRAGMA foreign_keys=OFF");
      assert.throws(() => inspection.prepare("UPDATE agent_configurations SET image_input=2").run(), /CHECK/,
        "only 0 and 1 are accepted by the column itself");
      assert.throws(() => inspection.prepare("UPDATE agent_configurations SET image_input=NULL").run(), /NOT NULL/);
    } finally { inspection.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("a schema 49 database without image input migrates to schema 50 with every agent off", async () => {
  const env = await fixture();
  const original = new ManifestStore(env.databasePath);
  try {
    const expected = await original.write(0, [entry, { ...entry, id: "agent_2", display_name: "SecondAgent", work_attempt_id: undefined, provider_ref: undefined, turn_control: undefined, reconciliation: undefined }]);
    await original.close();
    const old = new DatabaseSync(env.databasePath);
    old.exec("ALTER TABLE agent_configurations DROP COLUMN image_input; UPDATE manifest_metadata SET schema_version=49; PRAGMA user_version=49");
    assert.equal(old.prepare("SELECT 1 FROM pragma_table_info('agent_configurations') WHERE name='image_input'").get(), undefined);
    old.close();
    const migrated = new ManifestStore(env.databasePath);
    try {
      assert.equal((await migrated.getAgentConfiguration(entry.id))?.image_input, false);
      assert.equal((await migrated.getAgentConfiguration("agent_2"))?.image_input, false);
      assert.deepEqual((await migrated.load()).entries.map((agent) => agent.id), expected.entries.map((agent) => agent.id),
        "the migration keeps every agent");
      const inspection = new DatabaseSync(env.databasePath);
      try {
        assert.equal(inspection.prepare("PRAGMA user_version").get()?.user_version, DAEMON_STATE_SCHEMA_VERSION);
        assert.equal(inspection.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton=1").get()?.schema_version, DAEMON_STATE_SCHEMA_VERSION);
        assert.deepEqual(inspection.prepare("SELECT agent_id,image_input FROM agent_configurations ORDER BY agent_id").all().map((row) => ({ ...row })),
          [{ agent_id: "agent_1", image_input: 0 }, { agent_id: "agent_2", image_input: 0 }]);
      } finally { inspection.close(); }
      const generation = (await migrated.load()).generation;
      const updated = await migrated.updateAgentConfiguration(generation, IMAGE_INPUT_UPDATE(1, true));
      assert.equal(updated.outcome, "updated");
      assert.equal(updated.configuration?.image_input, true, "the added column takes the owner's choice");
      assert.equal((await migrated.getAgentConfiguration("agent_2"))?.image_input, false);
    } finally { await migrated.close(); }
  } finally { await original.close(); await env.cleanup(); }
});

test("a schema 39 database without image input gains the column through the older migration path", async () => {
  const env = await fixture();
  const original = new ManifestStore(env.databasePath);
  try {
    await original.write(0, [entry]);
    await original.close();
    const old = new DatabaseSync(env.databasePath);
    old.exec("ALTER TABLE agent_configurations DROP COLUMN image_input; ALTER TABLE agent_room_memberships DROP COLUMN local_room_id; UPDATE manifest_metadata SET schema_version=39; PRAGMA user_version=39");
    old.close();
    const migrated = new ManifestStore(env.databasePath);
    try {
      assert.equal((await migrated.getAgentConfiguration(entry.id))?.image_input, false);
      const inspection = new DatabaseSync(env.databasePath);
      try {
        assert.equal(inspection.prepare("PRAGMA user_version").get()?.user_version, DAEMON_STATE_SCHEMA_VERSION);
        assert.equal(inspection.prepare("SELECT image_input FROM agent_configurations WHERE agent_id=?").get(entry.id)?.image_input, 0);
      } finally { inspection.close(); }
    } finally { await migrated.close(); }
  } finally { await original.close(); await env.cleanup(); }
});

test("a current database refuses an image input column that is missing, weakened or holds an invalid value", async () => {
  const cases: Array<{ name: string; sql: string; refusal: RegExp }> = [
    { name: "missing column", sql: "ALTER TABLE agent_configurations DROP COLUMN image_input", refusal: /invalid image input column/ },
    { name: "column that allows null", sql: "ALTER TABLE agent_configurations DROP COLUMN image_input; ALTER TABLE agent_configurations ADD COLUMN image_input INTEGER DEFAULT 0", refusal: /invalid image input column/ },
    { name: "column that defaults to on", sql: "ALTER TABLE agent_configurations DROP COLUMN image_input; ALTER TABLE agent_configurations ADD COLUMN image_input INTEGER NOT NULL DEFAULT 1", refusal: /invalid image input column/ },
    // SQLite's own integrity check sees the broken CHECK constraint first, so the open fails either way.
    { name: "value outside 0 and 1", sql: "PRAGMA ignore_check_constraints=ON; UPDATE agent_configurations SET image_input=2; PRAGMA ignore_check_constraints=OFF", refusal: /invalid image input column|failed SQLite integrity validation/ },
  ];
  for (const { name, sql, refusal } of cases) {
    const env = await fixture();
    const original = new ManifestStore(env.databasePath);
    try {
      await original.write(0, [entry]);
      await original.close();
      const damaged = new DatabaseSync(env.databasePath);
      damaged.exec(sql);
      assert.equal(damaged.prepare("PRAGMA user_version").get()?.user_version, DAEMON_STATE_SCHEMA_VERSION, name);
      damaged.close();
      const reopened = new ManifestStore(env.databasePath);
      try {
        await assert.rejects(() => reopened.load(), refusal, name);
      } finally { await reopened.close(); }
      const inspection = new DatabaseSync(env.databasePath);
      try {
        assert.equal(inspection.prepare("PRAGMA user_version").get()?.user_version, DAEMON_STATE_SCHEMA_VERSION,
          `${name}: a refused open must not advance or repair the schema version`);
      } finally { inspection.close(); }
    } finally { await original.close(); await env.cleanup(); }
  }
});

test("image input is saved with the Inspector configuration and survives every manifest replacement", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write(0, [entry]);
    assert.equal((await store.getAgentConfiguration(entry.id))?.image_input, false);
    const updated = await store.updateAgentConfiguration(1, IMAGE_INPUT_UPDATE(1, true));
    assert.equal(updated.outcome, "updated");
    assert.equal(updated.configuration?.image_input, true);
    assert.equal(updated.configuration?.config_revision, 2, "turning the choice on is a configuration change like any other");
    assert.equal(updated.configuration?.runtime_configuration_revision, 1);
    const stale = { ...entry, observed_state: "idle" as const };
    await store.replaceEntry(2, stale);
    assert.equal((await store.getAgentConfiguration(entry.id))?.image_input, true, "a lifecycle replacement keeps the choice");
    await store.replaceEntriesBatch(3, [stale]);
    assert.equal((await store.getAgentConfiguration(entry.id))?.image_input, true, "a batch replacement keeps the choice");
    await store.write(4, [stale]);
    assert.equal((await store.getAgentConfiguration(entry.id))?.image_input, true, "a full manifest write keeps the choice");
    assert.equal(Object.hasOwn((await store.load()).entries[0]!, "image_input"), false, "the flat manifest never carries the choice");
    const conflict = await store.updateAgentConfiguration(5, IMAGE_INPUT_UPDATE(1, false));
    assert.equal(conflict.outcome, "conflict");
    assert.equal((await store.getAgentConfiguration(entry.id))?.image_input, true, "a conflicting edit does not change the choice");
    await store.close();
    const reopened = new ManifestStore(env.databasePath);
    try {
      assert.equal((await reopened.getAgentConfiguration(entry.id))?.image_input, true, "the choice survives a restart");
      const generation = (await reopened.load()).generation;
      const off = await reopened.updateAgentConfiguration(generation, IMAGE_INPUT_UPDATE(2, false));
      assert.equal(off.outcome, "updated");
      assert.equal(off.configuration?.image_input, false, "the owner can turn the choice off again");
    } finally { await reopened.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("room-move journal is request-idempotent and exact-generation phase fenced", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write(0, [entry]);
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
      await store.write(0, [moving]);
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
          const row = database.prepare("SELECT state,result_json,error FROM supervised_agent_effects WHERE effect_id=?")
            .get(prepared.effect.effect_id) as { state: string; result_json: string | null; error: string | null };
          return { state: row.state, result: row.result_json ? JSON.parse(row.result_json) as unknown : null, error: row.error };
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
          BEFORE UPDATE OF state ON supervised_agent_effects
          WHEN OLD.effect_id='${prepared.effect.effect_id}' AND OLD.state='prepared'
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
    await store.write(0, [moving]);
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
        return (database.prepare("SELECT state FROM supervised_agent_effects WHERE effect_id=?")
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
        BEFORE UPDATE OF state ON supervised_agent_effects
        WHEN OLD.effect_id='${prepared.effect.effect_id}' AND OLD.state='prepared' AND NEW.state='failed'
        BEGIN SELECT RAISE(ABORT,'injected effect rollback'); END`);
    } finally { inspection.close(); }

    const paused = { ...moving, desired_state: "paused" as const };
    await assert.rejects(() => store.replaceEntry(1, paused, undefined, {
      agentId: moving.id,
      detail: "pause before destination join",
    }), /injected effect rollback/);
    assert.equal((await store.load()).generation, 1, "manifest generation rolls back with the effect failure");
    assert.equal((await store.getEntry(moving.id))?.desired_state, "running");
    assert.equal((await store.getRoomMove(operationId))?.phase, "waiting_for_current_turn");
    assert.equal(effectState(), "prepared");
    assert.equal((await inbox.get(item.inbox_item_id))?.state, "dispatching");
    assert.equal((await inbox.providerTurnBinding(item.inbox_item_id))?.provider_turn_id, "move-lifecycle-turn");

    const corrupt = new DatabaseSync(env.databasePath);
    try {
      corrupt.exec("DROP TRIGGER reject_prejoin_effect_failure");
      corrupt.prepare("UPDATE supervised_agent_effects SET room_id=? WHERE effect_id=?")
        .run("wrong-source-room", prepared.effect.effect_id);
    } finally { corrupt.close(); }
    await assert.rejects(() => store.replaceEntry(1, paused, undefined, {
      agentId: moving.id,
      detail: "pause before destination join",
    }), /detached from its exact unresolved effect journal/i);
    assert.equal((await store.getEntry(moving.id))?.desired_state, "running");
    assert.equal((await store.getRoomMove(operationId))?.phase, "waiting_for_current_turn");

    const repair = new DatabaseSync(env.databasePath);
    try {
      repair.prepare("UPDATE supervised_agent_effects SET room_id=? WHERE effect_id=?")
        .run(moving.room_id, prepared.effect.effect_id);
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
    await store.write(0, [moving]);
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
    assert.equal((await store.load()).generation, 1);
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
    await store.write(0, [controlled]);
    await assert.rejects(() => store.prepareRoomMove(move), /blocked by unresolved turn-control/i);
    const completed = await store.replaceEntry(1, {
      ...controlled,
      turn_control: { ...controlled.turn_control!, status: "completed", error: null },
    });
    assert.equal((await store.prepareRoomMove(move)).created, true);
    await assert.rejects(() => store.prepareTurnControlState(completed.generation, {
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
    await store.write(0, [stopped]);
    const cancelled = await inbox.enqueueCorrection({
      agent_id: stopped.id, room_id: stopped.room_id, source_message_id: "purge-cancelled-receipt",
      source_message: { text: "cancel before provider work" }, activation: { decision: "activate" },
    });
    await inbox.transition(cancelled.inbox_item_id, "blocked", { last_error: "safe pre-turn cancellation" });
    assert.equal((await inbox.skipBlocked(cancelled.inbox_item_id)).state, "cancelled_by_user",
      "a retained user-cancelled receipt is terminal purge history, not live work");
    await inbox.close();
    const beforePurge = new DatabaseSync(env.databasePath);
    assert.equal(Number((beforePurge.prepare("SELECT last_sequence FROM turn_control_sequence_watermarks WHERE agent_id=?").get(stopped.id) as { last_sequence: number }).last_sequence), 1);
    beforePurge.prepare(`INSERT INTO supervised_agent_effects
      (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
       tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,'uncertain',NULL,?,?,?)`).run(
      "uncertain-before-purge", stopped.id, stopped.room_id, executionId, "retired-turn",
      "retired-request", "send_message", "{}", "May already have completed; verify external state.",
      "2026-08-05T12:00:00.000Z", "2026-08-05T12:00:00.000Z",
    );
    beforePurge.prepare(`INSERT INTO supervised_agent_effect_tombstones
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
    assert.equal(committed.generation, 2);
    assert.equal(committed.purge.phase, "complete");
    assert.equal(await reopened.getEntry(stopped.id), undefined);
    assert.equal(await readFile(worktreeMarker, "utf8"), "keep");
    const database = new DatabaseSync(env.databasePath);
    try {
      for (const [table, column, value] of [
        ["agent_identities", "agent_id", stopped.id], ["worker_session_bindings", "entry_id", stopped.id], ["supervised_agent_inbox", "agent_id", stopped.id],
        ["supervised_agent_effects", "agent_id", stopped.id], ["supervised_agent_effect_tombstones", "agent_id", stopped.id],
        ["supervised_worker_mint_states", "agent_id", stopped.id],
        ["reconciliation_action_tombstones", "agent_id", stopped.id],
        ["turn_control_sequence_watermarks", "agent_id", stopped.id],
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
    await store.write(0, [stopped]);
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
    await store.write(0, [stopped]);
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
    await store.write(0, [stopped]);
    seedTerminalAttempt(env.databasePath, attemptId, executionId, worktreeMarker);
    await store.preparePurge(1, {
      operationId: "purge_rollback", requestId: "purge_rollback", agentId: stopped.id, daemonGeneration: 2, externalRevokeRequired: false,
      workerSessionAttestation: "not_required", agentSessionId: null,
    });
    const injector = new DatabaseSync(env.databasePath);
    try {
      injector.exec(`CREATE TRIGGER inject_purge_rollback BEFORE DELETE ON agent_identities
        WHEN old.agent_id='agent_rollback' BEGIN SELECT RAISE(ABORT,'injected purge rollback'); END`);
    } finally { injector.close(); }
    await assert.rejects(
      () => store.commitPurge(1, { operationId: "purge_rollback", agentId: stopped.id, daemonGeneration: 2 }),
      /injected purge rollback/,
    );
    const database = new DatabaseSync(env.databasePath);
    try {
      assert.equal(Number((database.prepare("SELECT generation FROM manifest_metadata WHERE singleton=1").get() as { generation: number }).generation), 1);
      assert.equal((database.prepare("SELECT phase FROM agent_purge_operations WHERE operation_id='purge_rollback'").get() as { phase: string }).phase, "local_commit");
      for (const [table, column, value] of [
        ["agent_identities", "agent_id", stopped.id], ["work_attempts", "work_attempt_id", attemptId],
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
    await store.write(0, [entry]);
    await assert.rejects(() => store.preparePurge(1, {
      operationId: "purge_blocked", requestId: "purge_blocked", agentId: entry.id, daemonGeneration: 1,
      externalRevokeRequired: true, workerSessionAttestation: "exact", agentSessionId: "session_1",
    }), /fully stopped/);
    assert.equal((await store.load()).generation, 1);
    assert.ok(await store.getEntry(entry.id));
    assert.equal(await store.getPurge("purge_blocked"), null);
  } finally { await store.close(); await env.cleanup(); }
});

test("v12 canonical validation rejects a malformed durable-operation index", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try { await store.write(0, [entry]); } finally { await store.close(); }
  const database = new DatabaseSync(env.databasePath);
  try {
    database.exec("DROP INDEX one_active_agent_room_move; CREATE UNIQUE INDEX one_active_agent_room_move ON agent_room_moves(agent_id,updated_at) WHERE phase NOT IN ('active','failed')");
  } finally { database.close(); }
  const reopened = new ManifestStore(env.databasePath);
  try { await assert.rejects(() => reopened.load(), /index one_active_agent_room_move is invalid/); }
  finally { await reopened.close(); await env.cleanup(); }
});

test("v12 canonical validation rejects a mint-state table that could persist unchecked evidence", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try { await store.write(0, [entry]); } finally { await store.close(); }
  const database = new DatabaseSync(env.databasePath);
  try {
    database.exec(`
      DROP TABLE supervised_worker_mint_states;
      CREATE TABLE supervised_worker_mint_states (
        agent_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        agent_session_id TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  } finally { database.close(); }
  const reopened = new ManifestStore(env.databasePath);
  try {
    await assert.rejects(
      () => reopened.load(),
      /mint-state table does not match its canonical strict definition/,
    );
  } finally { await reopened.close(); await env.cleanup(); }
});

test("v11 mint evidence migrates transactionally to unknown and exact without credential columns", async () => {
  const env = await fixture();
  const neverMinted: DaemonManifestEntry = {
    ...entry,
    id: "agent_v11_never_minted",
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
  const exact: DaemonManifestEntry = {
    ...neverMinted,
    id: "agent_v11_exact",
    last_worker_binding: {
      agent_session_id: "session_v11_exact",
      work_attempt_id: "attempt_v11_exact",
      execution_generation_id: "execution_v11_exact",
      updated_at: "2026-07-20T00:00:00.000Z",
    },
  };
  const initialized = new ManifestStore(env.databasePath);
  try {
    await initialized.write(0, [neverMinted, exact]);
    await initialized.close();
    const historical = new DatabaseSync(env.databasePath);
    historical.exec(`
      DROP TABLE supervised_worker_mint_states;
      UPDATE manifest_metadata SET schema_version=11 WHERE singleton=1;
      PRAGMA user_version=11;
    `);
    historical.close();

    const interrupted = new ManifestStore(env.databasePath, undefined, undefined, () => {
      throw new Error("interrupt v12 mint-state migration");
    });
    await assert.rejects(() => interrupted.load(), /interrupt v12/);
    await interrupted.close();
    const afterInterruption = new DatabaseSync(env.databasePath);
    try {
      assert.equal((afterInterruption.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 11);
      assert.equal(
        (afterInterruption.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton=1")
          .get() as { schema_version: number }).schema_version,
        11,
      );
      assert.equal(
        afterInterruption.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervised_worker_mint_states'").get(),
        undefined,
        "interrupted schema creation rolls back with the version markers",
      );
    } finally { afterInterruption.close(); }

    const migrated = new ManifestStore(env.databasePath);
    await migrated.load();
    await migrated.close();
    const inspection = new DatabaseSync(env.databasePath);
    try {
      assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_SCHEMA_VERSION);
      const neverMintedState = inspection.prepare("SELECT phase,agent_session_id FROM supervised_worker_mint_states WHERE agent_id=?")
        .get(neverMinted.id) as { phase: string; agent_session_id: string | null };
      assert.equal(neverMintedState.phase, "minting_unknown", "v11 explicit null may have crossed the old lost-response window");
      assert.equal(neverMintedState.agent_session_id, null);
      const exactState = inspection.prepare("SELECT phase,agent_session_id FROM supervised_worker_mint_states WHERE agent_id=?")
        .get(exact.id) as { phase: string; agent_session_id: string | null };
      assert.equal(exactState.phase, "exact");
      assert.equal(exactState.agent_session_id, "session_v11_exact");
      const columns = (inspection.prepare("PRAGMA table_info(supervised_worker_mint_states)").all() as Array<{ name: string }>)
        .map((column) => column.name);
      assert.equal(columns.some((column) => /(token|bearer|credential|secret)/i.test(column)), false);
    } finally { inspection.close(); }
  } finally {
    await initialized.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("v10 state migrates through the exact-session purge fence to the current schema before version markers advance", async () => {
  const env = await fixture();
  const initialized = new ManifestStore(env.databasePath);
  try {
    const stopped: DaemonManifestEntry = {
      ...entry,
      id: "agent_v10_purge",
      desired_state: "stopped",
      observed_state: "stopped",
      condition: "none",
      last_error: null,
      workspace_path: null,
      work_attempt_id: null,
      provider_ref: null,
      activity: [],
      turn_control: null,
      last_worker_binding: {
        agent_session_id: "session_v10_exact",
        work_attempt_id: "attempt_v10",
        execution_generation_id: "execution_v10",
        updated_at: "2026-07-19T00:02:02.000Z",
      },
      workplace_liveness: { state: "unknown", observed_at: null, detail: null },
      native_liveness: { state: "unknown", observed_at: null, detail: null },
    };
    await initialized.write(0, [stopped]);
    await initialized.preparePurge(1, {
      operationId: "purge_v10", requestId: "purge_v10", agentId: stopped.id, daemonGeneration: 8,
      externalRevokeRequired: true, workerSessionAttestation: "exact", agentSessionId: "session_v10_exact",
    });
    await initialized.close();
    const historical = new DatabaseSync(env.databasePath);
    historical.exec(`
      CREATE TABLE agent_purge_operations_v10 (
        operation_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 1),
        phase TEXT NOT NULL CHECK(phase IN ('prepared','revoking_credentials','local_commit','complete','failed')),
        external_revoke_required INTEGER NOT NULL CHECK(external_revoke_required IN (0,1)),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        attached_work_attempt_id TEXT,
        preserved_workspace_path TEXT
      ) STRICT;
      INSERT INTO agent_purge_operations_v10
        SELECT operation_id,request_id,agent_id,daemon_generation,phase,external_revoke_required,error,created_at,updated_at,
          attached_work_attempt_id,preserved_workspace_path
        FROM agent_purge_operations;
      DROP TABLE agent_purge_operations;
      ALTER TABLE agent_purge_operations_v10 RENAME TO agent_purge_operations;
      UPDATE manifest_metadata SET schema_version=10 WHERE singleton=1;
      PRAGMA user_version=10;
    `);
    historical.close();

    const migrated = new ManifestStore(env.databasePath);
    await migrated.load();
    const recovered = await migrated.getPurge("purge_v10");
    assert.equal(recovered?.phase, "revoking_credentials");
    assert.equal(recovered?.worker_session_attestation, "exact");
    assert.equal(recovered?.agent_session_id, "session_v10_exact");
    const acknowledged = await migrated.markPurgeCredentialsRevoked({
      operationId: "purge_v10",
      agentId: stopped.id,
      expectedDaemonGeneration: 8,
      agentSessionId: "session_v10_exact",
    });
    assert.equal(acknowledged.phase, "local_commit");
    await migrated.close();
    const completion = new ManifestStore(env.databasePath);
    const committed = await completion.commitPurge(1, {
      operationId: "purge_v10", agentId: stopped.id, daemonGeneration: 8,
    });
    assert.equal(committed.purge.phase, "complete");
    await completion.close();
    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.equal(
      (inspection.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton=1").get() as { schema_version: number }).schema_version,
      DAEMON_STATE_SCHEMA_VERSION,
    );
    const columns = inspection.prepare("PRAGMA table_info(agent_purge_operations)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "agent_session_id"), true);
    assert.equal(columns.some((column) => column.name === "worker_session_attestation"), true);
    inspection.close();
  } finally {
    await initialized.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("v10 revoking purge without exact retained evidence migrates to recoverable state and rejects false acknowledgement", async () => {
  const env = await fixture();
  const initialized = new ManifestStore(env.databasePath);
  try {
    const { last_worker_binding: _legacyBinding, ...entryWithoutBindingEvidence } = entry;
    const stopped: DaemonManifestEntry = {
      ...entryWithoutBindingEvidence,
      id: "agent_v10_unknown_purge",
      desired_state: "stopped",
      observed_state: "stopped",
      condition: "none",
      last_error: null,
      workspace_path: null,
      work_attempt_id: null,
      provider_ref: null,
      activity: [],
      turn_control: null,
      workplace_liveness: { state: "unknown", observed_at: null, detail: null },
      native_liveness: { state: "unknown", observed_at: null, detail: null },
    };
    await initialized.write(0, [stopped]);
    await initialized.preparePurge(1, {
      operationId: "purge_v10_unknown", requestId: "purge_v10_unknown", agentId: stopped.id, daemonGeneration: 9,
      externalRevokeRequired: true, workerSessionAttestation: "unknown", agentSessionId: null,
    });
    await initialized.close();
    const historical = new DatabaseSync(env.databasePath);
    historical.exec(`
      CREATE TABLE agent_purge_operations_v10 (
        operation_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 1),
        phase TEXT NOT NULL CHECK(phase IN ('prepared','revoking_credentials','local_commit','complete','failed')),
        external_revoke_required INTEGER NOT NULL CHECK(external_revoke_required IN (0,1)),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        attached_work_attempt_id TEXT,
        preserved_workspace_path TEXT
      ) STRICT;
      INSERT INTO agent_purge_operations_v10
        SELECT operation_id,request_id,agent_id,daemon_generation,'revoking_credentials',external_revoke_required,error,created_at,updated_at,
          attached_work_attempt_id,preserved_workspace_path
        FROM agent_purge_operations;
      DROP TABLE agent_purge_operations;
      ALTER TABLE agent_purge_operations_v10 RENAME TO agent_purge_operations;
      UPDATE manifest_metadata SET schema_version=10 WHERE singleton=1;
      PRAGMA user_version=10;
    `);
    historical.close();

    const migrated = new ManifestStore(env.databasePath);
    await migrated.load();
    const recovered = await migrated.getPurge("purge_v10_unknown");
    assert.equal(recovered?.phase, "reprepare_credentials");
    assert.equal(recovered?.worker_session_attestation, "unknown");
    assert.equal(recovered?.agent_session_id, null);
    await assert.rejects(
      () => migrated.markPurgeCredentialsRevoked({
        operationId: "purge_v10_unknown", agentId: stopped.id, expectedDaemonGeneration: 9, agentSessionId: "guessed_session",
      }),
      ManifestConflictError,
    );
    await assert.rejects(
      () => migrated.markPurgeGrantRevokedWithoutWorkerSession({
        operationId: "purge_v10_unknown", agentId: stopped.id, expectedDaemonGeneration: 9,
      }),
      ManifestConflictError,
    );
    await migrated.close();
  } finally {
    await initialized.close().catch(() => undefined);
    await env.cleanup();
  }
});
