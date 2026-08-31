import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DAEMON_STATE_SCHEMA_VERSION, DaemonStateSchema } from "../daemon-state-database.js";
import { serializeDaemonDeploymentId } from "../manifest-entry-projection.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import type { ProviderActionHandle } from "../provider-action-port.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonManifest, DaemonManifestEntry, LegacyLaneOwner } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { matchesPollingActivationRuntime, validatePollingActivationSchema, validatePollingOfferSchema } from "../custodial-polling-activation.js";

const TEST_PROVIDER_TURN_AUTHORITY = {
  work_attempt_id: "attempt_1",
  origin_execution_generation_id: "run_1",
  provider_continuation_id: "thread_1",
} as const;

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
      const scope = { operationId: activation.operationId, agentId: activation.agentId,
        processIncarnationId: "01234567-89ab-4cde-8fab-0123456789ab" };
      assert.equal((await store.acknowledgePollingOffer({ ...scope, roomCursor: "msg_49" }, async commit => commit())).acknowledged, false);
      const first = await store.recordPollingOffer({ ...scope, requestId: 1, inputCursor: "msg_47", offeredFrontier: "msg_49" }, async commit => commit());
      assert.equal(first.mcp_request_id, "1"); assert.equal(first.predecessor_offer_id, null);
      assert.deepEqual(await store.recordPollingOffer({ ...scope, requestId: 1, inputCursor: "msg_47", offeredFrontier: "msg_49" }, async commit => commit()), first);
      const second = await store.recordPollingOffer({ ...scope, requestId: "1", inputCursor: "msg_47", offeredFrontier: "msg_50" }, async commit => commit());
      assert.equal(second.mcp_request_id, '"1"'); assert.equal(second.predecessor_offer_id, first.offer_id);
      await assert.rejects(store.recordPollingOffer({ ...scope, requestId: 1, inputCursor: "msg_47", offeredFrontier: "msg_49" }, async commit => commit()), /superseded/);
      assert.equal((await store.acknowledgePollingOffer({ ...scope, roomCursor: "msg_49" }, async commit => commit())).acknowledged, false);
      assert.equal(database.prepare("SELECT room_cursor FROM worker_session_bindings").get()?.room_cursor, "msg_47");
      assert.deepEqual(await store.load(), before, "offering/superseding does not rewrite the manifest or consume work");
      await store.close(); store = new ManifestStore(env.databasePath);
      assert.deepEqual(await store.getPollingOfferTail(activation.operationId), second, "outstanding offer survives daemon restart");
      const replacementScope = { ...scope, processIncarnationId: "fedcba98-7654-4321-8fab-0123456789ab" };
      const replacement = await store.recordPollingOffer({ ...replacementScope, requestId: 1, inputCursor: "msg_47", offeredFrontier: "msg_50" }, async commit => commit());
      assert.equal(replacement.predecessor_offer_id, second.offer_id);
      assert.equal((await store.acknowledgePollingOffer({ ...scope, roomCursor: "msg_50" }, async commit => commit())).acknowledged, false,
        "a previous MCP process cannot acknowledge the replacement process's offer");
      const repeatedFrontier = await store.recordPollingOffer({ ...replacementScope, requestId: 2, inputCursor: "msg_47", offeredFrontier: "msg_50" }, async commit => commit());
      const acknowledged = await store.acknowledgePollingOffer({ ...replacementScope, roomCursor: "msg_50" }, async commit => commit());
      assert.equal(acknowledged.acknowledged, true); assert.equal(acknowledged.offer?.offer_id, repeatedFrontier.offer_id);
      assert.equal(acknowledged.roomCursor, "msg_50"); assert.ok(acknowledged.offer?.acknowledged_at_ms);
      assert.deepEqual(await store.acknowledgePollingOffer({ ...replacementScope, roomCursor: "msg_50" }, async commit => commit()), acknowledged);
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
      processIncarnationId: "01234567-89ab-4cde-8fab-0123456789ab", requestId: 1, inputCursor: "msg_47", offeredFrontier: "msg_50" };
    await store.preparePollingActivation(activation, async commit => commit());
    await assert.rejects(store.recordPollingOffer(input, async commit => commit()), /active native activation/);
    await store.markPollingActivationDispatch(activation, async commit => commit());
    await store.checkpointPollingActivationTurn({ ...activation, providerTurnId: "native-turn" }, async commit => commit());
    await assert.rejects(store.recordPollingOffer(input, undefined as never), /ownership commit fence/);
    await assert.rejects(store.recordPollingOffer(input, async () => {}), /without committing/);
    for (const bad of [
      { ...input, operationId: "missing" }, { ...input, agentId: "other" }, { ...input, processIncarnationId: "4312" },
      { ...input, requestId: 1.5 }, { ...input, inputCursor: "opaque" },
      { ...input, offeredFrontier: "msg_46" }, { ...input, inputCursor: "msg_49" },
    ]) await assert.rejects(store.recordPollingOffer(bad, async commit => commit()));
    assert.equal(await store.getPollingOfferTail(activation.operationId), null);
    const offer = await store.recordPollingOffer(input, async commit => commit());
    const ack = { ...input, roomCursor: "msg_50" };
    const database = new DatabaseSync(env.databasePath);
    try {
      for (const [sql, undo] of [
        ["UPDATE worker_session_bindings SET agent_session_id='other'", "UPDATE worker_session_bindings SET agent_session_id='session_2'"],
        ["UPDATE worker_session_bindings SET room_cursor='msg_48'", "UPDATE worker_session_bindings SET room_cursor='msg_47'"],
        ["UPDATE agent_configurations SET config_revision=3", "UPDATE agent_configurations SET config_revision=2"],
        ["UPDATE runtime_deployments SET custodial_launch_agent_session_id='other'", "UPDATE runtime_deployments SET custodial_launch_agent_session_id='session_2'"],
      ]) {
        database.exec(sql!);
        await assert.rejects(store.acknowledgePollingOffer(ack, async commit => commit()), /changed/);
        await assert.rejects(store.recordPollingOffer({ ...input, requestId: 2 }, async commit => commit()));
        assert.deepEqual(await store.getPollingOfferTail(activation.operationId), offer);
        database.exec(undo!);
      }
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
      processIncarnationId: "01234567-89ab-4cde-8fab-0123456789ab", inputCursor: "msg_47", offeredFrontier: "msg_50" };
    const first = await store.recordPollingOffer({ ...input, requestId: 1 }, async commit => commit());
    const tail = await store.recordPollingOffer({ ...input, requestId: 2 }, async commit => commit());
    const database = new DatabaseSync(env.databasePath);
    try {
      database.exec("PRAGMA foreign_keys=ON");
      for (const field of ["offer_id", "activation_id", "process_incarnation_id", "mcp_request_id", "input_cursor", "offered_frontier", "predecessor_offer_id", "created_at_ms"]) {
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
        assert.throws(() => database.prepare(`INSERT INTO custodial_polling_offers(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row)));
      }
      assert.throws(() => database.prepare("UPDATE custodial_polling_offers SET acknowledged_at_ms=? WHERE offer_id=?").run(first.created_at_ms, first.offer_id), /immutable/);
      assert.throws(() => database.prepare("DELETE FROM custodial_polling_offers WHERE offer_id=?").run(tail.offer_id), /cannot be removed/);
      const result = await store.acknowledgePollingOffer({ ...input, roomCursor: "msg_50" }, async commit => commit());
      for (const value of [null, result.offer!.acknowledged_at_ms! + 1]) {
        assert.throws(() => database.prepare("UPDATE custodial_polling_offers SET acknowledged_at_ms=? WHERE offer_id=?").run(value, tail.offer_id), /immutable/);
      }
      validatePollingOfferSchema(database); assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
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
      providerLaunchPolicy: config.provider_launch_policy }), /unresolved delivery drain/);
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

test("turn-control preparation and FIFO claim have one atomic admission order", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T09:00:00.000Z");
  const base = (id: string, roomId: string): DaemonManifestEntry => ({
    ...entry,
    id,
    room_id: roomId,
    condition: "none",
    delivery_mode: "daemon_inbox",
    provider_ref: {
      ...entry.provider_ref!,
      provider_connection: { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "codex:4311" },
    },
    turn_control: undefined,
    last_turn_control_sequence: 0,
  });
  const exactTargets = new Map<string, { inboxItemId: string; sourceMessageId: string; providerTurnId: string }>();
  const prepare = (generation: number, agent: DaemonManifestEntry, actionId: string, actionSequence = 1) => store.prepareTurnControlState(generation, {
    agentId: agent.id,
    roomId: agent.room_id,
    expectedInboxItemId: exactTargets.get(agent.id)!.inboxItemId,
    expectedSourceMessageId: exactTargets.get(agent.id)!.sourceMessageId,
    expectedProviderTurnId: exactTargets.get(agent.id)!.providerTurnId,
    actionId,
    actionSequence,
    workAttemptId: "attempt_1",
    executionGenerationId: "run_1",
    providerContinuationId: "thread_1",
    providerConnection: agent.provider_ref!.provider_connection,
    deliveryMode: "daemon_inbox",
    hasCorrection: true,
    correctionText: `correction-${actionId}`,
    correctionStrategy: "stop_then_resend",
    capability: "native_interrupt",
    recordedAt: "2026-08-05T09:00:00.000Z",
  });
  try {
    const prepareFirst = base("prepare-first", "room-prepare-first");
    const claimFirst = base("claim-first", "room-claim-first");
    await store.write(0, [prepareFirst, claimFirst]);
    const pendingA = await inbox.enqueueCorrection({
      agent_id: prepareFirst.id, room_id: prepareFirst.room_id, source_message_id: `${prepareFirst.id}-message`,
      source_message: { text: "A" }, activation: { decision: "activate" },
    });
    const admittedA = await inbox.enqueueCorrection({
      agent_id: claimFirst.id, room_id: claimFirst.room_id, source_message_id: `${claimFirst.id}-message`,
      source_message: { text: "A" }, activation: { decision: "activate" },
    });
    await inbox.claimHead(prepareFirst.id);
    await inbox.checkpointTurnStarted(pendingA.inbox_item_id, `${prepareFirst.id}-turn`, TEST_PROVIDER_TURN_AUTHORITY);
    await inbox.claimHead(claimFirst.id);
    await inbox.checkpointTurnStarted(admittedA.inbox_item_id, `${claimFirst.id}-turn`, TEST_PROVIDER_TURN_AUTHORITY);
    exactTargets.set(prepareFirst.id, { inboxItemId: pendingA.inbox_item_id, sourceMessageId: `${prepareFirst.id}-message`, providerTurnId: `${prepareFirst.id}-turn` });
    exactTargets.set(claimFirst.id, { inboxItemId: admittedA.inbox_item_id, sourceMessageId: `${claimFirst.id}-message`, providerTurnId: `${claimFirst.id}-turn` });

    const frozen = await prepare(1, prepareFirst, "prepare-wins");
    assert.equal(frozen.linkedInboxItemId, pendingA.inbox_item_id, "the action binds the exact already-checkpointed turn");
    assert.equal(await inbox.claimHead(prepareFirst.id), null, "the accepted unlinked action freezes later admission");
    assert.equal((await inbox.get(pendingA.inbox_item_id))?.state, "dispatching");

    const linked = await prepare(frozen.generation, claimFirst, "claim-wins");
    assert.equal(linked.linkedInboxItemId, admittedA.inbox_item_id, "an already-admitted row becomes exact A");
    assert.equal(linked.linkedState, "dispatching");
    assert.equal(await inbox.claimHead(claimFirst.id), null, "the linked barrier never admits a successor");
    const targeted = await store.checkpointTurnControlTarget(linked.generation, {
      agentId: claimFirst.id, roomId: claimFirst.room_id, actionId: "claim-wins",
      workAttemptId: "attempt_1", executionGenerationId: "run_1", providerContinuationId: "thread_1",
      providerConnection: claimFirst.provider_ref!.provider_connection, deliveryMode: "daemon_inbox",
      providerTurnId: `${claimFirst.id}-turn`, observedAt: "2026-08-05T09:00:00.500Z",
    });
    assert.equal(targeted.entry.turn_control?.provider_turn_id, `${claimFirst.id}-turn`);
    assert.equal((await inbox.get(admittedA.inbox_item_id))?.provider_turn_id, `${claimFirst.id}-turn`, "journal and FIFO target checkpoint atomically");
    await assert.rejects(() => store.checkpointTurnControlTarget(targeted.generation, {
      agentId: claimFirst.id, roomId: claimFirst.room_id, actionId: "claim-wins",
      workAttemptId: "attempt_1", executionGenerationId: "run_1", providerContinuationId: "thread_1",
      providerConnection: claimFirst.provider_ref!.provider_connection, deliveryMode: "daemon_inbox",
      providerTurnId: "successor-B", observedAt: "2026-08-05T09:00:00.750Z",
    }), /exact prepared authority/i);

    await assert.rejects(() => store.prepareTurnControlState(targeted.generation, {
      agentId: claimFirst.id,
      roomId: claimFirst.room_id,
      expectedInboxItemId: admittedA.inbox_item_id,
      expectedSourceMessageId: `${claimFirst.id}-message`,
      expectedProviderTurnId: `${claimFirst.id}-turn`,
      actionId: "stale-mode",
      actionSequence: 2,
      workAttemptId: "attempt_1",
      executionGenerationId: "run_1",
      providerContinuationId: "thread_1",
      providerConnection: claimFirst.provider_ref!.provider_connection,
      deliveryMode: "mcp_polling",
      hasCorrection: false,
      correctionText: null,
      correctionStrategy: null,
      capability: "native_interrupt",
      recordedAt: "2026-08-05T09:00:01.000Z",
    }), /exact execution authority/i, "a request cannot cross a delivery-mode handoff");
  } finally {
    await inbox.close();
    await store.close();
    await env.cleanup();
  }
});

test("Cursor session discovery atomically retargets an already-prepared control and survives reopen", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T09:30:00.000Z");
  const bindings = new WorkerBindingStore(env.legacyPath, undefined, env.databasePath);
  const pendingContinuation = "cursor-pending:authority-race";
  const sessionContinuation = "cursor-session:authority-race";
  const wrapperConnection = {
    kind: "cursor_cli" as const,
    pid: 4812,
    processIdentity: "cursor-wrapper:4812:birth",
  };
  const cursor: DaemonManifestEntry = {
    ...entry,
    id: "cursor-authority-race",
    room_id: "cursor-authority-room",
    provider: "cursor",
    condition: "none",
    delivery_mode: "daemon_inbox",
    provider_ref: {
      work_attempt_id: "cursor-authority-attempt",
      provider_continuation_id: pendingContinuation,
      provider_connection: null,
      execution_generation_id: "cursor-authority-generation",
    },
    work_attempt_id: "cursor-authority-attempt",
    turn_control: undefined,
    last_turn_control_sequence: 0,
  };
  try {
    let generation = (await store.write(0, [cursor])).generation;
    const worker = await bindings.bind({
      entry_id: cursor.id,
      room_id: cursor.room_id,
      work_attempt_id: cursor.work_attempt_id!,
      execution_generation_id: cursor.provider_ref!.execution_generation_id,
      agent_session_id: "cursor-authority-worker",
      agent_session_token: "memory-only-test-token",
      api_url: "https://letagents.test",
    });
    const active = await inbox.enqueueCorrection({
      agent_id: cursor.id,
      room_id: cursor.room_id,
      source_message_id: "cursor-authority-message",
      source_message: { text: "A" },
      activation: { decision: "activate" },
    });
    await inbox.claimHead(cursor.id);
    const preparedTurn = await store.checkpointCursorPreparedTurn(generation, {
      agentId: cursor.id,
      roomId: cursor.room_id,
      inboxItemId: active.inbox_item_id,
      providerTurnId: "cursor-authority-turn",
      providerContinuationId: pendingContinuation,
      workAttemptId: cursor.work_attempt_id!,
      executionGenerationId: cursor.provider_ref!.execution_generation_id,
      agentSessionId: worker.agent_session_id,
      credentialRef: worker.credential_ref,
      apiUrl: worker.api_url,
      expectedProviderContinuationId: pendingContinuation,
      expectedProviderConnection: null,
      providerConnection: wrapperConnection,
      observedAt: "2026-08-05T09:30:00.000Z",
    });
    generation = preparedTurn.generation;
    const preparedControl = await store.prepareTurnControlState(generation, {
      agentId: cursor.id,
      roomId: cursor.room_id,
      expectedInboxItemId: active.inbox_item_id,
      expectedSourceMessageId: "cursor-authority-message",
      expectedProviderTurnId: "cursor-authority-turn",
      actionId: "cursor-authority-control",
      actionSequence: 1,
      workAttemptId: cursor.work_attempt_id!,
      executionGenerationId: cursor.provider_ref!.execution_generation_id,
      providerContinuationId: pendingContinuation,
      providerConnection: wrapperConnection,
      deliveryMode: "daemon_inbox",
      hasCorrection: false,
      correctionText: null,
      correctionStrategy: null,
      capability: "native_interrupt",
      recordedAt: "2026-08-05T09:30:00.100Z",
    });
    generation = preparedControl.generation;
    assert.equal(preparedControl.entry.turn_control?.target_provider_continuation_id, pendingContinuation);

    const discovered = await store.checkpointCursorProviderState(generation, {
      agentId: cursor.id,
      roomId: cursor.room_id,
      inboxItemId: active.inbox_item_id,
      providerTurnId: "cursor-authority-turn",
      workAttemptId: cursor.work_attempt_id!,
      executionGenerationId: cursor.provider_ref!.execution_generation_id,
      agentSessionId: worker.agent_session_id,
      credentialRef: worker.credential_ref,
      apiUrl: worker.api_url,
      expectedProviderContinuationId: pendingContinuation,
      expectedProviderConnection: wrapperConnection,
      providerContinuationId: sessionContinuation,
      providerConnection: wrapperConnection,
      observedAt: "2026-08-05T09:30:00.200Z",
    });
    assert.equal(discovered.entry.provider_ref?.provider_continuation_id, sessionContinuation);
    assert.equal(discovered.entry.turn_control?.target_provider_continuation_id, sessionContinuation,
      "the accepted control advances with the same exact Cursor turn revision");
    assert.equal((await inbox.providerTurnBinding(active.inbox_item_id))?.provider_continuation_id, sessionContinuation);

    // Reproduce the short-lived predecessor state where runtime+binding had
    // already committed the real session but the control still named the
    // wrapper's pending continuation. An idempotent provider callback must heal
    // it even though the runtime itself no longer needs an update.
    const splitForCallback = new DatabaseSync(env.databasePath);
    splitForCallback.prepare(`UPDATE turn_control_journals
      SET target_provider_continuation_id=? WHERE agent_id=?`).run(pendingContinuation, cursor.id);
    splitForCallback.close();
    const healed = await store.checkpointCursorProviderState(discovered.generation, {
      agentId: cursor.id,
      roomId: cursor.room_id,
      inboxItemId: active.inbox_item_id,
      providerTurnId: "cursor-authority-turn",
      workAttemptId: cursor.work_attempt_id!,
      executionGenerationId: cursor.provider_ref!.execution_generation_id,
      agentSessionId: worker.agent_session_id,
      credentialRef: worker.credential_ref,
      apiUrl: worker.api_url,
      expectedProviderContinuationId: sessionContinuation,
      expectedProviderConnection: wrapperConnection,
      providerContinuationId: sessionContinuation,
      providerConnection: wrapperConnection,
      observedAt: "2026-08-05T09:30:00.300Z",
    });
    assert.equal(healed.entry.turn_control?.target_provider_continuation_id, sessionContinuation,
      "an idempotent callback heals the predecessor journal-behind state");

    // Recreate the same split at the crash boundary. Current-v16 schema repair
    // must reconcile the exact same turn before causal validation runs.
    const splitForReopen = new DatabaseSync(env.databasePath);
    splitForReopen.prepare(`UPDATE turn_control_journals
      SET target_provider_continuation_id=? WHERE agent_id=?`).run(pendingContinuation, cursor.id);
    splitForReopen.close();

    await inbox.close();
    await bindings.close();
    await store.close();
    const reopened = new ManifestStore(env.databasePath);
    const reopenedEntry = await reopened.getEntry(cursor.id);
    assert.equal(reopenedEntry?.provider_ref?.provider_continuation_id, sessionContinuation);
    assert.equal(reopenedEntry?.turn_control?.target_provider_continuation_id, sessionContinuation,
      "current-v16 repair retargets the exact predecessor split before causal validation");
    await reopened.close();
  } finally {
    await inbox.close().catch(() => undefined);
    await bindings.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("turn-control replay authority is exact-next and constant-size across many actions and reopen", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T10:00:00.000Z");
  try {
    const controlled: DaemonManifestEntry = {
      ...entry,
      condition: "none",
      delivery_mode: "daemon_inbox",
      turn_control: undefined,
      last_turn_control_sequence: 0,
      provider_ref: {
        ...entry.provider_ref!,
        provider_connection: { ...entry.provider_ref!.provider_connection!, processIdentity: "codex:4311" },
      },
    };
    let generation = (await store.write(0, [controlled])).generation;
    const active = await inbox.enqueueCorrection({
      agent_id: controlled.id, room_id: controlled.room_id,
      source_message_id: "sequence-message", source_message: { text: "A" }, activation: { decision: "activate" },
    });
    await inbox.claimHead(controlled.id);
    await inbox.checkpointTurnStarted(active.inbox_item_id, "sequence-turn", TEST_PROVIDER_TURN_AUTHORITY);
    const prepare = (actionId: string, actionSequence: number) => store.prepareTurnControlState(generation, {
      agentId: controlled.id, roomId: controlled.room_id, actionId, actionSequence,
      expectedInboxItemId: active.inbox_item_id, expectedSourceMessageId: "sequence-message", expectedProviderTurnId: "sequence-turn",
      workAttemptId: controlled.work_attempt_id!, executionGenerationId: controlled.provider_ref!.execution_generation_id,
      providerContinuationId: controlled.provider_ref!.provider_continuation_id,
      providerConnection: controlled.provider_ref!.provider_connection, deliveryMode: "daemon_inbox",
      hasCorrection: false, correctionText: null, correctionStrategy: null,
      capability: "native_interrupt", recordedAt: "2026-08-05T10:00:00.000Z",
    });

    let prepared = await prepare("control-1", 1);
    generation = prepared.generation;
    let retryable = await store.replaceEntry(generation, {
      ...prepared.entry,
      turn_control: { ...prepared.entry.turn_control!, status: "retryable", error: "retry" },
    });
    generation = retryable.generation;
    const retry = await prepare("control-1", 1);
    assert.equal(retry.entry.turn_control?.action_sequence, 1, "an exact retry reuses the current sequence");
    generation = retry.generation;
    const completed = await store.replaceEntry(generation, {
      ...retry.entry,
      turn_control: { ...retry.entry.turn_control!, status: "completed", error: null },
    });
    generation = completed.generation;
    await assert.rejects(() => prepare("stale-sequence", 1), /exact next durable value/i);
    await assert.rejects(() => prepare("sequence-gap", 3), /exact next durable value/i);

    for (let sequence = 2; sequence <= 80; sequence += 1) {
      prepared = await prepare(`control-${sequence}`, sequence);
      generation = prepared.generation;
      retryable = await store.replaceEntry(generation, {
        ...prepared.entry,
        turn_control: { ...prepared.entry.turn_control!, status: "completed", error: null },
      });
      generation = retryable.generation;
    }
    const latest = (await store.getEntry(controlled.id))!;
    await assert.rejects(() => store.replaceEntry(generation, {
      ...latest,
      turn_control: { ...latest.turn_control!, action_id: "stale-control-79", action_sequence: 79 },
    }), /exactly match its durable sequence watermark/i,
    "a stale flat projection cannot move the current journal behind the lifetime watermark");
    const beforeReopen = new DatabaseSync(env.databasePath);
    assert.equal(Number((beforeReopen.prepare("SELECT last_sequence FROM turn_control_sequence_watermarks WHERE agent_id=?").get(entry.id) as { last_sequence: number }).last_sequence), 80);
    assert.equal(Number((beforeReopen.prepare("SELECT COUNT(*) AS count FROM turn_control_sequence_watermarks WHERE agent_id=?").get(entry.id) as { count: number }).count), 1);
    assert.equal(Number((beforeReopen.prepare("SELECT COUNT(*) AS count FROM reconciliation_action_tombstones").get() as { count: number }).count), 0);
    beforeReopen.close();
    await store.close();
    const reopened = new ManifestStore(env.databasePath);
    const reopenedEntry = (await reopened.getEntry(entry.id))!;
    assert.equal(reopenedEntry.last_turn_control_sequence, 80);
    assert.equal(reopenedEntry.turn_control?.action_sequence, 80);
    await reopened.close();
  } finally {
    await inbox.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("repeated Stop commits settle prepared effects and retain exactly bounded physical history", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T10:30:00.000Z");
  const controlled: DaemonManifestEntry = {
    ...entry,
    id: "bounded-stop-history",
    room_id: "bounded-stop-room",
    condition: "none",
    delivery_mode: "daemon_inbox",
    turn_control: undefined,
    last_turn_control_sequence: 0,
    provider_ref: {
      ...entry.provider_ref!,
      provider_connection: {
        kind: "codex_app_server",
        url: "http://127.0.0.1:4311",
        pid: 4311,
        processIdentity: "codex:4311",
      },
    },
  };
  let generation = 0;
  let firstInboxItemId = "";
  let currentInboxItemId = "";
  let predecessorEffectId = "";
  try {
    generation = (await store.write(0, [controlled])).generation;
    for (let sequence = 1; sequence <= 205; sequence += 1) {
      const sourceMessageId = `bounded-stop-message-${sequence}`;
      const providerTurnId = `bounded-stop-turn-${sequence}`;
      const item = await inbox.enqueueCorrection({
        agent_id: controlled.id,
        room_id: controlled.room_id,
        source_message_id: sourceMessageId,
        source_message: { text: `turn ${sequence}` },
        activation: { decision: "activate" },
      });
      if (sequence === 1) firstInboxItemId = item.inbox_item_id;
      currentInboxItemId = item.inbox_item_id;
      assert.equal((await inbox.claimHead(controlled.id))?.inbox_item_id, item.inbox_item_id);
      await inbox.checkpointTurnStarted(item.inbox_item_id, providerTurnId, TEST_PROVIDER_TURN_AUTHORITY);

      let effectId: string | null = null;
      if (sequence === 205) {
        const preparedEffect = await inbox.prepareEffect({
          agent_id: controlled.id,
          room_id: controlled.room_id,
          work_attempt_id: controlled.work_attempt_id!,
          execution_generation_id: controlled.provider_ref!.execution_generation_id,
          current_execution_generation_id: controlled.provider_ref!.execution_generation_id,
          provider_continuation_id: controlled.provider_ref!.provider_continuation_id,
          provider_turn_id: providerTurnId,
          mcp_request_id: "bounded-stop-predecessor-effect",
          tool_name: "send_message",
          request: { text: "must never execute" },
        });
        effectId = preparedEffect.effect.effect_id;
        predecessorEffectId = effectId;
      }

      const prepared = await store.prepareTurnControlState(generation, {
        agentId: controlled.id,
        roomId: controlled.room_id,
        expectedInboxItemId: item.inbox_item_id,
        expectedSourceMessageId: sourceMessageId,
        expectedProviderTurnId: providerTurnId,
        actionId: `bounded-stop-action-${sequence}`,
        actionSequence: sequence,
        workAttemptId: controlled.work_attempt_id!,
        executionGenerationId: controlled.provider_ref!.execution_generation_id,
        providerContinuationId: controlled.provider_ref!.provider_continuation_id,
        providerConnection: controlled.provider_ref!.provider_connection,
        deliveryMode: "daemon_inbox",
        hasCorrection: false,
        correctionText: null,
        correctionStrategy: null,
        capability: "native_interrupt",
        recordedAt: "2026-08-05T10:30:00.000Z",
      });
      const dispatching = await store.replaceEntry(prepared.generation, {
        ...prepared.entry,
        turn_control: {
          ...prepared.entry.turn_control!,
          status: "dispatching",
          stages: ["interrupting"],
        },
      });

      if (effectId) {
        // Reproduce the predecessor/crash shape that motivated the shared
        // invariant: a prepared effect survives behind an already-dispatched
        // control journal. Completion must settle it in the same transaction.
        const predecessor = new DatabaseSync(env.databasePath);
        predecessor.prepare("UPDATE supervised_agent_effects SET state='prepared',error=NULL WHERE effect_id=?")
          .run(effectId);
        predecessor.close();
      }

      const committed = await store.commitTurnControlState(dispatching.generation, {
        agentId: controlled.id,
        roomId: controlled.room_id,
        actionId: `bounded-stop-action-${sequence}`,
        workAttemptId: controlled.work_attempt_id!,
        executionGenerationId: controlled.provider_ref!.execution_generation_id,
        mode: "native_applied",
        settleOriginal: true,
        activateCorrection: false,
        observedAt: "2026-08-05T10:30:01.000Z",
      }, (current) => ({
        ...current,
        turn_control: {
          ...current.turn_control!,
          status: "completed",
          interrupted: true,
          resumed: false,
          state: "stopped",
          stages: ["interrupting", "applied"],
          error: null,
          updated_at: "2026-08-05T10:30:01.000Z",
        },
      }));
      generation = committed.generation;
    }

    const inspection = new DatabaseSync(env.databasePath);
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_inbox
      WHERE agent_id=? AND state='cancelled_by_user'`).get(controlled.id) as { count: number }).count), 200,
    "Stop completion itself enforces the exact terminal-receipt budget at quiescence");
    assert.ok(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_inbox_events e
      JOIN supervised_agent_inbox i USING (inbox_item_id) WHERE i.agent_id=?`).get(controlled.id) as { count: number }).count) <= 800,
    "cascading event history remains bounded with its 200 retained owners");
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_provider_turn_bindings
      WHERE agent_id=?`).get(controlled.id) as { count: number }).count), 200);
    assert.equal(inspection.prepare("SELECT 1 FROM supervised_agent_inbox WHERE inbox_item_id=?").get(firstInboxItemId), undefined,
      "the oldest unpinned Stop receipt is pruned");
    assert.ok(inspection.prepare("SELECT 1 FROM supervised_agent_inbox WHERE inbox_item_id=?").get(currentInboxItemId),
      "the current completed control keeps its exact target inside the fixed budget");
    assert.equal((inspection.prepare("SELECT state FROM supervised_agent_effects WHERE effect_id=?").get(predecessorEffectId) as { state: string }).state, "failed",
      "commit-time terminalization settles predecessor prepared effects atomically");
    assert.deepEqual(inspection.prepare("PRAGMA foreign_key_check").all(), []);
    inspection.close();

    await inbox.close();
    await store.close();
    const reopened = new ManifestStore(env.databasePath);
    const reopenedEntry = await reopened.getEntry(controlled.id);
    assert.equal(reopenedEntry?.turn_control?.inbox_item_id, currentInboxItemId);
    assert.equal(reopenedEntry?.turn_control?.action_sequence, 205);
    await reopened.close();
  } finally {
    await inbox.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("current-v16 validation rejects a completed control cross-wired to another agent's exact turn", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T10:45:00.000Z");
  const controlled: DaemonManifestEntry = {
    ...entry,
    id: "completed-target-corruption",
    room_id: "completed-target-room",
    condition: "none",
    delivery_mode: "daemon_inbox",
    turn_control: undefined,
    last_turn_control_sequence: 0,
    provider_ref: {
      ...entry.provider_ref!,
      provider_connection: {
        kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "codex:4311",
      },
    },
  };
  const peer: DaemonManifestEntry = {
    ...controlled,
    id: "completed-target-peer",
    display_name: "CompletedTargetPeer",
  };
  try {
    let generation = (await store.write(0, [controlled, peer])).generation;
    const item = await inbox.enqueueCorrection({
      agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "completed-target-message",
      source_message: { text: "stop me" }, activation: { decision: "activate" },
    });
    await inbox.claimHead(controlled.id);
    await inbox.checkpointTurnStarted(item.inbox_item_id, "completed-target-turn", TEST_PROVIDER_TURN_AUTHORITY);
    const prepared = await store.prepareTurnControlState(generation, {
      agentId: controlled.id, roomId: controlled.room_id,
      expectedInboxItemId: item.inbox_item_id, expectedSourceMessageId: item.source_message_id,
      expectedProviderTurnId: "completed-target-turn", actionId: "completed-target-control", actionSequence: 1,
      workAttemptId: controlled.work_attempt_id!, executionGenerationId: controlled.provider_ref!.execution_generation_id,
      providerContinuationId: controlled.provider_ref!.provider_continuation_id,
      providerConnection: controlled.provider_ref!.provider_connection, deliveryMode: "daemon_inbox",
      hasCorrection: false, correctionText: null, correctionStrategy: null,
      capability: "native_interrupt", recordedAt: "2026-08-05T10:45:00.000Z",
    });
    const dispatching = await store.replaceEntry(prepared.generation, {
      ...prepared.entry,
      turn_control: { ...prepared.entry.turn_control!, status: "dispatching", stages: ["interrupting"] },
    });
    generation = (await store.commitTurnControlState(dispatching.generation, {
      agentId: controlled.id, roomId: controlled.room_id, actionId: "completed-target-control",
      workAttemptId: controlled.work_attempt_id!, executionGenerationId: controlled.provider_ref!.execution_generation_id,
      mode: "native_applied", settleOriginal: true, activateCorrection: false,
      observedAt: "2026-08-05T10:45:01.000Z",
    }, (current) => ({
      ...current,
      turn_control: {
        ...current.turn_control!, status: "completed", interrupted: true, resumed: false,
        state: "stopped", stages: ["interrupting", "applied"], error: null,
      },
    }))).generation;
    assert.ok(generation > 0);
    const peerItem = await inbox.enqueueCorrection({
      agent_id: peer.id, room_id: peer.room_id, source_message_id: "completed-target-message",
      source_message: { text: "same exact coordinates, different owner" }, activation: { decision: "activate" },
    });
    await inbox.claimHead(peer.id);
    await inbox.checkpointTurnStarted(peerItem.inbox_item_id, "completed-target-turn", TEST_PROVIDER_TURN_AUTHORITY);
    await inbox.close();
    await store.close();

    const corrupted = new DatabaseSync(env.databasePath);
    corrupted.prepare("UPDATE turn_control_journals SET inbox_item_id=? WHERE agent_id=?")
      .run(peerItem.inbox_item_id, controlled.id);
    assert.throws(() => new DaemonStateSchema().createSchema(corrupted), /turn-control causal target.*exact inbox binding/i,
      "matching room/turn/work coordinates never substitute for exact agent ownership");
    const journal = corrupted.prepare(`SELECT target_source_message_id,inbox_item_id,provider_turn_id
      FROM turn_control_journals WHERE agent_id=?`).get(controlled.id) as Record<string, unknown>;
    assert.equal(journal.target_source_message_id, "completed-target-message");
    assert.equal(journal.inbox_item_id, peerItem.inbox_item_id,
      "validation fails closed without disguising the cross-agent corruption as retention");
    assert.equal(journal.provider_turn_id, "completed-target-turn");
    corrupted.prepare("UPDATE turn_control_journals SET inbox_item_id=? WHERE agent_id=?")
      .run("missing-target-without-retention-evidence", controlled.id);
    assert.throws(() => new DaemonStateSchema().createSchema(corrupted), /turn-control causal target.*exact inbox binding/i,
      "a missing target without exact pruning evidence remains corruption and fails closed");
    const stillCorrupt = corrupted.prepare(`SELECT target_room_id,target_source_message_id,inbox_item_id,provider_turn_id
      FROM turn_control_journals WHERE agent_id=?`).get(controlled.id) as Record<string, unknown>;
    assert.equal(stillCorrupt.target_room_id, controlled.room_id);
    assert.equal(stillCorrupt.target_source_message_id, "completed-target-message");
    assert.equal(stillCorrupt.inbox_item_id, "missing-target-without-retention-evidence",
      "startup never launders an unexplained missing target into audit-only history");
    assert.equal(stillCorrupt.provider_turn_id, "completed-target-turn");
    corrupted.close();
  } finally {
    await inbox.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("v16 validation rejects unsafe or forward-skewed turn-control watermarks", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write(0, [entry]);
    await store.close();
    const corrupted = new DatabaseSync(env.databasePath);
    corrupted.prepare("UPDATE turn_control_sequence_watermarks SET last_sequence=? WHERE agent_id=?").run(
      9_007_199_254_740_992,
      entry.id,
    );
    corrupted.close();
    const reopened = new ManifestStore(env.databasePath);
    await assert.rejects(() => reopened.load(), /safe integer range/i);
    await reopened.close();
    const skewed = new DatabaseSync(env.databasePath);
    skewed.prepare("UPDATE turn_control_sequence_watermarks SET last_sequence=2 WHERE agent_id=?").run(entry.id);
    skewed.close();
    const skewedReopen = new ManifestStore(env.databasePath);
    await assert.rejects(() => skewedReopen.load(), /exactly match its sequence watermark/i);
    await skewedReopen.close();
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("v15 migration discards unbounded tombstones and establishes constant-size sequence authority", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const legacyIds = Array.from({ length: 80 }, (_, index) => `legacy-control-${index}`);
  try {
    await store.write(0, [entry]);
    await store.close();
    const legacy = new DatabaseSync(env.databasePath);
    legacy.exec("DROP TABLE turn_control_sequence_watermarks; ALTER TABLE turn_control_journals DROP COLUMN action_sequence; DELETE FROM reconciliation_action_tombstones");
    const insert = legacy.prepare("INSERT INTO reconciliation_action_tombstones(agent_id,action_id) VALUES(?,?)");
    legacyIds.forEach((actionId) => insert.run(entry.id, actionId));
    legacy.exec("UPDATE manifest_metadata SET schema_version=15 WHERE singleton=1; PRAGMA user_version=15");
    legacy.close();

    const migrated = new ManifestStore(env.databasePath);
    const migratedEntry = await migrated.getEntry(entry.id);
    assert.equal(migratedEntry?.last_turn_control_sequence, 1);
    assert.equal(migratedEntry?.turn_control?.action_sequence, 1);
    await migrated.close();
    const inspection = new DatabaseSync(env.databasePath);
    assert.equal(Number((inspection.prepare("SELECT COUNT(*) AS count FROM reconciliation_action_tombstones").get() as { count: number }).count), 0);
    assert.equal(Number((inspection.prepare("SELECT last_sequence FROM turn_control_sequence_watermarks WHERE agent_id=?").get(entry.id) as { last_sequence: number }).last_sequence), 1);
    assert.equal(Number((inspection.prepare("SELECT action_sequence FROM turn_control_journals WHERE agent_id=?").get(entry.id) as { action_sequence: number }).action_sequence), 1);
    inspection.close();
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("v15 migration terminalizes unprovable turns and effects without stranding recoverable room moves", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const completedAgent = {
    ...entry, id: "legacy-completed-control", room_id: "legacy-completed-room",
    condition: "none" as const, delivery_mode: "daemon_inbox" as const, turn_control: undefined,
  };
  const activeNotAppliedAgent = {
    ...entry, id: "legacy-active-not-applied", room_id: "legacy-active-not-applied-room",
    condition: "none" as const, delivery_mode: "daemon_inbox" as const, turn_control: undefined,
  };
  const activeAppliedAgent = {
    ...entry, id: "legacy-active-applied", room_id: "legacy-active-applied-room",
    condition: "none" as const, delivery_mode: "daemon_inbox" as const, turn_control: undefined,
  };
  try {
    await store.write(0, [completedAgent, activeNotAppliedAgent, activeAppliedAgent]);
    await store.close();
    const legacy = new DatabaseSync(env.databasePath);
    const now = "2026-08-05T16:00:00.000Z";
    const insertInbox = legacy.prepare(`INSERT INTO supervised_agent_inbox
      (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,
       fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,
       outcome,last_error,failure_code,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
      VALUES (?,?,?,?,?,?,1,?,1,?,?,?,?,NULL,NULL,NULL,NULL,?,?,?)`);
    const inbox = (id: string, agentId: string, roomId: string, state: string, outcome: string | null, acknowledgedAt: string | null = null) => {
      insertInbox.run(id, agentId, roomId, `source-${id}`, "{}", "{}", state,
        `action-${id}`, `reply-${id}`, `turn-${id}`, outcome, now, now, acknowledgedAt);
    };
    inbox("completed", completedAgent.id, completedAgent.room_id, "acknowledged_no_reply", JSON.stringify({ kind: "no_reply" }), now);
    inbox("active-not-applied", activeNotAppliedAgent.id, activeNotAppliedAgent.room_id, "dispatching", null);
    inbox("active-applied", activeAppliedAgent.id, activeAppliedAgent.room_id, "dispatching", null);
    inbox("valid-reply", "valid-reply-agent", "valid-reply-room", "publishing", JSON.stringify({ kind: "reply", text: "durable" }));
    inbox("valid-no-reply", "valid-no-reply-agent", "valid-no-reply-room", "awaiting_result", JSON.stringify({ kind: "no_reply" }));
    inbox("empty-reply", "empty-reply-agent", "empty-reply-room", "awaiting_result", JSON.stringify({ kind: "reply", text: "" }));
    inbox("missing-kind", "missing-kind-agent", "missing-kind-room", "awaiting_result", "{}");
    inbox("invalid-json", "invalid-json-agent", "invalid-json-room", "awaiting_result", "{not-json");

    const updateControl = legacy.prepare(`UPDATE turn_control_journals SET
      turn_control_present=1,action_id=?,action_sequence=1,turn_work_attempt_id='attempt_1',
      turn_execution_generation_id='run_1',target_room_id=?,target_source_message_id=?,
      target_provider_continuation_id='thread_1',inbox_item_id=?,provider_turn_id=?,has_correction=0,
      correction_text=NULL,correction_strategy=NULL,operator_resolution=NULL,status=?,
      capability='native_interrupt',interrupted=?,resumed=?,turn_state='idle',error=NULL,
      recorded_at=?,updated_at=? WHERE agent_id=?`);
    updateControl.run("legacy-completed-action", completedAgent.room_id, "source-completed", "completed", "turn-completed",
      "completed", 1, 0, now, now, completedAgent.id);
    updateControl.run("legacy-not-applied-action", activeNotAppliedAgent.room_id, "source-active-not-applied", "active-not-applied", "turn-active-not-applied",
      "prepared", null, null, now, now, activeNotAppliedAgent.id);
    updateControl.run("legacy-applied-action", activeAppliedAgent.room_id, "source-active-applied", "active-applied", "turn-active-applied",
      "prepared", null, null, now, now, activeAppliedAgent.id);
    legacy.prepare("INSERT OR REPLACE INTO turn_control_sequence_watermarks(agent_id,last_sequence) VALUES(?,1)").run(completedAgent.id);
    legacy.prepare("INSERT OR REPLACE INTO turn_control_sequence_watermarks(agent_id,last_sequence) VALUES(?,1)").run(activeNotAppliedAgent.id);
    legacy.prepare("INSERT OR REPLACE INTO turn_control_sequence_watermarks(agent_id,last_sequence) VALUES(?,1)").run(activeAppliedAgent.id);

    const insertEffect = legacy.prepare(`INSERT INTO supervised_agent_effects
      (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
       tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,?,NULL,?,?)`);
    const effect = (id: string, agentId: string, tool: string, state: string) => insertEffect.run(
      id, agentId, `room-${agentId}`, "run-legacy", `turn-${agentId}`, `request-${id}`,
      tool, "{}", state, tool === "join_room" ? JSON.stringify({ phase: "prepared" }) : null, now, now,
    );
    effect("ordinary-prepared", "ordinary-prepared-agent", "claim_task", "prepared");
    effect("ordinary-executing", "ordinary-executing-agent", "send_message", "executing");
    effect("ordinary-completed", "ordinary-completed-agent", "claim_task", "completed");
    effect("orphan-join", "orphan-join-agent", "join_room", "prepared");
    effect("pre-move", "pre-move-agent", "join_room", "prepared");
    effect("post-join", "post-join-agent", "join_room", "prepared");
    effect("active-move", "active-move-agent", "join_room", "prepared");
    effect("failed-move", "failed-move-agent", "join_room", "prepared");

    const insertMove = legacy.prepare(`INSERT INTO agent_room_moves
      (operation_id,request_id,agent_id,source_room_id,destination_room_id,daemon_generation,
       work_attempt_id,execution_generation_id,agent_session_id,activating_inbox_item_id,
       provider_turn_id,effect_id,phase,remote_room_id,destination_cursor,error,created_at,updated_at,
       source_cursor_present,source_cursor,source_credentials_revoked)
      VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,0)`);
    const move = (id: string, agentId: string, phase: string, effectId: string | null, activating: string | null, error: string | null = null) => {
      insertMove.run(id, `request-${id}`, agentId, `source-${agentId}`, `destination-${agentId}`,
        effectId ? "attempt-legacy" : null, effectId ? "run-legacy" : null, effectId ? `session-${agentId}` : null,
        activating, effectId ? `turn-${agentId}` : null, effectId, phase,
        phase === "joining_destination" || phase === "active" ? `canonical-${agentId}` : null,
        phase === "active" ? "77" : null, error, now, now);
    };
    move("pre-move", "pre-move-agent", "waiting_for_current_turn", "pre-move", "active");
    move("post-join", "post-join-agent", "joining_destination", "post-join", "active");
    move("active-move", "active-move-agent", "active", "active-move", "active");
    move("failed-move", "failed-move-agent", "failed", "failed-move", "active", "legacy move failed");
    move("inspector-move", "inspector-move-agent", "prepared", null, null);

    legacy.exec(`DROP TABLE supervised_agent_provider_turn_bindings;
      DROP TABLE turn_control_sequence_watermarks;
      ALTER TABLE turn_control_journals DROP COLUMN action_sequence;
      ALTER TABLE turn_control_journals DROP COLUMN target_room_id;
      ALTER TABLE turn_control_journals DROP COLUMN target_source_message_id;
      ALTER TABLE turn_control_journals DROP COLUMN target_provider_continuation_id;
      UPDATE manifest_metadata SET schema_version=15 WHERE singleton=1;
      PRAGMA user_version=15;`);
    legacy.close();

    const migrated = new ManifestStore(env.databasePath);
    const manifest = await migrated.load();
    const completedControl = manifest.entries.find((candidate) => candidate.id === completedAgent.id)?.turn_control;
    const activeNotAppliedControl = manifest.entries.find((candidate) => candidate.id === activeNotAppliedAgent.id)?.turn_control;
    const activeAppliedControl = manifest.entries.find((candidate) => candidate.id === activeAppliedAgent.id)?.turn_control;
    assert.equal(completedControl?.status, "completed");
    assert.equal(completedControl?.inbox_item_id, "completed");
    assert.equal(completedControl?.provider_turn_id, "turn-completed");
    assert.equal(completedControl?.target_room_id, undefined, "terminal legacy journals retain identity without inventing authority");
    assert.equal(activeNotAppliedControl?.status, "uncertain");
    assert.match(activeNotAppliedControl?.error ?? "", /predates exact causal target fencing/i);
    assert.equal(activeAppliedControl?.status, "uncertain");

    const resolve = async (
      generation: number,
      agent: DaemonManifestEntry,
      actionId: string,
      mode: "operator_applied" | "operator_not_applied",
    ) => migrated.commitTurnControlState(generation, {
      agentId: agent.id,
      roomId: agent.room_id,
      actionId,
      workAttemptId: "attempt_1",
      executionGenerationId: "run_1",
      mode,
      settleOriginal: mode === "operator_applied",
      activateCorrection: false,
      observedAt: "2026-08-05T16:01:00.000Z",
    }, (current, outcome) => ({
      ...current,
      turn_control: {
        ...current.turn_control!,
        operator_resolution: mode === "operator_applied" ? "applied" : "not_applied",
        status: "completed",
        interrupted: mode === "operator_applied",
        resumed: false,
        state: "idle",
        stages: mode === "operator_applied" ? ["already_applied"] : [],
        error: null,
        updated_at: "2026-08-05T16:01:00.000Z",
      },
    }));
    const notApplied = await resolve(manifest.generation, activeNotAppliedAgent, "legacy-not-applied-action", "operator_not_applied");
    assert.equal(notApplied.original, "publication_won", "operator resolution leaves the already retired upgrade record terminal");
    assert.equal(notApplied.entry.turn_control?.operator_resolution, "not_applied");
    const applied = await resolve(notApplied.generation, activeAppliedAgent, "legacy-applied-action", "operator_applied");
    assert.equal(applied.original, "publication_won");
    assert.equal(applied.entry.turn_control?.operator_resolution, "applied");
    await migrated.close();

    const inspection = new DatabaseSync(env.databasePath);
    const inboxState = (id: string) => (inspection.prepare("SELECT state FROM supervised_agent_inbox WHERE inbox_item_id=?").get(id) as { state: string }).state;
    assert.equal(inboxState("active-not-applied"), "acknowledged_no_reply");
    assert.equal(inboxState("active-applied"), "acknowledged_no_reply");
    assert.equal(inboxState("valid-reply"), "publishing");
    assert.equal(inboxState("valid-no-reply"), "awaiting_result");
    assert.equal(inboxState("empty-reply"), "acknowledged_no_reply");
    assert.equal(inboxState("missing-kind"), "acknowledged_no_reply");
    assert.equal(inboxState("invalid-json"), "acknowledged_no_reply");
    const effectState = (id: string) => inspection.prepare("SELECT state,result_json,error FROM supervised_agent_effects WHERE effect_id=?").get(id) as { state: string; result_json: string | null; error: string | null };
    assert.equal(effectState("ordinary-prepared").state, "failed");
    assert.equal(effectState("ordinary-executing").state, "failed");
    assert.equal(effectState("ordinary-completed").state, "completed");
    assert.equal(effectState("orphan-join").state, "failed");
    assert.equal(effectState("pre-move").state, "failed");
    assert.equal(effectState("post-join").state, "prepared", "post-join recovery keeps its existing rollback state machine");
    assert.equal(effectState("active-move").state, "completed");
    assert.equal(JSON.parse(effectState("active-move").result_json ?? "{}").phase, "active");
    assert.equal(effectState("failed-move").state, "failed");
    const movePhase = (id: string) => (inspection.prepare("SELECT phase FROM agent_room_moves WHERE operation_id=?").get(id) as { phase: string }).phase;
    assert.equal(movePhase("pre-move"), "failed");
    assert.equal(movePhase("post-join"), "joining_destination");
    assert.equal(movePhase("inspector-move"), "prepared", "Inspector moves have no provider-turn binding to migrate");
    inspection.close();
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("operator not-applied never resurrects an ordinary user-cancelled exact turn", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T16:30:00.000Z");
  const controlled: DaemonManifestEntry = {
    ...entry,
    id: "ordinary-user-cancelled",
    room_id: "ordinary-user-cancelled-room",
    condition: "none",
    delivery_mode: "daemon_inbox",
    turn_control: undefined,
  };
  try {
    await store.write(0, [controlled]);
    const row = await inbox.enqueueCorrection({
      agent_id: controlled.id,
      room_id: controlled.room_id,
      source_message_id: "ordinary-user-cancelled-source",
      source_message: { text: "work" },
      activation: { decision: "activate" },
    });
    await inbox.claimHead(controlled.id);
    await inbox.checkpointTurnStarted(row.inbox_item_id, "ordinary-user-cancelled-turn", TEST_PROVIDER_TURN_AUTHORITY);
    const journaled = await store.replaceEntry(1, {
      ...(await store.getEntry(controlled.id))!,
      turn_control: {
        action_id: "ordinary-user-cancelled-action",
        action_sequence: 1,
        work_attempt_id: "attempt_1",
        execution_generation_id: "run_1",
        target_room_id: controlled.room_id,
        target_source_message_id: row.source_message_id,
        target_provider_continuation_id: "thread_1",
        inbox_item_id: row.inbox_item_id,
        provider_turn_id: "ordinary-user-cancelled-turn",
        has_correction: false,
        correction_text: null,
        correction_strategy: null,
        status: "uncertain",
        capability: "native_interrupt",
        interrupted: null,
        resumed: null,
        state: null,
        stages: [],
        error: "native outcome is uncertain",
        recorded_at: "2026-08-05T16:30:00.000Z",
        updated_at: "2026-08-05T16:30:00.000Z",
      },
      last_turn_control_sequence: 1,
    });
    await inbox.cancelInterruptedTurn(row.inbox_item_id, "Stopped by the user.", {
      agent_id: controlled.id,
      room_id: controlled.room_id,
    });
    await assert.rejects(() => store.commitTurnControlState(journaled.generation, {
      agentId: controlled.id,
      roomId: controlled.room_id,
      actionId: "ordinary-user-cancelled-action",
      workAttemptId: "attempt_1",
      executionGenerationId: "run_1",
      mode: "operator_not_applied",
      settleOriginal: false,
      activateCorrection: false,
      observedAt: "2026-08-05T16:31:00.000Z",
    }, (current) => current), /cancelled turn cannot be recovered/i);
    assert.equal((await inbox.get(row.inbox_item_id))?.state, "cancelled_by_user");
    assert.equal((await store.getEntry(controlled.id))?.turn_control?.status, "uncertain");
  } finally {
    await inbox.close();
    await store.close();
    await env.cleanup();
  }
});

test("exact native failure wins every Stop resolution and admits only the new correction", async () => {
  for (const outcome of ["failed", "interrupted"] as const) {
    for (const mode of ["native_applied", "operator_applied", "operator_not_applied"] as const) {
      const env = await fixture();
      const store = new ManifestStore(env.databasePath);
      const now = "2026-08-05T10:00:00.000Z";
      const inbox = new SupervisedAgentInboxStore(env.databasePath, () => now);
      const actionId = `${outcome}-${mode}`;
      const controlled: DaemonManifestEntry = {
        ...entry, condition: "none", delivery_mode: "daemon_inbox", turn_control: undefined,
      };
      try {
        await store.write(0, [controlled]);
        const a = await inbox.enqueueCorrection({
          agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "A",
          source_message: { text: "A" }, activation: { decision: "activate" },
        });
        await inbox.enqueueCorrection({
          agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "B",
          source_message: { text: "B" }, activation: { decision: "activate" },
        });
        await inbox.claimHead(controlled.id);
        await inbox.checkpointTurnStarted(a.inbox_item_id, "turn-A", TEST_PROVIDER_TURN_AUTHORITY);
        const linked = await store.replaceEntry(1, {
          ...(await store.getEntry(controlled.id))!,
          turn_control: {
            action_id: actionId, action_sequence: 1, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
            target_room_id: controlled.room_id, target_source_message_id: "A", target_provider_continuation_id: "thread_1",
            inbox_item_id: a.inbox_item_id, provider_turn_id: "turn-A",
            has_correction: true, correction_text: "new instruction", correction_strategy: "stop_then_resend",
            status: mode === "native_applied" ? "dispatching" : "uncertain", capability: "native_interrupt",
            interrupted: null, resumed: null, state: null, stages: [], error: null, recorded_at: now, updated_at: now,
          },
          last_turn_control_sequence: 1,
        });
        await inbox.checkpointNormalizedTerminal({
          inbox_item_id: a.inbox_item_id, agent_id: controlled.id, execution_generation_id: "run_1",
          provider_turn_id: "turn-A", outcome, text: null, evidence: "stream",
          terminal_evidence: { outcome, text: null, evidence: "stream", turnId: "turn-A", providerContinuationId: "thread_1" },
        });
        if (outcome === "interrupted") {
          await inbox.transition(a.inbox_item_id, "acknowledged_failed");
        }
        const commitInput = {
          agentId: controlled.id, roomId: controlled.room_id, actionId, workAttemptId: "attempt_1",
          executionGenerationId: "run_1", mode, settleOriginal: mode !== "operator_not_applied",
          activateCorrection: true, observedAt: now,
        };
        const before = await inbox.get(a.inbox_item_id);
        if (mode === "native_applied" && outcome === "failed") {
          const corrupt = new DatabaseSync(env.databasePath);
          const validEvidence = (corrupt.prepare("SELECT terminal_evidence_json FROM supervised_agent_terminal_results WHERE inbox_item_id=?")
            .get(a.inbox_item_id) as { terminal_evidence_json: string }).terminal_evidence_json;
          try {
            corrupt.prepare("UPDATE supervised_agent_terminal_results SET terminal_evidence_json=? WHERE inbox_item_id=?")
              .run(JSON.stringify({ ...JSON.parse(validEvidence), providerContinuationId: "another-continuation" }), a.inbox_item_id);
            await assert.rejects(() => store.commitTurnControlState(linked.generation, commitInput, (current) => current),
              /does not match its exact native terminal/);
            assert.equal((await store.load()).generation, linked.generation);
            assert.deepEqual(await inbox.get(a.inbox_item_id), before);
          } finally {
            corrupt.prepare("UPDATE supervised_agent_terminal_results SET terminal_evidence_json=? WHERE inbox_item_id=?")
              .run(validEvidence, a.inbox_item_id);
            corrupt.close();
          }
        }
        await assert.rejects(() => store.commitTurnControlState(linked.generation, commitInput, () => {
          throw new Error("injected completion failure");
        }), /injected completion failure/);
        assert.deepEqual(await inbox.get(a.inbox_item_id), before, "terminalization and correction insertion roll back together");
        assert.equal((await store.load()).generation, linked.generation);
        assert.equal((await inbox.receipts(controlled.id)).length, 2);

        const committed = await store.commitTurnControlState(linked.generation, commitInput, (current, result) => {
          assert.equal(result.original, "terminal_won");
          return {
            ...current,
            turn_control: {
              ...current.turn_control!, status: "completed", interrupted: false, resumed: true, state: "idle",
              operator_resolution: mode === "operator_applied" ? "applied" : mode === "operator_not_applied" ? "not_applied" : null,
              stages: ["applied", "resumed"], updated_at: now,
            },
          };
        });
        assert.equal(committed.original, "terminal_won");
        assert.equal((await inbox.get(a.inbox_item_id))?.state, "acknowledged_failed");
        assert.equal(await inbox.nativeFailure(a.inbox_item_id), outcome);
        assert.equal((await inbox.get(a.inbox_item_id))?.attempt_count, before?.attempt_count);
        assert.deepEqual((await inbox.receipts(controlled.id)).map((item) => [item.source_message_id, item.state]), [
          ["A", "acknowledged_failed"], [`correction:${actionId}`, "pending"], ["B", "pending"],
        ]);
        const inspection = new DatabaseSync(env.databasePath);
        try {
          assert.equal(inspection.prepare("SELECT 1 FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND phase='user_cancelled'").get(a.inbox_item_id), undefined);
          assert.equal((inspection.prepare("SELECT COUNT(*) AS value FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND phase='turn_finished'")
            .get(a.inbox_item_id) as { value: number }).value, 1, "Stop preserves the single native terminal timeline event");
          assert.equal(inspection.prepare("SELECT 1 FROM supervised_agent_publications WHERE inbox_item_id=?").get(a.inbox_item_id), undefined);
          assert.deepEqual(inspection.prepare("PRAGMA foreign_key_check").all(), []);
        } finally { inspection.close(); }
        assert.equal((await inbox.claimHead(controlled.id))?.inbox_item_id, committed.correctionInboxItemId);
        await store.close();
        const reopened = new ManifestStore(env.databasePath);
        try {
          assert.equal((await reopened.load()).entries[0]?.turn_control?.interrupted, false,
            "completed control survives reopen without inventing a Stop effect");
        } finally { await reopened.close(); }
      } finally {
        await inbox.close();
        await store.close();
        await env.cleanup();
      }
    }
  }
});

test("turn-control commit atomically cancels A and inserts its correction before queued B", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T10:00:00.000Z");
  const actionId = "atomic-stop-resend";
  try {
    const controlled: DaemonManifestEntry = {
      ...entry,
      condition: "none",
      delivery_mode: "daemon_inbox",
      turn_control: {
        action_id: actionId,
        action_sequence: 1,
        work_attempt_id: "attempt_1",
        execution_generation_id: "run_1",
        inbox_item_id: null,
        provider_turn_id: null,
        has_correction: true,
        correction_text: "use the corrected plan",
        correction_strategy: "stop_then_resend",
        status: "prepared",
        capability: "native_interrupt",
        interrupted: null,
        resumed: null,
        state: null,
        stages: [],
        error: null,
        recorded_at: "2026-08-05T10:00:00.000Z",
        updated_at: "2026-08-05T10:00:00.000Z",
      },
    };
    await store.write(0, [{ ...controlled, turn_control: undefined }]);
    const a = await inbox.enqueueCorrection({
      agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "A",
      source_message: { text: "A" }, activation: { decision: "activate" },
    });
    await inbox.enqueueCorrection({
      agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "B",
      source_message: { text: "B" }, activation: { decision: "activate" },
    });
    assert.equal((await inbox.claimHead(controlled.id))?.inbox_item_id, a.inbox_item_id);
    await inbox.checkpointTurnStarted(a.inbox_item_id, "turn-A", TEST_PROVIDER_TURN_AUTHORITY);
    const before = await store.load();
    const linked = await store.replaceEntry(before.generation, {
      ...before.entries[0]!,
      turn_control: {
        ...controlled.turn_control!,
        inbox_item_id: a.inbox_item_id,
        provider_turn_id: "turn-A",
        status: "dispatching",
      },
    });
    const committed = await store.commitTurnControlState(linked.generation, {
      agentId: controlled.id,
      roomId: controlled.room_id,
      actionId,
      workAttemptId: "attempt_1",
      executionGenerationId: "run_1",
      mode: "native_applied",
      settleOriginal: true,
      activateCorrection: true,
      observedAt: "2026-08-05T10:00:01.000Z",
    }, (current, outcome) => {
      assert.equal(outcome.original, "cancelled");
      assert.ok(outcome.correctionInboxItemId);
      return {
        ...current,
        turn_control: {
          ...current.turn_control!,
          status: "completed",
          interrupted: true,
          resumed: true,
          state: "idle",
          stages: ["delivered", "interrupting", "applied", "resumed"],
          error: null,
          updated_at: "2026-08-05T10:00:01.000Z",
        },
      };
    });
    assert.equal(committed.original, "cancelled");
    assert.equal((await inbox.get(a.inbox_item_id))?.state, "cancelled_by_user");
    const ordered = await inbox.receipts(controlled.id);
    assert.deepEqual(ordered.map((item) => [item.source_message_id, item.fifo_sequence, item.state]), [
      ["A", 1, "cancelled_by_user"],
      [`correction:${actionId}`, 2, "pending"],
      ["B", 3, "pending"],
    ]);
    assert.equal(committed.entry.turn_control?.status, "completed");
    assert.equal(committed.entry.turn_control?.correction_text, "use the corrected plan");
  } finally {
    await inbox.close();
    await store.close();
    await env.cleanup();
  }
});

test("a linked retryable turn-control journal durably fences successor B after A finishes", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T10:15:00.000Z");
  try {
    const controlled: DaemonManifestEntry = {
      ...entry, condition: "none", delivery_mode: "daemon_inbox",
      turn_control: {
        action_id: "retryable-barrier", action_sequence: 1, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
        inbox_item_id: null, provider_turn_id: null, has_correction: false,
        status: "prepared", capability: "native_interrupt", interrupted: null, resumed: null,
        state: null, stages: [], error: null,
        recorded_at: "2026-08-05T10:15:00.000Z", updated_at: "2026-08-05T10:15:00.000Z",
      },
    };
    await store.write(0, [{ ...controlled, turn_control: undefined }]);
    const a = await inbox.enqueueCorrection({ agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "barrier-A", source_message: { text: "A" }, activation: { decision: "activate" } });
    const b = await inbox.enqueueCorrection({ agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "barrier-B", source_message: { text: "B" }, activation: { decision: "activate" } });
    await inbox.claimHead(controlled.id);
    await inbox.checkpointTurnStarted(a.inbox_item_id, "turn-barrier-A", TEST_PROVIDER_TURN_AUTHORITY);
    const linked = await store.replaceEntry(1, {
      ...(await store.getEntry(controlled.id))!,
      turn_control: {
        ...controlled.turn_control!,
        inbox_item_id: a.inbox_item_id,
        provider_turn_id: "turn-barrier-A",
        status: "retryable",
      },
    });
    await inbox.transition(a.inbox_item_id, "awaiting_result");
    await inbox.transition(a.inbox_item_id, "acknowledged_no_reply", { outcome: JSON.stringify({ kind: "no_reply", text: null, evidence: "transcript" }) });
    assert.equal(await inbox.claimHead(controlled.id), null, "accepted action fences B even after A becomes terminal");
    assert.equal((await inbox.get(b.inbox_item_id))?.state, "pending");

    const completed = await store.commitTurnControlState(linked.generation, {
      agentId: controlled.id, roomId: controlled.room_id, actionId: "retryable-barrier",
      workAttemptId: "attempt_1", executionGenerationId: "run_1", mode: "native_applied",
      settleOriginal: false, activateCorrection: false, observedAt: "2026-08-05T10:15:01.000Z",
    }, (current) => ({
      ...current,
      turn_control: {
        ...current.turn_control!, status: "completed", interrupted: false, resumed: false,
        state: "idle", stages: ["applied"], error: null, updated_at: "2026-08-05T10:15:01.000Z",
      },
    }));
    assert.equal(completed.entry.turn_control?.status, "completed");
    assert.equal((await inbox.claimHead(controlled.id))?.inbox_item_id, b.inbox_item_id);
  } finally {
    await inbox.close();
    await store.close();
    await env.cleanup();
  }
});

test("atomic completion repairs an untouched predecessor correction behind B without duplicating it", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T10:20:00.000Z");
  const actionId = "legacy-enqueue-crash";
  try {
    const controlled: DaemonManifestEntry = {
      ...entry, condition: "none", delivery_mode: "daemon_inbox",
      turn_control: {
        action_id: actionId, action_sequence: 1, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
        inbox_item_id: null, provider_turn_id: null, has_correction: true,
        correction_text: "preserve exact correction", correction_strategy: "stop_then_resend",
        status: "dispatching", capability: "native_interrupt", interrupted: null, resumed: null,
        state: null, stages: [], error: "predecessor crashed after enqueue",
        recorded_at: "2026-08-05T10:20:00.000Z", updated_at: "2026-08-05T10:20:00.000Z",
      },
    };
    await store.write(0, [{ ...controlled, turn_control: undefined }]);
    const a = await inbox.enqueueCorrection({ agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "legacy-A", source_message: { text: "A" }, activation: { decision: "activate" } });
    await inbox.enqueueCorrection({ agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "legacy-B", source_message: { text: "B" }, activation: { decision: "activate" } });
    const preexistingCorrection = await inbox.enqueueCorrection({
      agent_id: controlled.id, room_id: controlled.room_id, source_message_id: `correction:${actionId}`,
      source_message: { text: "preserve exact correction", sender: { kind: "supervisor_correction" } },
      activation: { decision: "activate", reason: "human_correction", addressed: true },
    });
    await inbox.claimHead(controlled.id);
    await inbox.checkpointTurnStarted(a.inbox_item_id, "turn-legacy-A", TEST_PROVIDER_TURN_AUTHORITY);
    const linked = await store.replaceEntry(1, {
      ...(await store.getEntry(controlled.id))!,
      turn_control: {
        ...controlled.turn_control!, inbox_item_id: a.inbox_item_id,
        provider_turn_id: "turn-legacy-A", status: "dispatching",
      },
    });
    const committed = await store.commitTurnControlState(linked.generation, {
      agentId: controlled.id, roomId: controlled.room_id, actionId,
      workAttemptId: "attempt_1", executionGenerationId: "run_1", mode: "operator_applied",
      settleOriginal: true, activateCorrection: true, observedAt: "2026-08-05T10:20:01.000Z",
    }, (current) => ({
      ...current,
      turn_control: {
        ...current.turn_control!, operator_resolution: "applied", status: "completed", interrupted: true, resumed: true,
        state: "idle", stages: ["already_applied"], error: null, updated_at: "2026-08-05T10:20:01.000Z",
      },
    }));
    assert.equal(committed.correctionInboxItemId, preexistingCorrection.inbox_item_id);
    assert.deepEqual((await inbox.receipts(controlled.id)).map((item) => [item.source_message_id, item.fifo_sequence]), [
      ["legacy-A", 1], [`correction:${actionId}`, 2], ["legacy-B", 3],
    ]);
  } finally {
    await inbox.close();
    await store.close();
    await env.cleanup();
  }
});

test("legacy admitted successor authority is preserved ahead of an accepted correction", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T10:25:00.000Z");
  const actionId = "legacy-admitted-successor";
  const controlled: DaemonManifestEntry = {
    ...entry, condition: "none", delivery_mode: "daemon_inbox", turn_control: {
      action_id: actionId, action_sequence: 1, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      inbox_item_id: null, provider_turn_id: null, has_correction: true,
      correction_text: "apply after already-admitted B", correction_strategy: "stop_then_resend",
      status: "uncertain", capability: "native_interrupt", interrupted: null, resumed: null,
      state: null, stages: [], error: "legacy admission race",
      recorded_at: "2026-08-05T10:25:00.000Z", updated_at: "2026-08-05T10:25:00.000Z",
    },
  };
  try {
    await store.write(0, [{ ...controlled, turn_control: undefined }]);
    const a = await inbox.enqueueCorrection({ agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "legacy-terminal-A", source_message: { text: "A" }, activation: { decision: "activate" } });
    const b = await inbox.enqueueCorrection({ agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "legacy-admitted-B", source_message: { text: "B" }, activation: { decision: "activate" } });
    await inbox.claimHead(controlled.id);
    await inbox.checkpointTurnStarted(a.inbox_item_id, "turn-legacy-terminal-A", TEST_PROVIDER_TURN_AUTHORITY);
    await inbox.transition(a.inbox_item_id, "awaiting_result", { outcome: JSON.stringify({ kind: "no_reply" }) });
    await inbox.transition(a.inbox_item_id, "acknowledged_no_reply");
    assert.equal((await inbox.claimHead(controlled.id))?.inbox_item_id, b.inbox_item_id, "legacy B acquired authority before the journal barrier existed");
    const journaled = await store.replaceEntry(1, {
      ...(await store.getEntry(controlled.id))!,
      turn_control: { ...controlled.turn_control!, inbox_item_id: a.inbox_item_id, provider_turn_id: "turn-legacy-terminal-A" },
    });
    const committed = await store.commitTurnControlState(journaled.generation, {
      agentId: controlled.id, roomId: controlled.room_id, actionId,
      workAttemptId: "attempt_1", executionGenerationId: "run_1", mode: "operator_applied",
      settleOriginal: true, activateCorrection: true, observedAt: "2026-08-05T10:25:01.000Z",
    }, (current) => ({
      ...current,
      turn_control: {
        ...current.turn_control!, operator_resolution: "applied", status: "completed",
        interrupted: false, resumed: true, state: "working", stages: ["already_applied"],
        error: null, updated_at: "2026-08-05T10:25:01.000Z",
      },
    }));
    assert.equal(committed.entry.turn_control?.status, "completed");
    assert.deepEqual((await inbox.receipts(controlled.id)).map((item) => [item.source_message_id, item.fifo_sequence, item.state]), [
      ["legacy-terminal-A", 1, "acknowledged_no_reply"],
      ["legacy-admitted-B", 2, "dispatching"],
      [`correction:${actionId}`, 3, "pending"],
    ]);
  } finally {
    await inbox.close();
    await store.close();
    await env.cleanup();
  }
});

test("turn-control transaction rolls back cancellation, FIFO shift, correction, journal, and generation together", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T10:30:00.000Z");
  const actionId = "atomic-rollback";
  try {
    const controlled: DaemonManifestEntry = {
      ...entry, condition: "none", delivery_mode: "daemon_inbox",
      turn_control: {
        action_id: actionId, action_sequence: 1, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
        inbox_item_id: null, provider_turn_id: null, has_correction: true,
        correction_text: "must roll back", correction_strategy: "stop_then_resend",
        status: "prepared", capability: "native_interrupt", interrupted: null, resumed: null,
        state: null, stages: [], error: null,
        recorded_at: "2026-08-05T10:30:00.000Z", updated_at: "2026-08-05T10:30:00.000Z",
      },
    };
    await store.write(0, [{ ...controlled, turn_control: undefined }]);
    const a = await inbox.enqueueCorrection({ agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "rollback-A", source_message: { text: "A" }, activation: { decision: "activate" } });
    await inbox.enqueueCorrection({ agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "rollback-B", source_message: { text: "B" }, activation: { decision: "activate" } });
    await inbox.claimHead(controlled.id);
    await inbox.checkpointTurnStarted(a.inbox_item_id, "turn-rollback-A", TEST_PROVIDER_TURN_AUTHORITY);
    const linked = await store.replaceEntry(1, {
      ...(await store.getEntry(controlled.id))!,
      turn_control: {
        ...controlled.turn_control!,
        inbox_item_id: a.inbox_item_id,
        provider_turn_id: "turn-rollback-A",
        status: "dispatching",
      },
    });
    await assert.rejects(() => store.commitTurnControlState(linked.generation, {
      agentId: controlled.id, roomId: controlled.room_id, actionId, workAttemptId: "attempt_1", executionGenerationId: "run_1",
      mode: "native_applied", settleOriginal: true, activateCorrection: true, observedAt: "2026-08-05T10:30:01.000Z",
    }, () => { throw new Error("late projection failure"); }), /late projection failure/);
    assert.equal((await store.load()).generation, linked.generation);
    assert.equal((await store.getEntry(controlled.id))?.turn_control?.status, "dispatching");
    assert.deepEqual((await inbox.receipts(controlled.id)).map((item) => [item.source_message_id, item.fifo_sequence, item.state]), [
      ["rollback-A", 1, "dispatching"],
      ["rollback-B", 2, "pending"],
    ]);
    assert.equal((await inbox.receipts(controlled.id)).some((item) => item.source_message_id === `correction:${actionId}`), false);
    const inspection = new DatabaseSync(env.databasePath);
    assert.equal(Number((inspection.prepare("SELECT COUNT(*) AS count FROM reconciliation_action_tombstones").get() as { count: number }).count), 0,
      "a rolled-back control completion cannot mint unbounded replay state");
    inspection.close();
  } finally {
    await inbox.close();
    await store.close();
    await env.cleanup();
  }
});

test("terminal runtime recovery never guesses an unlinked legacy journal's FIFO row", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T10:40:00.000Z");
  const actionId = "runtime-recovers-unlinked-A";
  const controlled: DaemonManifestEntry = {
    ...entry, condition: "none", delivery_mode: "daemon_inbox", turn_control: {
      action_id: actionId, action_sequence: 1, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      inbox_item_id: null, provider_turn_id: null, has_correction: true,
      correction_text: "continue on the successor runtime", correction_strategy: "stop_then_resend",
      status: "retryable", capability: "restart_resume", interrupted: null, resumed: null,
      state: null, stages: [], error: "legacy journal was not linked",
      recorded_at: "2026-08-05T10:40:00.000Z", updated_at: "2026-08-05T10:40:00.000Z",
    },
  };
  try {
    await store.write(0, [{ ...controlled, turn_control: undefined }]);
    const a = await inbox.enqueueCorrection({ agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "runtime-A", source_message: { text: "A" }, activation: { decision: "activate" } });
    await inbox.enqueueCorrection({ agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "runtime-B", source_message: { text: "B" }, activation: { decision: "activate" } });
    await inbox.claimHead(controlled.id);
    await inbox.checkpointTurnStarted(a.inbox_item_id, "turn-runtime-A", TEST_PROVIDER_TURN_AUTHORITY);
    await inbox.transition(a.inbox_item_id, "awaiting_result", { outcome: JSON.stringify({ kind: "no_reply" }) });
    await inbox.transition(a.inbox_item_id, "acknowledged_no_reply");
    const b = (await inbox.receipts(controlled.id)).find((item) => item.source_message_id === "runtime-B")!;
    assert.equal((await inbox.claimHead(controlled.id))?.inbox_item_id, b.inbox_item_id, "successor B acquired authority before the legacy journal was recovered");
    seedTerminalExecution(env.databasePath, "attempt_1", "run_1");
    const journaled = await store.replaceEntry(1, controlled);
    const committed = await store.commitTurnControlState(journaled.generation, {
      agentId: controlled.id, roomId: controlled.room_id, actionId,
      workAttemptId: "attempt_1", executionGenerationId: "run_1", mode: "runtime_recovered",
      settleOriginal: true, activateCorrection: true, observedAt: "2026-08-05T10:40:01.000Z",
    }, (current, outcome) => ({
      ...current,
      turn_control: {
        ...current.turn_control!, inbox_item_id: outcome.inboxItemId, provider_turn_id: outcome.providerTurnId,
        status: "completed", interrupted: true, resumed: true, state: "idle",
        stages: ["delivered", "applied", "resumed"], error: null, updated_at: "2026-08-05T10:40:01.000Z",
      },
    }));
    assert.equal(committed.entry.turn_control?.inbox_item_id ?? null, null, "position is not accepted as evidence that current head B is old A");
    assert.equal(committed.entry.turn_control?.provider_turn_id ?? null, null);
    assert.deepEqual((await inbox.receipts(controlled.id)).map((item) => [item.source_message_id, item.fifo_sequence, item.state]), [
      ["runtime-A", 1, "acknowledged_no_reply"],
      ["runtime-B", 2, "dispatching"],
      [`correction:${actionId}`, 3, "pending"],
    ]);
  } finally {
    await inbox.close();
    await store.close();
    await env.cleanup();
  }
});

test("operator not-applied preserves blocked A and queues its accepted correction behind it", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T10:50:00.000Z");
  const actionId = "blocked-not-applied";
  const controlled: DaemonManifestEntry = {
    ...entry, condition: "none", delivery_mode: "daemon_inbox", turn_control: undefined,
  };
  try {
    await store.write(0, [controlled]);
    const a = await inbox.enqueueCorrection({ agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "blocked-A", source_message: { text: "A" }, activation: { decision: "activate" } });
    await inbox.enqueueCorrection({ agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "blocked-B", source_message: { text: "B" }, activation: { decision: "activate" } });
    await inbox.claimHead(controlled.id);
    await inbox.checkpointTurnStarted(a.inbox_item_id, "turn-blocked-A", TEST_PROVIDER_TURN_AUTHORITY);
    await inbox.transition(a.inbox_item_id, "blocked", { last_error: "manual recovery required" });
    const journaled = await store.replaceEntry(1, {
      ...(await store.getEntry(controlled.id))!,
      turn_control: {
        action_id: actionId, action_sequence: 1, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
        inbox_item_id: a.inbox_item_id, provider_turn_id: "turn-blocked-A",
        has_correction: true, correction_text: "continue after blocked A", correction_strategy: "stop_then_resend",
        operator_resolution: null, status: "uncertain", capability: "native_interrupt",
        interrupted: null, resumed: null, state: null, stages: [], error: "native outcome unknown",
        recorded_at: "2026-08-05T10:50:00.000Z", updated_at: "2026-08-05T10:50:00.000Z",
      },
    });
    const committed = await store.commitTurnControlState(journaled.generation, {
      agentId: controlled.id, roomId: controlled.room_id, actionId,
      workAttemptId: "attempt_1", executionGenerationId: "run_1", mode: "operator_not_applied",
      settleOriginal: false, activateCorrection: true, observedAt: "2026-08-05T10:50:01.000Z",
    }, (current) => ({
      ...current,
      turn_control: {
        ...current.turn_control!, operator_resolution: "not_applied", status: "completed",
        interrupted: false, resumed: true, state: "idle", stages: [], error: null,
        updated_at: "2026-08-05T10:50:01.000Z",
      },
    }));
    assert.equal(committed.original, "resumed");
    assert.deepEqual((await inbox.receipts(controlled.id)).map((item) => [item.source_message_id, item.fifo_sequence, item.state]), [
      ["blocked-A", 1, "blocked"],
      [`correction:${actionId}`, 2, "pending"],
      ["blocked-B", 3, "pending"],
    ]);
  } finally {
    await inbox.close();
    await store.close();
    await env.cleanup();
  }
});

