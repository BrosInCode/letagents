import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { DAEMON_STATE_SCHEMA_VERSION, DaemonStateSchema } from "../daemon-state-database.js";
import { ManifestStore } from "../manifest-store.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { matchesPollingActivationRuntime, POLLING_OFFER_REPLAY_WINDOW, recordPollingOffer, validatePollingActivationSchema, validatePollingOfferSchema } from "../custodial-polling-activation.js";
import {
  TEST_PROVIDER_TURN_AUTHORITY,
  terminal,
  entry,
  fixture,
  deliveryDrainCoordinates,
  seedActiveDrainExecution,
  seedPollingActivationRuntime,
  withRuntimeIdentity,
} from "./helpers/manifest-store-sqlite-fixture.js";

test("polling offers persist a single successor chain without advancing the cursor until its exact tail is acknowledged", async () => {
  const env = await fixture(); let store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath);
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  try {
    const activation = await seedPollingActivationRuntime(env, store, inbox, bindings);
    await store.preparePollingActivation(activation, async commit => commit());
    await store.markPollingActivationDispatch(activation, async commit => commit());
    await store.checkpointPollingActivationTurn({ ...activation, providerTurnId: "native-turn" }, async commit => commit());
    const database = new DatabaseSync(env.databasePath);
    try {
      database.exec("CREATE TRIGGER reject_offer_manifest_reinsert BEFORE DELETE ON agent_identities BEGIN SELECT RAISE(ABORT,'offer cannot replace manifest graph'); END");
      const before = await store.load();
      const identity = { operationId: activation.operationId, agentId: activation.agentId,
        processIncarnationId: "01234567-89ab-4cde-8fab-0123456789ab" };
      const initial = await store.acknowledgePollingOffer({ ...identity, roomCursor: null }, async commit => commit());
      assert.deepEqual(initial, { acknowledged: false, offer: null, roomCursor: "msg_47",
        bindingEpoch: database.prepare("SELECT binding_epoch FROM worker_session_bindings").get()!.binding_epoch });
      const scope = { ...identity, expectedBindingEpoch: initial.bindingEpoch };
      assert.deepEqual(await store.acknowledgePollingOffer({ ...scope, roomCursor: "msg_49" }, async commit => commit()), initial);
      assert.equal(await store.recordPollingOffer({ ...scope, requestId: "empty", inputCursor: "msg_47", offeredFrontier: "msg_47" }, async commit => commit()), null);
      assert.equal(await store.getPollingOfferTail(activation.operationId), null);
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custodial_polling_offers").get()!.n, 0);
      const first = await store.recordPollingOffer({ ...scope, requestId: 1, inputCursor: "msg_47", offeredFrontier: "msg_49" }, async commit => commit());
      assert.ok(first);
      assert.equal(first.mcp_request_id, "1"); assert.equal(first.predecessor_offer_id, null);
      assert.deepEqual(await store.recordPollingOffer({ ...scope, requestId: 1, inputCursor: "msg_47", offeredFrontier: "msg_49" }, async commit => commit()), first);
      const second = await store.recordPollingOffer({ ...scope, requestId: "1", inputCursor: "msg_47", offeredFrontier: "msg_50" }, async commit => commit());
      assert.ok(second);
      assert.equal(second.mcp_request_id, '"1"'); assert.equal(second.predecessor_offer_id, first.offer_id);
      await assert.rejects(store.recordPollingOffer({ ...scope, requestId: 1, inputCursor: "msg_47", offeredFrontier: "msg_49" }, async commit => commit()), /superseded/);
      for (const requestId of [1, "1"]) await assert.rejects(store.recordPollingOffer({ ...scope, requestId, inputCursor: "msg_47", offeredFrontier: "msg_47" }, async commit => commit()), /invocation changed/);
      assert.equal(await store.recordPollingOffer({ ...scope, requestId: "empty-tail", inputCursor: "msg_47", offeredFrontier: "msg_47" }, async commit => commit()), null);
      assert.deepEqual(await store.getPollingOfferTail(activation.operationId), second, "no-progress reads cannot supersede an outstanding offer");
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custodial_polling_offers").get()!.n, 2);
      for (const roomCursor of [null, "msg_49"]) assert.deepEqual(await store.acknowledgePollingOffer({ ...scope, roomCursor }, async commit => commit()),
        { ...initial, offer: second });
      await assert.rejects(store.acknowledgePollingOffer({ ...scope, roomCursor: "opaque" }, async commit => commit()), /numeric room cursor/);
      assert.equal(database.prepare("SELECT room_cursor FROM worker_session_bindings").get()?.room_cursor, "msg_47");
      assert.deepEqual(await store.load(), before, "offering/superseding does not rewrite the manifest or consume work");
      await store.close(); store = new ManifestStore(env.databasePath);
      assert.deepEqual(await store.getPollingOfferTail(activation.operationId), second, "outstanding offer survives daemon restart");
      const replacementScope = { ...scope, processIncarnationId: "fedcba98-7654-4321-8fab-0123456789ab" };
      const replacement = await store.recordPollingOffer({ ...replacementScope, requestId: 1, inputCursor: "msg_47", offeredFrontier: "msg_50" }, async commit => commit());
      assert.ok(replacement);
      assert.equal(replacement.predecessor_offer_id, second.offer_id);
      assert.equal((await store.acknowledgePollingOffer({ ...scope, roomCursor: "msg_50" }, async commit => commit())).acknowledged, false,
        "a previous MCP process cannot acknowledge the replacement process's offer");
      const repeatedFrontier = await store.recordPollingOffer({ ...replacementScope, requestId: 2, inputCursor: "msg_47", offeredFrontier: "msg_50" }, async commit => commit());
      assert.ok(repeatedFrontier);
      const acknowledged = await store.acknowledgePollingOffer({ ...replacementScope, roomCursor: "msg_50" }, async commit => commit());
      assert.equal(acknowledged.acknowledged, true); assert.equal(acknowledged.offer?.offer_id, repeatedFrontier.offer_id);
      assert.equal(acknowledged.roomCursor, "msg_50"); assert.ok(acknowledged.offer?.acknowledged_at_ms);
      assert.equal(acknowledged.bindingEpoch, initial.bindingEpoch);
      assert.deepEqual(await store.acknowledgePollingOffer({ ...replacementScope, roomCursor: "msg_50" }, async commit => commit()), acknowledged);
      assert.equal(await store.recordPollingOffer({ ...replacementScope, requestId: "empty-after-ack", inputCursor: "msg_50", offeredFrontier: "msg_50" }, async commit => commit()), null);
      assert.deepEqual(await store.getPollingOfferTail(activation.operationId), acknowledged.offer);
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custodial_polling_offers WHERE acknowledged_at_ms IS NOT NULL").get()?.n, 1,
        "same-frontier acknowledgement marks only the current tail, never its superseded history");
      const last = await store.recordPollingOffer({ ...replacementScope, requestId: 3, inputCursor: "msg_50", offeredFrontier: "msg_51" }, async commit => commit());
      await store.completePollingActivation({ ...activation, providerTurnId: "native-turn", outcome: "completed" }, async commit => commit());
      assert.deepEqual(await store.getPollingOfferTail(activation.operationId), last, "native completion never fabricates a cursor ACK");
      assert.equal(database.prepare("SELECT room_cursor FROM worker_session_bindings").get()?.room_cursor, "msg_50");
      await assert.rejects(store.acknowledgePollingOffer({ ...replacementScope, roomCursor: "msg_51" }, async commit => commit()), /active native activation/);
      validatePollingOfferSchema(database);
      database.exec("DROP TRIGGER reject_offer_manifest_reinsert");
    } finally { database.close(); }
  } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
});

