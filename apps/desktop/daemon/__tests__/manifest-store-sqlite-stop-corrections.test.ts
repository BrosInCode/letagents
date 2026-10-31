import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { ManifestStore } from "../manifest-store.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { RoomWorkPublicationStore } from "../room-work-publication-store.js";
import type { DaemonManifestEntry } from "../types.js";
import {
  TEST_PROVIDER_TURN_AUTHORITY,
  entry,
  fixture,
  seedTerminalExecution,
} from "./helpers/manifest-store-sqlite-fixture.js";

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

test("a native reply winning Stop preserves its intercepted thread choice across restart", async () => {
  for (const toolName of ["send_thread_message", "set_reply_thread"]) {
    const env = await fixture();
    const store = new ManifestStore(env.databasePath);
    let inbox = new SupervisedAgentInboxStore(env.databasePath);
    const controlled: DaemonManifestEntry = {
      ...entry, condition: "none", delivery_mode: "daemon_inbox", turn_control: undefined, last_turn_control_sequence: 0,
      provider_ref: { ...entry.provider_ref!, provider_connection: {
        kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "codex:4311",
      } },
    };
    try {
      const initial = await store.write(0, [controlled]);
      const [item] = await inbox.ingestPoll({ agent_id: controlled.id, room_id: controlled.room_id, last_observed_message_id: "msg_72",
        messages: [{ source_message_id: "msg_72", source_message: { id: "msg_72", text: "check in this thread" }, activation: { decision: "activate" } }] });
      assert.ok(item);
      await inbox.claimHead(controlled.id);
      await inbox.checkpointTurnStarted(item.inbox_item_id, "turn-A", TEST_PROVIDER_TURN_AUTHORITY);
      const prepared = await inbox.prepareEffect({
        agent_id: controlled.id, room_id: controlled.room_id, execution_generation_id: "run_1",
        work_attempt_id: "attempt_1", current_execution_generation_id: "run_1", provider_continuation_id: "thread_1",
        provider_turn_id: "turn-A", mcp_request_id: "thread-choice", tool_name: toolName,
        request: toolName === "set_reply_thread" ? {} : { thread_parent_id: "msg_72", text: "draft" }, mutation: true,
      });
      assert.equal(await inbox.hasInterceptedThreadReply(item.inbox_item_id), true);
      const control = await store.prepareTurnControlState(initial.generation, {
        agentId: controlled.id, roomId: controlled.room_id, expectedInboxItemId: item.inbox_item_id,
        expectedSourceMessageId: "msg_72", expectedProviderTurnId: "turn-A", actionId: "stop", actionSequence: 1,
        workAttemptId: "attempt_1", executionGenerationId: "run_1", providerContinuationId: "thread_1",
        providerConnection: controlled.provider_ref!.provider_connection, deliveryMode: "daemon_inbox",
        hasCorrection: false, correctionText: null, correctionStrategy: null, capability: "native_interrupt",
        recordedAt: new Date().toISOString(),
      });
      const db = new DatabaseSync(env.databasePath);
      try { assert.equal(db.prepare("SELECT state FROM supervised_agent_effects WHERE effect_id=?").get(prepared.effect.effect_id)?.state, toolName === "set_reply_thread" ? "completed" : "failed"); }
      finally { db.close(); }
      await inbox.checkpointNormalizedTerminal({ inbox_item_id: item.inbox_item_id, agent_id: controlled.id,
        execution_generation_id: "run_1", provider_turn_id: "turn-A", outcome: "reply", text: "final answer", evidence: "stream",
        terminal_evidence: { turnId: "turn-A", providerContinuationId: "thread_1", outcome: "reply", text: "final answer", evidence: "stream" } });
      const dispatching = await store.replaceEntry(control.generation, { ...control.entry,
        turn_control: { ...control.entry.turn_control!, status: "dispatching", stages: ["interrupting"] } });
      const resolved = await store.commitTurnControlState(dispatching.generation, {
        agentId: controlled.id, roomId: controlled.room_id, actionId: "stop", workAttemptId: "attempt_1",
        executionGenerationId: "run_1", mode: "native_applied", settleOriginal: true, activateCorrection: false,
        observedAt: new Date().toISOString(),
      }, current => ({ ...current, turn_control: { ...current.turn_control!, status: "completed", interrupted: false,
        resumed: false, state: "idle", stages: ["applied"] } }));
      assert.equal(resolved.original, "publication_won");
      await inbox.close(); inbox = new SupervisedAgentInboxStore(env.databasePath);
      assert.equal(await inbox.hasInterceptedThreadReply(item.inbox_item_id), true);
      assert.equal((await inbox.get(item.inbox_item_id))?.reply_client_message_id, item.reply_client_message_id);
    } finally { await inbox.close(); await store.close(); await env.cleanup(); }
  }
});

