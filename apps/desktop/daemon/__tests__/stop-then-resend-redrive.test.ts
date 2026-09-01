// Regression: native Stop, exact FIFO settlement, correction activation, and
// turn-control journaling are one recoverable state machine. Covers pre-COMMIT
// failure, restart quarantine, operator resolution, post-COMMIT readback, and
// A -> correction -> B ordering through the real socket/inbox/pump boundary.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProviderActionPort } from "../provider-action-port.js";
import { SupervisorDaemon } from "../main.js";
import { WorkDurabilityStore } from "../durability-store.js";
import { ManifestStore } from "../manifest-store.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonManifestEntry } from "../types.js";

const TEST_OID = "a".repeat(40);
type DaemonInternals = {
  durability: WorkDurabilityStore;
  workerBindings: WorkerBindingStore;
  supervisedInbox: SupervisedAgentInboxStore;
  putManifestEntry(entry: Record<string, unknown>): Promise<unknown>;
  startSupervisedDelivery(entryId: string): Promise<void>;
  attachLiveProvider(entry: unknown): Promise<unknown>;
  store: Pick<ManifestStore, "getEntry" | "commitTurnControlState">;
  publishNativeActivity: () => Promise<boolean>;
};

async function eventually(predicate: () => Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function daemonRequest(socketPath: string, method: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      body += chunk;
      if (!body.includes("\n")) return;
      socket.end();
      resolve(JSON.parse(body.slice(0, body.indexOf("\n"))));
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: "redrive-repro", method, params })}\n`));
  });
}

test("a crash after native Stop quarantines exact A until operator resolution atomically queues its correction before B", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-redrive-repro-"));
  const workAttemptId = randomUUID();
  const bare = join(root, "repos", "repo.git");
  const workspacePath = join(root, "worktrees", "repo", workAttemptId);
  await mkdir(bare, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, ".letagents-work-attempt.json"), JSON.stringify({ version: 1, repo: "repo", work_attempt_id: workAttemptId, task_id: "redrive", remote_url: "https://example.invalid/repo", resolved_revision: TEST_OID, bare_path: bare }));
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "daemon-state.sqlite"), auditPath: join(root, "audit.jsonl"),
    attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root,
    workerBindingsPath: join(root, "worker-bindings.json"),
  };
  const seedStore = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(root, "worktrees"));
  await seedStore.createAttempt({ taskId: "redrive", leaseId: "redrive", leaseEpoch: 0, workspacePath, workAttemptId });
  await seedStore.close();

  const calls: string[] = [];
  const continuation = "continuation-repro";
  const handles = new Map<string, unknown>();
  const activeRoomTurns = new Map<string, (error: Error) => void>();
  const interruptLatestRoomTurn = (reason: string): void => {
    const latestInboxItemId = [...activeRoomTurns.keys()].at(-1);
    if (!latestInboxItemId) throw new Error("test provider has no active room turn to interrupt");
    const reject = activeRoomTurns.get(latestInboxItemId)!;
    activeRoomTurns.delete(latestInboxItemId);
    reject(new Error(reason));
  };
  const runInterruptibleRoomTurn = async (
    inboxItemId: string,
    checkpoint?: () => Promise<void>,
  ): Promise<never> => {
    return new Promise<never>((_resolve, reject) => {
      activeRoomTurns.set(inboxItemId, reject);
      void checkpoint?.().catch((error) => {
        if (activeRoomTurns.get(inboxItemId) === reject) activeRoomTurns.delete(inboxItemId);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    }).finally(() => {
      activeRoomTurns.delete(inboxItemId);
    });
  };
  // Stop-only provider (NO midTurnCorrection) on daemon_inbox => stop-then-resend.
  // Room turns hang forever so A remains a real active daemon-inbox invocation
  // while native Stop and the durable transaction race it.
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true, turnControl: "native_interrupt" }),
    spawn: async () => { calls.push("spawn"); throw new Error("repro must not spawn"); },
    attach: async (ref) => { calls.push(`attach:${ref.workAttemptId}`); return (handles.get(ref.workAttemptId) ?? null) as never; },
    attachAction: async () => ({ state: "absent" as const }),
    resume: async () => { calls.push("resume"); throw new Error("repro must not resume"); },
    poke: async () => {},
    controlTurn: async (_handle, correction, options) => {
      await options?.markDispatched?.();
      calls.push(`control:${correction ?? "stop"}`);
      interruptLatestRoomTurn("native test Stop interrupted the exact active room turn");
      return { capability: "native_interrupt", interrupted: true, resumed: false, state: "idle" };
    },
    runRoomTurn: async (_handle, request, options) => {
      calls.push(`room-turn:${request.inboxItemId}`);
      return runInterruptibleRoomTurn(
        request.inboxItemId,
        async () => {
          await options?.checkpointTurnStarted?.(`turn:${request.inboxItemId}`);
        },
      );
    },
    recoverRoomTurn: async (_handle, request) => {
      calls.push(`recover-room-turn:${request.inboxItemId}`);
      return runInterruptibleRoomTurn(request.inboxItemId);
    },
    stop: async (handle) => {
      calls.push("stop");
      for (const [inboxItemId, reject] of activeRoomTurns) {
        activeRoomTurns.delete(inboxItemId);
        reject(new Error("test provider stopped"));
      }
      return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped" as const, providerContinuationId: handle.providerContinuationId };
    },
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const httpStub = {
    poll: async () => ({ messages: [] as Array<Record<string, unknown>> }),
    latest: async () => ({ messages: [] as Array<Record<string, unknown>> }),
    publish: async (input: { roomId: string; clientMessageId: string }) => ({ messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }),
  };
  const entryId = "redrive_agent";
  const roomId = "room";
  const bindAgent = async (internals: DaemonInternals) => internals.workerBindings.bind({
    entry_id: entryId,
    room_id: roomId,
    work_attempt_id: workAttemptId,
    execution_generation_id: executionGenerationId,
    agent_session_id: "agent_session_exact",
    agent_session_token: "test-session-token",
    api_url: "https://letagents.test",
  });
  let executionGenerationId = "";
  let daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, httpStub);
  try {
    await daemon.start();
    const internals = daemon as unknown as DaemonInternals;
    internals.publishNativeActivity = async () => true;
    const generation = await internals.durability.startGeneration(workAttemptId, "repro", 1);
    executionGenerationId = generation.execution_generation_id;
    const pid = 7111;
    handles.set(workAttemptId, {
      workAttemptId,
      pid,
      providerContinuationId: continuation,
      providerConnection: { kind: "claude_cli" as const, pid, processIdentity: `claude:${pid}` },
      observedState: "working" as const,
    });
    await internals.putManifestEntry({
      id: entryId, room_id: roomId, display_name: "Claude", provider: "claude-code", model: null, charter: "poll",
      desired_state: "running", observed_state: "working", condition: "none",
      delivery_mode: "daemon_inbox", permission_profile_id: null, created_by: "test", created_at: new Date().toISOString(),
      workspace_path: workspacePath, work_attempt_id: workAttemptId,
      provider_ref: {
        work_attempt_id: workAttemptId,
        provider_continuation_id: continuation,
        provider_connection: { kind: "claude_cli", pid, processIdentity: `claude:${pid}` },
        execution_generation_id: executionGenerationId,
      },
    });
    await internals.supervisedInbox.bootstrapCursor({ agent_id: entryId, room_id: roomId, last_observed_message_id: null });
    await bindAgent(internals);
    await internals.attachLiveProvider(await internals.store.getEntry(entryId));
    const daemonGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const unownedDispatch = await daemonRequest(paths.socketPath, "manifest.control_turn", {
      id: entryId,
      daemon_generation: daemonGeneration,
      room_id: roomId,
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      provider_continuation_id: continuation,
      provider_turn_id: "missing-turn",
      inbox_item_id: "missing-inbox",
      source_message_id: "missing-message",
      action_id: "unowned-native-dispatch",
      action_sequence: 1,
      correction: null,
    });
    assert.equal(unownedDispatch.ok, false, "an idle Stop cannot acquire provider-session-wide authority");
    assert.match(unownedDispatch.error ?? "", /exact room message|exact room turn|durable authority binding/i);
    assert.equal(calls.some((call) => call.startsWith("control:")), false, "provider side effect is fenced before an unowned native dispatch");
    const original = await internals.supervisedInbox.enqueueCorrection({
      agent_id: entryId, room_id: roomId, source_message_id: "A",
      source_message: { text: "original A" }, activation: { decision: "activate", reason: "test", addressed: true },
    });
    const successor = await internals.supervisedInbox.enqueueCorrection({
      agent_id: entryId, room_id: roomId, source_message_id: "B",
      source_message: { text: "successor B" }, activation: { decision: "activate", reason: "test", addressed: true },
    });
    await internals.startSupervisedDelivery(entryId);
    await eventually(async () => calls.includes(`room-turn:${original.inbox_item_id}`), "original A live on daemon 1");
    await eventually(async () => (await internals.supervisedInbox.get(original.inbox_item_id))?.provider_turn_id === `turn:${original.inbox_item_id}`, "original A provider-turn checkpoint");
    const controlParams = {
      id: entryId,
      daemon_generation: daemonGeneration,
      room_id: roomId,
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      provider_continuation_id: continuation,
      provider_turn_id: `turn:${original.inbox_item_id}`,
      inbox_item_id: original.inbox_item_id,
      source_message_id: original.source_message_id,
      action_id: "redrive-action",
      action_sequence: 1,
      correction: "use plan B",
    };
    const realCommit = internals.store.commitTurnControlState.bind(internals.store);
    internals.store.commitTurnControlState = async () => {
      throw new Error("injected crash boundary before atomic turn-control commit");
    };
    // Native Stop applies, but the single SQLite transaction is injected to
    // fail before cancellation/correction/journal completion.
    const first = await daemonRequest(paths.socketPath, "manifest.control_turn", controlParams);
    internals.store.commitTurnControlState = realCommit;
    assert.equal(first.ok, false, "the caller sees the unresolved durable boundary");
    assert.match(first.error ?? "", /injected crash boundary/);
    assert.equal(calls.filter((call) => call.startsWith("control:")).length, 1, "first drive dispatched exactly one native Stop");
    const frozen = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(frozen.turn_control?.status, "uncertain");
    assert.equal(frozen.turn_control?.inbox_item_id, original.inbox_item_id);
    assert.equal(frozen.turn_control?.correction_text, "use plan B");
    assert.equal((await internals.supervisedInbox.get(original.inbox_item_id))?.state, "dispatching");
    assert.equal((await internals.supervisedInbox.get(successor.inbox_item_id))?.state, "pending");
    assert.equal((await internals.supervisedInbox.receipts(entryId)).some((item) => item.source_message_id === "correction:redrive-action"), false);

    // Crash/restart cannot normalize A or advance B while the linked journal is
    // unresolved.
    await daemon.stop();
    daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, httpStub);
    await daemon.start();
    const internals2 = daemon as unknown as DaemonInternals;
    internals2.publishNativeActivity = async () => true;
    const recovered = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(recovered.turn_control?.status, "uncertain", "restart preserves the exact native-effect quarantine");
    await bindAgent(internals2);
    await internals2.attachLiveProvider(await internals2.store.getEntry(entryId));
    await internals2.startSupervisedDelivery(entryId);
    const successorDaemonGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const controlCallsBefore = calls.filter((call) => call.startsWith("control:")).length;
    // Same-action replay is refused and cannot accidentally Stop successor B.
    const redrive = await daemonRequest(paths.socketPath, "manifest.control_turn", {
      ...controlParams, daemon_generation: successorDaemonGeneration,
    });
    assert.equal(redrive.ok, false);
    assert.match(redrive.error ?? "", /unresolved.*not replayed/i);
    assert.equal(
      calls.filter((call) => call.startsWith("control:")).length,
      controlCallsBefore,
      "the re-drive dispatched NO second native Stop",
    );

    // Operator confirms the Stop applied. Cancellation of A, exact correction
    // enqueue, and journal completion commit together; only then may delivery
    // wake, with the correction ahead of B.
    const resolved = await daemonRequest(paths.socketPath, "manifest.resolve_turn_control", {
      id: entryId,
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      action_id: "redrive-action",
      resolution: "applied",
    });
    assert.equal(resolved.ok, true, resolved.error ?? "operator resolution failed");
    const receipts = await internals2.supervisedInbox.receipts(entryId);
    const correction = receipts.find((item) => item.source_message_id === "correction:redrive-action");
    assert.ok(correction);
    assert.deepEqual(receipts.map((item) => [item.source_message_id, item.fifo_sequence]), [
      ["A", 1],
      ["correction:redrive-action", 2],
      ["B", 3],
    ]);
    assert.equal((await internals2.supervisedInbox.get(original.inbox_item_id))?.state, "cancelled_by_user");
    await eventually(async () => calls.includes(`room-turn:${correction!.inbox_item_id}`), "durable correction starts after resolution");
    await eventually(async () => (await internals2.supervisedInbox.get(correction!.inbox_item_id))?.provider_turn_id === `turn:${correction!.inbox_item_id}`, "correction provider-turn checkpoint");
    assert.equal(calls.includes(`room-turn:${successor.inbox_item_id}`), false, "successor B remains behind the correction");

    // A post-COMMIT error is the opposite ambiguity: readback must recognize
    // the completed exact action, release/abort its reservation, report success,
    // and wake B. Freezing here would leave a committed cancellation stuck.
    const realPostCommit = internals2.store.commitTurnControlState.bind(internals2.store);
    let reportAfterCommit = true;
    internals2.store.commitTurnControlState = async (...args: Parameters<ManifestStore["commitTurnControlState"]>) => {
      const result = await realPostCommit(...args);
      if (reportAfterCommit) {
        reportAfterCommit = false;
        throw new Error("injected failure reported after COMMIT");
      }
      return result;
    };
    const postCommit = await daemonRequest(paths.socketPath, "manifest.control_turn", {
      id: entryId,
      daemon_generation: successorDaemonGeneration,
      room_id: roomId,
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      provider_continuation_id: continuation,
      provider_turn_id: `turn:${correction!.inbox_item_id}`,
      inbox_item_id: correction!.inbox_item_id,
      source_message_id: correction!.source_message_id,
      action_id: "post-commit-readback",
      action_sequence: 2,
      correction: null,
    });
    internals2.store.commitTurnControlState = realPostCommit;
    assert.equal(postCommit.ok, true, postCommit.error ?? "post-COMMIT readback did not converge");
    assert.equal((await internals2.supervisedInbox.get(correction!.inbox_item_id))?.state, "cancelled_by_user");
    await eventually(async () => calls.includes(`room-turn:${successor.inbox_item_id}`), "successor B wakes after post-COMMIT readback");
    assert.equal(calls.filter((call) => call.startsWith("control:")).length, 2, "each exact action signals native Stop once");
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a linked prepared crash lets A finish, fences B, then folds the exact correction without native latest-turn control", async () => {
  const root = await mkdtemp(join(tmpdir(), "la-prepared-fold-"));
  const workAttemptId = randomUUID();
  const bare = join(root, "repos", "repo.git");
  const workspacePath = join(root, "worktrees", "repo", workAttemptId);
  await mkdir(bare, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, ".letagents-work-attempt.json"), JSON.stringify({ version: 1, repo: "repo", work_attempt_id: workAttemptId, task_id: "prepared-fold", remote_url: "https://example.invalid/repo", resolved_revision: TEST_OID, bare_path: bare }));
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "daemon-state.sqlite"), auditPath: join(root, "audit.jsonl"),
    attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root,
    workerBindingsPath: join(root, "worker-bindings.json"),
  };
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(root, "worktrees"));
  await durability.createAttempt({ taskId: "prepared-fold", leaseId: "prepared-fold", leaseEpoch: 0, workspacePath, workAttemptId });
  durability.bindSupervisorFence({ supervisor_id: paths.lockPath, supervisor_generation: 1 });
  const generation = await durability.startGeneration(workAttemptId, "repro", 1);
  await durability.close();

  const entryId = "prepared_fold_agent";
  const roomId = "room-prepared-fold";
  const continuation = "continuation-prepared-fold";
  const pid = 7222;
  const actionId = "prepared-fold-action";
  const correctionText = "apply the durable revised plan";
  const recordedAt = "2026-08-05T14:00:00.000Z";
  const seedManifest = new ManifestStore(paths.manifestPath);
  const seedInbox = new SupervisedAgentInboxStore(paths.manifestPath, () => recordedAt);
  let originalInboxItemId = "";
  let successorInboxItemId = "";
  try {
    const seededEntry: DaemonManifestEntry = {
      id: entryId, room_id: roomId, display_name: "Codex", provider: "codex", model: null, charter: "poll",
      desired_state: "running", observed_state: "working", condition: "none", delivery_mode: "daemon_inbox",
      permission_profile_id: "workspace-write", created_by: "test", created_at: recordedAt,
      workspace_path: workspacePath, work_attempt_id: workAttemptId,
      provider_ref: {
        work_attempt_id: workAttemptId, provider_continuation_id: continuation,
        execution_generation_id: generation.execution_generation_id,
        provider_connection: { kind: "codex_app_server", url: "http://127.0.0.1:7222", pid, processIdentity: `codex:${pid}` },
      },
      last_turn_control_sequence: 1,
      turn_control: {
        action_id: actionId, action_sequence: 1, work_attempt_id: workAttemptId, execution_generation_id: generation.execution_generation_id,
        target_room_id: null, target_source_message_id: null, target_provider_continuation_id: null,
        inbox_item_id: null, provider_turn_id: null, has_correction: true, correction_text: correctionText,
        correction_strategy: "stop_then_resend", status: "prepared", capability: "native_interrupt",
        interrupted: null, resumed: null, state: null, stages: [], error: null,
        recorded_at: recordedAt, updated_at: recordedAt,
      },
    };
    await seedManifest.write(0, [{ ...seededEntry, turn_control: undefined }]);
    const original = await seedInbox.enqueueCorrection({ agent_id: entryId, room_id: roomId, source_message_id: "prepared-A", source_message: { text: "A" }, activation: { decision: "activate" } });
    const successor = await seedInbox.enqueueCorrection({ agent_id: entryId, room_id: roomId, source_message_id: "prepared-B", source_message: { text: "B" }, activation: { decision: "activate" } });
    originalInboxItemId = original.inbox_item_id;
    successorInboxItemId = successor.inbox_item_id;
    await seedInbox.claimHead(entryId);
    await seedInbox.checkpointTurnStarted(original.inbox_item_id, `turn:${original.inbox_item_id}`, {
      work_attempt_id: workAttemptId,
      origin_execution_generation_id: generation.execution_generation_id,
      provider_continuation_id: continuation,
    });
    const current = (await seedManifest.load()).entries[0]!;
    await seedManifest.replaceEntry(1, {
      ...current,
      turn_control: {
        ...seededEntry.turn_control!, inbox_item_id: original.inbox_item_id,
        target_room_id: roomId, target_source_message_id: original.source_message_id,
        target_provider_continuation_id: continuation,
        provider_turn_id: `turn:${original.inbox_item_id}`, status: "prepared",
      },
    });
    await seedInbox.bootstrapCursor({ agent_id: entryId, room_id: roomId, last_observed_message_id: null });
  } finally {
    await seedInbox.close();
    await seedManifest.close();
  }

  const calls: string[] = [];
  type RoomResult = { turnId: string; outcome: "reply" | "no_reply"; text: string | null };
  const activeTurns = new Map<string, { resolve: (result: RoomResult) => void; reject: (error: Error) => void }>();
  const waitForTurn = (inboxItemId: string): Promise<RoomResult> => new Promise<RoomResult>((resolve, reject) => {
    activeTurns.set(inboxItemId, { resolve, reject });
  }).finally(() => activeTurns.delete(inboxItemId));
  const handle = {
    workAttemptId, pid, providerContinuationId: continuation,
    providerConnection: { kind: "codex_app_server" as const, url: "http://127.0.0.1:7222", pid, processIdentity: `codex:${pid}` },
    observedState: "working" as const,
  };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, midTurnCorrection: true, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true, turnControl: "native_interrupt" }),
    spawn: async () => { throw new Error("prepared-fold test must not spawn"); },
    attach: async () => handle,
    attachAction: async () => ({ state: "absent" as const }),
    resume: async () => { throw new Error("prepared-fold test must not resume"); },
    poke: async () => {},
    controlTurn: async () => {
      calls.push("control:WRONG-LATEST-TURN");
      throw new Error("terminal fold must not dispatch provider control");
    },
    runRoomTurn: async (_handle, request, options) => {
      calls.push(`room-turn:${request.inboxItemId}`);
      await options?.checkpointTurnStarted?.(`turn:${request.inboxItemId}`);
      return waitForTurn(request.inboxItemId);
    },
    recoverRoomTurn: async (_handle, request) => {
      calls.push(`recover-room-turn:${request.inboxItemId}`);
      return waitForTurn(request.inboxItemId);
    },
    stop: async (providerHandle) => {
      for (const active of activeTurns.values()) active.reject(new Error("prepared-fold provider stopped"));
      activeTurns.clear();
      return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped" as const, providerContinuationId: providerHandle.providerContinuationId };
    },
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const httpStub = {
    poll: async () => ({ messages: [] as Array<Record<string, unknown>> }),
    latest: async () => ({ messages: [] as Array<Record<string, unknown>> }),
    publish: async (input: { roomId: string; clientMessageId: string }) => ({ messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }),
  };
  let daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, httpStub);
  try {
    await daemon.start();
    const internals = daemon as unknown as DaemonInternals;
    internals.publishNativeActivity = async () => true;
    await internals.workerBindings.bind({
      entry_id: entryId, room_id: roomId, work_attempt_id: workAttemptId,
      execution_generation_id: generation.execution_generation_id,
      agent_session_id: "agent-session-prepared-fold", agent_session_token: "test-session-token",
      api_url: "https://letagents.test",
    });
    await internals.attachLiveProvider(await internals.store.getEntry(entryId));
    await internals.startSupervisedDelivery(entryId);
    await eventually(async () => calls.includes(`recover-room-turn:${originalInboxItemId}`), "exact A recovery after prepared crash");
    activeTurns.get(originalInboxItemId)!.resolve({ turnId: `turn:${originalInboxItemId}`, outcome: "no_reply", text: null });
    await eventually(async () => (await internals.supervisedInbox.get(originalInboxItemId))?.state === "acknowledged_no_reply", "A terminal outcome");
    assert.equal(calls.includes(`room-turn:${successorInboxItemId}`), false, "durable retryable journal fences successor B");

    const realCommit = internals.store.commitTurnControlState.bind(internals.store);
    let reportAfterCommit = true;
    internals.store.commitTurnControlState = async (...args: Parameters<ManifestStore["commitTurnControlState"]>) => {
      const committed = await realCommit(...args);
      if (reportAfterCommit) {
        reportAfterCommit = false;
        throw new Error("prepared-fold failure reported after COMMIT");
      }
      return committed;
    };
    const result = await daemonRequest(paths.socketPath, "manifest.control_turn", {
      id: entryId,
      daemon_generation: ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation,
      room_id: roomId, work_attempt_id: workAttemptId, execution_generation_id: generation.execution_generation_id,
      provider_continuation_id: continuation, provider_turn_id: `turn:${originalInboxItemId}`,
      inbox_item_id: originalInboxItemId, source_message_id: "prepared-A",
      action_id: actionId, action_sequence: 1, correction: correctionText,
    });
    internals.store.commitTurnControlState = realCommit;
    assert.equal(result.ok, true, result.error ?? "prepared retry fold failed");
    assert.equal(calls.includes("control:WRONG-LATEST-TURN"), false, "terminal A is folded without provider latest-turn control");
    const receipts = await internals.supervisedInbox.receipts(entryId);
    const correction = receipts.find((item) => item.source_message_id === `correction:${actionId}`);
    assert.ok(correction);
    assert.deepEqual(receipts.map((item) => [item.source_message_id, item.fifo_sequence]), [
      ["prepared-A", 1], [`correction:${actionId}`, 2], ["prepared-B", 3],
    ]);
    await eventually(async () => calls.includes(`room-turn:${correction.inbox_item_id}`), "durable correction after terminal fold");
    assert.equal(calls.includes(`room-turn:${successorInboxItemId}`), false, "B remains behind the accepted correction");
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon-inbox native-correction capability still uses pure Stop and preserves a not-applied correction ahead of B", async () => {
  const root = await mkdtemp(join(tmpdir(), "la-not-applied-fold-"));
  const workAttemptId = randomUUID();
  const bare = join(root, "repos", "repo.git");
  const workspacePath = join(root, "worktrees", "repo", workAttemptId);
  await mkdir(bare, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, ".letagents-work-attempt.json"), JSON.stringify({ version: 1, repo: "repo", work_attempt_id: workAttemptId, task_id: "not-applied-fold", remote_url: "https://example.invalid/repo", resolved_revision: TEST_OID, bare_path: bare }));
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "daemon-state.sqlite"), auditPath: join(root, "audit.jsonl"),
    attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root,
    workerBindingsPath: join(root, "worker-bindings.json"),
  };
  const seedStore = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(root, "worktrees"));
  await seedStore.createAttempt({ taskId: "not-applied-fold", leaseId: "not-applied-fold", leaseEpoch: 0, workspacePath, workAttemptId });
  await seedStore.close();

  type RoomResult = { turnId: string; outcome: "reply" | "no_reply"; text: string | null };
  const activeTurns = new Map<string, { resolve: (result: RoomResult) => void; reject: (error: Error) => void }>();
  const waitForTurn = (inboxItemId: string): Promise<RoomResult> => new Promise<RoomResult>((resolve, reject) => {
    activeTurns.set(inboxItemId, { resolve, reject });
  }).finally(() => activeTurns.delete(inboxItemId));
  const calls: string[] = [];
  const continuation = "continuation-not-applied-fold";
  const pid = 7333;
  const handle = {
    workAttemptId, pid, providerContinuationId: continuation,
    providerConnection: { kind: "codex_app_server" as const, url: "http://127.0.0.1:7333", pid, processIdentity: `codex:${pid}` },
    observedState: "working" as const,
  };
  let proveNotApplied = true;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, midTurnCorrection: true, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true, turnControl: "native_interrupt" }),
    spawn: async () => { throw new Error("not-applied fold test must not spawn"); },
    attach: async () => handle,
    attachAction: async () => ({ state: "absent" as const }),
    resume: async () => { throw new Error("not-applied fold test must not resume"); },
    poke: async () => {},
    controlTurn: async (_handle, correction, options) => {
      await options?.markDispatched?.();
      calls.push(`control:${correction ?? "stop"}`);
      if (proveNotApplied) {
        proveNotApplied = false;
        throw Object.assign(new Error("provider proved Stop was not applied"), { turnControlOutcome: "not_applied" as const });
      }
      throw new Error("terminal retry must fold without a second latest-turn control call");
    },
    runRoomTurn: async (_handle, request, options) => {
      calls.push(`room-turn:${request.inboxItemId}`);
      await options?.checkpointTurnStarted?.(`turn:${request.inboxItemId}`);
      return waitForTurn(request.inboxItemId);
    },
    recoverRoomTurn: async (_handle, request) => {
      calls.push(`recover-room-turn:${request.inboxItemId}`);
      return waitForTurn(request.inboxItemId);
    },
    stop: async (providerHandle) => {
      for (const active of activeTurns.values()) active.reject(new Error("not-applied fold provider stopped"));
      activeTurns.clear();
      return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped" as const, providerContinuationId: providerHandle.providerContinuationId };
    },
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const httpStub = {
    poll: async () => ({ messages: [] as Array<Record<string, unknown>> }),
    latest: async () => ({ messages: [] as Array<Record<string, unknown>> }),
    publish: async (input: { roomId: string; clientMessageId: string }) => ({ messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }),
  };
  const entryId = "not_applied_fold_agent";
  const roomId = "room-not-applied-fold";
  const correctionText = "keep this exact correction after A";
  const actionId = "not-applied-fold-action";
  const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, httpStub);
  try {
    await daemon.start();
    const internals = daemon as unknown as DaemonInternals;
    internals.publishNativeActivity = async () => true;
    const generation = await internals.durability.startGeneration(workAttemptId, "repro", 1);
    await internals.putManifestEntry({
      id: entryId, room_id: roomId, display_name: "Codex", provider: "codex", model: null, charter: "poll",
      desired_state: "running", observed_state: "working", condition: "none", delivery_mode: "daemon_inbox",
      permission_profile_id: "workspace-write", created_by: "test", created_at: new Date().toISOString(),
      workspace_path: workspacePath, work_attempt_id: workAttemptId,
      provider_ref: {
        work_attempt_id: workAttemptId, provider_continuation_id: continuation,
        execution_generation_id: generation.execution_generation_id,
        provider_connection: handle.providerConnection,
      },
    });
    await internals.supervisedInbox.bootstrapCursor({ agent_id: entryId, room_id: roomId, last_observed_message_id: null });
    await internals.workerBindings.bind({
      entry_id: entryId, room_id: roomId, work_attempt_id: workAttemptId,
      execution_generation_id: generation.execution_generation_id,
      agent_session_id: "agent-session-not-applied-fold", agent_session_token: "test-session-token",
      api_url: "https://letagents.test",
    });
    await internals.attachLiveProvider(await internals.store.getEntry(entryId));
    const original = await internals.supervisedInbox.enqueueCorrection({ agent_id: entryId, room_id: roomId, source_message_id: "not-applied-A", source_message: { text: "A" }, activation: { decision: "activate" } });
    const successor = await internals.supervisedInbox.enqueueCorrection({ agent_id: entryId, room_id: roomId, source_message_id: "not-applied-B", source_message: { text: "B" }, activation: { decision: "activate" } });
    await internals.startSupervisedDelivery(entryId);
    await eventually(async () => calls.includes(`room-turn:${original.inbox_item_id}`), "live A before not-applied control");
    await eventually(async () => (await internals.supervisedInbox.get(original.inbox_item_id))?.provider_turn_id === `turn:${original.inbox_item_id}`, "not-applied A provider-turn checkpoint");

    const controlParams = {
      id: entryId,
      daemon_generation: ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation,
      room_id: roomId, work_attempt_id: workAttemptId, execution_generation_id: generation.execution_generation_id,
      provider_continuation_id: continuation, provider_turn_id: `turn:${original.inbox_item_id}`,
      inbox_item_id: original.inbox_item_id, source_message_id: original.source_message_id,
      action_id: actionId, action_sequence: 1, correction: correctionText,
    };
    const first = await daemonRequest(paths.socketPath, "manifest.control_turn", controlParams);
    assert.equal(first.ok, false);
    assert.match(first.error ?? "", /proved Stop was not applied/);
    assert.deepEqual(calls.filter((call) => call.startsWith("control:")), ["control:stop"], "daemon-inbox correction never enters adapter-native correction");
    const retryable = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!.turn_control;
    assert.equal(retryable?.status, "retryable");
    assert.equal(retryable?.inbox_item_id, original.inbox_item_id);
    assert.equal(retryable?.correction_strategy, "stop_then_resend");

    activeTurns.get(original.inbox_item_id)!.resolve({ turnId: `turn:${original.inbox_item_id}`, outcome: "no_reply", text: null });
    await eventually(async () => (await internals.supervisedInbox.get(original.inbox_item_id))?.state === "acknowledged_no_reply", "A finishes after not-applied Stop");
    assert.equal(calls.includes(`room-turn:${successor.inbox_item_id}`), false, "retryable journal blocks B after A");

    const retry = await daemonRequest(paths.socketPath, "manifest.control_turn", controlParams);
    assert.equal(retry.ok, true, retry.error ?? "terminal not-applied retry fold failed");
    assert.equal(calls.filter((call) => call.startsWith("control:")).length, 1, "terminal retry never controls provider latest turn");
    const receipts = await internals.supervisedInbox.receipts(entryId);
    const correction = receipts.find((item) => item.source_message_id === `correction:${actionId}`);
    assert.ok(correction);
    assert.deepEqual(receipts.map((item) => [item.source_message_id, item.fifo_sequence]), [
      ["not-applied-A", 1], [`correction:${actionId}`, 2], ["not-applied-B", 3],
    ]);
    await eventually(async () => calls.includes(`room-turn:${correction.inbox_item_id}`), "correction starts after not-applied terminal fold");
    assert.equal(calls.includes(`room-turn:${successor.inbox_item_id}`), false);
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
