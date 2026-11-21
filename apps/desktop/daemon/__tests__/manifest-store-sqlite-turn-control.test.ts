import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DaemonStateSchema } from "../daemon-state-database.js";
import { ManifestStore } from "../manifest-store.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonManifestEntry } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import {
  TEST_PROVIDER_TURN_AUTHORITY,
  entry,
  fixture,
} from "./helpers/manifest-store-sqlite-fixture.js";

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
    await store.write([prepareFirst, claimFirst]);
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

    const linked = await prepare((await store.load()).versions[claimFirst.id]!, claimFirst, "claim-wins");
    assert.equal(linked.linkedInboxItemId, admittedA.inbox_item_id, "an already-admitted row becomes exact A");
    assert.equal(linked.linkedState, "dispatching");
    assert.equal(await inbox.claimHead(claimFirst.id), null, "the linked barrier never admits a successor");
    const targeted = await store.checkpointTurnControlTarget(linked.version, {
      agentId: claimFirst.id, roomId: claimFirst.room_id, actionId: "claim-wins",
      workAttemptId: "attempt_1", executionGenerationId: "run_1", providerContinuationId: "thread_1",
      providerConnection: claimFirst.provider_ref!.provider_connection, deliveryMode: "daemon_inbox",
      providerTurnId: `${claimFirst.id}-turn`, observedAt: "2026-08-05T09:00:00.500Z",
    });
    assert.equal(targeted.entry.turn_control?.provider_turn_id, `${claimFirst.id}-turn`);
    assert.equal((await inbox.get(admittedA.inbox_item_id))?.provider_turn_id, `${claimFirst.id}-turn`, "journal and FIFO target checkpoint atomically");
    await assert.rejects(() => store.checkpointTurnControlTarget(targeted.version, {
      agentId: claimFirst.id, roomId: claimFirst.room_id, actionId: "claim-wins",
      workAttemptId: "attempt_1", executionGenerationId: "run_1", providerContinuationId: "thread_1",
      providerConnection: claimFirst.provider_ref!.provider_connection, deliveryMode: "daemon_inbox",
      providerTurnId: "successor-B", observedAt: "2026-08-05T09:00:00.750Z",
    }), /exact prepared authority/i);

    await assert.rejects(() => store.prepareTurnControlState(targeted.version, {
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
      deliveryMode: "daemon_inbox",
      hasCorrection: false,
      correctionText: null,
      correctionStrategy: null,
      capability: "native_interrupt",
      recordedAt: "2026-08-05T09:00:01.000Z",
    }), /unresolved/i);
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
    let generation = (await store.write([cursor])).versions[cursor.id]!;
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
      configurationRevision: 1,
      requestedAuthorityMode: "typed",
      observedAt: "2026-08-05T09:30:00.000Z",
    });
    generation = preparedTurn.version;
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
    generation = preparedControl.version;
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

    // Reproduce a split state where runtime+binding already committed the real
    // session while the control JSON still names the wrapper's pending continuation.
    // An idempotent provider callback heals it even though the runtime itself no longer needs an update.
    const splitForCallback = new DatabaseSync(env.databasePath);
    splitForCallback.prepare(`UPDATE agents
      SET turn_control_json=json_set(turn_control_json, '$.target_provider_continuation_id', ?) WHERE agent_id=?`)
      .run(pendingContinuation, cursor.id);
    splitForCallback.close();
    const healed = await store.checkpointCursorProviderState(discovered.version, {
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

    await inbox.close();
    await bindings.close();
    await store.close();
    const reopened = new ManifestStore(env.databasePath);
    const reopenedEntry = await reopened.getEntry(cursor.id);
    assert.equal(reopenedEntry?.provider_ref?.provider_continuation_id, sessionContinuation);
    assert.equal(reopenedEntry?.turn_control?.target_provider_continuation_id, sessionContinuation);
    await reopened.close();
  } finally {
    await inbox.close().catch(() => undefined);
    await bindings.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("a successor runtime records the real session of a Cursor turn only after the runtime that started the turn has ended", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-08-05T09:45:00.000Z");
  const bindings = new WorkerBindingStore(env.legacyPath, undefined, env.databasePath);
  const pendingContinuation = "cursor-pending:successor";
  const sessionContinuation = "cursor-session:successor";
  const workAttemptId = "cursor-successor-attempt";
  const wrapperConnection = { kind: "cursor_cli" as const, url: null, serverAuthPath: null, pid: 4813, processIdentity: "cursor-wrapper:4813:birth" };
  const idleConnection = { kind: "cursor_cli" as const, url: null, serverAuthPath: null, pid: null, processIdentity: null };
  const cursor: DaemonManifestEntry = {
    ...entry,
    id: "cursor-successor",
    room_id: "cursor-successor-room",
    provider: "cursor",
    condition: "none",
    delivery_mode: "daemon_inbox",
    provider_ref: {
      work_attempt_id: workAttemptId,
      provider_continuation_id: pendingContinuation,
      provider_connection: null,
      execution_generation_id: "cursor-origin-generation",
    },
    work_attempt_id: workAttemptId,
    turn_control: undefined,
    last_turn_control_sequence: 0,
  };
  const database = new DatabaseSync(env.databasePath);
  try {
    let generation = (await store.write([cursor])).versions[cursor.id]!;
    const worker = await bindings.bind({
      entry_id: cursor.id, room_id: cursor.room_id, work_attempt_id: workAttemptId,
      execution_generation_id: "cursor-origin-generation", agent_session_id: "cursor-successor-worker",
      agent_session_token: "memory-only-test-token", api_url: "https://letagents.test",
    });
    const active = await inbox.enqueueCorrection({
      agent_id: cursor.id, room_id: cursor.room_id, source_message_id: "cursor-successor-message",
      source_message: { text: "A" }, activation: { decision: "activate" },
    });
    await inbox.claimHead(cursor.id);
    generation = (await store.checkpointCursorPreparedTurn(generation, {
      agentId: cursor.id, roomId: cursor.room_id, inboxItemId: active.inbox_item_id,
      providerTurnId: "cursor-successor-turn", providerContinuationId: pendingContinuation,
      workAttemptId, executionGenerationId: "cursor-origin-generation",
      agentSessionId: worker.agent_session_id, credentialRef: worker.credential_ref, apiUrl: worker.api_url,
      expectedProviderContinuationId: pendingContinuation, expectedProviderConnection: null,
      providerConnection: wrapperConnection, configurationRevision: 1, requestedAuthorityMode: "typed",
      observedAt: "2026-08-05T09:45:00.100Z",
    })).version;

    // The lane restarts in the same work attempt, as it does after a turn that never reported init.
    database.prepare(`INSERT INTO work_attempts VALUES(?,'task','lease',1,'/successor','repo','remote','revision','/bare','active',?,NULL,NULL,NULL)`)
      .run(workAttemptId, "2026-08-05T09:45:00.000Z");
    database.prepare("INSERT INTO work_attempt_executions VALUES('cursor-origin-generation',?,?,'test',1,NULL)").run(workAttemptId, "2026-08-05T09:45:00.000Z");
    const successor: DaemonManifestEntry = {
      ...cursor,
      provider_ref: { ...cursor.provider_ref!, provider_connection: idleConnection, execution_generation_id: "cursor-successor-generation" },
    };
    generation = (await store.write([successor])).versions[cursor.id]!;
    const successorWorker = await bindings.bind({
      entry_id: cursor.id, room_id: cursor.room_id, work_attempt_id: workAttemptId,
      execution_generation_id: "cursor-successor-generation", agent_session_id: worker.agent_session_id,
      agent_session_token: "memory-only-test-token", api_url: worker.api_url,
    });
    const recover = (expectedGeneration: number) => store.checkpointCursorProviderState(expectedGeneration, {
      agentId: cursor.id, roomId: cursor.room_id, inboxItemId: active.inbox_item_id,
      providerTurnId: "cursor-successor-turn", workAttemptId, executionGenerationId: "cursor-successor-generation",
      agentSessionId: successorWorker.agent_session_id, credentialRef: successorWorker.credential_ref, apiUrl: successorWorker.api_url,
      expectedProviderContinuationId: pendingContinuation, expectedProviderConnection: idleConnection,
      providerContinuationId: sessionContinuation, providerConnection: idleConnection,
      observedAt: "2026-08-05T09:45:01.000Z",
    });
    await assert.rejects(recover(generation), /durable provider-turn authority binding/,
      "nothing yet proves that the turn's own runtime ended");
    assert.equal((await inbox.providerTurnBinding(active.inbox_item_id))?.provider_continuation_id, pendingContinuation);

    database.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='cursor-origin-generation'")
      .run(JSON.stringify({ ended_at: "2026-08-05T09:45:00.900Z", terminal_cause: "protocol_error" }));
    const recovered = await recover(generation);
    assert.equal(recovered.entry.provider_ref?.provider_continuation_id, sessionContinuation);
    const binding = await inbox.providerTurnBinding(active.inbox_item_id);
    assert.equal(binding?.provider_continuation_id, sessionContinuation);
    assert.equal(binding?.origin_execution_generation_id, "cursor-origin-generation", "the turn stays bound to the runtime that started it");
  } finally {
    database.close();
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
    let generation = (await store.write([controlled])).versions[controlled.id]!;
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
    generation = prepared.version;
    let retryable = await store.replaceEntry(generation, {
      ...prepared.entry,
      turn_control: { ...prepared.entry.turn_control!, status: "retryable", error: "retry" },
    });
    generation = retryable.version;
    const retry = await prepare("control-1", 1);
    assert.equal(retry.entry.turn_control?.action_sequence, 1, "an exact retry reuses the current sequence");
    generation = retry.version;
    const completed = await store.replaceEntry(generation, {
      ...retry.entry,
      turn_control: { ...retry.entry.turn_control!, status: "completed", error: null },
    });
    generation = completed.version;
    await assert.rejects(() => prepare("stale-sequence", 1), /exact next durable value/i);
    await assert.rejects(() => prepare("sequence-gap", 3), /exact next durable value/i);

    for (let sequence = 2; sequence <= 80; sequence += 1) {
      prepared = await prepare(`control-${sequence}`, sequence);
      generation = prepared.version;
      retryable = await store.replaceEntry(generation, {
        ...prepared.entry,
        turn_control: { ...prepared.entry.turn_control!, status: "completed", error: null },
      });
      generation = retryable.version;
    }
    const latest = (await store.getEntry(controlled.id))!;
    await assert.rejects(() => store.replaceEntry(generation, {
      ...latest,
      turn_control: { ...latest.turn_control!, action_id: "stale-control-79", action_sequence: 79 },
    }), /exactly match its durable sequence watermark/i,
    "a stale flat projection cannot move the current journal behind the lifetime watermark");
    const beforeReopen = new DatabaseSync(env.databasePath);
    assert.equal(Number((beforeReopen.prepare("SELECT last_turn_control_sequence FROM agents WHERE agent_id=?").get(entry.id) as { last_turn_control_sequence: number }).last_turn_control_sequence), 80);
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
    generation = (await store.write([controlled])).versions[controlled.id]!;
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
      const dispatching = await store.replaceEntry(prepared.version, {
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
        predecessor.prepare("UPDATE effects SET state='prepared',error=NULL WHERE effect_id=?")
          .run(effectId);
        predecessor.close();
      }

      const committed = await store.commitTurnControlState(dispatching.version, {
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
      generation = committed.version;
    }

    const inspection = new DatabaseSync(env.databasePath);
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM inbox_items
      WHERE agent_id=? AND state='cancelled_by_user'`).get(controlled.id) as { count: number }).count), 200,
    "Stop completion itself enforces the exact terminal-receipt budget at quiescence");
    assert.ok(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_inbox_events e
      JOIN inbox_items i USING (inbox_item_id) WHERE i.agent_id=?`).get(controlled.id) as { count: number }).count) <= 800,
    "cascading event history remains bounded with its 200 retained owners");
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_provider_turn_bindings
      WHERE agent_id=?`).get(controlled.id) as { count: number }).count), 200);
    assert.equal(inspection.prepare("SELECT 1 FROM inbox_items WHERE inbox_item_id=?").get(firstInboxItemId), undefined,
      "the oldest unpinned Stop receipt is pruned");
    assert.ok(inspection.prepare("SELECT 1 FROM inbox_items WHERE inbox_item_id=?").get(currentInboxItemId),
      "the current completed control keeps its exact target inside the fixed budget");
    assert.equal((inspection.prepare("SELECT state FROM effects WHERE effect_id=?").get(predecessorEffectId) as { state: string }).state, "failed",
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