test("idle stop-then-resend appends after terminal history instead of renumbering causality", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T11:00:00.000Z");
  try {
    const controlled: DaemonManifestEntry = {
      ...entry,
      condition: "none",
      delivery_mode: "daemon_inbox",
      turn_control: {
        action_id: "idle-correction",
        action_sequence: 1,
        work_attempt_id: "attempt_1",
        execution_generation_id: "run_1",
        inbox_item_id: null,
        provider_turn_id: null,
        has_correction: true,
        correction_text: "next instruction",
        correction_strategy: "stop_then_resend",
        status: "prepared",
        capability: "native_interrupt",
        interrupted: null,
        resumed: null,
        state: null,
        stages: [],
        error: null,
        recorded_at: "2026-08-05T11:00:00.000Z",
        updated_at: "2026-08-05T11:00:00.000Z",
      },
    };
    await store.write(0, [{ ...controlled, turn_control: undefined }]);
    const historical = await inbox.enqueueCorrection({
      agent_id: controlled.id, room_id: controlled.room_id, source_message_id: "historical",
      source_message: { text: "done" }, activation: { decision: "activate" },
    });
    await inbox.claimHead(controlled.id);
    await inbox.checkpointTurnStarted(historical.inbox_item_id, "turn-history", TEST_PROVIDER_TURN_AUTHORITY);
    await inbox.transition(historical.inbox_item_id, "awaiting_result", { outcome: JSON.stringify({ kind: "no_reply" }) });
    await inbox.transition(historical.inbox_item_id, "acknowledged_no_reply");
    const prepared = await store.replaceEntry(1, {
      ...(await store.getEntry(controlled.id))!,
      turn_control: controlled.turn_control,
    });
    await store.commitTurnControlState(prepared.generation, {
      agentId: controlled.id,
      roomId: controlled.room_id,
      actionId: "idle-correction",
      workAttemptId: "attempt_1",
      executionGenerationId: "run_1",
      mode: "native_applied",
      settleOriginal: false,
      activateCorrection: true,
      observedAt: "2026-08-05T11:00:01.000Z",
    }, (current) => ({
      ...current,
      turn_control: {
        ...current.turn_control!, status: "completed", interrupted: false, resumed: true,
        state: "idle", stages: ["delivered", "applied", "resumed"], error: null,
        updated_at: "2026-08-05T11:00:01.000Z",
      },
    }));
    assert.deepEqual((await inbox.receipts(controlled.id)).map((item) => [item.source_message_id, item.fifo_sequence]), [
      ["historical", 1],
      ["correction:idle-correction", 2],
    ]);
  } finally {
    await inbox.close();
    await store.close();
    await env.cleanup();
  }
});