test("polling offer and ACK transactions recheck exact authority and roll back the receipt with the worker cursor", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath);
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  try {
    const activation = await seedPollingActivationRuntime(env, store, inbox, bindings);
    const input = { operationId: activation.operationId, agentId: activation.agentId,
      processIncarnationId: "01234567-89ab-4cde-8fab-0123456789ab", requestId: 1, inputCursor: "msg_47", offeredFrontier: "msg_50", expectedBindingEpoch: 1 };
    await store.preparePollingActivation(activation, async commit => commit());
    await assert.rejects(store.recordPollingOffer(input, async commit => commit()), /active native activation/);
    await store.markPollingActivationDispatch(activation, async commit => commit());
    await store.checkpointPollingActivationTurn({ ...activation, providerTurnId: "native-turn" }, async commit => commit());
    input.expectedBindingEpoch = (await store.acknowledgePollingOffer({ ...input, roomCursor: null }, async commit => commit())).bindingEpoch;
    await assert.rejects(store.recordPollingOffer(input, undefined as never), /ownership commit fence/);
    await assert.rejects(store.recordPollingOffer(input, async () => {}), /without committing/);
    for (const bad of [
      { ...input, operationId: "missing" }, { ...input, agentId: "other" }, { ...input, processIncarnationId: "4312" },
      { ...input, requestId: 1.5 }, { ...input, inputCursor: "opaque" },
      { ...input, offeredFrontier: "msg_46" }, { ...input, inputCursor: "msg_49" },
      ...[0, -1, 1.5, Number.NaN, input.expectedBindingEpoch + 1].map(expectedBindingEpoch => ({ ...input, expectedBindingEpoch })),
    ]) await assert.rejects(store.recordPollingOffer(bad, async commit => commit()));
    assert.equal(await store.getPollingOfferTail(activation.operationId), null);
    let offer = await store.recordPollingOffer(input, async commit => commit());
    assert.ok(offer);
    const ack = { ...input, roomCursor: "msg_50" };
    const database = new DatabaseSync(env.databasePath);
    try {
      for (const [sql, undo] of [
        ["UPDATE worker_session_bindings SET agent_session_id='other'", "UPDATE worker_session_bindings SET agent_session_id='session_2'"],
        ["UPDATE worker_session_bindings SET room_cursor='msg_48'", "UPDATE worker_session_bindings SET room_cursor='msg_47'"],
        ["UPDATE agent_configurations SET config_revision=3", "UPDATE agent_configurations SET config_revision=2"],
        ["UPDATE runtime_deployments SET custodial_launch_agent_session_id='other'", "UPDATE runtime_deployments SET custodial_launch_agent_session_id='session_2'"],
        ["UPDATE supervised_worker_sessions SET room_id='other'", "UPDATE supervised_worker_sessions SET room_id=(SELECT room_id FROM worker_session_bindings)"],
        ["UPDATE supervised_worker_sessions SET agent_session_id='other'", "UPDATE supervised_worker_sessions SET agent_session_id='session_2'"],
        ["UPDATE supervised_worker_sessions SET execution_generation_id='other'", "UPDATE supervised_worker_sessions SET execution_generation_id='run_2'"],
        ["UPDATE supervised_worker_sessions SET credential_ref='other'", "UPDATE supervised_worker_sessions SET credential_ref=(SELECT credential_ref FROM worker_session_bindings)"],
        ...["'2000-01-01T00:00:00.000Z'", "'invalid'", "NULL"].map(expires => [`UPDATE supervised_worker_sessions SET expires_at=${expires}`, "UPDATE supervised_worker_sessions SET expires_at='2099-01-01T00:00:00.000Z'"]),
      ]) {
        assert.equal((await store.acknowledgePollingOffer({ ...ack, roomCursor: null }, async commit => commit())).bindingEpoch, input.expectedBindingEpoch);
        database.exec(sql!);
        await assert.rejects(store.acknowledgePollingOffer(ack, async commit => commit()), /changed/);
        await assert.rejects(store.recordPollingOffer({ ...input, requestId: 2 }, async commit => commit()));
        assert.deepEqual(await store.getPollingOfferTail(activation.operationId), offer);
        database.exec(undo!);
        assert.deepEqual(await store.recordPollingOffer(input, async commit => commit()), offer, "restored exact session authority accepts the original tail");
      }
      await assert.rejects(store.recordPollingOffer({ ...input, requestId: "expired-before-commit" }, async commit => {
        database.exec("UPDATE supervised_worker_sessions SET expires_at='2000-01-01T00:00:00.000Z'");
        await commit();
      }), /expired/);
      assert.deepEqual(await store.getPollingOfferTail(activation.operationId), offer, "worker expiry is checked inside the fenced transaction");
      database.exec("UPDATE supervised_worker_sessions SET expires_at='2099-01-01T00:00:00.000Z'");
      const previousBinding = (await bindings.get(input.agentId))!;
      await bindings.bind({ ...previousBinding, agent_session_token: "test-rebound-token" }, { roomCursor: "msg_47" });
      const rebound = await store.acknowledgePollingOffer(ack, async commit => commit());
      assert.equal(rebound.acknowledged, false,
        "same-session formal rebinding must invalidate the old offer's delayed ACK");
      assert.equal(rebound.roomCursor, "msg_47"); assert.ok(rebound.bindingEpoch > input.expectedBindingEpoch);
      assert.deepEqual(await store.acknowledgePollingOffer({ ...ack, roomCursor: null }, async commit => commit()), rebound);
      await assert.rejects(store.recordPollingOffer(input, async commit => commit()), /binding epoch changed/);
      await assert.rejects(store.recordPollingOffer({ ...input, requestId: 2 }, async commit => commit()), /binding epoch changed/);
      await assert.rejects(store.recordPollingOffer({ ...input, requestId: "empty", offeredFrontier: "msg_47" }, async commit => commit()), /binding epoch changed/);
      input.expectedBindingEpoch = rebound.bindingEpoch;
      await assert.rejects(store.recordPollingOffer(input, async commit => commit()), /invocation changed/);
      const replacement = await store.recordPollingOffer({ ...input, requestId: 2 }, async commit => commit());
      assert.ok(replacement);
      assert.equal(replacement.predecessor_offer_id, offer.offer_id);
      assert.ok(replacement.binding_epoch > offer.binding_epoch);
      offer = replacement;
      database.exec("CREATE TRIGGER reject_offer_worker_cursor AFTER UPDATE OF room_cursor ON worker_session_bindings BEGIN SELECT RAISE(ABORT,'test ACK rollback'); END");
      await assert.rejects(store.acknowledgePollingOffer(ack, async commit => commit()), /test ACK rollback/);
      assert.deepEqual(await store.getPollingOfferTail(activation.operationId), offer);
      assert.equal(database.prepare("SELECT room_cursor FROM worker_session_bindings").get()?.room_cursor, "msg_47");
      database.exec("DROP TRIGGER reject_offer_worker_cursor");
      assert.equal((await store.acknowledgePollingOffer(ack, async commit => commit())).acknowledged, true);
      assert.equal(database.prepare("SELECT room_cursor FROM worker_session_bindings").get()?.room_cursor, "msg_50");
      validatePollingOfferSchema(database);
    } finally { database.close(); }
  } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
});

