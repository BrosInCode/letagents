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
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonManifest, DaemonManifestEntry, LegacyLaneOwner } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";

const TEST_PROVIDER_TURN_AUTHORITY = {
  work_attempt_id: "attempt_1",
  origin_execution_generation_id: "run_1",
  provider_continuation_id: "thread_1",
} as const;

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