test("operator applied retires an unlinked native-correction journal without guessing FIFO authority", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T11:30:00.000Z");
  const actionId = "unlinked-native-applied";
  try {
    await store.write(0, [{ ...entry, condition: "none", delivery_mode: "daemon_inbox", turn_control: undefined }]);
    const successor = await inbox.enqueueCorrection({
      agent_id: entry.id, room_id: entry.room_id, source_message_id: "already-admitted-successor",
      source_message: { text: "B" }, activation: { decision: "activate" },
    });
    await inbox.claimHead(entry.id);
    await inbox.checkpointTurnStarted(successor.inbox_item_id, "turn-successor-B", TEST_PROVIDER_TURN_AUTHORITY);
    const journaled = await store.replaceEntry(1, {
      ...(await store.getEntry(entry.id))!,
      turn_control: {
        action_id: actionId, action_sequence: 1, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
        inbox_item_id: null, provider_turn_id: "legacy-native-A", has_correction: true,
        correction_text: "native correction already applied", correction_strategy: "native",
        operator_resolution: null, status: "uncertain", capability: "native_interrupt",
        interrupted: null, resumed: null, state: null, stages: [], error: "legacy native outcome unknown",
        recorded_at: "2026-08-05T11:30:00.000Z", updated_at: "2026-08-05T11:30:00.000Z",
      },
    });
    const committed = await store.commitTurnControlState(journaled.generation, {
      agentId: entry.id, roomId: entry.room_id, actionId,
      workAttemptId: "attempt_1", executionGenerationId: "run_1", mode: "operator_applied",
      settleOriginal: false, activateCorrection: false, observedAt: "2026-08-05T11:30:01.000Z",
    }, (current) => ({
      ...current,
      turn_control: {
        ...current.turn_control!, operator_resolution: "applied", status: "completed",
        interrupted: true, resumed: true, state: "working", stages: ["already_applied"], error: null,
        updated_at: "2026-08-05T11:30:01.000Z",
      },
    }));
    assert.equal(committed.entry.turn_control?.inbox_item_id ?? null, null);
    assert.equal(committed.entry.turn_control?.operator_resolution, "applied");
    assert.equal((await inbox.get(successor.inbox_item_id))?.state, "dispatching", "successor B remains untouched");
  } finally {
    await inbox.close();
    await store.close();
    await env.cleanup();
  }
});

