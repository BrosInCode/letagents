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
      configurationRevision: 1,
      requestedAuthorityMode: "typed_shadow",
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