test("polling offer SQL prevents forks, disconnected successors and rewriting or deleting ACK evidence", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath);
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  try {
    const activation = await seedPollingActivationRuntime(env, store, inbox, bindings);
    await store.preparePollingActivation(activation, async commit => commit());
    await store.markPollingActivationDispatch(activation, async commit => commit());
    await store.checkpointPollingActivationTurn({ ...activation, providerTurnId: "native-turn" }, async commit => commit());
    const input = { operationId: activation.operationId, agentId: activation.agentId,
      processIncarnationId: "01234567-89ab-4cde-8fab-0123456789ab", inputCursor: "msg_47", offeredFrontier: "msg_50", expectedBindingEpoch: 1 };
    input.expectedBindingEpoch = (await store.acknowledgePollingOffer({ ...input, roomCursor: null }, async commit => commit())).bindingEpoch;
    const first = await store.recordPollingOffer({ ...input, requestId: 1 }, async commit => commit());
    const tail = await store.recordPollingOffer({ ...input, requestId: 2 }, async commit => commit());
    assert.ok(first); assert.ok(tail);
    const database = new DatabaseSync(env.databasePath);
    try {
      database.exec("PRAGMA foreign_keys=ON");
      for (const field of ["offer_id", "activation_id", "process_incarnation_id", "mcp_request_id", "binding_epoch", "input_cursor", "offered_frontier", "predecessor_offer_id", "created_at_ms"]) {
        const value = tail[field as keyof typeof tail];
        assert.throws(() => database.prepare(`UPDATE custodial_polling_offers SET ${field}=? WHERE offer_id=?`)
          .run(typeof value === "number" ? value + 1 : `${value}-changed`, tail.offer_id), /immutable/);
      }
      for (const changed of [
        { predecessor_offer_id: null }, { predecessor_offer_id: first.offer_id },
        { predecessor_offer_id: "missing" }, { activation_id: "other" },
        { acknowledged_at_ms: tail.created_at_ms }, { created_at_ms: tail.created_at_ms - 1 },
      ]) {
        const row = { ...tail, offer_id: "invalid", mcp_request_id: "3", predecessor_offer_id: tail.offer_id, ...changed };
        assert.throws(() => database.prepare(`INSERT INTO custodial_polling_offers(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row)),
          changed.predecessor_offer_id === first.offer_id ? /UNIQUE constraint failed: custodial_polling_offers.predecessor_offer_id/ : undefined);
      }
      assert.throws(() => database.prepare("UPDATE custodial_polling_offers SET acknowledged_at_ms=? WHERE offer_id=?").run(first.created_at_ms, first.offer_id), /immutable/);
      assert.throws(() => database.prepare("DELETE FROM custodial_polling_offers WHERE offer_id=?").run(tail.offer_id), /cannot be removed/);
      const result = await store.acknowledgePollingOffer({ ...input, roomCursor: "msg_50" }, async commit => commit());
      for (const value of [null, result.offer!.acknowledged_at_ms! + 1]) {
        assert.throws(() => database.prepare("UPDATE custodial_polling_offers SET acknowledged_at_ms=? WHERE offer_id=?").run(value, tail.offer_id), /immutable/);
      }
      // The single-column SET NULL FK retains same-activation enforcement in
      // the append trigger, even when both activations and the parent exist.
      await store.completePollingActivation({ ...activation, providerTurnId: "native-turn", outcome: "completed" }, async commit => commit());
      const other = { ...database.prepare("SELECT * FROM custodial_polling_activations WHERE operation_id=?").get(activation.operationId)!,
        operation_id: "other-activation", request_id: "other-request", phase: "prepared", provider_turn_id: null, terminal_outcome: null };
      const fabricated = { ...other, compacted_through_offer_id: "unrelated" };
      assert.throws(() => database.prepare(`INSERT INTO custodial_polling_activations(${Object.keys(fabricated).join(",")}) VALUES(${Object.keys(fabricated).map(() => "?").join(",")})`).run(...Object.values(fabricated)), /completed reverse predecessor/);
      database.prepare(`INSERT INTO custodial_polling_activations(${Object.keys(other).join(",")}) VALUES(${Object.keys(other).map(() => "?").join(",")})`).run(...Object.values(other));
      database.exec("UPDATE custodial_polling_activations SET phase='dispatching' WHERE operation_id='other-activation'; UPDATE custodial_polling_activations SET phase='active',provider_turn_id='other-turn' WHERE operation_id='other-activation'");
      const crossActivation = { ...tail, offer_id: "cross-activation", activation_id: "other-activation", predecessor_offer_id: tail.offer_id };
      assert.throws(() => database.prepare(`INSERT INTO custodial_polling_offers(${Object.keys(crossActivation).join(",")}) VALUES(${Object.keys(crossActivation).map(() => "?").join(",")})`).run(...Object.values(crossActivation)), /active chain tail/);
      validatePollingOfferSchema(database); assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { database.close(); }
  } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
});

test("polling offer compaction bounds repeated unACKed reads while preserving tail, cursor, rollback and the explicit replay window", async () => {
  const env = await fixture(); let store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath);
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  try {
    const activation = await seedPollingActivationRuntime(env, store, inbox, bindings);
    await store.preparePollingActivation(activation, async commit => commit());
    await store.markPollingActivationDispatch(activation, async commit => commit());
    await store.checkpointPollingActivationTurn({ ...activation, providerTurnId: "native-turn" }, async commit => commit());
    const input = { operationId: activation.operationId, agentId: activation.agentId,
      processIncarnationId: "01234567-89ab-4cde-8fab-0123456789ab", inputCursor: "msg_47", offeredFrontier: "msg_49", expectedBindingEpoch: 1 };
    input.expectedBindingEpoch = (await store.acknowledgePollingOffer({ ...input, roomCursor: null }, async commit => commit())).bindingEpoch;
    const database = new DatabaseSync(env.databasePath);
    try {
      database.exec("PRAGMA foreign_keys=ON");
      const count = () => database.prepare("SELECT COUNT(*) AS n FROM custodial_polling_offers").get()!.n;
      const rows = () => database.prepare("SELECT rowid,* FROM custodial_polling_offers ORDER BY rowid").all();
      const watermark = () => database.prepare("SELECT compacted_through_offer_id FROM custodial_polling_activations WHERE operation_id=?").get(activation.operationId)!.compacted_through_offer_id;
      let previousId: string | null = null;
      for (let requestId = 0; requestId < POLLING_OFFER_REPLAY_WINDOW * 2; requestId++) {
        const tail = await store.recordPollingOffer({ ...input, requestId }, async commit => commit());
        assert.ok(tail);
        assert.equal(tail.predecessor_offer_id, previousId); previousId = tail.offer_id;
        assert.equal(count(), Math.min(requestId + 1, POLLING_OFFER_REPLAY_WINDOW));
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custodial_polling_offers WHERE predecessor_offer_id IS NULL").get()!.n, 1);
      }
      assert.ok(watermark());
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custodial_polling_offers WHERE acknowledged_at_ms IS NOT NULL").get()!.n, 0,
        "superseded unACKed rows compact without fabricating consumption");
      assert.equal(database.prepare("SELECT room_cursor FROM worker_session_bindings").get()!.room_cursor, "msg_47");
      await assert.rejects(store.recordPollingOffer({ ...input, requestId: POLLING_OFFER_REPLAY_WINDOW }, async commit => commit()), /superseded/);
      const before = { rows: rows(), watermark: watermark(), tail: await store.getPollingOfferTail(activation.operationId) };
      database.exec("CREATE TRIGGER reject_offer_compaction AFTER UPDATE OF compacted_through_offer_id ON custodial_polling_activations BEGIN SELECT RAISE(ABORT,'test compaction rollback'); END");
      await assert.rejects(store.recordPollingOffer({ ...input, requestId: "new" }, async commit => commit()), /test compaction rollback/);
      assert.deepEqual({ rows: rows(), watermark: watermark(), tail: await store.getPollingOfferTail(activation.operationId) }, before);
      database.exec("DROP TRIGGER reject_offer_compaction");
      await store.close(); store = new ManifestStore(env.databasePath);
      assert.deepEqual(await store.getPollingOfferTail(activation.operationId), before.tail);
      assert.equal(watermark(), before.watermark);
      // Beyond-window IDs are unknown-age, not permanently deduplicated. This
      // pure read may reoffer, but must still start at the durable ACK cursor.
      const replay = await store.recordPollingOffer({ ...input, requestId: 0, offeredFrontier: "msg_50" }, async commit => commit());
      assert.ok(replay);
      assert.notEqual(replay.offer_id, before.tail!.offer_id); assert.equal(count(), POLLING_OFFER_REPLAY_WINDOW);
      assert.equal(replay.acknowledged_at_ms, null);
      assert.equal(database.prepare("SELECT room_cursor FROM worker_session_bindings").get()!.room_cursor, "msg_47");
      assert.equal((await store.acknowledgePollingOffer({ ...input, roomCursor: "msg_47" }, async commit => commit())).acknowledged, false);
      assert.equal((await store.acknowledgePollingOffer({ ...input, roomCursor: "msg_50" }, async commit => commit())).acknowledged, true);
      await assert.rejects(store.recordPollingOffer({ ...input, requestId: 1 }, async commit => commit()), /durable acknowledged cursor/);
      const retainedRoot = database.prepare("SELECT offer_id FROM custodial_polling_offers WHERE predecessor_offer_id IS NULL").get()!;
      for (const invalidAnchor of [null, "unrelated", retainedRoot.offer_id, replay.offer_id, before.watermark]) {
        assert.throws(() => database.prepare("UPDATE custodial_polling_activations SET compacted_through_offer_id=? WHERE operation_id=?")
          .run(invalidAnchor, activation.operationId), /exact deletion cascade/);
      }
      for (const sql of [
        "UPDATE custodial_polling_offers SET predecessor_offer_id=NULL WHERE predecessor_offer_id IS NOT NULL",
        "DELETE FROM custodial_polling_offers",
        "UPDATE custodial_polling_activations SET compacted_through_offer_id=NULL",
        "UPDATE custodial_polling_activations SET compacted_through_offer_id='unrelated'",
      ]) assert.throws(() => database.exec(sql), /immutable|cannot be removed|exact deletion cascade/);
      validatePollingActivationSchema(database); validatePollingOfferSchema(database);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
      const finalRows = rows(); const finalWatermark = watermark();
      database.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
      assert.throws(() => validatePollingActivationSchema(database), /foreign key enforcement/);
      assert.throws(() => validatePollingOfferSchema(database), /foreign key enforcement/);
      assert.throws(() => new DaemonStateSchema().createSchema(database), /foreign key enforcement/);
      assert.throws(() => recordPollingOffer(database, { ...input, requestId: "disabled-fk" }, undefined), /foreign key enforcement/);
      assert.deepEqual(rows(), finalRows); assert.equal(watermark(), finalWatermark);
      database.exec("ROLLBACK; PRAGMA foreign_keys=ON");
    } finally { database.close(); }
  } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
});

test("polling activation journals explicit intent, exact started ID, uncertainty and terminal before replay", async () => {
  for (const outcome of ["completed", "failed", "interrupted", "lost"] as const) {
    const env = await fixture(); let store = new ManifestStore(env.databasePath);
    const inbox = new SupervisedAgentInboxStore(env.databasePath);
    const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
    try {
      const input = await seedPollingActivationRuntime(env, store, inbox, bindings);
      const graphGuard = new DatabaseSync(env.databasePath);
      graphGuard.exec("CREATE TRIGGER reject_activation_manifest_reinsert BEFORE DELETE ON agent_identities BEGIN SELECT RAISE(ABORT,'activation cannot replace manifest graph'); END");
      graphGuard.close();
      assert.equal(await store.unresolvedPollingActivation(input.agentId), null);
      const before = await store.load();
      const { activation } = await store.preparePollingActivation(input, async commit => commit());
      assert.equal(activation.phase, "prepared"); assert.equal(activation.provider_turn_id, null);
      assert.equal(activation.room_cursor, "msg_47"); assert.equal(activation.agent_session_id, "session_2");
      assert.equal(activation.config_revision, 2); assert.equal(activation.execution_generation_id, "run_2");
      assert.deepEqual(await store.preparePollingActivation(input, async commit => commit()), { created: false, activation });
      assert.deepEqual(await store.load(), before, "journal acceptance cannot alter runtime, configuration, or mode");
      const dispatch = await store.markPollingActivationDispatch(input, async commit => commit());
      assert.equal(dispatch.phase, "dispatching");
      assert.deepEqual(await store.markPollingActivationDispatch(input, async commit => commit()), dispatch);
      await assert.rejects(store.cancelPollingActivation(input, async commit => commit()), /undispatched/);
      await assert.rejects(store.completePollingActivation({ ...input, providerTurnId: "unbound", outcome: "completed" }, async commit => commit()), /exact native turn/);
      await store.markPollingActivationUncertain(input, async commit => commit());
      await store.close(); store = new ManifestStore(env.databasePath);
      assert.equal((await store.unresolvedPollingActivation(input.agentId))?.phase, "uncertain");
      assert.equal((await store.getEntry(input.agentId))?.provider_ref?.custodial_launch_agent_session_id, "session_2",
        "the exact launch receipt survives a process restart without consulting current credentials");
      const providerTurnId = outcome === "lost" ? null : "activation-turn";
      if (providerTurnId) {
        // This fence represents the authenticated ACK of the original live
        // invocation, never an inferred latest turn after restart.
        const active = await store.checkpointPollingActivationTurn({ ...input, providerTurnId }, async commit => commit());
        assert.equal(active.phase, "active"); assert.equal(active.provider_turn_id, providerTurnId);
        await assert.rejects(store.checkpointPollingActivationTurn({ ...input, providerTurnId: "other" }, async commit => commit()), /already bound/);
        await store.markPollingActivationUncertain(input, async commit => commit());
        assert.equal((await store.checkpointPollingActivationTurn({ ...input, providerTurnId }, async commit => commit())).phase, "active",
          "exact known-ID reconciliation can resolve uncertainty without adopting a new ID");
      }
      const removeGraphGuard = new DatabaseSync(env.databasePath);
      removeGraphGuard.exec("DROP TRIGGER reject_activation_manifest_reinsert"); removeGraphGuard.close();
      const current = (await store.getEntry(input.agentId))!;
      await store.replaceEntry((await store.load()).generation, { ...current, provider_ref: null });
      const completed = await store.completePollingActivation({ ...input, providerTurnId, outcome }, async commit => commit());
      assert.equal(completed.phase, "complete"); assert.equal(completed.terminal_outcome, outcome);
      assert.equal(await store.unresolvedPollingActivation(input.agentId), null);
      assert.deepEqual(await store.completePollingActivation({ ...input, providerTurnId, outcome }, async commit => commit()), completed);
      await assert.rejects(store.completePollingActivation({ ...input, providerTurnId, outcome: outcome === "failed" ? "lost" : "failed" }, async commit => commit()), /immutable|exact native turn/);
      assert.equal((await store.getEntry(input.agentId))?.provider_ref, null);
      const database = new DatabaseSync(env.databasePath);
      try {
        validatePollingActivationSchema(database);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_generations").get()?.n, 0);
        assert.equal(database.prepare("SELECT room_cursor FROM worker_session_bindings WHERE entry_id=?").get(input.agentId)?.room_cursor, "msg_47");
        assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
      } finally { database.close(); }
    } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
  }
});

test("polling activation SQL preserves immutable identity, predecessor and terminal authority while runtime matching is exact", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath);
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  try {
    const input = await seedPollingActivationRuntime(env, store, inbox, bindings);
    const { activation } = await store.preparePollingActivation(input, async commit => commit());
    const current = (await store.getEntry(input.agentId))!;
    assert.equal(matchesPollingActivationRuntime(activation, current, input.handle), true);
    assert.equal(matchesPollingActivationRuntime(activation, { ...current, desired_state: "paused" },
      { ...input.handle, appliedConfigurationRevision: undefined }), true);
    for (const changed of [
      { ...current, room_id: "other" }, { ...current, delivery_mode: "daemon_inbox" as const },
      { ...current, provider_ref: null },
      ...[
        { work_attempt_id: "other" }, { execution_generation_id: "other" }, { provider_continuation_id: "other" },
        { custodial_launch_agent_session_id: null }, { custodial_launch_agent_session_id: "other" },
        { provider_connection: { ...input.handle.providerConnection!, pid: 9999 } },
        { provider_connection: { ...input.handle.providerConnection!, processIdentity: "reused-pid" } },
        { provider_connection: { kind: "codex_app_server" as const, url: "http://127.0.0.1:9999", pid: 4312, processIdentity: "codex:4312" } },
      ].map(ref => ({ ...current, provider_ref: { ...current.provider_ref!, ...ref } })),
    ]) assert.equal(matchesPollingActivationRuntime(activation, changed), false);
    assert.equal(matchesPollingActivationRuntime(activation, current, { ...input.handle, custodyLaunchAgentSessionId: "other" }), false);
    const database = new DatabaseSync(env.databasePath);
    try {
      for (const field of ["operation_id", "request_id", "agent_id", "room_id", "work_attempt_id", "execution_generation_id", "reverse_operation_id",
        "native_continuation_id", "native_connection_kind", "native_connection_sha256", "native_pid", "native_process_identity", "config_revision", "agent_session_id", "room_cursor", "created_at_ms"]) {
        const value = activation[field as keyof typeof activation];
        assert.throws(() => database.prepare(`UPDATE custodial_polling_activations SET ${field}=?`).run(typeof value === "number" ? value + 1 : `${value}-changed`));
      }
      for (const sql of ["provider_turn_id='premature'", "phase='active',provider_turn_id='premature'", "phase='complete',terminal_outcome='lost'"]) {
        assert.throws(() => database.exec(`UPDATE custodial_polling_activations SET ${sql}`));
      }
      assert.deepEqual(await store.getPollingActivation(input.operationId), activation);
      await store.markPollingActivationDispatch(input, async commit => commit());
      await store.checkpointPollingActivationTurn({ ...input, providerTurnId: "native-turn" }, async commit => commit());
      for (const sql of ["provider_turn_id='replacement'", "provider_turn_id=NULL", "phase='prepared'", "terminal_outcome='failed'"]) {
        assert.throws(() => database.exec(`UPDATE custodial_polling_activations SET ${sql}`));
      }
      const complete = await store.completePollingActivation({ ...input, providerTurnId: "native-turn", outcome: "failed" }, async commit => commit());
      for (const sql of ["terminal_outcome='completed'", "updated_at_ms=updated_at_ms+1", "phase='uncertain',terminal_outcome=NULL"]) {
        assert.throws(() => database.exec(`UPDATE custodial_polling_activations SET ${sql}`));
      }
      assert.deepEqual(await store.getPollingActivation(input.operationId), complete);
      for (const invalid of [{ reverse_operation_id: "missing" }, { phase: "active", provider_turn_id: "invented" }]) {
        const row = { ...activation, operation_id: "other", request_id: "other", ...invalid };
        assert.throws(() => database.prepare(`INSERT INTO custodial_polling_activations(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`)
          .run(...Object.values(row)), /completed reverse predecessor/);
      }
      validatePollingActivationSchema(database);
    } finally { database.close(); }
  } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
});

test("polling activation requires exact post-reverse custody and idempotent request identity", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath);
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  try {
    const input = await seedPollingActivationRuntime(env, store, inbox, bindings);
    for (const bad of [
      { ...input, reverseOperationId: "missing" }, { ...input, executionGenerationId: "run_1" }, { ...input, roomId: "other" },
      { ...input, boundary: { state: "unknown" as const } },
      { ...input, boundary: { state: "active" as const, providerContinuationId: "thread_1", nativeProcessIdentity: "codex:4312", providerTurnId: "busy" } },
      { ...input, handle: { ...input.handle, appliedConfigurationRevision: 1 } },
      { ...input, handle: { ...input.handle, pid: 9999 } },
    ]) await assert.rejects(store.preparePollingActivation(bad, async commit => commit()));
    await assert.rejects(store.preparePollingActivation(input, undefined as never), /ownership commit fence/);
    const database = new DatabaseSync(env.databasePath);
    try {
      for (const [sql, undo] of [
        ["UPDATE worker_session_bindings SET room_cursor=NULL", "UPDATE worker_session_bindings SET room_cursor='msg_47'"],
        ["UPDATE runtime_deployments SET custodial_launch_agent_session_id=NULL", "UPDATE runtime_deployments SET custodial_launch_agent_session_id='session_2'"],
        ["UPDATE runtime_deployments SET custodial_launch_agent_session_id='other'", "UPDATE runtime_deployments SET custodial_launch_agent_session_id='session_2'"],
        ["UPDATE agent_configurations SET runtime_configuration_revision=1", "UPDATE agent_configurations SET runtime_configuration_revision=2"],
        ["UPDATE agent_configurations SET polling_contract=NULL", "UPDATE agent_configurations SET polling_contract='custodial_polling_v1'"],
        ["UPDATE execution_cutover_v2 SET phase='draining'", "UPDATE execution_cutover_v2 SET phase='complete'"],
      ]) {
        database.exec(sql!); await assert.rejects(store.preparePollingActivation(input, async commit => commit())); database.exec(undo!);
      }
      const original = structuredClone(input);
      const preparing = store.preparePollingActivation(input, async commit => commit());
      input.handle.providerContinuationId = "caller-mutated"; input.roomId = "caller-mutated";
      const { activation } = await preparing;
      assert.equal(activation.native_continuation_id, "thread_1"); assert.equal(activation.room_id, "room_1");
      for (const changed of [
        { ...original, requestId: "another-request" }, { ...original, operationId: "another-operation" },
        { ...original, executionGenerationId: "other-generation" }, { ...original, reverseOperationId: "another-reverse" },
      ]) await assert.rejects(store.preparePollingActivation(changed, async commit => commit()), /different coordinates/);
      await assert.rejects(store.preparePollingActivation({ ...original, operationId: "second", requestId: "second" }, async commit => commit()), /unresolved polling activation/);
      await assert.rejects(store.checkpointPollingActivationTurn({ ...original, providerTurnId: "too-early" }, async commit => commit()), /no dispatched/);
      const cancelled = await store.cancelPollingActivation(original, async commit => commit());
      assert.equal(cancelled.phase, "cancelled"); assert.deepEqual(await store.cancelPollingActivation(original, async commit => commit()), cancelled);
      assert.equal(await store.unresolvedPollingActivation(original.agentId), null);
      await assert.rejects(store.markPollingActivationDispatch(original, async commit => commit()), /cannot dispatch/);
      const next = await store.preparePollingActivation({ ...original, operationId: "second", requestId: "second" }, async commit => commit());
      assert.equal(next.created, true);
    } finally { database.close(); }
  } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
});

test("polling activation phase writes roll back and fail closed on changed current authority or successor generation", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath);
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  try {
    const input = await seedPollingActivationRuntime(env, store, inbox, bindings);
    const database = new DatabaseSync(env.databasePath);
    try {
      database.exec("CREATE TRIGGER reject_activation_insert AFTER INSERT ON custodial_polling_activations BEGIN SELECT RAISE(ABORT,'test activation rollback'); END");
      await assert.rejects(store.preparePollingActivation(input, async commit => commit()), /test activation rollback/);
      assert.equal(await store.getPollingActivation(input.operationId), null);
      database.exec("DROP TRIGGER reject_activation_insert");
      const { activation } = await store.preparePollingActivation(input, async commit => commit());
      await assert.rejects(store.markPollingActivationDispatch(input, async () => {}), /without committing/);
      assert.deepEqual(await store.getPollingActivation(input.operationId), activation);
      for (const [sql, undo] of [
        ["UPDATE worker_session_bindings SET agent_session_id='other'", "UPDATE worker_session_bindings SET agent_session_id='session_2'"],
        ["UPDATE worker_session_bindings SET room_cursor='msg_48'", "UPDATE worker_session_bindings SET room_cursor='msg_47'"],
        ["UPDATE agent_configurations SET config_revision=3", "UPDATE agent_configurations SET config_revision=2"],
      ]) {
        database.exec(sql!); await assert.rejects(store.markPollingActivationDispatch(input, async commit => commit()), /changed/); database.exec(undo!);
      }
      await store.markPollingActivationDispatch(input, async commit => commit());
      database.exec("CREATE TRIGGER reject_activation_checkpoint AFTER UPDATE OF provider_turn_id ON custodial_polling_activations BEGIN SELECT RAISE(ABORT,'test checkpoint rollback'); END");
      await assert.rejects(store.checkpointPollingActivationTurn({ ...input, providerTurnId: "activation-turn" }, async commit => commit()), /checkpoint rollback/);
      assert.equal((await store.getPollingActivation(input.operationId))?.provider_turn_id, null);
      database.exec("DROP TRIGGER reject_activation_checkpoint");
      await store.checkpointPollingActivationTurn({ ...input, providerTurnId: "activation-turn" }, async commit => commit());
      database.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='run_2'").run(JSON.stringify(terminal));
      database.prepare("INSERT INTO work_attempt_executions VALUES('run_3','attempt_1',?,'provider',10,?)").run(terminal.ended_at, JSON.stringify(terminal));
      await assert.rejects(store.checkpointPollingActivationTurn({ ...input, providerTurnId: "activation-turn" }, async commit => commit()), /generation changed/);
      await assert.rejects(store.completePollingActivation({ ...input, providerTurnId: "activation-turn", outcome: "lost" }, async commit => commit()), /generation changed/);
      assert.equal((await store.getPollingActivation(input.operationId))?.phase, "active");
    } finally { database.close(); }
  } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
});

test("delivery drain and FIFO claim atomically select A without admitting successor B", async () => {
  for (const claimFirst of [false, true]) {
    const env = await fixture();
    const store = new ManifestStore(env.databasePath);
    const inbox = new SupervisedAgentInboxStore(env.databasePath);
    const { agent, input } = deliveryDrainCoordinates();
    try {
      await store.write(0, [agent]);
      seedActiveDrainExecution(env.databasePath);
      assert.equal(await store.unresolvedDeliveryDrain(agent.id), null);
      const a = await inbox.enqueueCorrection({ agent_id: agent.id, room_id: agent.room_id, source_message_id: "drain-A", source_message: { text: "A" }, activation: { decision: "activate" } });
      const b = await inbox.enqueueCorrection({ agent_id: agent.id, room_id: agent.room_id, source_message_id: "drain-B", source_message: { text: "B" }, activation: { decision: "activate" } });
      const prepared = await store.prepareDeliveryDrain(input, async (commit) => {
        if (claimFirst) {
          assert.equal((await inbox.claimHead(agent.id))?.inbox_item_id, a.inbox_item_id);
          await inbox.checkpointTurnStarted(a.inbox_item_id, "native-A", TEST_PROVIDER_TURN_AUTHORITY);
        }
        await commit();
      });
      assert.equal(prepared.created, true);
      assert.deepEqual(await store.unresolvedDeliveryDrain(agent.id), prepared.cutover);
      assert.equal(prepared.cutover.phase, "draining");
      assert.equal(prepared.cutover.admitted_inbox_item_id, claimFirst ? a.inbox_item_id : null);
      assert.equal(prepared.cutover.admitted_source_message_id, claimFirst ? a.source_message_id : null);
      assert.equal(prepared.cutover.admitted_action_id, claimFirst ? a.action_id : null);
      assert.equal(prepared.cutover.native_target_turn_id, claimFirst ? "native-A" : null,
        "an idle observation made before admission is not a lock against already-admitted A");
      assert.equal(prepared.cutover.target_turn_id, null, "native authority never becomes an optional shadow turn id");
      if (claimFirst) {
        await inbox.transition(a.inbox_item_id, "awaiting_result");
        await inbox.transition(a.inbox_item_id, "result_recovery");
        assert.equal((await inbox.claimHead(agent.id))?.inbox_item_id, a.inbox_item_id, "exact result recovery remains available");
        await inbox.checkpointNormalizedTerminal({ inbox_item_id: a.inbox_item_id, agent_id: agent.id, execution_generation_id: "run_1", provider_turn_id: "native-A", outcome: "reply", text: "A finished", evidence: "stream", terminal_evidence: { turnId: "native-A" } });
        await inbox.transition(a.inbox_item_id, "publishing");
        const published = await inbox.checkpointPublication({ inbox_item_id: a.inbox_item_id, room_id: agent.room_id, canonical_message_id: "canonical-A" });
        assert.equal(published.state, "acknowledged");
        assert.equal(published.reply_client_message_id, a.reply_client_message_id);
      }
      assert.equal(await inbox.claimHead(agent.id), null, "draining never admits pending work or a successor");
      assert.equal((await inbox.get(b.inbox_item_id))?.state, "pending");
      const inspection = new DatabaseSync(env.databasePath);
      try {
        assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM execution_runtime_generations").get() as { count: number }).count, 0,
          "cutover admission does not require optional native activity capture");
      } finally { inspection.close(); }
      const cancelled = await store.cancelDeliveryDrain({ operationId: input.operationId, agentId: agent.id });
      assert.equal(cancelled.phase, "cancelled");
      assert.equal(await store.unresolvedDeliveryDrain(agent.id), null);
      assert.equal((await inbox.claimHead(agent.id))?.inbox_item_id, claimFirst ? b.inbox_item_id : a.inbox_item_id);
      assert.equal((await store.getEntry(agent.id))?.delivery_mode, "daemon_inbox", "admission and cancellation never switch delivery mode");
    } finally { await inbox.close(); await store.close(); await env.cleanup(); }
  }
});

test("delivery drain permits admitted pre-native invocation but not a fresh pre-dispatch retry", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath);
  const { agent, input } = deliveryDrainCoordinates();
  try {
    await store.write(0, [agent]);
    seedActiveDrainExecution(env.databasePath);
    const a = await inbox.enqueueCorrection({ agent_id: agent.id, room_id: agent.room_id, source_message_id: "pre-native-A", source_message: {}, activation: { decision: "activate" } });
    await inbox.claimHead(agent.id);
    const { cutover } = await store.prepareDeliveryDrain(input);
    assert.equal(cutover.admitted_inbox_item_id, a.inbox_item_id);
    assert.equal((await store.deliveryDrainReadiness(input.operationId)).status, "waiting");
    assert.equal(cutover.native_target_turn_id, null);
    assert.equal((await inbox.checkpointDispatchIntent(a.inbox_item_id)).state, "dispatching");
    await inbox.recordRetryFailure(a.inbox_item_id, { domain: "pre_dispatch", error: "proven not sent" });
    await inbox.transition(a.inbox_item_id, "pending");
    assert.equal((await store.deliveryDrainReadiness(input.operationId)).status, "queued");
    assert.equal(await inbox.claimHead(agent.id), null, "the original A identity is not permission to replay its invocation");
    await assert.rejects(() => inbox.transition(a.inbox_item_id, "dispatching"), /delivery drain/i,
      "the generic transition API must not bypass the admission barrier");
    await assert.rejects(() => inbox.checkpointDispatchIntent(a.inbox_item_id));
    await store.cancelDeliveryDrain({ operationId: input.operationId, agentId: agent.id });
    assert.equal((await inbox.claimHead(agent.id))?.inbox_item_id, a.inbox_item_id);
  } finally { await inbox.close(); await store.close(); await env.cleanup(); }
});

test("reverse delivery commit atomically transfers the observed cursor and replays without changing a successor", async () => {
  for (const detach of [false, true]) {
    const env = await fixture(); let store = new ManifestStore(env.databasePath);
    const inbox = new SupervisedAgentInboxStore(env.databasePath);
    const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
    const { agent, input } = deliveryDrainCoordinates();
    try {
      await store.write(0, [agent]); seedActiveDrainExecution(env.databasePath);
      await bindings.bind({ entry_id: agent.id, room_id: agent.room_id, work_attempt_id: "attempt_1",
        execution_generation_id: "run_1", agent_session_id: "session_1", agent_session_token: "test-token", api_url: "https://example.test" });
      await bindings.checkpointCursor(agent.id, "session_1", "run_1", "9");
      await inbox.ingestPoll({ agent_id: agent.id, room_id: agent.room_id, last_observed_message_id: "msg_47", messages: [] });
      await store.prepareDeliveryDrain(input);
      assert.deepEqual((await store.deliveryDrainReadiness(input.operationId)).cursor, "msg_47");
      const dispatched = await store.markDeliveryDrainDispatch(input);
      assert.equal(dispatched.phase, "dispatching");
      assert.deepEqual(await store.markDeliveryDrainDispatch(input), dispatched);
      const uncertain = await store.markDeliveryDrainUncertain(input);
      assert.equal(uncertain.phase, "uncertain");
      assert.deepEqual(await store.markDeliveryDrainUncertain(input), uncertain);
      await assert.rejects(store.cancelDeliveryDrain(input), /pre-dispatch authority/);
      if (detach) await store.replaceEntry((await store.load()).generation, { ...agent, provider_ref: null });
      await store.close(); store = new ManifestStore(env.databasePath);
      const generation = (await store.load()).generation;
      let fenceCalls = 0;
      const completed = await store.commitDeliveryDrain(generation, input, async (commit) => { fenceCalls += 1; await commit(); });
      assert.equal(completed.generation, generation + 1);
      assert.equal(completed.cutover.phase, "complete");
      assert.equal(await store.unresolvedDeliveryDrain(agent.id), null);
      assert.equal((await store.getEntry(agent.id))?.delivery_mode ?? "mcp_polling", "mcp_polling");
      const config = await store.getAgentConfiguration(agent.id);
      assert.equal(config?.polling_contract, "custodial_polling_v1");
      assert.equal(config?.config_revision, 2);
      assert.equal(config?.runtime_configuration_revision, 1, "the stopped runtime never applied the new policy");
      const database = new DatabaseSync(env.databasePath);
      try {
        assert.equal(database.prepare("SELECT room_cursor FROM worker_session_bindings WHERE entry_id=?").get(agent.id)?.room_cursor, "msg_47");
        const checkpoints = database.prepare("SELECT room_cursor,provider_continuation_id FROM work_attempt_checkpoints WHERE work_attempt_id='attempt_1'").all();
        assert.deepEqual(checkpoints.map((row) => ({ ...row })), [{ room_cursor: "msg_47", provider_continuation_id: "thread_1" }]);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_generations").get()?.n, 0);
        assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
      } finally { database.close(); }
      const saved = (await store.getEntry(agent.id))!;
      const successor = await store.replaceEntry(completed.generation, withRuntimeIdentity({ ...saved,
        provider_ref: { ...agent.provider_ref!, execution_generation_id: "successor", provider_continuation_id: "next-thread" } }));
      const replay = await store.commitDeliveryDrain(generation, input, async () => { throw new Error("must not stop successor"); });
      assert.equal(replay.generation, successor.generation);
      assert.deepEqual(replay.cutover, completed.cutover);
      assert.equal(fenceCalls, 1);
      assert.equal((await store.getAgentConfiguration(agent.id))?.config_revision, 2);
      assert.equal((await inbox.cursor(agent.id))?.last_observed_message_id, "msg_47");
    } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
  }
});

test("custodial forward undoes only pre-activation reverse and atomically transfers the worker ACK once", async () => {
  for (const cancelledIntent of [false, true]) {
    const env = await fixture(); let store = new ManifestStore(env.databasePath);
    const inbox = new SupervisedAgentInboxStore(env.databasePath);
    const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
    try {
      const activation = await seedPollingActivationRuntime(env, store, inbox, bindings);
      if (cancelledIntent) {
        await store.preparePollingActivation(activation, async commit => commit());
        await store.cancelPollingActivation(activation, async commit => commit());
      }
      const input = { ...activation, operationId: "forward", requestId: "forward-request" };
      await bindings.checkpointCursorMonotonic(input.agentId, "session_2", "run_2", "msg_59");
      const before = await store.load();
      const accepted = await store.prepareCustodialForward(input, async commit => commit());
      assert.equal(accepted.cutover.from_mode, "mcp_polling"); assert.equal(accepted.cutover.to_mode, "daemon_inbox");
      assert.equal(accepted.cutover.predecessor_operation_id, activation.reverseOperationId);
      assert.equal(accepted.cutover.native_target_turn_id, null); assert.equal(accepted.cutover.admitted_inbox_item_id, null);
      assert.deepEqual(await store.prepareCustodialForward(input, async commit => commit()), { ...accepted, created: false });
      assert.deepEqual(await store.load(), before);
      assert.deepEqual(await store.deliveryDrainReadiness(input.operationId), { cutover: accepted.cutover, status: "ready", cursor: "msg_59" });
      await assert.rejects(store.preparePollingActivation({ ...activation, operationId: "late-activation", requestId: "late-activation" }, async commit => commit()), /conflicts/);
      await store.markDeliveryDrainDispatch(input);
      await store.markDeliveryDrainUncertain(input);
      await assert.rejects(store.cancelDeliveryDrain(input), /pre-dispatch/);
      await store.close(); store = new ManifestStore(env.databasePath);
      const generation = (await store.load()).generation;
      const completed = await store.commitDeliveryDrain(generation, input, async commit => commit());
      assert.equal(completed.generation, generation + 1); assert.equal(completed.cutover.phase, "complete");
      const configuration = await store.getAgentConfiguration(input.agentId);
      assert.equal(configuration?.polling_contract, null); assert.equal(configuration?.config_revision, 3);
      assert.equal(configuration?.runtime_configuration_revision, 2, "stopping does not apply the successor's policy");
      assert.equal((await store.getEntry(input.agentId))?.delivery_mode, "daemon_inbox");
      assert.equal((await inbox.cursor(input.agentId))?.last_observed_message_id, "msg_59");
      assert.equal((await bindings.get(input.agentId))?.room_cursor, "msg_59", "source ACK is not rewritten during handoff");
      const database = new DatabaseSync(env.databasePath);
      try {
        const checkpoints = database.prepare("SELECT room_cursor FROM work_attempt_checkpoints WHERE work_attempt_id='attempt_1' ORDER BY sort_order").all();
        assert.deepEqual(checkpoints.map(row => row.room_cursor), ["msg_47", "msg_59"]);
        assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, DAEMON_STATE_SCHEMA_VERSION);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_generations").get()?.n, 0);
        assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
        const current = (await store.getEntry(input.agentId))!;
        await store.replaceEntry((await store.load()).generation, withRuntimeIdentity({ ...current,
          provider_ref: { ...current.provider_ref!, execution_generation_id: "successor", provider_continuation_id: "successor-thread" } }));
        const replay = await store.commitDeliveryDrain(generation, input, async () => { throw new Error("must not stop successor"); });
        assert.deepEqual(replay.cutover, completed.cutover);
        assert.equal((await store.getEntry(input.agentId))?.provider_ref?.provider_continuation_id, "successor-thread");
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM work_attempt_checkpoints WHERE work_attempt_id='attempt_1'").get()?.n, 2);
        assert.equal((await store.getAgentConfiguration(input.agentId))?.config_revision, 3);
      } finally { database.close(); }
    } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
  }
});

test("custodial forward refuses every dispatched or unresolved activation even in an older generation", async () => {
  for (const phase of ["prepared", "dispatching", "active", "uncertain", "completed", "failed", "interrupted", "lost"] as const) {
    const env = await fixture(); const store = new ManifestStore(env.databasePath);
    const inbox = new SupervisedAgentInboxStore(env.databasePath);
    const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
    try {
      const activation = await seedPollingActivationRuntime(env, store, inbox, bindings);
      await store.preparePollingActivation(activation, async commit => commit());
      if (phase !== "prepared") await store.markPollingActivationDispatch(activation, async commit => commit());
      if (["active", "completed", "failed", "interrupted"].includes(phase)) {
        await store.checkpointPollingActivationTurn({ ...activation, providerTurnId: "activation-turn" }, async commit => commit());
      }
      if (phase === "uncertain" || phase === "lost") await store.markPollingActivationUncertain(activation, async commit => commit());
      if (phase === "completed" || phase === "failed" || phase === "interrupted" || phase === "lost") {
        await store.completePollingActivation({ ...activation, providerTurnId: phase === "lost" ? null : "activation-turn", outcome: phase }, async commit => commit());
      }
      const input = { ...activation, operationId: "forward", requestId: "forward-request" };
      const before = await store.load();
      await assert.rejects(store.prepareCustodialForward(input, async commit => commit()), /polling activation/);
      assert.equal(await store.getDeliveryDrain(input.operationId), null); assert.deepEqual(await store.load(), before);
      if (phase === "completed") {
        const database = new DatabaseSync(env.databasePath);
        try {
          database.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='run_2'").run(JSON.stringify(terminal));
          database.prepare("INSERT INTO work_attempt_executions VALUES('run_3','attempt_1',?,'provider',10,NULL)").run(terminal.ended_at);
        } finally { database.close(); }
        const current = (await store.getEntry(input.agentId))!;
        const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4313", pid: 4313, processIdentity: "codex:4313" };
        await store.replaceEntry((await store.load()).generation, withRuntimeIdentity({ ...current, provider_ref: { ...current.provider_ref!,
          execution_generation_id: "run_3", provider_connection: connection, custodial_launch_agent_session_id: "session_3" } }));
        await bindings.bind({ entry_id: input.agentId, room_id: input.roomId, work_attempt_id: "attempt_1", execution_generation_id: "run_3",
          agent_session_id: "session_3", agent_session_token: "test-token", api_url: "https://example.test" }, { roomCursor: "msg_47" });
        await assert.rejects(store.prepareCustodialForward({ ...input, executionGenerationId: "run_3",
          handle: { ...input.handle, pid: 4313, providerConnection: connection },
          boundary: { state: "idle", providerContinuationId: "thread_1", nativeProcessIdentity: "codex:4313", latestProviderTurnId: null } }, async commit => commit()), /before polling activation/);
      }
    } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
  }
});

test("custodial forward validates frozen custody and cursor authority and rolls back every transfer write", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath);
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  try {
    const activation = await seedPollingActivationRuntime(env, store, inbox, bindings);
    const input = { ...activation, operationId: "forward", requestId: "forward-request" };
    await bindings.checkpointCursorMonotonic(input.agentId, "session_2", "run_2", "msg_59");
    await assert.rejects(store.prepareCustodialForward(input, undefined as never), /ownership commit fence/);
    for (const invalid of [
      { ...input, reverseOperationId: "missing" }, { ...input, roomId: "other" }, { ...input, executionGenerationId: "run_1" },
      { ...input, handle: { ...input.handle, appliedConfigurationRevision: 1 } },
      { ...input, handle: { ...input.handle, custodyLaunchAgentSessionId: "other" } },
      { ...input, boundary: { state: "active" as const, providerContinuationId: "thread_1", nativeProcessIdentity: "codex:4312", providerTurnId: "busy" } },
    ]) await assert.rejects(store.prepareCustodialForward(invalid, async commit => commit()));
    const database = new DatabaseSync(env.databasePath);
    try {
      await assert.rejects(inbox.enqueueCorrection({ agent_id: input.agentId, room_id: input.roomId,
        source_message_id: "pending-B", source_message: {}, activation: {} }), /freezes daemon inbox ingress/);
      // A historical/partially repaired queue must not be silently discarded.
      database.prepare(`INSERT INTO supervised_agent_inbox
        (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,created_at,updated_at)
        VALUES('pending-B',?,?,'pending-B','{}','{}',1,'pending',0,'action-B','reply-B',?,?)`).run(input.agentId, input.roomId, entry.created_at, entry.created_at);
      await assert.rejects(store.prepareCustodialForward(input, async commit => commit()), /pending inbox/);
      database.exec("DELETE FROM supervised_agent_inbox WHERE inbox_item_id='pending-B'");
      database.prepare(`INSERT INTO supervised_agent_effects(effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,created_at,updated_at)
        VALUES('pending-effect',?,?,?,'turn','request','send_message','{}',1,'uncertain',?,?)`).run(input.agentId, input.roomId, "run_2", entry.created_at, entry.created_at);
      await assert.rejects(store.prepareCustodialForward(input, async commit => commit()), /pending inbox.*effects/);
      database.exec("DELETE FROM supervised_agent_effects WHERE effect_id='pending-effect'");
      const before = await store.load();
      const { cutover } = await store.prepareCustodialForward(input, async commit => commit());
      for (const changed of [{ ...input, requestId: "different" }, { ...input, operationId: "different" }, { ...input, reverseOperationId: "different" }]) {
        await assert.rejects(store.prepareCustodialForward(changed, async commit => commit()), /different coordinates/);
      }
      await assert.rejects(store.commitDeliveryDrain(before.generation, input, async commit => commit()), /stop intent/);
      await assert.rejects(store.markDeliveryDrainDispatch({ ...input, boundary: { state: "active", providerContinuationId: "thread_1",
        nativeProcessIdentity: "codex:4312", providerTurnId: "busy" } }), /native idle/);
      assert.deepEqual(await store.getDeliveryDrain(input.operationId), cutover);
      await store.markDeliveryDrainDispatch(input);
      await store.markDeliveryDrainUncertain(input);
      const generation = (await store.load()).generation;
      for (const [change, undo] of [
        ["UPDATE worker_session_bindings SET agent_session_id='other'", "UPDATE worker_session_bindings SET agent_session_id='session_2'"],
        ["UPDATE worker_session_bindings SET room_id='other'", "UPDATE worker_session_bindings SET room_id='room_1'"],
        ["UPDATE worker_session_bindings SET execution_generation_id='other'", "UPDATE worker_session_bindings SET execution_generation_id='run_2'"],
        ["UPDATE worker_session_bindings SET room_cursor=NULL", "UPDATE worker_session_bindings SET room_cursor='msg_59'"],
        ["UPDATE worker_session_bindings SET room_cursor='msg_46'", "UPDATE worker_session_bindings SET room_cursor='msg_59'"],
        ["UPDATE supervised_agent_ingress_cursors SET last_observed_message_id='msg_60'", "UPDATE supervised_agent_ingress_cursors SET last_observed_message_id='msg_47'"],
        ["UPDATE work_attempt_checkpoints SET room_cursor='msg_60'", "UPDATE work_attempt_checkpoints SET room_cursor='msg_47'"],
        ["UPDATE runtime_deployments SET custodial_launch_agent_session_id=NULL", "UPDATE runtime_deployments SET custodial_launch_agent_session_id='session_2'"],
        ["UPDATE runtime_deployments SET provider_ref_present=0", "UPDATE runtime_deployments SET provider_ref_present=1"],
        ["UPDATE runtime_deployments SET provider_process_identity='reused-pid'", "UPDATE runtime_deployments SET provider_process_identity='codex:4312'"],
        ["UPDATE agent_configurations SET config_revision=3", "UPDATE agent_configurations SET config_revision=2"],
      ]) {
        database.exec(change!); await assert.rejects(store.commitDeliveryDrain(generation, input, async commit => commit())); database.exec(undo!);
        assert.equal((await store.getDeliveryDrain(input.operationId))?.phase, "uncertain");
        assert.equal((await store.load()).generation, generation);
      }
      const binding = database.prepare("SELECT * FROM worker_session_bindings WHERE entry_id=?").get(input.agentId)!;
      database.prepare("DELETE FROM worker_session_bindings WHERE entry_id=?").run(input.agentId);
      await assert.rejects(store.commitDeliveryDrain(generation, input, async commit => commit()), /worker binding authority/);
      database.prepare(`INSERT INTO worker_session_bindings(${Object.keys(binding).join(",")}) VALUES(${Object.keys(binding).map(() => "?").join(",")})`).run(...Object.values(binding));
      database.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='run_2'").run(JSON.stringify(terminal));
      database.prepare("INSERT INTO work_attempt_executions VALUES('successor','attempt_1',?,'provider',10,NULL)").run(terminal.ended_at);
      await assert.rejects(store.commitDeliveryDrain(generation, input, async commit => commit()), /execution authority/);
      database.exec("DELETE FROM work_attempt_executions WHERE execution_generation_id='successor'");
      const checkpoints = database.prepare("SELECT * FROM work_attempt_checkpoints").all();
      database.exec("CREATE TRIGGER refuse_forward_commit BEFORE UPDATE OF phase ON execution_cutover_v2 WHEN NEW.phase='complete' BEGIN SELECT RAISE(ABORT,'test forward rollback'); END");
      await assert.rejects(store.commitDeliveryDrain(generation, input, async commit => commit()), /test forward rollback/);
      database.exec("DROP TRIGGER refuse_forward_commit");
      assert.deepEqual(database.prepare("SELECT * FROM work_attempt_checkpoints").all(), checkpoints);
      assert.equal((await inbox.cursor(input.agentId))?.last_observed_message_id, "msg_47");
      assert.equal((await store.getAgentConfiguration(input.agentId))?.polling_contract, "custodial_polling_v1");
      assert.equal((await store.getAgentConfiguration(input.agentId))?.config_revision, 2);
      assert.equal((await store.load()).generation, generation);
      assert.equal((await store.commitDeliveryDrain(generation, input, async commit => commit())).cutover.phase, "complete");
    } finally { database.close(); }
  } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
});

test("custodial forward rejects a stale reverse and an activation that names an older reverse in the current polling era", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath);
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  try {
    const first = await seedPollingActivationRuntime(env, store, inbox, bindings);
    const forwardA = { ...first, operationId: "forward-A", requestId: "forward-A" };
    await store.prepareCustodialForward(forwardA, async commit => commit()); await store.markDeliveryDrainDispatch(forwardA);
    await store.commitDeliveryDrain((await store.load()).generation, forwardA, async commit => commit());
    async function installSuccessor(runId: string, generation: number, pid: number, revision: number) {
      const database = new DatabaseSync(env.databasePath);
      try {
        database.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE terminal_json IS NULL").run(JSON.stringify(terminal));
        database.prepare("INSERT INTO work_attempt_executions VALUES(?,'attempt_1',?,'provider',?,NULL)").run(runId, terminal.ended_at, generation);
      } finally { database.close(); }
      const current = (await store.getEntry(first.agentId))!;
      const connection = { kind: "codex_app_server" as const, url: `http://127.0.0.1:${pid}`, pid, processIdentity: `codex:${pid}` };
      await store.replaceEntry((await store.load()).generation, withRuntimeIdentity({ ...current, provider_ref: { ...current.provider_ref!,
        execution_generation_id: runId, provider_connection: connection, custodial_launch_agent_session_id: `session_${runId}` } }));
      await store.markRuntimeConfigurationApplied((await store.load()).generation, { agentId: first.agentId, executionGenerationId: runId, appliedRevision: revision });
      await bindings.bind({ entry_id: first.agentId, room_id: first.roomId, work_attempt_id: "attempt_1", execution_generation_id: runId,
        agent_session_id: `session_${runId}`, agent_session_token: "test-token", api_url: "https://example.test" }, { roomCursor: "msg_47" });
      return { ...first, executionGenerationId: runId,
        handle: { ...first.handle, pid, providerConnection: connection, appliedConfigurationRevision: revision },
        boundary: { state: "idle" as const, providerContinuationId: "thread_1", nativeProcessIdentity: `codex:${pid}`, latestProviderTurnId: null } };
    }
    const daemon = await installSuccessor("run_3", 10, 4313, 3);
    const reverseB = { ...daemon, operationId: "reverse-B", requestId: "reverse-B" };
    await store.prepareDeliveryDrain(reverseB); await store.markDeliveryDrainDispatch(reverseB);
    await store.commitDeliveryDrain((await store.load()).generation, reverseB, async commit => commit());
    const polling = await installSuccessor("run_4", 11, 4314, 4);
    const forwardB = { ...polling, reverseOperationId: reverseB.operationId, operationId: "forward-B", requestId: "forward-B" };
    await assert.rejects(store.prepareCustodialForward({ ...forwardB, reverseOperationId: first.reverseOperationId }, async commit => commit()), /current reverse predecessor/);
    // The existing activation contract permits naming an earlier completed
    // predecessor. Forward safety must inspect the actual execution era too.
    const activation = { ...polling, operationId: "activation-old-predecessor", requestId: "activation-old-predecessor" };
    await store.preparePollingActivation(activation, async commit => commit());
    await store.markPollingActivationDispatch(activation, async commit => commit());
    await store.checkpointPollingActivationTurn({ ...activation, providerTurnId: "native-run-4" }, async commit => commit());
    await store.completePollingActivation({ ...activation, providerTurnId: "native-run-4", outcome: "completed" }, async commit => commit());
    await assert.rejects(store.prepareCustodialForward(forwardB, async commit => commit()), /before polling activation/);
    assert.equal(await store.getDeliveryDrain(forwardB.operationId), null);
    assert.equal((await store.getAgentConfiguration(first.agentId))?.polling_contract, "custodial_polling_v1");
  } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
});

test("reverse delivery stop intent refuses absent cursors, active boundaries, queued work, and configuration edits", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath); const { agent, input } = deliveryDrainCoordinates();
  try {
    await store.write(0, [agent]); seedActiveDrainExecution(env.databasePath);
    await store.prepareDeliveryDrain(input);
    assert.equal((await store.deliveryDrainReadiness(input.operationId)).cursor, null);
    await assert.rejects(store.markDeliveryDrainDispatch(input), /numeric ingress cursor/);
    await inbox.bootstrapCursor({ agent_id: agent.id, room_id: agent.room_id, last_observed_message_id: null });
    await assert.rejects(store.markDeliveryDrainDispatch(input), /numeric ingress cursor/);
    await inbox.ingestPoll({ agent_id: agent.id, room_id: agent.room_id, last_observed_message_id: "47", messages: [] });
    await assert.rejects(store.markDeliveryDrainDispatch({ ...input,
      boundary: { state: "active", providerContinuationId: "thread_1", nativeProcessIdentity: "codex:4311", providerTurnId: "unowned" } }), /native idle/);
    const config = (await store.getAgentConfiguration(agent.id))!;
    const generation = (await store.load()).generation;
    await assert.rejects(store.updateAgentConfiguration(generation, { agentId: agent.id, expectedRevision: config.config_revision,
      model: config.model, reasoningEffort: config.reasoning_effort, charter: "changed", permissionProfileId: config.permission_profile_id,
      providerLaunchPolicy: config.provider_launch_policy, imageInput: config.image_input }), /unresolved delivery drain/);
    assert.equal((await store.load()).generation, generation);
    assert.deepEqual(await store.getAgentConfiguration(agent.id), config);
    // Poll completion wins the SQLite boundary before stop intent. B is kept,
    // so refusal cannot skip a message by transferring the newer cursor.
    await assert.rejects(store.markDeliveryDrainDispatch(input, async (commit) => {
      await inbox.ingestPoll({ agent_id: agent.id, room_id: agent.room_id, last_observed_message_id: "48",
        messages: [{ source_message_id: "48", source_message: { text: "B" }, activation: {} }] });
      await commit();
    }), /unsettled inbox/);
    assert.equal((await store.getDeliveryDrain(input.operationId))?.phase, "draining");
    assert.equal((await store.deliveryDrainReadiness(input.operationId)).status, "queued");
    assert.equal((await inbox.cursor(agent.id))?.last_observed_message_id, "48");
    assert.equal((await inbox.head(agent.id))?.source_message_id, "48");
    assert.equal(await inbox.claimHead(agent.id), null);
    await store.cancelDeliveryDrain(input);
    assert.equal((await inbox.claimHead(agent.id))?.source_message_id, "48");
  } finally { await inbox.close(); await store.close(); await env.cleanup(); }
});