test("operator not-applied recovers only the exact provider turn or Cursor's proven pre-native row", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T12:00:00.000Z");
  const control = (actionId: string) => ({
    action_id: actionId,
    action_sequence: 1,
    work_attempt_id: "attempt_1",
    execution_generation_id: "run_1",
    inbox_item_id: null,
    provider_turn_id: null,
    has_correction: false,
    correction_text: null,
    correction_strategy: null,
    status: "uncertain" as const,
    capability: "native_interrupt" as const,
    interrupted: null,
    resumed: null,
    state: null,
    stages: [] as [],
    error: "native outcome unknown",
    recorded_at: "2026-08-05T12:00:00.000Z",
    updated_at: "2026-08-05T12:00:00.000Z",
  });
  const exact: DaemonManifestEntry = { ...entry, id: "exact-recovery", room_id: "room-exact", condition: "none", delivery_mode: "daemon_inbox", turn_control: control("resolve-exact") };
  const cursor: DaemonManifestEntry = {
    ...entry, id: "cursor-pre-native", room_id: "room-cursor", provider: "cursor", condition: "none", delivery_mode: "daemon_inbox",
    provider_ref: { ...entry.provider_ref!, provider_connection: { kind: "cursor_cli", pid: null, processIdentity: null } },
    turn_control: control("resolve-cursor-pre-native"),
  };
  const generic: DaemonManifestEntry = {
    ...entry, id: "generic-null-turn", room_id: "room-generic", provider: "claude-code", condition: "none", delivery_mode: "daemon_inbox",
    provider_ref: { ...entry.provider_ref!, provider_connection: { kind: "claude_cli", pid: 42, processIdentity: "claude:42" } },
    turn_control: control("resolve-generic-null"),
  };
  try {
    await store.write(0, [
      { ...exact, turn_control: undefined },
      { ...cursor, turn_control: undefined },
      { ...generic, turn_control: undefined },
    ]);
    const exactRow = await inbox.enqueueCorrection({ agent_id: exact.id, room_id: exact.room_id, source_message_id: "exact-A", source_message: { text: "A" }, activation: { decision: "activate" } });
    const cursorRow = await inbox.enqueueCorrection({ agent_id: cursor.id, room_id: cursor.room_id, source_message_id: "cursor-A", source_message: { text: "A" }, activation: { decision: "activate" } });
    const genericRow = await inbox.enqueueCorrection({ agent_id: generic.id, room_id: generic.room_id, source_message_id: "generic-A", source_message: { text: "A" }, activation: { decision: "activate" } });
    await inbox.claimHead(exact.id);
    await inbox.checkpointTurnStarted(exactRow.inbox_item_id, "turn-exact", TEST_PROVIDER_TURN_AUTHORITY);
    await inbox.claimHead(cursor.id);
    await inbox.claimHead(generic.id);
    const linked = (await store.load()).entries.map((candidate) => candidate.id === exact.id
      ? { ...candidate, turn_control: { ...exact.turn_control!, inbox_item_id: exactRow.inbox_item_id, provider_turn_id: "turn-exact" } }
      : candidate.id === cursor.id
        ? { ...candidate, turn_control: { ...cursor.turn_control!, inbox_item_id: cursorRow.inbox_item_id } }
        : { ...candidate, turn_control: { ...generic.turn_control!, inbox_item_id: genericRow.inbox_item_id } });
    await store.write(1, linked);
    const finishNotApplied = (current: DaemonManifestEntry) => ({
      ...current,
      turn_control: {
        ...current.turn_control!, operator_resolution: "not_applied" as const, status: "completed" as const, interrupted: false, resumed: false,
        state: "working" as const, stages: [], error: "operator verified not applied",
        updated_at: "2026-08-05T12:00:01.000Z",
      },
    });
    const exactCommit = await store.commitTurnControlState(2, {
      agentId: exact.id, roomId: exact.room_id, actionId: "resolve-exact", workAttemptId: "attempt_1", executionGenerationId: "run_1",
      mode: "operator_not_applied", settleOriginal: false, activateCorrection: false, observedAt: "2026-08-05T12:00:01.000Z",
    }, finishNotApplied);
    assert.equal(exactCommit.original, "resumed");
    const recoveredExact = await inbox.get(exactRow.inbox_item_id);
    assert.equal(recoveredExact?.state, "pending");
    assert.equal(recoveredExact?.provider_turn_id, "turn-exact");
    assert.equal(recoveredExact?.attempt_count, 1);
    const cursorCommit = await store.commitTurnControlState(exactCommit.generation, {
      agentId: cursor.id, roomId: cursor.room_id, actionId: "resolve-cursor-pre-native", workAttemptId: "attempt_1", executionGenerationId: "run_1",
      mode: "operator_not_applied", settleOriginal: false, activateCorrection: false, observedAt: "2026-08-05T12:00:02.000Z",
    }, finishNotApplied);
    const recoveredCursor = await inbox.get(cursorRow.inbox_item_id);
    assert.equal(recoveredCursor?.state, "pending");
    assert.equal(recoveredCursor?.provider_turn_id, null);
    assert.equal(recoveredCursor?.attempt_count, 0);
    await assert.rejects(() => store.commitTurnControlState(cursorCommit.generation, {
      agentId: generic.id, roomId: generic.room_id, actionId: "resolve-generic-null", workAttemptId: "attempt_1", executionGenerationId: "run_1",
      mode: "operator_not_applied", settleOriginal: false, activateCorrection: false, observedAt: "2026-08-05T12:00:03.000Z",
    }, finishNotApplied), /null-turn control cannot be resumed/i);
    assert.equal((await inbox.get(genericRow.inbox_item_id))?.state, "dispatching");
    assert.equal((await store.load()).generation, cursorCommit.generation, "rejected resolution rolls back the manifest generation");
  } finally {
    await inbox.close();
    await store.close();
    await env.cleanup();
  }
});