test("a durable grouped no-reply winning Stop settles its exact members through shared terminal recovery", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath);
  const controlled: DaemonManifestEntry = { ...entry, condition: "none", delivery_mode: "daemon_inbox", turn_control: undefined,
    last_turn_control_sequence: 0, provider_ref: { ...entry.provider_ref!, provider_connection: {
      kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "codex:4311" } } };
  try {
    const initial = await store.write(0, [controlled]);
    const messages = [72, 73].map(n => ({ source_message_id: `msg_${n}`,
      source_message: { id: `msg_${n}`, text: `My view ${n}.`, source: "agent", sender: `Peer ${n}`, thread_root_id: "msg_1",
        agent_identity: { actor_label: `Peer ${n}`, agent_key: `owner/peer${n}` } },
      activation: { decision: "activate", reason: "thread_participant" } }));
    await inbox.ingestPoll({ agent_id: controlled.id, room_id: controlled.room_id, last_observed_message_id: "msg_73", messages });
    const db = new DatabaseSync(env.databasePath);
    try {
      new RoomWorkPublicationStore(db).pin({ agentId: controlled.id, roomId: controlled.room_id, apiOrigin: "https://letagents.test",
        agentKey: "owner/self", agentInstanceId: `daemon:${controlled.id}`, hostId: "host", installationId: "installation", sourceSessionId: "session" }, ["msg_72", "msg_73"]);
    } finally { db.close(); }
    const head = (await inbox.claimHead(controlled.id))!;
    assert.ok(head.activation.queued_peer_messages);
    await inbox.checkpointTurnStarted(head.inbox_item_id, "turn-A", TEST_PROVIDER_TURN_AUTHORITY);
    const control = await store.prepareTurnControlState(initial.generation, {
      agentId: controlled.id, roomId: controlled.room_id, expectedInboxItemId: head.inbox_item_id, expectedSourceMessageId: "msg_72",
      expectedProviderTurnId: "turn-A", actionId: "stop", actionSequence: 1, workAttemptId: "attempt_1", executionGenerationId: "run_1",
      providerContinuationId: "thread_1", providerConnection: controlled.provider_ref!.provider_connection, deliveryMode: "daemon_inbox",
      hasCorrection: false, correctionText: null, correctionStrategy: null, capability: "native_interrupt", recordedAt: new Date().toISOString(),
    });
    await inbox.checkpointNormalizedTerminal({ inbox_item_id: head.inbox_item_id, agent_id: controlled.id, execution_generation_id: "run_1",
      provider_turn_id: "turn-A", outcome: "no_reply", text: null, evidence: "stream",
      terminal_evidence: { turnId: "turn-A", providerContinuationId: "thread_1", outcome: "no_reply", text: null, evidence: "stream" } });
    const dispatching = await store.replaceEntry(control.generation, { ...control.entry,
      turn_control: { ...control.entry.turn_control!, status: "dispatching", stages: ["interrupting"] } });
    await store.commitTurnControlState(dispatching.generation, { agentId: controlled.id, roomId: controlled.room_id, actionId: "stop",
      workAttemptId: "attempt_1", executionGenerationId: "run_1", mode: "native_applied", settleOriginal: true, activateCorrection: false,
      observedAt: new Date().toISOString(),
    }, current => ({ ...current, turn_control: { ...current.turn_control!, status: "completed", interrupted: false, resumed: false, state: "idle", stages: ["applied"] } }));
    assert.equal((await inbox.get(head.inbox_item_id))!.state, "acknowledged_no_reply");
    const child = (await inbox.getBySourceMessage(controlled.id, controlled.room_id, "msg_73"))!;
    assert.equal(child.state, "acknowledged_no_reply"); assert.equal(child.attempt_count, 0); assert.equal(child.provider_turn_id, null);
    const proof = new DatabaseSync(env.databasePath);
    try {
      assert.ok(proof.prepare("SELECT 1 FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND idempotency_key='peer_batch_report:pending'").get(child.inbox_item_id));
      assert.equal(proof.prepare("SELECT 1 FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?").get(child.inbox_item_id), undefined);
    } finally { proof.close(); }
  } finally { await inbox.close(); await store.close(); await env.cleanup(); }
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