test("reverse delivery commit rolls back all authority and cursor writes and rejects stale bindings or successor executions", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath);
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  const { agent, input } = deliveryDrainCoordinates();
  try {
    await store.write(0, [agent]); seedActiveDrainExecution(env.databasePath);
    await bindings.bind({ entry_id: agent.id, room_id: agent.room_id, work_attempt_id: "attempt_1",
      execution_generation_id: "run_1", agent_session_id: "session_1", agent_session_token: "test-token", api_url: "https://example.test" });
    await bindings.checkpointCursor(agent.id, "session_1", "run_1", "3");
    await inbox.ingestPoll({ agent_id: agent.id, room_id: agent.room_id, last_observed_message_id: "47", messages: [] });
    await store.prepareDeliveryDrain(input); await store.markDeliveryDrainDispatch(input);
    const generation = (await store.load()).generation;
    const database = new DatabaseSync(env.databasePath);
    try {
      const commit = () => store.commitDeliveryDrain(generation, input, async (mutate) => mutate());
      await assert.rejects(store.commitDeliveryDrain(generation, input, undefined as never), /native-death commit fence/);
      await assert.rejects(store.commitDeliveryDrain(generation, input, async () => {}), /without committing/);
      database.exec("CREATE TRIGGER reject_reverse_complete AFTER UPDATE OF phase ON execution_cutover_v2 WHEN NEW.phase='complete' BEGIN SELECT RAISE(ABORT,'reverse commit rollback'); END");
      await assert.rejects(commit(), /reverse commit rollback/);
      assert.equal((await store.load()).generation, generation);
      assert.equal((await store.getAgentConfiguration(agent.id))?.polling_contract, null);
      assert.equal(database.prepare("SELECT room_cursor FROM worker_session_bindings WHERE entry_id=?").get(agent.id)?.room_cursor, "3");
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM work_attempt_checkpoints").get()?.n, 0);
      assert.equal((await store.getDeliveryDrain(input.operationId))?.phase, "dispatching");
      database.exec("DROP TRIGGER reject_reverse_complete");
      database.exec("UPDATE worker_session_bindings SET execution_generation_id='stale'");
      await assert.rejects(commit(), /worker binding changed/);
      database.exec("UPDATE worker_session_bindings SET execution_generation_id='run_1'");
      database.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='run_1'").run(JSON.stringify(terminal));
      database.prepare("INSERT INTO work_attempt_executions VALUES('successor','attempt_1',?,'provider',9,?)").run(terminal.ended_at, JSON.stringify(terminal));
      await assert.rejects(commit(), /exact execution authority/);
      assert.equal((await store.load()).generation, generation);
      assert.equal((await store.getDeliveryDrain(input.operationId))?.phase, "dispatching");
    } finally { database.close(); }
  } finally { await bindings.close(); await inbox.close(); await store.close(); await env.cleanup(); }
});