test("historical not-applied recovery cannot send A's turn id through an unrelated successor continuation", async () => {
  const env = await fixture();
  const workAttemptId = "11111111-1111-4111-8111-111111111111";
  const controlledGenerationId = "22222222-2222-4222-8222-222222222222";
  const successorGenerationId = "33333333-3333-4333-8333-333333333333";
  const agent: DaemonManifestEntry = {
    ...entry,
    id: "historical-not-applied",
    room_id: "room-historical-not-applied",
    condition: "none",
    delivery_mode: "daemon_inbox",
    work_attempt_id: workAttemptId,
    provider_ref: {
      work_attempt_id: workAttemptId,
      execution_generation_id: successorGenerationId,
      provider_continuation_id: "thread-successor-B",
      provider_connection: {
        kind: "codex_app_server",
        url: "http://127.0.0.1:4333",
        pid: 4333,
        processIdentity: "codex-successor:4333",
      },
    },
    turn_control: undefined,
  };
  let store = new ManifestStore(env.databasePath);
  let inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T12:30:00.000Z");
  try {
    await store.write(0, [agent]);
    const original = await inbox.enqueueCorrection({
      agent_id: agent.id,
      room_id: agent.room_id,
      source_message_id: "historical-A",
      source_message: { text: "A" },
      activation: { decision: "activate" },
    });
    await inbox.claimHead(agent.id);
    await inbox.checkpointTurnStarted(original.inbox_item_id, "turn-old-A", {
      work_attempt_id: workAttemptId,
      origin_execution_generation_id: controlledGenerationId,
      provider_continuation_id: "thread-old-A",
    });
    const journaled = await store.replaceEntry(1, {
      ...agent,
      turn_control: {
        action_id: "resolve-historical-A",
        action_sequence: 1,
        work_attempt_id: workAttemptId,
        execution_generation_id: controlledGenerationId,
        inbox_item_id: original.inbox_item_id,
        provider_turn_id: "turn-old-A",
        has_correction: false,
        correction_text: null,
        correction_strategy: null,
        operator_resolution: null,
        status: "uncertain",
        capability: "native_interrupt",
        interrupted: null,
        resumed: null,
        state: null,
        stages: [],
        error: "native response was lost",
        recorded_at: "2026-08-05T12:30:00.000Z",
        updated_at: "2026-08-05T12:30:00.000Z",
      },
    });
    await inbox.close();
    await store.close();

    const database = new DatabaseSync(env.databasePath);
    database.prepare(`INSERT INTO work_attempts
      (work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      workAttemptId, "task-historical", "lease-historical", 1, join(env.root, "workspace"), "repo",
      "https://example.test/repo.git", "a".repeat(40), join(env.root, "bare.git"), "active", "2026-08-05T12:00:00.000Z",
    );
    database.prepare(`INSERT INTO work_attempt_lease_epochs
      (work_attempt_id,sort_order,lease_id,epoch,recorded_at) VALUES (?,?,?,?,?)`).run(
      workAttemptId, 0, "lease-historical", 1, "2026-08-05T12:00:00.000Z",
    );
    database.prepare(`INSERT INTO work_attempt_executions
      (execution_generation_id,work_attempt_id,started_at,actor,generation,terminal_json)
      VALUES (?,?,?,?,?,?)`).run(
      controlledGenerationId, workAttemptId, "2026-08-05T12:00:00.000Z", "provider", 1, JSON.stringify({
        ended_at: "2026-08-05T12:20:00.000Z",
        exit_code: 1,
        signal: null,
        stdio_archive_ref: null,
        stdio_tail: "controlled runtime ended",
        terminal_cause: "process_exit",
        actor: "provider",
        generation: 1,
        provider_continuation_id: "thread-old-A",
      }),
    );
    database.close();

    store = new ManifestStore(env.databasePath);
    inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T12:30:01.000Z");
    const finishNotApplied = (current: DaemonManifestEntry) => ({
      ...current,
      turn_control: {
        ...current.turn_control!,
        operator_resolution: "not_applied" as const,
        status: "completed" as const,
        interrupted: false,
        resumed: false,
        state: "working" as const,
        stages: [],
        error: null,
        updated_at: "2026-08-05T12:30:01.000Z",
      },
    });
    await assert.rejects(() => store.commitTurnControlState(journaled.generation, {
      agentId: agent.id,
      roomId: agent.room_id,
      actionId: "resolve-historical-A",
      workAttemptId,
      executionGenerationId: controlledGenerationId,
      mode: "operator_not_applied",
      settleOriginal: false,
      activateCorrection: false,
      observedAt: "2026-08-05T12:30:01.000Z",
    }, finishNotApplied), /different or unverifiable provider-turn authority binding/i);
    assert.equal((await inbox.get(original.inbox_item_id))?.state, "dispatching", "A remains frozen instead of entering successor B");
    assert.equal((await store.getEntry(agent.id))?.turn_control?.status, "uncertain", "operator resolution remains unresolved");
    assert.equal((await store.load()).generation, journaled.generation, "rejected recovery rolls back the manifest generation");

    const sameContinuation = await store.replaceEntry(journaled.generation, {
      ...(await store.getEntry(agent.id))!,
      provider_ref: {
        ...agent.provider_ref!,
        provider_continuation_id: "thread-old-A",
      },
    });
    const recovered = await store.commitTurnControlState(sameContinuation.generation, {
      agentId: agent.id,
      roomId: agent.room_id,
      actionId: "resolve-historical-A",
      workAttemptId,
      executionGenerationId: controlledGenerationId,
      mode: "operator_not_applied",
      settleOriginal: false,
      activateCorrection: false,
      observedAt: "2026-08-05T12:30:02.000Z",
    }, finishNotApplied);
    assert.equal(recovered.original, "resumed", "the same exact continuation may recover A across a process generation");
    assert.equal((await inbox.get(original.inbox_item_id))?.state, "pending");
    assert.equal((await inbox.get(original.inbox_item_id))?.provider_turn_id, "turn-old-A");
  } finally {
    await inbox.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

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
      charter: "Updated charter", permissionProfileId: "full_access", providerLaunchPolicy: { approvalPolicy: "never" },
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
      charter: "Use the new charter on future turns.", permissionProfileId: "read_only", providerLaunchPolicy: { approvalPolicy: "ask" },
    });
    assert.equal(updated.outcome, "updated");
    assert.equal(updated.configuration?.config_revision, 2);
    assert.equal(updated.configuration?.runtime_configuration_revision, 1);
    const conflict = await store.updateAgentConfiguration(2, {
      agentId: entry.id, expectedRevision: 1, model: "ignored", reasoningEffort: null,
      charter: "ignored", permissionProfileId: null, providerLaunchPolicy: {},
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

const terminal = {
  ended_at: "2026-07-19T00:03:00.000Z",
  exit_code: 17,
  signal: null,
  stdio_archive_ref: "archive://run-1",
  stdio_tail: "provider stopped",
  terminal_cause: "process_exit",
  actor: "provider",
  generation: 8,
  provider_continuation_id: "thread_1",
};

const entry: DaemonManifestEntry = {
  id: "agent_1",
  room_id: "room_1",
  display_name: "MistyMorrow",
  provider: "codex",
  model: "gpt-5.6-codex",
  charter: "Investigate daemon stability.",
  desired_state: "running",
  observed_state: "working",
  condition: "coordination_blocked",
  last_error: null,
  permission_profile_id: "workspace-write",
  provider_launch_policy: { deliveryMode: "mcp_polling" },
  created_by: "user_1",
  created_at: "2026-07-19T00:00:00.000Z",
  source_repo_path: "/repo",
  workspace_path: "/worktrees/agent_1",
  work_attempt_id: "attempt_1",
  provider_ref: {
    work_attempt_id: "attempt_1",
    provider_continuation_id: "thread_1",
    provider_connection: { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: null },
    execution_generation_id: "run_1",
  },
  workplace_liveness: { state: "reachable", observed_at: "2026-07-19T00:01:00.000Z", detail: null },
  native_liveness: { state: "active", observed_at: "2026-07-19T00:01:01.000Z", detail: "streaming" },
  ready_reached_at: "2026-07-19T00:01:00.000Z",
  activity: [{
    observed_at: "2026-07-19T00:01:02.000Z",
    sequence: 4,
    provider: "codex",
    kind: "tool",
    method: "turn/product-path-delivery",
    summary: "Delivered room message",
    status: "working",
    payload: { message_id: "message_1" },
    payload_truncated: false,
    payload_redacted: true,
    durable_payload_ref: null,
  }],
  turn_control: {
    action_id: "action_1",
    action_sequence: 1,
    work_attempt_id: "attempt_1",
    execution_generation_id: "run_1",
    has_correction: true,
    status: "completed",
    capability: "native_interrupt",
    interrupted: true,
    resumed: false,
    state: "working",
    stages: ["delivered", "interrupting", "applied"],
    error: null,
    recorded_at: "2026-07-19T00:02:00.000Z",
    updated_at: "2026-07-19T00:02:01.000Z",
  },
  last_turn_control_sequence: 1,
  last_worker_binding: {
    agent_session_id: "session_1",
    work_attempt_id: "attempt_1",
    execution_generation_id: "run_1",
    updated_at: "2026-07-19T00:02:02.000Z",
  },
  reconciliation: {
    exit_timestamps_ms: [10, 20],
    consecutive_action_failures: 2,
    last_observed_state: "failed",
    next_restart_at_ms: 30,
    completed_action_ids: ["old_1", "old_2"],
    last_action_sequence: 9,
    pending_action: { id: "pending_1", sequence: 9, kind: "restart_with_resume", recorded_at_ms: 25 },
    last_terminal: terminal,
  },
  reconciliation_notices: [{
    at: "2026-07-19T00:03:01.000Z",
    kind: "coordination_escalation",
    cause: "provider process exited",
    terminal,
  }],
};

const owner: LegacyLaneOwner = {
  reservation_id: "reservation_1",
  room_id: "room_1",
  provider: "codex",
  owner_pid: 123,
  owner_process_identity: "birth-123",
  state: "active",
  session_id: "session_legacy",
  created_at: "2026-07-19T00:00:00.000Z",
  updated_at: "2026-07-19T00:00:01.000Z",
};

async function fixture(): Promise<{ root: string; databasePath: string; legacyPath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "letagents-manifest-sqlite-"));
  return {
    root,
    databasePath: join(root, "daemon-state.sqlite"),
    legacyPath: join(root, "daemon-manifest.json"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function deliveryDrainCoordinates() {
  const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "codex:4311" };
  const agent: DaemonManifestEntry = {
    ...entry, condition: "none", delivery_mode: "daemon_inbox", turn_control: undefined, last_turn_control_sequence: 0,
    provider_ref: { ...entry.provider_ref!, provider_connection: connection },
  };
  const handle: ProviderActionHandle = { workAttemptId: "attempt_1", pid: 4311, providerContinuationId: "thread_1", providerConnection: { ...connection }, observedState: "idle" };
  return { agent, input: {
    requestId: "drain-request", operationId: "drain-operation", agentId: agent.id, roomId: agent.room_id,
    executionGenerationId: "run_1", handle,
    boundary: { state: "idle" as const, providerContinuationId: "thread_1", nativeProcessIdentity: "codex:4311", latestProviderTurnId: null },
  } };
}

function seedActiveDrainExecution(databasePath: string): void {
  seedTerminalExecution(databasePath, "attempt_1", "run_1");
  const database = new DatabaseSync(databasePath);
  try { database.exec("UPDATE work_attempt_executions SET terminal_json=NULL WHERE execution_generation_id='run_1'"); }
  finally { database.close(); }
}

async function seedPollingActivationRuntime(env: Awaited<ReturnType<typeof fixture>>, store: ManifestStore,
  inbox: SupervisedAgentInboxStore, bindings: WorkerBindingStore): Promise<Parameters<ManifestStore["preparePollingActivation"]>[0]> {
  const { agent, input } = deliveryDrainCoordinates();
  await store.write(0, [agent]); seedActiveDrainExecution(env.databasePath);
  await inbox.ingestPoll({ agent_id: agent.id, room_id: agent.room_id, last_observed_message_id: "msg_47", messages: [] });
  await store.prepareDeliveryDrain(input); await store.markDeliveryDrainDispatch(input);
  await store.commitDeliveryDrain((await store.load()).generation, input, async commit => commit());
  const database = new DatabaseSync(env.databasePath);
  try {
    database.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='run_1'").run(JSON.stringify(terminal));
    database.prepare("INSERT INTO work_attempt_executions VALUES('run_2','attempt_1',?,'provider',9,NULL)").run(terminal.ended_at);
  } finally { database.close(); }
  const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4312", pid: 4312, processIdentity: "codex:4312" };
  const next = withRuntimeIdentity({ ...(await store.getEntry(agent.id))!,
    provider_ref: { work_attempt_id: "attempt_1", execution_generation_id: "run_2", provider_continuation_id: "thread_1", provider_connection: connection,
      custodial_launch_agent_session_id: "session_2" } });
  await store.replaceEntry((await store.load()).generation, next);
  await store.markRuntimeConfigurationApplied((await store.load()).generation, { agentId: agent.id, executionGenerationId: "run_2", appliedRevision: 2 });
  await bindings.bind({ entry_id: agent.id, room_id: agent.room_id, work_attempt_id: "attempt_1", execution_generation_id: "run_2",
    agent_session_id: "session_2", agent_session_token: "test-token", api_url: "https://example.test" }, { roomCursor: "msg_47" });
  return { operationId: "activation", requestId: "activation-request", agentId: agent.id, roomId: agent.room_id,
    executionGenerationId: "run_2", reverseOperationId: input.operationId,
    handle: { workAttemptId: "attempt_1", pid: 4312, providerConnection: connection, providerContinuationId: "thread_1", observedState: "idle", appliedConfigurationRevision: 2 },
    boundary: { state: "idle", providerContinuationId: "thread_1", nativeProcessIdentity: "codex:4312", latestProviderTurnId: null } };
}

function seedTerminalExecution(databasePath: string, workAttemptId: string, executionGenerationId: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(`INSERT OR IGNORE INTO work_attempts
      (work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      workAttemptId, "task_1", "lease_1", 1, `/workspace/${workAttemptId}`, "repo", "https://example.test/repo.git", "abc123", `/bare/${workAttemptId}`, "active", "2026-08-05T10:00:00.000Z",
    );
    database.prepare(`INSERT OR REPLACE INTO work_attempt_executions
      (execution_generation_id,work_attempt_id,started_at,actor,generation,terminal_json)
      VALUES (?,?,?,?,?,?)`).run(
      executionGenerationId, workAttemptId, "2026-08-05T10:00:00.000Z", "provider", 8, JSON.stringify(terminal),
    );
  } finally {
    database.close();
  }
}

function storedManifest(manifest: DaemonManifest): string {
  const checksum = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  return `${JSON.stringify({ manifest, checksum })}\n`;
}

function withRuntimeIdentity(item: DaemonManifestEntry): DaemonManifestEntry {
  const runId = item.provider_ref?.execution_generation_id;
  return runId ? { ...item, run_id: runId, deployment_id: serializeDaemonDeploymentId(item.id, runId) } : item;
}

function removePostV5DeliveryTables(database: DatabaseSync): void {
  database.exec(`
    -- Physical v1-v4 databases cannot contain the later v13 repair journal.
    DROP TABLE IF EXISTS provider_continuation_repairs;
    DROP TABLE IF EXISTS supervised_agent_provider_turn_bindings;
    DROP TABLE IF EXISTS supervised_agent_publications;
    DROP TABLE IF EXISTS supervised_agent_history_boundaries;
    DROP TABLE IF EXISTS supervised_agent_pruned_sources;
    DROP TABLE IF EXISTS supervised_agent_effects;
    DROP TABLE IF EXISTS supervised_agent_ingress_health;
    DROP TABLE IF EXISTS supervised_agent_observed_messages;
    DROP TABLE IF EXISTS supervised_agent_terminal_results;
    DROP TABLE IF EXISTS supervised_agent_inbox_events;
    DROP TABLE IF EXISTS supervised_agent_ingress_cursors;
    DROP TABLE IF EXISTS supervised_agent_inbox;
  `);
}

function assertRoomScopedV9DeliveryShape(database: DatabaseSync): void {
  assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_SCHEMA_VERSION);
  assert.equal((database.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as { schema_version: number }).schema_version, DAEMON_STATE_SCHEMA_VERSION);
  const inbox = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'").get() as { sql: string };
  const observed = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_observed_messages'").get() as { sql: string };
  const publications = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_publications'").get() as { sql: string };
  assert.match(inbox.sql, /UNIQUE\s*\(\s*agent_id\s*,\s*room_id\s*,\s*source_message_id\s*\)/i);
  assert.match(observed.sql, /PRIMARY KEY\s*\(\s*agent_id\s*,\s*room_id\s*,\s*source_message_id\s*\)/i);
  assert.match(publications.sql, /FOREIGN KEY\s*\(\s*inbox_item_id\s*,\s*agent_id\s*,\s*room_id\s*\)/i);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
}

function seedTerminalAttempt(databasePath: string, attemptId: string, executionId: string, workspacePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(`INSERT INTO work_attempts(
      work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,
      workspace_resolved_revision,workspace_bare_path,state,created_at,concluded_at,conclusion_cause,postmortem_diff
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      attemptId, `task_${attemptId}`, `lease_${attemptId}`, 1, workspacePath, "repo", "https://github.com/example/repo.git",
      "a".repeat(40), join(workspacePath, ".bare"), "cleanly_concluded", "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:03:00.000Z", "provider stopped", "",
    );
    database.prepare("INSERT INTO work_attempt_lease_epochs VALUES(?,?,?,?,?)").run(attemptId, 0, `lease_${attemptId}`, 1, "2026-07-19T00:00:00.000Z");
    database.prepare("INSERT INTO work_attempt_checkpoints VALUES(?,?,?,?,?)").run(attemptId, 0, "2026-07-19T00:01:00.000Z", "message_1", "thread_1");
    database.prepare("INSERT INTO work_attempt_executions VALUES(?,?,?,?,?,?)").run(
      executionId, attemptId, "2026-07-19T00:01:00.000Z", "provider", 1,
      JSON.stringify({ ...terminal, actor: "provider", generation: 1 }),
    );
  } finally { database.close(); }
}

test("SQLite manifest round-trips the flat wire projection from relational domain tables", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const undefinedPolicyEntry = { ...entry, id: "agent_2", provider_launch_policy: undefined };
    const saved = await store.write(0, [entry, undefinedPolicyEntry], [owner]);
    assert.deepEqual(await store.load(), saved);
    assert.equal(Object.hasOwn(saved.entries[1]!, "provider_launch_policy"), false);

    const database = (store as unknown as { database: DatabaseSync }).database;
    assert.equal((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    assert.equal((database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((database.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM agent_identities").get() as { count: number }).count, 2);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM runtime_deployments").get() as { count: number }).count, 2);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM activity_events").get() as { count: number }).count, 2);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM reconciliation_exit_timestamps").get() as { count: number }).count, 4);
    assert.equal((database.prepare("SELECT terminal_cause FROM reconciliation_notices WHERE agent_id = ?").get(entry.id) as { terminal_cause: string }).terminal_cause, terminal.terminal_cause);
    assert.equal((await stat(env.root)).mode & 0o777, 0o700);
    assert.equal((await stat(env.databasePath)).mode & 0o777, 0o600);

    await store.close();
    await assert.rejects(() => store.load(), /closed/);
    const reopened = new ManifestStore(env.databasePath);
    assert.deepEqual(await reopened.load(), saved);
    await reopened.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("SQLite manifest preserves the complete OpenCode server identity across reopen", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const openModel: DaemonManifestEntry = {
    ...entry,
    id: "agent_open_model",
    provider: "open-model",
    model: "moonshotai/kimi-k3",
    provider_ref: {
      work_attempt_id: "attempt_open_model",
      provider_continuation_id: "session_open_model",
      execution_generation_id: "generation_open_model",
      provider_connection: {
        kind: "opencode_server",
        url: "http://127.0.0.1:52486",
        pid: 45550,
        processIdentity: "opencode-birth-45550",
        serverAuthPath: "/runtime/attempt_open_model/server-auth.json",
      },
    },
  };
  try {
    await store.write(0, [openModel]);
    await store.close();
    const reopened = new ManifestStore(env.databasePath);
    assert.deepEqual((await reopened.getEntry(openModel.id))?.provider_ref, openModel.provider_ref);
    await reopened.close();
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("v13 state adds the OpenCode control reference before advancing version markers", async () => {
  const env = await fixture();
  const initialized = new ManifestStore(env.databasePath);
  try {
    await initialized.write(0, [entry]);
    await initialized.close();
    const historical = new DatabaseSync(env.databasePath);
    historical.exec(`
      ALTER TABLE runtime_deployments DROP COLUMN provider_server_auth_path;
      UPDATE manifest_metadata SET schema_version=13 WHERE singleton=1;
      PRAGMA user_version=13;
    `);
    historical.close();

    const migrated = new ManifestStore(env.databasePath);
    await migrated.load();
    await migrated.close();
    const inspection = new DatabaseSync(env.databasePath);
    try {
      assert.equal(
        (inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        DAEMON_STATE_SCHEMA_VERSION,
      );
      assert.ok((inspection.prepare("PRAGMA table_info(runtime_deployments)").all() as Array<{ name: string }>)
        .some((column) => column.name === "provider_server_auth_path"));
    } finally {
      inspection.close();
    }
  } finally {
    await initialized.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("SQLite manifest generation CAS serializes independent connections without losing agents", async () => {
  const env = await fixture();
  const first = new ManifestStore(env.databasePath);
  const second = new ManifestStore(env.databasePath);
  try {
    const entries = [entry, { ...entry, id: "agent_2", display_name: "OwlSolar" }];
    await first.write(0, entries);
    assert.equal((await second.load()).generation, 1);
    const results = await Promise.allSettled([
      first.write(1, entries.map((item) => ({ ...item, observed_state: "idle" as const }))),
      second.write(1, entries.map((item) => ({ ...item, observed_state: "paused" as const }))),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof ManifestConflictError).length, 1);
    const durable = await first.load();
    assert.equal(durable.generation, 2);
    assert.deepEqual(durable.entries.map((item) => item.id), ["agent_1", "agent_2"]);
    assert.equal(new Set(durable.entries.map((item) => item.observed_state)).size, 1);
  } finally {
    await first.close();
    await second.close();
    await env.cleanup();
  }
});

test("legacy JSON imports once after checksum validation and is retained as a backup", async () => {
  const env = await fixture();
  const manifest: DaemonManifest = { generation: 41, entries: [entry], legacy_lane_owners: [owner] };
  const imported = { ...manifest, entries: manifest.entries.map(withRuntimeIdentity) };
  await writeFile(env.legacyPath, storedManifest(manifest), { mode: 0o600 });
  const store = new ManifestStore(env.databasePath, env.legacyPath);
  try {
    assert.deepEqual(await store.load(), imported);
    await assert.rejects(() => readFile(env.legacyPath), { code: "ENOENT" });
    assert.equal(await readFile(`${env.legacyPath}.migrated-backup`, "utf8"), storedManifest(manifest));
    await store.close();
    const reopened = new ManifestStore(env.databasePath, env.legacyPath);
    assert.deepEqual(await reopened.load(), imported);
    await reopened.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("invalid legacy checksums quarantine the source and durably block empty startup", async () => {
  const env = await fixture();
  await writeFile(env.legacyPath, JSON.stringify({ manifest: { generation: 9, entries: [entry] }, checksum: "invalid" }));
  const store = new ManifestStore(env.databasePath, env.legacyPath);
  try {
    await assert.rejects(() => store.load(), /checksum validation/);
    await assert.rejects(() => store.load(), /migration is blocked/);
    const names = await import("node:fs/promises").then(({ readdir }) => readdir(env.root));
    assert.ok(names.some((name) => name.startsWith("daemon-manifest.json.corrupt-")));
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("a post-commit backup failure retries idempotently without reimporting", async () => {
  const env = await fixture();
  const manifest: DaemonManifest = { generation: 7, entries: [entry] };
  const imported = { ...manifest, entries: manifest.entries.map(withRuntimeIdentity) };
  await writeFile(env.legacyPath, storedManifest(manifest));
  await mkdir(`${env.legacyPath}.migrated-backup`);
  const store = new ManifestStore(env.databasePath, env.legacyPath);
  try {
    await assert.rejects(() => store.load());
    await rm(`${env.legacyPath}.migrated-backup`, { recursive: true });
    assert.deepEqual(await store.load(), imported);
    assert.equal(await readFile(`${env.legacyPath}.migrated-backup`, "utf8"), storedManifest(manifest));
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("future SQLite schema versions are rejected without being downgraded", async () => {
  const env = await fixture();
  const futureVersion = DAEMON_STATE_SCHEMA_VERSION + 1;
  const database = new DatabaseSync(env.databasePath);
  database.exec(`PRAGMA user_version = ${futureVersion}`);
  database.close();
  const store = new ManifestStore(env.databasePath);
  try {
    await assert.rejects(() => store.load(), new RegExp(`schema version ${futureVersion}`));
    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, futureVersion);
    inspection.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("manifest metadata schema disagreement is rejected on reopen", async () => {
  const env = await fixture();
  const futureVersion = DAEMON_STATE_SCHEMA_VERSION + 1;
  const initialized = new ManifestStore(env.databasePath);
  try {
    await initialized.load();
    await initialized.close();
    const database = new DatabaseSync(env.databasePath);
    database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1").run(futureVersion);
    database.close();
    const reopened = new ManifestStore(env.databasePath);
    await assert.rejects(() => reopened.load(), new RegExp(`metadata schema version ${futureVersion}`));
    await reopened.close();
  } finally {
    await initialized.close();
    await env.cleanup();
  }
});

test("contradictory SQLite and metadata version pairs reject before migration", async () => {
  const futureVersion = DAEMON_STATE_SCHEMA_VERSION + 1;
  for (const pair of [
    { userVersion: 1, metadataVersion: 2, pattern: /version pair is inconsistent/ },
    { userVersion: 2, metadataVersion: 1, pattern: /version pair is inconsistent/ },
    { userVersion: 1, metadataVersion: futureVersion, pattern: new RegExp(`metadata schema version ${futureVersion}`) },
  ]) {
    const env = await fixture();
    const initialized = new ManifestStore(env.databasePath);
    try {
      await initialized.load();
      await initialized.close();
      const database = new DatabaseSync(env.databasePath);
      database.exec(`PRAGMA user_version = ${pair.userVersion}`);
      database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1").run(pair.metadataVersion);
      database.close();

      const rejected = new ManifestStore(env.databasePath);
      await assert.rejects(() => rejected.load(), pair.pattern);
      await rejected.close();

      const inspection = new DatabaseSync(env.databasePath);
      assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, pair.userVersion);
      assert.equal((inspection.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as { schema_version: number }).schema_version, pair.metadataVersion);
      inspection.close();
    } finally {
      await initialized.close();
      await env.cleanup();
    }
  }
});

test("physical v1-v4 databases with no delivery tables advance to the complete current shape before stamping markers", async () => {
  for (const version of [1, 2, 3, 4]) {
    const env = await fixture();
    const initial = new ManifestStore(env.databasePath);
    try {
      const expected = await initial.write(0, [entry]);
      await initial.close();
      const historical = new DatabaseSync(env.databasePath);
      removePostV5DeliveryTables(historical);
      historical.exec(`UPDATE manifest_metadata SET schema_version = ${version} WHERE singleton = 1; PRAGMA user_version = ${version}`);
      assert.equal(
        (historical.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'").get() as { count: number }).count,
        0,
        `v${version} fixture has no delivery inbox table`,
      );
      historical.close();

      const migrated = new ManifestStore(env.databasePath);
      assert.deepEqual(await migrated.load(), expected, `v${version} preserves manifest data`);
      await migrated.close();

      const inspection = new DatabaseSync(env.databasePath);
      assertRoomScopedV9DeliveryShape(inspection);
      assert.equal(
        (inspection.prepare("SELECT run_id FROM runtime_deployments WHERE agent_id=?").get(entry.id) as { run_id: string }).run_id,
        entry.provider_ref?.execution_generation_id,
        `v${version} retains runtime identity`,
      );
      inspection.close();

      const reopened = new ManifestStore(env.databasePath);
      assert.deepEqual(await reopened.load(), expected, `v${version} second reopen is stable`);
      await reopened.close();
    } finally {
      await initial.close();
      await env.cleanup();
    }
  }
});

test("v1 daemon state migrates transactionally to v2 and normalizes exit timestamps", async () => {
  const env = await fixture();
  const initial = new ManifestStore(env.databasePath);
  try {
    const invalid = { ...entry, id: "legacy_undefined", display_name: "Legacy Undefined" };
    await initial.write(0, [entry, invalid]);
    await initial.close();

    const v1 = new DatabaseSync(env.databasePath);
    v1.exec("ALTER TABLE agent_configurations DROP COLUMN provider_launch_policy_undefined");
    v1.exec("ALTER TABLE runtime_deployments DROP COLUMN provider_process_identity_present");
    v1.exec("ALTER TABLE reconciliation_records ADD COLUMN exit_timestamps_json TEXT");
    v1.prepare("UPDATE reconciliation_records SET exit_timestamps_json = ? WHERE agent_id = ?").run("[101,202,303]", entry.id);
    v1.prepare("DELETE FROM reconciliation_exit_timestamps WHERE agent_id = ?").run(entry.id);
    v1.prepare("UPDATE agent_configurations SET provider_launch_policy_present = 1, provider_launch_policy_json = NULL WHERE agent_id = ?").run(invalid.id);
    v1.prepare("UPDATE agent_launch_intents SET source_repo_path_present = 0, source_repo_path = '/stale' WHERE agent_id = ?").run(invalid.id);
    v1.prepare(`
      UPDATE runtime_deployments
      SET workspace_path_present = 0, workspace_path = '/stale',
          work_attempt_id_present = 0, work_attempt_id = 'stale-attempt',
          provider_ref_present = 0, workplace_liveness_present = 1,
          workplace_liveness_state = NULL, workplace_liveness_observed_at = 'stale',
          native_liveness_present = 1, native_liveness_state = NULL,
          native_liveness_observed_at = 'stale', activity_present = 0
      WHERE agent_id = ?
    `).run(invalid.id);
    v1.prepare("UPDATE agent_lifecycle_states SET last_error_present = 0, last_error = 'stale' WHERE agent_id = ?").run(invalid.id);
    v1.prepare("UPDATE agent_readiness SET ready_reached_at_present = 0, ready_reached_at = 'stale' WHERE agent_id = ?").run(invalid.id);
    v1.prepare("UPDATE turn_control_journals SET turn_control_present = 0 WHERE agent_id = ?").run(invalid.id);
    v1.prepare("UPDATE retained_worker_bindings SET last_worker_binding_present = 0 WHERE agent_id = ?").run(invalid.id);
    v1.prepare("UPDATE reconciliation_records SET reconciliation_present = 1, consecutive_action_failures = NULL, reconciliation_notices_present = 0 WHERE agent_id = ?").run(invalid.id);
    v1.prepare("UPDATE reconciliation_records SET terminal_actor = NULL WHERE agent_id = ?").run(entry.id);
    v1.prepare("UPDATE reconciliation_notices SET terminal_actor = NULL WHERE agent_id = ?").run(entry.id);
    v1.exec("UPDATE manifest_metadata SET schema_version = 1; PRAGMA user_version = 1");
    const v1ConfigurationColumns = (v1.prepare("PRAGMA table_info(agent_configurations)").all() as Array<{ name: string }>).map((column) => column.name);
    assert.equal(v1ConfigurationColumns.includes("provider_launch_policy_undefined"), false);
    assert.equal((v1.prepare("SELECT COUNT(*) AS count FROM reconciliation_exit_timestamps WHERE agent_id = ?").get(entry.id) as { count: number }).count, 0);
    v1.close();

    const migrated = new ManifestStore(env.databasePath);
    const state = await migrated.load();
    assert.equal(state.generation, 1, "migration preserves the manifest CAS generation");
    assert.deepEqual(state.entries[0]?.reconciliation?.exit_timestamps_ms, [101, 202, 303]);
    assert.equal(Object.hasOwn(state.entries[0]!.reconciliation!, "last_terminal"), false);
    assert.equal(Object.hasOwn(state.entries[0]!.reconciliation_notices![0]!, "terminal"), false);
    const normalized = state.entries.find((candidate) => candidate.id === invalid.id)!;
    for (const optional of [
      "provider_launch_policy", "source_repo_path", "workspace_path", "work_attempt_id",
      "provider_ref", "workplace_liveness", "native_liveness", "activity", "last_error",
      "ready_reached_at", "turn_control", "last_worker_binding", "reconciliation",
      "reconciliation_notices",
    ]) assert.equal(Object.hasOwn(normalized, optional), false, `${optional} is normalized to absence`);
    await migrated.close();

    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.equal((inspection.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as { schema_version: number }).schema_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.equal((inspection.prepare("SELECT provider_launch_policy_undefined FROM agent_configurations WHERE agent_id = ?").get(entry.id) as { provider_launch_policy_undefined: number }).provider_launch_policy_undefined, 0);
    assert.equal((inspection.prepare("SELECT provider_process_identity_present FROM runtime_deployments WHERE agent_id = ?").get(entry.id) as { provider_process_identity_present: number }).provider_process_identity_present, 0);
    const preservedRuntime = inspection.prepare("SELECT deployment_id, run_id FROM runtime_deployments WHERE agent_id = ?").get(invalid.id) as { deployment_id: string; run_id: string };
    assert.equal(preservedRuntime.run_id, entry.provider_ref?.execution_generation_id);
    assert.ok(preservedRuntime.deployment_id, "migration preserves deployment identity independently from provider_ref presence");
    for (const table of ["activity_events", "turn_control_stages", "reconciliation_exit_timestamps", "reconciliation_completed_actions", "reconciliation_notices"]) {
      assert.equal((inspection.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE agent_id = ?`).get(invalid.id) as { count: number }).count, 0, `${table} stale children are removed`);
    }
    const normalizedColumns = inspection.prepare(`
      SELECT runtime.workspace_path, runtime.work_attempt_id, runtime.provider_work_attempt_id,
             runtime.workplace_liveness_state, runtime.native_liveness_state,
             lifecycle.last_error, readiness.ready_reached_at,
             turn_journal.action_id, binding.binding_agent_session_id,
             reconciliation.consecutive_action_failures
      FROM runtime_deployments runtime
      JOIN agent_lifecycle_states lifecycle USING (agent_id)
      JOIN agent_readiness readiness USING (agent_id)
      JOIN turn_control_journals turn_journal USING (agent_id)
      JOIN retained_worker_bindings binding USING (agent_id)
      JOIN reconciliation_records reconciliation USING (agent_id)
      WHERE runtime.agent_id = ?
    `).get(invalid.id) as Record<string, unknown>;
    assert.ok(Object.values(normalizedColumns).every((value) => value === null), "absent optional projections retain no stale payload columns");
    inspection.close();

    const reopened = new ManifestStore(env.databasePath);
    assert.deepEqual((await reopened.load()).entries[0]?.reconciliation?.exit_timestamps_ms, [101, 202, 303]);
    await reopened.close();
  } finally {
    await initial.close();
    await env.cleanup();
  }
});

