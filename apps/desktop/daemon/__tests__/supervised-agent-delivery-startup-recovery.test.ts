import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SupervisorDaemon } from "../main.js";
import { ManifestStore } from "../manifest-store.js";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import {
  agent,
  currentAuthority,
  TEST_PROVIDER_TURN_AUTHORITY,
  provider,
  waitForAsync,
  installCursorCompletionProjectionFixture,
  daemonRequest,
  enqueue,
  ingest,
  recordExecution,
} from "./helpers/supervised-agent-delivery-fixture.js";
import { testDaemonEndpoint } from "./helpers/daemon-fixture.js";

test("daemon socket restores and skips only exact pre-turn authority without replacing the provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-restore-socket-"));
  let daemon: SupervisorDaemon | null = null;
  try {
    const paths = {
      lockPath: join(root, "daemon.lock"), ...testDaemonEndpoint(root),
      manifestPath: join(root, "daemon.sqlite"), auditPath: join(root, "audit.log"),
      attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempts"),
      workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
    };
    const identity = {
      attempt: "00000000-0000-4000-8000-000000000031",
      execution: "00000000-0000-4000-8000-000000000032",
      session: "00000000-0000-4000-8000-000000000033",
    };
    const connection = {
      kind: "codex_app_server" as const,
      url: "http://127.0.0.1:43131",
      pid: 43131,
      processIdentity: "pid:43131:birth:durable",
    };
    const liveHandle = {
      workAttemptId: identity.attempt,
      providerContinuationId: "thread-missing",
      pid: connection.pid,
      providerConnection: connection,
      appliedConfigurationRevision: 1,
      observedState: "idle" as const,
    };
    let repairs = 0;
    let turns = 0;
    const durableCheckpoints: string[] = [];
    daemon = new SupervisorDaemon(
      paths,
      "darwin",
      provider(
        async (handle, _request, options) => {
          turns += 1;
          assert.equal(handle, liveHandle, "repair promotes the same live provider handle");
          assert.equal(handle.pid, connection.pid);
          assert.equal(handle.providerConnection?.processIdentity, connection.processIdentity);
          await options?.checkpointTurnStarted?.("turn-after-repair");
          return { turnId: "turn-after-repair", outcome: "no_reply", text: null };
        },
        undefined,
        async (handle, request, options) => {
          repairs += 1;
          assert.equal(handle, liveHandle);
          assert.equal(request.expectedProviderContinuationId, "thread-missing");
          assert.equal(request.workAttemptId, identity.attempt);
          await options.checkpointReplacement("thread-replacement");
          liveHandle.providerContinuationId = "thread-replacement";
          return {
            handle: liveHandle,
            outcome: "replaced",
            previousProviderContinuationId: "thread-missing",
            replacementProviderContinuationId: "thread-replacement",
          };
        },
      ),
      false,
      60_000,
      undefined,
      {},
      {
        poll: ({ signal }) => new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({}), { once: true });
        }),
        publish: async () => { throw new Error("no-reply turn must not publish"); },
      },
    );
    const internals = daemon as unknown as {
      liveHandles: Map<string, typeof liveHandle>;
      store: ManifestStore;
      manifestGeneration: number;
      supervisedInbox: SupervisedAgentInboxStore;
      workerBindings: { bind(input: Record<string, string>): Promise<unknown> };
      durability: {
        getAttempt(id: string): Promise<{ work_attempt_id: string; checkpoints: Array<{ provider_continuation_id: string | null }> }>;
        checkpoint(id: string, input: { provider_continuation_id: string | null }): Promise<void>;
      };
    };
    await daemon.start();
    internals.durability.getAttempt = async (id) => {
      assert.equal(id, identity.attempt);
      return {
        work_attempt_id: id,
        checkpoints: durableCheckpoints.map((provider_continuation_id) => ({ provider_continuation_id })),
      };
    };
    internals.durability.checkpoint = async (id, checkpoint) => {
      assert.equal(id, identity.attempt);
      assert.ok(checkpoint.provider_continuation_id);
      durableCheckpoints.push(checkpoint.provider_continuation_id);
    };
    const manifestEntry = {
        id: "stone", room_id: "room", display_name: "Stone", provider: "codex",
        model: "gpt-5.6-sol", charter: "test", desired_state: "running",
        observed_state: "idle", condition: "none", permission_profile_id: null,
        delivery_mode: "daemon_inbox", created_by: "test", created_at: new Date().toISOString(),
        workspace_path: root, work_attempt_id: identity.attempt,
        provider_ref: {
          work_attempt_id: identity.attempt,
          provider_continuation_id: "thread-missing",
          provider_connection: connection,
          execution_generation_id: identity.execution,
        },
      } as const;
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: manifestEntry });
    assert.equal(put.ok, true, put.error);
    const manifestDatabase = (internals.store as unknown as { database: DatabaseSync }).database;
    manifestDatabase.prepare(`INSERT INTO work_attempts(
      work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,
      workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      identity.attempt,
      "task-restore",
      "lease-restore",
      1,
      root,
      "repo",
      "remote",
      "revision",
      root,
      "active",
      new Date().toISOString(),
    );
    manifestDatabase.prepare(`INSERT INTO work_attempt_executions(
      execution_generation_id,work_attempt_id,started_at,actor,generation,terminal_json
    ) VALUES(?,?,?,?,?,NULL)`).run(
      identity.execution,
      identity.attempt,
      new Date().toISOString(),
      "test",
      1,
    );
    const snapshot = await internals.store.load();
    const birth = await internals.store.checkpointProviderBirth(snapshot.generation, {
      entry: manifestEntry,
      executionGenerationId: identity.execution,
      providerConnection: connection,
      appliedRevision: 1,
      requestedAuthorityMode: "typed_shadow",
      observedAtMs: Date.now(),
    });
    internals.manifestGeneration = birth.generation;
    internals.liveHandles.set("stone", liveHandle);
    await internals.workerBindings.bind({
      entry_id: "stone", room_id: "room", work_attempt_id: identity.attempt,
      execution_generation_id: identity.execution, agent_session_id: identity.session,
      agent_session_token: "stone-token", api_url: "https://letagents.test",
    });
    await internals.supervisedInbox.ingestPoll({
      agent_id: "stone", room_id: "room", last_observed_message_id: "msg_1",
      messages: [{ source_message_id: "msg_1", source_message: { id: "msg_1" }, activation: {} }],
    });
    const blocked = await internals.supervisedInbox.claimHead("stone");
    await internals.supervisedInbox.transition(blocked!.inbox_item_id, "blocked", {
      failure_code: "provider_continuation_missing",
      last_error: "thread not found: 00000000-0000-4000-8000-000000000099",
    });
    const generation = (await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number };
    const exact = {
      entry_id: "stone", room_id: "room", source_message_id: "msg_1",
      work_attempt_id: identity.attempt, execution_generation_id: identity.execution,
      agent_session_id: identity.session, daemon_generation: generation.generation,
    };
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.restore_agent_conversation", {
      ...exact,
      daemon_generation: generation.generation + 1,
    })).ok, false, "stale daemon generations fail before any repair side effect");

    const originalProcessIdentity = liveHandle.providerConnection.processIdentity;
    liveHandle.providerConnection = { ...connection, processIdentity: "pid:43131:birth:reused" };
    assert.equal(
      (await daemonRequest(paths.socketPath, "supervisor.restore_agent_conversation", exact)).ok,
      false,
      "changed process identity fails closed",
    );
    liveHandle.providerConnection = { ...connection, processIdentity: originalProcessIdentity };

    const concurrent = await Promise.all([
      daemonRequest(paths.socketPath, "supervisor.restore_agent_conversation", exact),
      daemonRequest(paths.socketPath, "supervisor.restore_agent_conversation", exact),
    ]);
    assert.equal(concurrent.filter((response) => response.ok).length, 1, "only one concurrent restore owns the blocked head");
    await waitForAsync(async () =>
      (await internals.supervisedInbox.receipts("stone"))[0]?.state === "acknowledged_no_reply",
    );
    const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{
      id: string;
      work_attempt_id?: string;
      provider_ref?: {
        provider_continuation_id: string;
        execution_generation_id: string;
        provider_connection: { pid: number | null; processIdentity?: string | null };
      };
    }>;
    const restored = manifest.find((entry) => entry.id === "stone")!;
    assert.equal(restored.work_attempt_id, identity.attempt);
    assert.equal(restored.provider_ref?.execution_generation_id, identity.execution);
    assert.equal(restored.provider_ref?.provider_continuation_id, "thread-replacement");
    assert.equal(restored.provider_ref?.provider_connection.pid, connection.pid);
    assert.equal(restored.provider_ref?.provider_connection.processIdentity, connection.processIdentity);
    assert.deepEqual(durableCheckpoints, ["thread-replacement"]);
    assert.equal(repairs, 1);
    assert.equal(turns, 1);

    await internals.supervisedInbox.ingestPoll({
      agent_id: "stone", room_id: "room", last_observed_message_id: "msg_2",
      messages: [{ source_message_id: "msg_2", source_message: { id: "msg_2" }, activation: {} }],
    });
    const skippable = await internals.supervisedInbox.claimHead("stone");
    await internals.supervisedInbox.transition(skippable!.inbox_item_id, "blocked", { last_error: "safe pre-turn block" });
    const attention = async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{
      id: string; delivery_attention?: { source_message_id: string; retry: string; can_skip: boolean; skip_unavailable_reason: string | null } | null;
    }>).find((entry) => entry.id === "stone")?.delivery_attention;
    assert.deepEqual(await attention(), { reason: "message_blocked", source_message_id: "msg_2", blocked_since: (await internals.supervisedInbox.get(skippable!.inbox_item_id))!.updated_at,
      detail: "safe pre-turn block", waiting_count: 0, provider_work_started: false, retry: "start_turn", can_skip: true, skip_unavailable_reason: null });
    const skipExact = { ...exact, source_message_id: "msg_2" };
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.skip_room_delivery", skipExact)).ok, true);
    assert.equal((await internals.supervisedInbox.get(skippable!.inbox_item_id))?.state, "cancelled_by_user");

    await internals.supervisedInbox.ingestPoll({
      agent_id: "stone", room_id: "room", last_observed_message_id: "msg_3",
      messages: [{ source_message_id: "msg_3", source_message: { id: "msg_3" }, activation: {} }],
    });
    const ambiguous = await internals.supervisedInbox.claimHead("stone");
    // The turn ran in the agent's current conversation and has no terminal
    // result, so it may still be running there.
    await internals.supervisedInbox.checkpointTurnStarted(ambiguous!.inbox_item_id, "turn-ambiguous", {
      work_attempt_id: identity.attempt,
      origin_execution_generation_id: identity.execution,
      provider_continuation_id: "thread-replacement",
    });
    await internals.supervisedInbox.transition(ambiguous!.inbox_item_id, "blocked", { last_error: "ambiguous native result" });
    assert.equal(
      (await daemonRequest(paths.socketPath, "supervisor.skip_room_delivery", {
        ...exact,
        source_message_id: "msg_3",
      })).ok,
      false,
      "skip is unavailable while a started provider turn may still be running",
    );
    const refused = await attention();
    assert.deepEqual([refused?.source_message_id, refused?.retry, refused?.can_skip], ["msg_3", "reread_saved_turn", false]);
    assert.match(refused?.skip_unavailable_reason ?? "", /may still be running/);

    await daemon.stop();
    daemon = null;
  } finally {
    await daemon?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("exact native failure settles once, advances FIFO, and survives cleanup errors and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-native-terminal-"));
  try {
    for (const outcome of ["failed", "interrupted"] as const) {
      for (const cleanupFails of [false, true]) {
        const path = join(root, `${outcome}-${cleanupFails}.sqlite`);
        let store = new SupervisedAgentInboxStore(path);
        let runs = 0;
        let recoveries = 0;
        const port = provider(async (_handle, _request, options) => {
          runs += 1;
          await options?.beforeNativeDispatch?.();
          const turnId = `turn-${runs}`;
          await options?.checkpointTurnStarted?.(turnId);
          if (runs > 1) return { turnId, outcome: "no_reply", text: null };
          const result = { turnId, providerContinuationId: "thread", outcome, text: null, evidence: "stream" as const };
          const checkpoint = await options?.checkpointTerminalResult?.(result);
          assert.equal(checkpoint?.acceptedResult.outcome, outcome);
          assert.equal(checkpoint?.cleanupRecoveryEvidence, true);
          if (cleanupFails) throw new Error("native journal cleanup unavailable after terminal commit");
          return result;
        }, async () => { recoveries += 1; throw new Error("must not re-read a settled native failure"); });
        const http = { poll: async () => ({}), publish: async () => { throw new Error("failure has no room reply"); } };
        const snapshots: string[] = [];
        const delivery = new SupervisedAgentDelivery(store, port, http, currentAuthority,
          undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
          async (_agent, source) => { snapshots.push(source); });
        try {
          await delivery.pump(agent);
          await ingest(store, "1"); await ingest(store, "2");
          await delivery.pump(agent);
          const receipts = await store.receipts(agent.agentId);
          assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply"]);
          assert.deepEqual(snapshots, ["1", "2"], "settled failures capture changes even when adapter cleanup rejects");
          assert.equal(JSON.parse(receipts[0]!.outcome!).kind, outcome);
          assert.equal(receipts[0]!.canonical_message_id, null);
          assert.equal(receipts[0]!.attempt_count, 1);
          assert.equal(receipts[0]!.timeline.filter((event) => event.phase === "turn_finished").length, 1);
          assert.equal(receipts[0]!.timeline.some((event) => ["retry_scheduled", "published", "no_reply"].includes(event.phase)), false);
          await delivery.fenceAndDrain(); await store.close();
          store = new SupervisedAgentInboxStore(path);
          const reopened = new SupervisedAgentDelivery(store, port, http, currentAuthority);
          await reopened.pump({ ...agent, executionGenerationId: "generation-2", daemonGeneration: 2 });
          assert.equal(runs, 2); assert.equal(recoveries, 0);
          assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_failed");
          await reopened.fenceAndDrain();
        } finally { await delivery.fenceAndDrain(); await store.close(); }
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native failure cannot invent a dispatch checkpoint or use another continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-invalid-terminal-"));
  try {
    for (const defect of ["missing_dispatch", "wrong_continuation"] as const) {
      const store = new SupervisedAgentInboxStore(join(root, `${defect}.sqlite`));
      let runs = 0;
      const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
        runs += 1;
        if (defect !== "missing_dispatch") await options?.checkpointTurnStarted?.("turn");
        return { turnId: "turn", providerContinuationId: defect === "wrong_continuation" ? "other" : "thread",
          outcome: "failed", text: null, evidence: "stream" };
      }, async () => { throw Object.assign(new Error("exact native state unknown"), { roomTurnRecoveryOutcome: "ambiguous" }); }),
      { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority, 1, async () => {});
      try {
        await delivery.pump(agent); await ingest(store); await delivery.pump(agent);
        const receipt = (await store.receipts(agent.agentId))[0]!;
        assert.equal(receipt.state, "blocked"); assert.equal(receipt.outcome, null); assert.equal(runs, 1);
        assert.equal(await store.nativeFailure(receipt.inbox_item_id), null);
      } finally { await delivery.fenceAndDrain(); await store.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a saved reply or Cursor completion proposal wins a late exact native failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-terminal-winner-"));
  try {
    for (const candidate of ["codex", "cursor"]) {
      const store = new SupervisedAgentInboxStore(join(root, `${candidate}.sqlite`));
      const recordCompletion = installCursorCompletionProjectionFixture(store);
      const published: string[] = [];
      const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
        await options?.checkpointTurnStarted?.("turn");
        if (candidate === "cursor") {
          recordCompletion("turn", { outcome: "reply", text: "Saved answer." });
        } else {
          await options?.checkpointTerminalResult?.({ turnId: "turn", outcome: "reply", text: "Saved answer.", evidence: "stream" });
        }
        const failure = { turnId: "turn", providerContinuationId: "thread", outcome: "failed" as const, text: null, evidence: "stream" as const };
        const accepted = await options?.checkpointTerminalResult?.(failure);
        assert.equal(accepted?.acceptedResult.outcome, "reply");
        return failure;
      }), { poll: async () => ({}), publish: async ({ text, roomId }) => { published.push(text); return { roomId, messageId: "published" }; } }, currentAuthority);
      try {
        const currentAgent = { ...agent, provider: candidate };
        await delivery.pump(currentAgent); await ingest(store); await delivery.pump(currentAgent);
        assert.deepEqual(published, ["Saved answer."], candidate);
        assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
      } finally { await delivery.fenceAndDrain(); await store.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery republishes a durable publishing outcome without rerunning its provider turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-republish-recovery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite")); const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "turn", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(item.inbox_item_id, "awaiting_result", { outcome: JSON.stringify({ kind: "reply", text: "durable" }) });
    await store.transition(item.inbox_item_id, "publishing");
    let turns = 0; const published: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { turns += 1; throw new Error("provider must not rerun"); }), { poll: async () => ({}), publish: async ({ clientMessageId, roomId }) => { published.push(clientMessageId); return { messageId: `msg:${clientMessageId}`, roomId }; } }, currentAuthority);
    await delivery.pump(agent);
    assert.equal(turns, 0); assert.deepEqual(published, [item.reply_client_message_id]);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery treats a dispatching durable terminal outcome as republish-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-dispatch-recovery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite")); const item = await enqueue(store);
    await store.checkpointTerminalOutcome(item.inbox_item_id, JSON.stringify({ kind: "reply", text: "durable" }));
    let turns = 0; const published: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { turns += 1; throw new Error("provider must not rerun"); }), { poll: async () => ({}), publish: async ({ clientMessageId, roomId }) => { published.push(clientMessageId); return { messageId: `msg:${clientMessageId}`, roomId }; } }, currentAuthority);
    await delivery.pump(agent);
    assert.equal(turns, 0); assert.deepEqual(published, [item.reply_client_message_id]);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery reports a saved no-reply completion without running the provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-no-reply-report-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let delivery: SupervisedAgentDelivery | undefined;
  try {
    const item = await enqueue(store);
    await store.checkpointTerminalOutcome(item.inbox_item_id, JSON.stringify({ kind: "no_reply", text: null }));
    const hints: string[] = [];
    const unexpected = async (): Promise<never> => { assert.fail("saved no-reply must not run, recover or publish a model reply"); };
    delivery = new SupervisedAgentDelivery(store, provider(unexpected, unexpected),
      { poll: async () => ({}), publish: unexpected }, currentAuthority,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, id => { hints.push(id); });
    await delivery.pump(agent);
    assert.equal((await store.get(item.inbox_item_id))?.state, "acknowledged_no_reply");
    assert.deepEqual(hints, [agent.agentId]);
    await delivery.pump(agent);
    assert.deepEqual(hints, [agent.agentId], "unchanged idle pumping does not repeat the hint");
  } finally {
    await delivery?.fenceAndDrain();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup recovery blocks ambiguous awaiting and retryable work instead of acknowledging it", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-ambiguous-recovery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const first = await enqueue(store, "1");
    await store.checkpointTurnStarted(first.inbox_item_id, "turn", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(first.inbox_item_id, "awaiting_result");
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { throw new Error("must not run"); }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await delivery.pump(agent);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "blocked");
    await store.close();

    const retryStore = new SupervisedAgentInboxStore(join(root, "retry.sqlite")); const retry = await enqueue(retryStore, "1");
    await retryStore.checkpointTurnStarted(retry.inbox_item_id, "turn", TEST_PROVIDER_TURN_AUTHORITY);
    await retryStore.transition(retry.inbox_item_id, "awaiting_result");
    await retryStore.transition(retry.inbox_item_id, "retryable", { last_error: "lost response" });
    const retryDelivery = new SupervisedAgentDelivery(retryStore, provider(async () => { throw new Error("must not run"); }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await retryDelivery.pump(agent);
    assert.equal((await retryStore.receipts(agent.agentId))[0]?.state, "blocked");
    await retryStore.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery reattaches only a persisted exact provider turn and blocks ambiguity without rerunning", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-exact-recovery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "turn-exact", TEST_PROVIDER_TURN_AUTHORITY);
    let recoveries = 0; let newTurns = 0; const published: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(
      async () => { newTurns += 1; throw new Error("must not rerun"); },
      async (_handle, request) => { recoveries += 1; assert.equal(request.providerTurnId, "turn-exact"); return { turnId: "turn-exact", outcome: "reply", text: "recovered" }; },
    ), { poll: async () => ({}), publish: async (input) => { published.push(input.text); return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; } }, currentAuthority, 0);
    await delivery.pump(agent);
    assert.equal(recoveries, 1); assert.equal(newTurns, 0); assert.deepEqual(published, ["recovered"]);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
    await store.close();

    const ambiguousStore = new SupervisedAgentInboxStore(join(root, "ambiguous.sqlite"));
    const ambiguous = await enqueue(ambiguousStore);
    await ambiguousStore.checkpointTurnStarted(ambiguous.inbox_item_id, "turn-ambiguous", TEST_PROVIDER_TURN_AUTHORITY);
    const ambiguousDelivery = new SupervisedAgentDelivery(ambiguousStore, provider(
      async () => { throw new Error("must not rerun"); },
      async () => { throw Object.assign(new Error("exact turn missing"), { roomTurnRecoveryOutcome: "ambiguous" as const }); },
    ), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority, 0);
    await ambiguousDelivery.pump(agent);
    assert.equal((await ambiguousStore.receipts(agent.agentId))[0]?.state, "blocked");
    await ambiguousStore.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery rejects an exact turn after its provider continuation is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-continuation-swap-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "turn-old-continuation", {
      ...TEST_PROVIDER_TURN_AUTHORITY,
      provider_continuation_id: "thread-old",
    });
    await store.transition(item.inbox_item_id, "awaiting_result");
    let recoveries = 0;
    const successor = {
      ...agent,
      providerContinuationId: "thread-successor",
      handle: { ...agent.handle, providerContinuationId: "thread-successor" },
    };
    const delivery = new SupervisedAgentDelivery(store, provider(
      async () => { throw new Error("must not redispatch"); },
      async () => { recoveries += 1; throw new Error("must not recover through successor authority"); },
    ), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await delivery.pump(successor);
    assert.equal(recoveries, 0);
    const blocked = (await store.receipts(agent.agentId))[0]!;
    assert.equal(blocked.state, "blocked");
    assert.match(blocked.last_error ?? "", /different or unverifiable provider authority/i);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a saved turn is recovered as one whose process has ended only when a later runtime recovers it and that process's terminal is on record", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-process-ended-"));
  const { DatabaseSync } = await import("node:sqlite");
  try {
    /** Recover one saved turn of `generation-1` with a runtime of `runsIn`, the turn's own process ended or not. */
    const recover = async (name: string, runsIn: string, ended: boolean) => {
      const path = join(root, `${name}.sqlite`);
      const store = new SupervisedAgentInboxStore(path);
      const item = await enqueue(store);
      await store.checkpointTurnStarted(item.inbox_item_id, "turn-saved", TEST_PROVIDER_TURN_AUTHORITY);
      const database = new DatabaseSync(path);
      recordExecution(database, ended);
      database.close();
      const requests: Array<Record<string, unknown>> = [];
      const delivery = new SupervisedAgentDelivery(store, provider(
        async () => { throw new Error("must not rerun"); },
        async (_handle, request) => { requests.push({ ...request }); return { turnId: "turn-saved", outcome: "reply", text: "recovered" }; },
      ), { poll: async () => ({}), publish: async (input) => ({ messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }) }, currentAuthority, 0);
      await delivery.pump({ ...agent, executionGenerationId: runsIn });
      assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
      await store.close();
      return requests[0]!;
    };
    assert.equal((await recover("later-runtime-ended", "generation-2", true)).originProcessEnded, true);
    assert.equal((await recover("later-runtime-alive", "generation-2", false)).originProcessEnded, undefined,
      "a process with no recorded terminal may still be running the turn");
    assert.equal((await recover("own-runtime", "generation-1", true)).originProcessEnded, undefined,
      "a runtime is never told that its own process has ended");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a turn of a session an ended Open Model process ran is read in that session by its replacement; no other mismatch of authority is", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-earlier-session-"));
  const { DatabaseSync } = await import("node:sqlite");
  const reason = "The agent's process ended during this turn, and the turn's result could not be recovered. The message was not run again.";
  try {
    const recover = async (name: string, input: { provider: string; ended: boolean; workAttemptId?: string }) => {
      const path = join(root, `${name}.sqlite`);
      const store = new SupervisedAgentInboxStore(path);
      const item = await enqueue(store);
      await store.checkpointTurnStarted(item.inbox_item_id, "turn-old-session", { ...TEST_PROVIDER_TURN_AUTHORITY, provider_continuation_id: "session-old" });
      await store.transition(item.inbox_item_id, "awaiting_result");
      const database = new DatabaseSync(path);
      recordExecution(database, input.ended);
      database.close();
      const requests: Array<Record<string, unknown>> = [];
      const successor = { ...agent, provider: input.provider, executionGenerationId: "generation-2", providerContinuationId: "session-new",
        workAttemptId: input.workAttemptId ?? agent.workAttemptId,
        handle: { ...agent.handle, providerContinuationId: "session-new", workAttemptId: input.workAttemptId ?? agent.workAttemptId } };
      const delivery = new SupervisedAgentDelivery(store, provider(
        async () => { throw new Error("must not rerun"); },
        async (_handle, request, options) => {
          requests.push({ ...request });
          const result = { turnId: "turn-old-session", providerContinuationId: "session-old", outcome: "interrupted" as const, text: null, evidence: "transcript" as const, error: reason };
          await options?.checkpointTerminalResult?.(result);
          return result;
        },
      ), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority, 0);
      await delivery.pump(successor);
      const receipt = (await store.receipts(agent.agentId))[0]!;
      await store.close();
      return { receipt, requests };
    };
    const read = await recover("open-model-ended", { provider: "open-model", ended: true });
    assert.deepEqual(read.requests.map((request) => [request.providerTurnId, request.providerContinuationId, request.originProcessEnded]),
      [["turn-old-session", "session-old", true]], "the adapter is given the turn's own session");
    assert.equal(read.receipt.state, "acknowledged_failed");
    assert.equal(read.receipt.last_error, reason, "and the message settles with what the session showed");

    for (const [name, input] of Object.entries({
      "open-model-alive": { provider: "open-model", ended: false },
      "codex-ended": { provider: "codex", ended: true },
      "claude-ended": { provider: "claude-code", ended: true },
      "another-work-attempt": { provider: "open-model", ended: true, workAttemptId: "another-attempt" },
    })) {
      const refused = await recover(name, input);
      assert.deepEqual(refused.requests, [], `${name}: the turn is not read through another authority`);
      assert.equal(refused.receipt.state, "blocked", name);
      assert.match(refused.receipt.last_error ?? "", /different or unverifiable provider authority/i, name);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("same-continuation successor recovery preserves the provider turn's origin generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-origin-generation-"));
  try {
    const databasePath = join(root, "daemon.sqlite");
    const store = new SupervisedAgentInboxStore(databasePath);
    const item = await enqueue(store);
    const originExecutionGenerationId = "generation-origin";
    await store.checkpointTurnStarted(item.inbox_item_id, "turn-origin", {
      ...TEST_PROVIDER_TURN_AUTHORITY,
      origin_execution_generation_id: originExecutionGenerationId,
    });
    await store.transition(item.inbox_item_id, "awaiting_result");
    let recoveries = 0;
    const successor = {
      ...agent,
      executionGenerationId: "generation-successor",
      handle: { ...agent.handle },
    };
    const delivery = new SupervisedAgentDelivery(store, provider(
      async () => { throw new Error("must not redispatch"); },
      async (_handle, request) => {
        recoveries += 1;
        assert.equal(request.providerTurnId, "turn-origin");
        return { turnId: "turn-origin", outcome: "no_reply", text: null };
      },
    ), { poll: async () => ({}), publish: async () => { throw new Error("no reply must not publish"); } }, currentAuthority);
    await delivery.pump(successor);
    assert.equal(recoveries, 1);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
    await store.close();
    const inspection = new DatabaseSync(databasePath);
    try {
      assert.equal(
        (inspection.prepare("SELECT execution_generation_id FROM supervised_agent_terminal_results WHERE inbox_item_id=?")
          .get(item.inbox_item_id) as { execution_generation_id: string }).execution_generation_id,
        originExecutionGenerationId,
      );
    } finally { inspection.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery retries exactly once when wrapper evidence proves native dispatch never began", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-not-dispatched-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "cursor:prepared-only", TEST_PROVIDER_TURN_AUTHORITY);
    let recoveries = 0;
    let newTurns = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(
      async (_handle, _request, options) => {
        newTurns += 1;
        await options?.beforeNativeDispatch?.();
        await options?.checkpointTurnStarted?.("cursor:actual-turn");
        return { turnId: "cursor:actual-turn", outcome: "no_reply", text: null };
      },
      async () => {
        recoveries += 1;
        throw Object.assign(new Error("prepared wrapper never released"), {
          roomTurnRecoveryOutcome: "not_dispatched" as const,
        });
      },
    ), {
      poll: async () => ({}),
      publish: async () => { throw new Error("no-reply must not publish"); },
    }, currentAuthority, 0);

    await delivery.pump(agent);

    const receipt = (await store.receipts(agent.agentId))[0]!;
    assert.equal(recoveries, 1);
    assert.equal(newTurns, 1);
    assert.equal(receipt.state, "acknowledged_no_reply");
    assert.equal(receipt.provider_turn_id, "cursor:actual-turn");
    assert.equal(receipt.attempt_count, 1, "the never-dispatched wrapper did not consume a model attempt");
    assert.equal(receipt.timeline.filter((event) => event.phase === "retry_scheduled").length, 1);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const admitted of [false, true]) test(`persistent undispatched wrapper failures are bounded (turn admitted: ${admitted})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-not-dispatched-cap-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    await ingest(store);
    let turns = 0;
    const delays: number[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(
      async (_handle, _request, options) => {
        turns += 1;
        await options?.beforeNativeDispatch?.();
        if (admitted) await options?.checkpointTurnStarted?.(`cursor:prepared-only:${turns}`);
        throw Object.assign(new Error("persistent pre-release provider checkpoint failure"), {
          roomTurnRecoveryOutcome: "not_dispatched" as const,
        });
      },
    ), {
      poll: async () => ({}),
      publish: async () => { throw new Error("an undispatched turn cannot publish"); },
    }, currentAuthority, 10, async (ms) => { delays.push(ms); });

    await delivery.pump({ ...agent, provider: "cursor" });

    const receipt = (await store.receipts(agent.agentId))[0]!;
    assert.equal(turns, 3, "safe redispatch is capped at the same three-attempt budget as ordinary delivery");
    assert.deepEqual(delays, [10, 20], "undispatched retries use exponential backoff");
    assert.equal(receipt.state, "blocked");
    assert.equal(receipt.timeline.filter((event) => event.phase === "retry_scheduled").length, 3,
      "the exhausted failure is journaled atomically with its block");
    assert.match(receipt.last_error ?? "", /failed 3 times/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed Cursor idle compensation spends only recovery budget and retains exact authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-compensation-budget-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  try {
    const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "cursor:prepared", TEST_PROVIDER_TURN_AUTHORITY);
    const binding = await store.providerTurnBinding(item.inbox_item_id);
    let recoveries = 0; let compensations = 0; const delays: number[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(
      async () => { throw new Error("must never redispatch before compensation succeeds"); },
      async () => {
        recoveries += 1;
        throw Object.assign(new Error("wrapper never released"), { roomTurnRecoveryOutcome: "not_dispatched" });
      },
    ), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority,
    10, async (ms) => { delays.push(ms); }, undefined, undefined, undefined, undefined,
    async () => { compensations += 1; throw new Error("idle checkpoint unavailable"); });
    await delivery.pump({ ...agent, provider: "cursor" });
    assert.equal(recoveries, 3); assert.equal(compensations, 3);
    assert.deepEqual(delays, [10, 20]);
    const blocked = (await store.receipts(agent.agentId))[0]!;
    assert.equal(blocked.state, "blocked"); assert.equal(blocked.provider_turn_id, "cursor:prepared");
    assert.deepEqual(await store.providerTurnBinding(item.inbox_item_id), binding);
    const inspection = new DatabaseSync(join(root, "daemon.sqlite"));
    try {
      const events = inspection.prepare("SELECT idempotency_key FROM supervised_agent_inbox_events WHERE phase='retry_scheduled'").all();
      assert.deepEqual(events.map((event) => event.idempotency_key), [1, 2, 3].map((ordinal) => `retry_failure:result_recovery:${ordinal}`));
    } finally { inspection.close(); }
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a checkpointed terminal provider rejection settles failed and advances FIFO without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-terminal-provider-failure-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const bidiControls = [
      "\u061c", "\u200e", "\u200f",
      "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
      "\u2066", "\u2067", "\u2068", "\u2069",
    ];
    const disguisedCredentials = bidiControls.map((control, index) => (
      index % 2 === 0
        ? `to${control}ken=secret-${index}-value`
        : `api_${control}key=secret-${index}-value`
    )).join(" ");
    const redactedCredentials = bidiControls.map((_control, index) => (
      index % 2 === 0 ? "token=[REDACTED]" : "api_key=[REDACTED]"
    )).join(" ");
    const expectedProviderError = `Open Model request failed at the model provider (HTTP 404): expired model. ${redactedCredentials}`;
    let turns = 0;
    let recoveries = 0;
    const delivery = new SupervisedAgentDelivery(
      store,
      provider(async (_handle, _request, options) => {
        turns += 1;
        await options?.beforeNativeDispatch?.();
        const turnId = `turn-${turns}`;
        await options?.checkpointTurnStarted?.(turnId);
        if (turns > 1) return { turnId, outcome: "no_reply", text: null };
        await options?.checkpointTerminalResult?.({
          turnId,
          providerContinuationId: "thread",
          outcome: "failed",
          text: null,
          evidence: "transcript",
          error: `\u001b[31mOpen Model request failed\u001b[0m at the model provider (HTTP 404):\u0000 expired model. ${disguisedCredentials}`,
        });
        throw Object.assign(
          new Error("The provider completed, but its final answer could not be read."),
          { roomTurnRecoveryOutcome: "terminal_failure" as const },
        );
      }, async () => {
        recoveries += 1;
        throw new Error("must not recover a checkpointed terminal provider rejection");
      }),
      {
        poll: async () => ({}),
        publish: async () => { throw new Error("must not publish"); },
      },
      currentAuthority,
      0,
    );

    const openModelAgent = { ...agent, provider: "open-model" };
    await delivery.pump(openModelAgent);
    await ingest(store, "1");
    await ingest(store, "2");
    await delivery.pump(openModelAgent);

    const receipts = await store.receipts(agent.agentId);
    assert.equal(turns, 2);
    assert.equal(recoveries, 0);
    assert.deepEqual(receipts.map((receipt) => receipt.state), [
      "acknowledged_failed",
      "acknowledged_no_reply",
    ]);
    assert.deepEqual(JSON.parse(receipts[0]!.outcome!), {
      kind: "failed",
      text: null,
      evidence: "transcript",
    });
    assert.equal(
      receipts[0]!.last_error,
      expectedProviderError,
      "the failed receipt retains an actionable provider explanation without credentials or display controls",
    );
    const inspection = new DatabaseSync(join(root, "daemon.sqlite"));
    try {
      const persisted = inspection.prepare("SELECT terminal_evidence_json FROM supervised_agent_terminal_results WHERE inbox_item_id=?")
        .get(receipts[0]!.inbox_item_id) as { terminal_evidence_json: string };
      assert.equal(
        (JSON.parse(persisted.terminal_evidence_json) as { error?: string }).error,
        expectedProviderError,
        "durable terminal evidence contains only the same safe display text",
      );
    } finally {
      inspection.close();
    }
    assert.equal(
      receipts[0]?.timeline.some((event) => event.phase === "retry_scheduled"),
      false,
    );
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