test("reverse delivery readiness accepts only exact settled A receipts and blocks full or compacted uncertain effects", async () => {
  for (const outcome of ["reply", "no_reply", "failed", "interrupted", "cancelled_by_user"] as const) {
    const env = await fixture(); const store = new ManifestStore(env.databasePath);
    const inbox = new SupervisedAgentInboxStore(env.databasePath); const { agent, input } = deliveryDrainCoordinates();
    try {
      await store.write(0, [agent]); seedActiveDrainExecution(env.databasePath);
      const [a] = await inbox.ingestPoll({ agent_id: agent.id, room_id: agent.room_id, last_observed_message_id: "47",
        messages: [{ source_message_id: "47", source_message: {}, activation: {} }] });
      await inbox.claimHead(agent.id); await inbox.checkpointTurnStarted(a!.inbox_item_id, "native-A", TEST_PROVIDER_TURN_AUTHORITY);
      await store.prepareDeliveryDrain({ ...input, boundary: { state: "active", providerContinuationId: "thread_1", nativeProcessIdentity: "codex:4311", providerTurnId: "native-A" } });
      assert.equal((await store.deliveryDrainReadiness(input.operationId)).status, "waiting");
      await assert.rejects(store.markDeliveryDrainDispatch(input), /unsettled inbox/);
      if (outcome === "cancelled_by_user") await inbox.cancelInterruptedTurn(a!.inbox_item_id);
      else {
        const text = outcome === "reply" ? "A completed" : null;
        await inbox.checkpointNormalizedTerminal({ inbox_item_id: a!.inbox_item_id, agent_id: agent.id,
          execution_generation_id: "run_1", provider_turn_id: "native-A", outcome, text, evidence: "stream",
          terminal_evidence: { turnId: "native-A", providerContinuationId: "thread_1", outcome, text, evidence: "stream" } });
        await inbox.transition(a!.inbox_item_id, "awaiting_result");
        if (outcome === "reply") {
          await inbox.transition(a!.inbox_item_id, "publishing");
          assert.equal((await store.deliveryDrainReadiness(input.operationId)).status, "waiting");
          await inbox.checkpointPublication({ inbox_item_id: a!.inbox_item_id, room_id: agent.room_id, canonical_message_id: "published-A" });
        } else await inbox.transition(a!.inbox_item_id, outcome === "no_reply" ? "acknowledged_no_reply" : "acknowledged_failed");
      }
      assert.equal((await store.deliveryDrainReadiness(input.operationId)).status, "ready");
      const database = new DatabaseSync(env.databasePath);
      try {
        database.prepare(`INSERT INTO supervised_agent_effects(effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,created_at,updated_at)
          VALUES('uncertain',?,?,?,'native-A','request','write_file','{}',1,'uncertain',?,?)`).run(agent.id, agent.room_id, "run_1", agent.created_at, agent.created_at);
        assert.equal((await store.deliveryDrainReadiness(input.operationId)).status, "waiting");
        await assert.rejects(store.markDeliveryDrainDispatch(input), /unsettled inbox/);
        database.prepare(`INSERT INTO supervised_agent_effect_tombstones(effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_sha256,request_bytes,mutation,state,created_at,updated_at)
          SELECT effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,?,2,mutation,state,created_at,updated_at FROM supervised_agent_effects WHERE effect_id='uncertain'`).run("a".repeat(64));
        database.exec("DELETE FROM supervised_agent_effects WHERE effect_id='uncertain'");
        assert.equal((await store.deliveryDrainReadiness(input.operationId)).status, "waiting");
        database.exec("UPDATE supervised_agent_effect_tombstones SET state='completed' WHERE effect_id='uncertain'");
        assert.equal((await store.deliveryDrainReadiness(input.operationId)).status, "ready");
        if (outcome === "reply") {
          database.prepare("DELETE FROM supervised_agent_publications WHERE inbox_item_id=?").run(a!.inbox_item_id);
          await assert.rejects(store.markDeliveryDrainDispatch(input), /terminal receipt/);
        } else {
          database.prepare("UPDATE supervised_agent_provider_turn_bindings SET provider_continuation_id='other' WHERE inbox_item_id=?").run(a!.inbox_item_id);
          await assert.rejects(store.markDeliveryDrainDispatch(input), /terminal receipt/);
        }
      } finally { database.close(); }
    } finally { await inbox.close(); await store.close(); await env.cleanup(); }
  }
});

