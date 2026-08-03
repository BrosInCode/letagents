// Regression: a crash-recovered re-drive of the SAME stop-then-resend action
// must not dispatch a second native Stop and must not cancel the live
// correction turn. Covers the #863 P1 re-drive lane end-to-end (real socket,
// real recovery, real inbox/pump) with hanging provider turns so the queued
// correction is a LIVE in-flight turn at re-drive time.
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
  store: { getEntry(entryId: string): Promise<unknown> };
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

test("a re-driven stop-then-resend never dispatches a second native Stop nor cancels the live correction", async () => {
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
  // Stop-only provider (NO midTurnCorrection) on daemon_inbox => stop-then-resend.
  // Room turns hang forever, so the queued correction is a LIVE in-flight turn
  // at re-drive time — the exact state the P1 re-drive corrupted.
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
      return { capability: "native_interrupt", interrupted: true, resumed: false, state: "idle" };
    },
    runRoomTurn: async (_handle, request, options) => {
      calls.push(`room-turn:${request.inboxItemId}`);
      await options?.checkpointTurnStarted?.(`turn:${request.inboxItemId}`);
      return new Promise(() => {}); // the correction turn stays live
    },
    recoverRoomTurn: async (_handle, request) => {
      calls.push(`recover-room-turn:${request.inboxItemId}`);
      return new Promise(() => {}); // the recovered correction turn stays live
    },
    stop: async (handle) => { calls.push("stop"); return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped" as const, providerContinuationId: handle.providerContinuationId }; },
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
      observedState: () => "working" as const,
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
    await internals.startSupervisedDelivery(entryId);
    const controlParams = {
      id: entryId,
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      action_id: "redrive-action",
      correction: "use plan B",
    };
    // Drive 1: Stop + settle + enqueue commits correction:redrive-action.
    const first = await daemonRequest(paths.socketPath, "manifest.control_turn", controlParams);
    assert.equal(first.ok, true, `first drive: ${first.error ?? ""}`);
    assert.equal((first.result as { resumed?: boolean }).resumed, true);
    assert.equal(calls.filter((call) => call.startsWith("control:")).length, 1, "first drive dispatched exactly one native Stop");
    // The pump starts the correction turn; it hangs => a LIVE correction.
    await eventually(async () => calls.some((call) => call.startsWith("room-turn:")), "correction turn live on daemon 1");
    // Crash simulation: the enqueue committed but the completed journal did not.
    // Recovery of `dispatching` + stop-then-resend marks the action retryable.
    await daemon.stop();
    const manifestStore = new ManifestStore(paths.manifestPath);
    const manifest = await manifestStore.load();
    // The crash happened BEFORE the completed journal write, which is the same
    // write that records the action in reconciliation.completed_action_ids —
    // so the recovered state has status "dispatching" AND no completed action.
    await manifestStore.write(manifest.generation, manifest.entries.map((candidate) => candidate.id === entryId
      ? {
        ...candidate,
        turn_control: { ...candidate.turn_control!, status: "dispatching" as const },
        reconciliation: candidate.reconciliation
          ? { ...candidate.reconciliation, completed_action_ids: (candidate.reconciliation.completed_action_ids ?? []).filter((actionId: string) => actionId !== "redrive-action") }
          : candidate.reconciliation,
      }
      : candidate), manifest.legacy_lane_owners);
    await manifestStore.close();
    daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, httpStub);
    await daemon.start();
    const internals2 = daemon as unknown as DaemonInternals;
    internals2.publishNativeActivity = async () => true;
    const recovered = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(recovered.turn_control?.status, "retryable", "crash recovery re-drives a dispatched stop-then-resend as retryable");
    // Restore the room credential (memory-only across restarts), re-attach the
    // live provider handle, and pump: the recovered correction resumes as a
    // live provider turn again.
    await bindAgent(internals2);
    await internals2.attachLiveProvider(await internals2.store.getEntry(entryId));
    await internals2.startSupervisedDelivery(entryId);
    await eventually(async () => calls.some((call) => call.startsWith("recover-room-turn:")), "correction turn re-live on daemon 2");
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return (current.observed_state === "working" || current.observed_state === "idle") && current.condition === "none";
    }, "entry settles for turn control");
    const controlCallsBefore = calls.filter((call) => call.startsWith("control:")).length;
    // Re-drive of the SAME action: must NOT stop/cancel the live correction.
    const redrive = await daemonRequest(paths.socketPath, "manifest.control_turn", controlParams);
    assert.equal(redrive.ok, true, `re-drive: ${redrive.error ?? ""}`);
    assert.equal((redrive.result as { resumed?: boolean }).resumed, true, "re-drive reports the resend still applies");
    assert.equal(
      calls.filter((call) => call.startsWith("control:")).length,
      controlCallsBefore,
      "the re-drive dispatched NO second native Stop",
    );
    const inspector = await daemonRequest(paths.socketPath, "supervisor.get_agent_inspector_detail", {
      entry_id: entryId,
      room_id: roomId,
      source_message_id: "correction:redrive-action",
    });
    assert.equal(inspector.ok, true, `inspector: ${inspector.error ?? ""}`);
    const receipt = (inspector.result as { receipt?: { state?: string } }).receipt;
    assert.ok(receipt, "correction receipt exists");
    assert.notEqual(receipt?.state, "cancelled_by_user", "the live correction was NOT cancelled by the re-drive");
    assert.notEqual(receipt?.state, "cancelled_by_room_move");
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