test("v2 backfills legacy exit timestamps when normalized table exists but agent rows are absent", async () => {
  const env = await fixture();
  const initial = new ManifestStore(env.databasePath);
  try {
    await initial.write(0, [entry]);
    await initial.close();
    const partial = new DatabaseSync(env.databasePath);
    partial.exec("ALTER TABLE reconciliation_records ADD COLUMN exit_timestamps_json TEXT");
    partial.prepare("UPDATE reconciliation_records SET exit_timestamps_json = ? WHERE agent_id = ?").run("[111,222]", entry.id);
    partial.prepare("DELETE FROM reconciliation_exit_timestamps WHERE agent_id = ?").run(entry.id);
    assert.equal((partial.prepare("SELECT COUNT(*) AS count FROM reconciliation_exit_timestamps WHERE agent_id = ?").get(entry.id) as { count: number }).count, 0);
    partial.close();

    const repaired = new ManifestStore(env.databasePath);
    assert.deepEqual((await repaired.load()).entries[0]?.reconciliation?.exit_timestamps_ms, [111, 222]);
    await repaired.close();

    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("SELECT exit_timestamps_json FROM reconciliation_records WHERE agent_id = ?").get(entry.id) as { exit_timestamps_json: string | null }).exit_timestamps_json, null);
    inspection.prepare("UPDATE reconciliation_records SET exit_timestamps_json = ? WHERE agent_id = ?").run("[333]", entry.id);
    inspection.close();
    const reopened = new ManifestStore(env.databasePath);
    assert.deepEqual((await reopened.load()).entries[0]?.reconciliation?.exit_timestamps_ms, [111, 222]);
    await reopened.close();
    const finalInspection = new DatabaseSync(env.databasePath);
    assert.equal((finalInspection.prepare("SELECT exit_timestamps_json FROM reconciliation_records WHERE agent_id = ?").get(entry.id) as { exit_timestamps_json: string }).exit_timestamps_json, "[333]", "newer normalized rows are not overwritten by stale legacy JSON");
    finalInspection.close();
  } finally {
    await initial.close();
    await env.cleanup();
  }
});