test("delivery drain snapshots exact witness before await and replays it after runtime changes and reopen", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const { agent, input } = deliveryDrainCoordinates();
  try {
    await store.write(0, [agent]);
    seedActiveDrainExecution(env.databasePath);
    const original = structuredClone(input);
    const preparing = store.prepareDeliveryDrain(input);
    input.roomId = "changed-after-call";
    input.handle.providerContinuationId = "changed-after-call";
    if (input.handle.providerConnection?.kind === "codex_app_server") input.handle.providerConnection.url = "http://127.0.0.1:9999";
    input.boundary.providerContinuationId = "changed-after-call";
    const { cutover } = await preparing;
    assert.equal(cutover.room_id, original.roomId);
    assert.equal(cutover.native_continuation_id, "thread_1");
    assert.equal(cutover.native_pid, 4311);
    assert.equal(cutover.native_process_identity, "codex:4311");
    assert.equal(cutover.native_connection_sha256, createHash("sha256").update(JSON.stringify(["codex_app_server", "http://127.0.0.1:4311", 4311, "codex:4311"])).digest("hex"));
    assert.equal(cutover.predecessor_operation_id, null);
    await store.replaceEntry((await store.load()).generation, { ...agent, provider_ref: { ...agent.provider_ref!, provider_continuation_id: "successor-thread" } });
    assert.deepEqual(await store.prepareDeliveryDrain(original), { created: false, cutover });
    for (const changed of [
      { ...original, operationId: "different-operation" },
      { ...original, agentId: "different-agent" },
      { ...original, roomId: "different-room" },
      { ...original, executionGenerationId: "different-generation" },
      { ...original, handle: { ...original.handle, providerConnection: { ...original.handle.providerConnection!, kind: "codex_app_server" as const, url: "http://127.0.0.1:9999" } } },
      { ...original, boundary: { state: "active" as const, providerContinuationId: "thread_1", nativeProcessIdentity: "codex:4311", providerTurnId: "unowned-turn" } },
    ]) await assert.rejects(() => store.prepareDeliveryDrain(changed), /bound to different|native boundary/i);
    await store.close();
    const reopened = new ManifestStore(env.databasePath);
    try {
      assert.deepEqual(await reopened.getDeliveryDrain(original.operationId), cutover);
      await assert.rejects(() => reopened.cancelDeliveryDrain({ operationId: original.operationId, agentId: "wrong-agent" }));
      const cancelled = await reopened.cancelDeliveryDrain({ operationId: original.operationId, agentId: agent.id });
      assert.equal(cancelled.phase, "cancelled");
      assert.deepEqual(await reopened.cancelDeliveryDrain({ operationId: original.operationId, agentId: agent.id }), cancelled,
        "cancellation retries return the original result without rewriting its timestamp");
      assert.equal(cancelled.native_connection_sha256, cutover.native_connection_sha256);
      assert.equal(cancelled.native_continuation_id, cutover.native_continuation_id);
      assert.equal((await reopened.getEntry(agent.id))?.provider_ref?.provider_continuation_id, "successor-thread");
    } finally { await reopened.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("delivery drain rejects unknown or stale authority and rolls back failed admission and cancellation fences", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const { agent, input } = deliveryDrainCoordinates();
  try {
    await store.write(0, [agent]);
    seedActiveDrainExecution(env.databasePath);
    for (const changed of [
      { ...input, boundary: { state: "unknown" as const } },
      { ...input, boundary: { ...input.boundary, nativeProcessIdentity: "reused-pid" } },
      { ...input, boundary: { state: "active" as const, providerContinuationId: "thread_1", nativeProcessIdentity: "codex:4311", providerTurnId: "unowned-active-turn" } },
      { ...input, roomId: "wrong-room" },
      { ...input, executionGenerationId: "stale-generation" },
      { ...input, handle: { ...input.handle, workAttemptId: "different-attempt" } },
      { ...input, handle: { ...input.handle, pid: 9999 } },
      { ...input, handle: { ...input.handle, appliedConfigurationRevision: 2 } },
    ]) await assert.rejects(() => store.prepareDeliveryDrain(changed));
    const database = new DatabaseSync(env.databasePath);
    try {
      database.exec("UPDATE agent_configurations SET config_revision=2 WHERE agent_id='agent_1'");
      await assert.rejects(() => store.prepareDeliveryDrain(input), /applied provider configuration/i);
      database.exec("UPDATE agent_configurations SET config_revision=1 WHERE agent_id='agent_1'");
      database.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='run_1'").run(JSON.stringify(terminal));
      await assert.rejects(() => store.prepareDeliveryDrain(input), /exact execution authority/i);
      database.exec("UPDATE work_attempt_executions SET terminal_json=NULL WHERE execution_generation_id='run_1'");
      await assert.rejects(() => store.prepareDeliveryDrain(input, async () => {}), /without committing/i);
      assert.equal(await store.getDeliveryDrain(input.operationId), null);
      database.exec("CREATE TRIGGER reject_drain_insert AFTER INSERT ON execution_cutover_v2 BEGIN SELECT RAISE(ABORT,'test drain rollback'); END");
      await assert.rejects(() => store.prepareDeliveryDrain(input), /test drain rollback/);
      assert.equal(await store.getDeliveryDrain(input.operationId), null);
      database.exec("DROP TRIGGER reject_drain_insert");
      const { cutover } = await store.prepareDeliveryDrain(input);
      await assert.rejects(() => store.cancelDeliveryDrain({ operationId: input.operationId, agentId: agent.id }, async () => {}), /without committing/i);
      assert.deepEqual(await store.getDeliveryDrain(input.operationId), cutover);
      database.exec("CREATE TRIGGER reject_drain_cancel AFTER UPDATE OF phase ON execution_cutover_v2 BEGIN SELECT RAISE(ABORT,'test cancel rollback'); END");
      await assert.rejects(() => store.cancelDeliveryDrain({ operationId: input.operationId, agentId: agent.id }), /test cancel rollback/);
      assert.deepEqual(await store.getDeliveryDrain(input.operationId), cutover);
      database.exec("DROP TRIGGER reject_drain_cancel");
      for (const phase of ["dispatching", "uncertain"] as const) {
        database.prepare("UPDATE execution_cutover_v2 SET phase=? WHERE operation_id=?").run(phase, input.operationId);
        await assert.rejects(() => store.cancelDeliveryDrain({ operationId: input.operationId, agentId: agent.id }), /pre-dispatch authority/i);
      }
      database.prepare("UPDATE execution_cutover_v2 SET phase='cancelled' WHERE operation_id=?").run(input.operationId);
      database.exec("INSERT INTO execution_cutover_v2(operation_id,request_id,agent_id,execution_generation_id,from_mode,to_mode,strategy,phase,created_at_ms,updated_at_ms) VALUES('historical','historical','agent_1','run_1','mcp_polling','daemon_inbox','drain','prepared',1,1)");
      await assert.rejects(() => store.cancelDeliveryDrain({ operationId: "historical", agentId: agent.id }), /pre-dispatch authority/i);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { database.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("delivery drain and existing control operations exclude one another in either admission order", async () => {
  for (const kind of ["turn-control", "room-move", "continuation-repair", "legacy-cutover"] as const) {
    for (const drainFirst of [false, true]) {
      const env = await fixture();
      const store = new ManifestStore(env.databasePath);
      const inbox = new SupervisedAgentInboxStore(env.databasePath);
      const { agent, input } = deliveryDrainCoordinates();
      try {
        await store.write(0, [agent]);
        seedActiveDrainExecution(env.databasePath);
        const a = await inbox.enqueueCorrection({ agent_id: agent.id, room_id: agent.room_id, source_message_id: "control-A", source_message: {}, activation: { decision: "activate" } });
        await inbox.claimHead(agent.id);
        if (kind === "turn-control") await inbox.checkpointTurnStarted(a.inbox_item_id, "native-A", TEST_PROVIDER_TURN_AUTHORITY);
        if (kind === "continuation-repair") await inbox.transition(a.inbox_item_id, "blocked", { failure_code: "provider_continuation_missing" });
        const boundary = kind === "turn-control"
          ? { state: "active" as const, providerContinuationId: "thread_1", nativeProcessIdentity: "codex:4311", providerTurnId: "native-A" }
          : input.boundary;
        const prepareOther = async () => {
          if (kind === "turn-control") return store.prepareTurnControlState((await store.load()).generation, {
            agentId: agent.id, roomId: agent.room_id, expectedInboxItemId: a.inbox_item_id,
            expectedSourceMessageId: a.source_message_id, expectedProviderTurnId: "native-A",
            actionId: "control-A", actionSequence: 1, workAttemptId: "attempt_1", executionGenerationId: "run_1",
            providerContinuationId: "thread_1", providerConnection: agent.provider_ref!.provider_connection,
            deliveryMode: "daemon_inbox", hasCorrection: false, correctionText: null, correctionStrategy: null,
            capability: "native_interrupt", recordedAt: "2026-08-31T09:00:00.000Z",
          });
          if (kind === "room-move") return store.prepareRoomMove({
            operation_id: "move-A", request_id: "move-A", agent_id: agent.id, source_room_id: agent.room_id,
            destination_room_id: "next-room", daemon_generation: 1, work_attempt_id: "attempt_1",
            execution_generation_id: "run_1", agent_session_id: "session_1", activating_inbox_item_id: null,
            provider_turn_id: null, effect_id: null, phase: "prepared",
          });
          if (kind === "continuation-repair") return inbox.beginContinuationRepair({
            agent_id: agent.id, room_id: agent.room_id, inbox_item_id: a.inbox_item_id, daemon_generation: 1,
            execution_generation_id: "run_1", work_attempt_id: "attempt_1", expected_pid: 4311,
            expected_process_identity: "codex:4311", missing_continuation: "thread_1",
          });
          return store.replaceEntry((await store.load()).generation, { ...agent, delivery_cutover: {
            work_attempt_id: "attempt_1", execution_generation_id: "run_1", provider_continuation_id: "thread_1",
            provider_turn_id: null, phase: "prepared", updated_at: "2026-08-31T09:00:00.000Z",
          } });
        };
        if (drainFirst) {
          if (kind === "turn-control") await assert.rejects(() => store.prepareDeliveryDrain({ ...input,
            boundary: { state: "active", providerContinuationId: "thread_1", nativeProcessIdentity: "codex:4311", providerTurnId: "unowned-successor" },
          }), /does not match the admitted turn/i);
          const { cutover } = await store.prepareDeliveryDrain({ ...input, boundary });
          assert.equal(cutover.native_target_turn_id, kind === "turn-control" ? "native-A" : null);
          await assert.rejects(prepareOther, /delivery drain|cutover/i, `${kind} must not bypass the accepted drain`);
          await store.cancelDeliveryDrain({ operationId: input.operationId, agentId: agent.id });
          await prepareOther();
        } else {
          await prepareOther();
          await assert.rejects(() => store.prepareDeliveryDrain({ ...input, boundary }), /unresolved control operation/i);
          assert.equal(await store.getDeliveryDrain(input.operationId), null);
        }
      } finally { await inbox.close(); await store.close(); await env.cleanup(); }
    }
  }
});