test("partially migrated v2 state is repaired transactionally before reads", async () => {
  const env = await fixture();
  const initial = new ManifestStore(env.databasePath);
  try {
    await initial.write(0, [entry]);
    await initial.close();

    const partial = new DatabaseSync(env.databasePath);
    partial.exec("ALTER TABLE runtime_deployments DROP COLUMN provider_process_identity_present");
    partial.exec("ALTER TABLE reconciliation_records ADD COLUMN exit_timestamps_json TEXT");
    partial.prepare("UPDATE reconciliation_records SET exit_timestamps_json = ? WHERE agent_id = ?").run("[404,505]", entry.id);
    partial.prepare("DELETE FROM reconciliation_exit_timestamps WHERE agent_id = ?").run(entry.id);
    assert.equal((partial.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.equal((partial.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as { schema_version: number }).schema_version, DAEMON_STATE_SCHEMA_VERSION);
    partial.close();

    const repaired = new ManifestStore(env.databasePath);
    const state = await repaired.load();
    assert.equal(state.generation, 1);
    assert.equal(state.entries.length, 1);
    assert.deepEqual(state.entries[0]?.reconciliation?.exit_timestamps_ms, [404, 505]);
    await repaired.close();

    const inspection = new DatabaseSync(env.databasePath);
    const runtimeColumns = (inspection.prepare("PRAGMA table_info(runtime_deployments)").all() as Array<{ name: string }>).map((column) => column.name);
    assert.equal(runtimeColumns.includes("provider_process_identity_present"), true);
    assert.equal((inspection.prepare("SELECT provider_process_identity_present FROM runtime_deployments WHERE agent_id = ?").get(entry.id) as { provider_process_identity_present: number }).provider_process_identity_present, 0);
    assert.equal((inspection.prepare("SELECT generation FROM manifest_metadata WHERE singleton = 1").get() as { generation: number }).generation, 1);
    inspection.close();
  } finally {
    await initial.close();
    await env.cleanup();
  }
});

test("all explicit optional undefined fields normalize to absence without fabricated state", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const minimal: DaemonManifestEntry = {
    id: "minimal_agent",
    room_id: "room_minimal",
    display_name: "Minimal",
    provider: "codex",
    model: null,
    charter: "Only required state.",
    desired_state: "paused",
    observed_state: "absent",
    condition: "none",
    permission_profile_id: null,
    created_by: "user_1",
    created_at: "2026-07-19T00:00:00.000Z",
    last_error: undefined,
    provider_launch_policy: undefined,
    source_repo_path: undefined,
    workspace_path: undefined,
    work_attempt_id: undefined,
    provider_ref: undefined,
    workplace_liveness: undefined,
    native_liveness: undefined,
    ready_reached_at: undefined,
    activity: undefined,
    turn_control: undefined,
    last_worker_binding: undefined,
    reconciliation: undefined,
    reconciliation_notices: undefined,
  };
  try {
    const saved = await store.write(0, [minimal]);
    const persisted = (await store.load()).entries[0]!;
    assert.deepEqual(persisted, saved.entries[0]);
    for (const optional of [
      "last_error", "provider_launch_policy", "source_repo_path", "workspace_path", "work_attempt_id",
      "provider_ref", "workplace_liveness", "native_liveness", "ready_reached_at", "activity",
      "turn_control", "last_worker_binding", "reconciliation", "reconciliation_notices",
    ]) assert.equal(Object.hasOwn(persisted, optional), false, `${optional} remains absent`);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("targeted activity writes leave every unrelated agent row untouched and avoid full replacement", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const others = Array.from({ length: 23 }, (_, index) => ({
      ...entry,
      id: `agent_other_${index}`,
      display_name: `Other Agent ${index}`,
    }));
    const other = others[0]!;
    const created = await store.write(0, [entry, ...others]);
    const database = (store as unknown as { database: DatabaseSync }).database;
    const tables = [
      "agent_identities", "agent_profiles", "agent_room_memberships", "agent_configurations",
      "agent_launch_intents", "runtime_deployments", "activity_events", "agent_lifecycle_states",
      "agent_readiness", "turn_control_journals", "turn_control_stages", "retained_worker_bindings",
      "reconciliation_records", "reconciliation_exit_timestamps", "reconciliation_completed_actions",
      "reconciliation_notices",
    ];
    const snapshot = () => Object.fromEntries(tables.map((table) => [
      table,
      database.prepare(`SELECT rowid, * FROM ${table} WHERE agent_id <> ? ORDER BY agent_id, rowid`).all(entry.id),
    ]));
    const before = snapshot();
    const raw = store as unknown as { replaceEntries: () => never };
    raw.replaceEntries = () => { throw new Error("full replacement must not run on the activity path"); };

    const nextEvent = { ...entry.activity![0]!, sequence: 5, observed_at: "2026-07-19T00:04:00.000Z", summary: "Targeted event" };
    const result = await store.appendActivity(1, entry.id, nextEvent, "idle", {
      state: "idle", observed_at: nextEvent.observed_at, detail: nextEvent.summary,
    }, 1);
    assert.equal(result.generation, 2);
    assert.deepEqual(result.entry.activity, [nextEvent]);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(await store.getEntry(other.id), created.entries.find((candidate) => candidate.id === other.id));
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("targeted batch replacement updates multiple agents in one generation without touching unrelated rows", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const entries = Array.from({ length: 24 }, (_, index) => ({
      ...entry,
      id: `batch_agent_${index}`,
      display_name: `Batch Agent ${index}`,
    }));
    await store.write(0, entries);
    const database = (store as unknown as { database: DatabaseSync }).database;
    const tables = [
      "agent_identities", "agent_profiles", "agent_room_memberships", "agent_configurations",
      "agent_launch_intents", "runtime_deployments", "activity_events", "agent_lifecycle_states",
      "agent_readiness", "turn_control_journals", "turn_control_stages", "retained_worker_bindings",
      "reconciliation_records", "reconciliation_exit_timestamps", "reconciliation_completed_actions",
      "reconciliation_notices",
    ];
    const changedIds = [entries[0]!.id, entries[1]!.id];
    const snapshot = () => Object.fromEntries(tables.map((table) => [
      table,
      database.prepare(`SELECT rowid, * FROM ${table} WHERE agent_id NOT IN (?, ?) ORDER BY agent_id, rowid`).all(...changedIds),
    ]));
    const before = snapshot();
    const raw = store as unknown as { replaceEntries: () => never };
    raw.replaceEntries = () => { throw new Error("full replacement must not run on the targeted batch path"); };

    const result = await store.replaceEntriesBatch(1, [
      { ...entries[0]!, reconciliation: { ...entries[0]!.reconciliation!, next_restart_at_ms: 101 } },
      { ...entries[1]!, reconciliation: { ...entries[1]!.reconciliation!, next_restart_at_ms: 202 } },
    ]);
    assert.equal(result.generation, 2, "the batch increments generation once");
    assert.deepEqual(result.entries.map((item) => item.reconciliation?.next_restart_at_ms), [101, 202]);
    assert.deepEqual(snapshot(), before);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("permission housekeeping failure aborts initialization without changing generation", async () => {
  const env = await fixture();
  const initialized = new ManifestStore(env.databasePath);
  try {
    assert.deepEqual(await initialized.load(), { generation: 0, entries: [] });
    await initialized.close();

    const failing = new ManifestStore(env.databasePath, undefined, async () => {
      throw new Error("injected permission failure");
    });
    await assert.rejects(() => failing.load(), /injected permission failure/);
    await failing.close();

    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("SELECT generation FROM manifest_metadata WHERE singleton = 1").get() as { generation: number }).generation, 0);
    inspection.close();

    const reopened = new ManifestStore(env.databasePath);
    assert.equal((await reopened.write(0, [entry])).generation, 1);
    await reopened.close();
  } finally {
    await initialized.close();
    await env.cleanup();
  }
});

test("fresh schema creation rolls back every DDL statement when initialization fails", async () => {
  const env = await fixture();
  const failing = new ManifestStore(env.databasePath, undefined, undefined, () => {
    throw new Error("injected schema initialization failure");
  });
  try {
    await assert.rejects(() => failing.load(), /injected schema initialization failure/);
    await failing.close();
    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0);
    assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'manifest_metadata'").get() as { count: number }).count, 0);
    inspection.close();

    const recovered = new ManifestStore(env.databasePath);
    assert.deepEqual(await recovered.load(), { generation: 0, entries: [] });
    await recovered.close();
  } finally {
    await failing.close();
    await env.cleanup();
  }
});

test("targeted writes return their committed projection without any post-commit getEntry", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const initial = await store.write(0, [entry]);
    const raw = store as unknown as { getEntry: () => never };
    raw.getEntry = () => { throw new Error("injected post-commit read failure"); };

    const replaced = await store.replaceEntry(1, { ...initial.entries[0]!, observed_state: "idle" });
    assert.equal(replaced.generation, 2);
    assert.equal(replaced.entry.observed_state, "idle");
    const event = { ...entry.activity![0]!, sequence: 5, observed_at: "2026-07-19T01:00:00.000Z" };
    const appended = await store.appendActivity(2, entry.id, event, "working", { state: "active", observed_at: event.observed_at, detail: "working" });
    assert.equal(appended.generation, 3);
    assert.equal(appended.entry.activity?.at(-1)?.sequence, 5);
    const live = await store.updateWorkplaceLiveness(3, entry.id, { state: "reachable", observed_at: event.observed_at, detail: "online" });
    assert.equal(live.generation, 4);
    const batched = await store.replaceEntriesBatch(4, [{ ...live.entry, condition: "none" }]);
    assert.equal(batched.generation, 5);
    assert.equal(batched.entries[0]?.condition, "none");
    assert.equal((await store.load()).generation, 5);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("targeted projection failure occurs before commit and rolls back generation", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const before = await store.write(0, [entry]);
    const raw = store as unknown as {
      readEntryFromDatabase: (database: DatabaseSync, agentId: string) => DaemonManifestEntry | undefined;
    };
    const original = raw.readEntryFromDatabase.bind(store);
    raw.readEntryFromDatabase = () => { throw new Error("injected projection failure"); };
    await assert.rejects(
      () => store.updateWorkplaceLiveness(1, entry.id, { state: "stale", observed_at: null, detail: "stale" }),
      /injected projection failure/,
    );
    raw.readEntryFromDatabase = original;
    assert.deepEqual(await store.load(), before);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("detached deployment identity survives lane-owner full writes and restart", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const neverLaunched: DaemonManifestEntry = {
      ...entry,
      id: "never_launched",
      display_name: "Never Launched",
      provider_ref: undefined,
      work_attempt_id: undefined,
    };
    const created = await store.write(0, [entry, neverLaunched]);
    const launched = created.entries[0]!;
    assert.equal(launched.run_id, entry.provider_ref?.execution_generation_id);
    assert.ok(launched.deployment_id);
    assert.equal(Object.hasOwn(created.entries[1]!, "run_id"), false);

    const detached = await store.replaceEntry(1, { ...launched, provider_ref: undefined });
    assert.equal(Object.hasOwn(detached.entry, "provider_ref"), false);
    assert.equal(detached.entry.run_id, launched.run_id);
    assert.equal(detached.entry.deployment_id, launched.deployment_id);

    const beforeLaneChange = await store.load();
    await store.write(2, beforeLaneChange.entries, [owner]);
    await store.close();

    const reopened = new ManifestStore(env.databasePath);
    const durable = await reopened.load();
    assert.equal(durable.entries[0]?.run_id, launched.run_id);
    assert.equal(durable.entries[0]?.deployment_id, launched.deployment_id);
    assert.equal(Object.hasOwn(durable.entries[0]!, "provider_ref"), false);
    assert.equal(Object.hasOwn(durable.entries[1]!, "run_id"), false);
    const database = (reopened as unknown as { database: DatabaseSync }).database;
    const unlaunchedRuntime = database.prepare("SELECT run_id, deployment_id FROM runtime_deployments WHERE agent_id = ?").get(neverLaunched.id) as { run_id: null; deployment_id: null };
    assert.equal(unlaunchedRuntime.run_id, null);
    assert.equal(unlaunchedRuntime.deployment_id, null);
    await reopened.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("v6 repair adds bounded delivery columns without shifting exact turn or cutover identities", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const seeded: DaemonManifestEntry = {
      ...entry,
      delivery_mode: "daemon_inbox",
      delivery_cutover: {
        work_attempt_id: "attempt_1",
        execution_generation_id: "run_1",
        provider_continuation_id: "thread_1",
        provider_turn_id: "turn_cutover_exact",
        phase: "uncertain",
        error: "exact turn state unknown",
        updated_at: "2026-07-19T00:02:03.000Z",
      },
      turn_control: { ...entry.turn_control!, provider_turn_id: "turn_legacy_poll" },
    };
    await store.write(0, [seeded]);
    const database = (store as unknown as { database: DatabaseSync }).database;
    // Only a predecessor may rebuild missing ingress configuration. Current
    // custody authority must instead fail closed if its column disappears.
    database.exec("ALTER TABLE agent_configurations DROP COLUMN polling_contract; UPDATE manifest_metadata SET schema_version=22; PRAGMA user_version=22");
    database.exec("ALTER TABLE agent_configurations DROP COLUMN delivery_mode; ALTER TABLE agent_configurations DROP COLUMN delivery_cutover_json; ALTER TABLE turn_control_journals DROP COLUMN provider_turn_id; ALTER TABLE turn_control_journals DROP COLUMN inbox_item_id; ALTER TABLE turn_control_journals DROP COLUMN correction_text; ALTER TABLE turn_control_journals DROP COLUMN correction_strategy; ALTER TABLE turn_control_journals DROP COLUMN operator_resolution");
    await store.close();

    const repaired = new ManifestStore(env.databasePath);
    const loaded = await repaired.load();
    const restored = loaded.entries[0]!;
    assert.equal(restored.delivery_mode ?? "mcp_polling", "mcp_polling", "old v6 rows safely default to legacy ingress before cutover");
    assert.equal(restored.turn_control?.provider_turn_id, undefined, "missing v6 extension does not shift booleans into the turn id");
    assert.equal(restored.turn_control?.inbox_item_id, undefined);
    assert.equal(restored.turn_control?.correction_text, undefined);
    assert.equal(restored.turn_control?.correction_strategy, undefined);
    assert.equal(restored.turn_control?.has_correction, true);
    assert.equal(restored.turn_control?.status, "completed");
    assert.equal(restored.delivery_cutover, undefined);
    await repaired.replaceEntry(loaded.generation, {
      ...restored,
      delivery_mode: "daemon_inbox",
      delivery_cutover: {
        work_attempt_id: "attempt_1",
        execution_generation_id: "run_1",
        provider_continuation_id: "thread_1",
        provider_turn_id: "turn_repaired_cutover",
        phase: "prepared",
        error: null,
        updated_at: "2026-07-19T00:02:04.000Z",
      },
      turn_control: { ...restored.turn_control!, provider_turn_id: "turn_repaired_exact" },
    });
    const roundTrip = await repaired.load();
    assert.equal(roundTrip.entries[0]?.delivery_mode, "daemon_inbox");
    assert.equal(roundTrip.entries[0]?.turn_control?.provider_turn_id, "turn_repaired_exact");
    assert.equal(roundTrip.entries[0]?.turn_control?.has_correction, true);
    assert.equal(roundTrip.entries[0]?.turn_control?.status, "completed");
    assert.deepEqual(roundTrip.entries[0]?.delivery_cutover, {
      work_attempt_id: "attempt_1",
      execution_generation_id: "run_1",
      provider_continuation_id: "thread_1",
      provider_turn_id: "turn_repaired_cutover",
      phase: "prepared",
      error: null,
      updated_at: "2026-07-19T00:02:04.000Z",
    });
    await repaired.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});
