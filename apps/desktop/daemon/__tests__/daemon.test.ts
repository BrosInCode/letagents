import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import { AuditLog } from "../audit-log.js";
import { DaemonControlSocket } from "../control-socket.js";
import { CorruptAttemptStoreError, ImmutableExecutionError, WorkDurabilityStore } from "../durability-store.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import { DaemonLifecycleLog, daemonLifecycleErrorDetail } from "../lifecycle-log.js";
import { serializeDaemonDeploymentId } from "../manifest-entry-projection.js";
import { CONTINUATION_REPAIR_EXHAUSTED_ERROR, continuationRepairExhaustionNeedsPersistence, continuationRepairMissingContinuation, isSupervisedQuietPollContinuation, isSupervisedWaitProviderEvent, productionSupervisedDeliveryHttp, providerStreamLifecycle, resolveReadyReachedAt, SupervisorDaemon as ProductionSupervisorDaemon, SupervisorGrantRequestError, sameProcessBirthIdentity, supervisedWaitCursorFromProviderEvent, supervisedWaitEvidenceFromProviderEvent, workplaceLivenessStaleAfterMs } from "../main.js";
import { assertMacOS } from "../platform.js";
import { DaemonAlreadyRunningError, DaemonFenceLostError, DaemonSingleton } from "../singleton.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonActivityEvent, type DaemonManifestEntry, type DaemonManifestEntryView, type DaemonRequest, type DaemonRoomMoveRecord } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { WorkerRuntimeCustody, type CachedWorkerAuthorization, type InstalledHostGrant } from "../worker-runtime-custody.js";
import { loadSupervisedToolRuntimeAt, type DaemonToolAgentSession } from "../supervised-tool-runtime.js";
import { productionSupervisorGrantHttp } from "../cloud-http.js";

const TEST_PROVIDER_TURN_AUTHORITY = {
  work_attempt_id: "attempt",
  origin_execution_generation_id: "generation",
  provider_continuation_id: "continuation",
} as const;
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { SupervisedDeliveryHttp, SupervisedIngressAgent } from "../supervised-agent-delivery.js";
import { createGitCommand, repositoryStorageKey, WorkspaceProvisioner } from "../workspace-provisioner.js";
import { acquireWorkspaceFence, withWorkspaceFence } from "../workspace-fence.js";
import { CRASH_LOOP_EXIT_LIMIT, decideReconciliation, restartBackoffMs } from "../reconciler-policy.js";
import { ProviderReconciler } from "../reconciler-runner.js";
import { advanceReconciliationState, recordReconciliationActionFailure, rememberCompletedControlAction } from "../reconciler-state.js";
import type { ProviderActionHandle, ProviderActionPort } from "../provider-action-port.js";
import type { NativeExecutionObservation, NativeExecutionSubscription } from "../../shared/execution-protocol.js";
import type { HostApprovalChallenge, HostApprovalOperation } from "../../shared/host-approval-auth.js";
import type { ExecutionCaptureCoordinator } from "../execution-capture-coordinator.js";
import type { ProviderCheckpointCoordinator } from "../provider-checkpoint-coordinator.js";
import type { ProviderRecoveryDiagnostics, ProviderStreamCoordinator } from "../provider-stream-coordinator.js";
import { unavailableLifecycleProjectionDiagnostics } from "../lifecycle-projection-ledger.js";
import { ProviderActionPortRouter, type NativeProviderAdapter } from "../provider-action-port-router.js";
import { launchLegacyWithOwnership } from "../../electron/main/supervisor-ownership.js";
import { defaultGetProcessIdentity } from "../../electron/main/agents/provider-evidence.js";
import { OpenCodeRuntimeGoneError } from "../../electron/main/agents/open-model-provider-adapter.js";

/**
 * Unit ports stand in for the production router, whose successful spawn and
 * resume responses attest the exact configuration revision and native process
 * birth applied by the adapter. Keep those contracts explicit in this daemon
 * harness instead of weakening the production daemon's attestation checks.
 */
function configurationAttestingTestPort(port: ProviderActionPort): ProviderActionPort {
  const attestNativeBirth = (
    handle: ProviderActionHandle,
    provider: string | undefined,
  ): ProviderActionHandle => {
    if (handle.providerConnection !== undefined) return handle;
    const processIdentity = handle.pid === null
      ? null
      : `daemon-test:${provider ?? "unknown"}:${handle.pid}:${handle.providerContinuationId ?? "none"}`;
    if (provider === "codex") {
      handle.providerConnection = {
        kind: "codex_app_server",
        url: `ws://127.0.0.1:${handle.pid ?? 0}`,
        pid: handle.pid,
        processIdentity,
      };
    } else if (provider === "claude-code") {
      handle.providerConnection = { kind: "claude_cli", pid: handle.pid, processIdentity };
    } else if (provider === "cursor") {
      handle.providerConnection = { kind: "cursor_cli", pid: handle.pid, processIdentity };
    } else if (provider === "open-model") {
      handle.providerConnection = {
        kind: "opencode_server",
        url: `http://127.0.0.1:${handle.pid ?? 0}`,
        pid: handle.pid,
        processIdentity,
        serverAuthPath: `/tmp/letagents-daemon-test-${handle.pid ?? 0}.auth`,
      };
    }
    return handle;
  };
  return new Proxy(port, {
    get(target, property, receiver) {
      if (property === "spawn") {
        return async (request: Parameters<ProviderActionPort["spawn"]>[0]) => {
          const handle = attestNativeBirth(await target.spawn(request), request.provider);
          Object.defineProperty(handle, "appliedConfigurationRevision", {
            value: request.configurationRevision,
            enumerable: false,
            configurable: true,
            writable: true,
          });
          return handle;
        };
      }
      if (property === "resume") {
        return async (ref: Parameters<ProviderActionPort["resume"]>[0], request: Parameters<ProviderActionPort["resume"]>[1]) => {
          const handle = attestNativeBirth(await target.resume(ref, request), request.provider ?? ref.provider);
          Object.defineProperty(handle, "appliedConfigurationRevision", {
            value: request.configurationRevision,
            enumerable: false,
            configurable: true,
            writable: true,
          });
          return handle;
        };
      }
      if (property === "attach") {
        return async (ref: Parameters<ProviderActionPort["attach"]>[0]) => {
          const attachment = await target.attach(ref);
          return attachment && !("state" in attachment && attachment.state === "terminal")
            ? attestNativeBirth(attachment, ref.provider)
            : attachment;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function runtimeReadySubscription(
  handle: Pick<ProviderActionHandle, "workAttemptId" | "pid" | "providerConnection">,
  listener: (event: NativeExecutionObservation) => void,
): NativeExecutionSubscription {
  const processIdentity = handle.providerConnection?.processIdentity ?? null;
  const pid = handle.providerConnection?.pid ?? handle.pid;
  const sourceId = `runtime-ready:${handle.workAttemptId}:${processIdentity ?? "unknown"}`;
  listener({
    sourceId,
    sequence: 1,
    observedAtMs: Date.now(),
    ...(pid === null ? {} : { nativeProcessPid: pid }),
    ...(processIdentity === null ? {} : { nativeProcessIdentity: processIdentity }),
    fact: { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" },
  });
  return { sourceId, position: () => ({ firstRetainedSequence: 1, latestSequence: 1 }), dispose() {} };
}

class SupervisorDaemon extends ProductionSupervisorDaemon {
  constructor(...args: ConstructorParameters<typeof ProductionSupervisorDaemon>) {
    const forwarded = [...args] as ConstructorParameters<typeof ProductionSupervisorDaemon>;
    if (forwarded[2]) forwarded[2] = configurationAttestingTestPort(forwarded[2]);
    super(...forwarded);
  }
}

const execFileAsync = promisify(execFile);
const TEST_PROCESS_IDENTITY = execFileSync(
  "/bin/ps",
  ["-p", String(process.pid), "-o", "lstart=", "-o", "command="],
  { encoding: "utf8" },
).trim();

test("daemon tool runtime loader requires a sealed package tree outside explicit development", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-tool-runtime-"));
  try {
    const valid = join(root, "daemon-tool-executor.mjs");
    await writeFile(valid, "export async function executeDaemonTool() { return { liveResult: {}, durableResult: {} }; }\nexport function supervisedToolIsMutation() { return false; }\n", { mode: 0o600 });
    await assert.rejects(() => loadSupervisedToolRuntimeAt(valid), /sealed package tree/i);
    const runtime = await loadSupervisedToolRuntimeAt(valid, { allowUnsealedDevelopmentRuntime: true });
    assert.equal(runtime.supervisedToolIsMutation("get_board"), false);

    const redirected = join(root, "redirected.mjs");
    await symlink(valid, redirected);
    await assert.rejects(
      () => loadSupervisedToolRuntimeAt(redirected, { allowUnsealedDevelopmentRuntime: true }),
      /real file|canonical/i,
    );

    const incompatible = join(root, "incompatible.mjs");
    await writeFile(incompatible, "export const nope = true;\n", { mode: 0o600 });
    await assert.rejects(
      () => loadSupervisedToolRuntimeAt(incompatible, { allowUnsealedDevelopmentRuntime: true }),
      /incompatible contract/i,
    );

    const nodeModules = join(root, "sealed", "node_modules");
    const executor = join(nodeModules, "letagents", "dist", "mcp", "server", "daemon-tool-executor.js");
    const dependencyProof = join(nodeModules, "dependency-proof.txt");
    const verifier = join(root, "runtime-verifier.mjs");
    const sealedDigest = "a".repeat(64);
    await mkdir(dirname(executor), { recursive: true });
    await writeFile(executor, "export async function executeDaemonTool() { return { liveResult: {}, durableResult: {} }; }\nexport function supervisedToolIsMutation() { return false; }\n", { mode: 0o600 });
    await writeFile(dependencyProof, sealedDigest, { mode: 0o600 });
    await writeFile(verifier, `import { readFileSync } from "node:fs";\nimport { join } from "node:path";\nexport const LETAGENTS_MCP_RUNTIME_TREE_SHA256 = "${sealedDigest}";\nexport function computeLetAgentsMcpRuntimeTreeSha256(root) { return readFileSync(join(root, "dependency-proof.txt"), "utf8").trim(); }\n`, { mode: 0o600 });
    const sealedRuntime = await loadSupervisedToolRuntimeAt(executor, {
      verifierPath: verifier,
      expectedTreeSha256: sealedDigest,
    });
    assert.equal(sealedRuntime.supervisedToolIsMutation("get_board"), false);
    await writeFile(dependencyProof, "b".repeat(64), { mode: 0o600 });
    await assert.rejects(
      () => loadSupervisedToolRuntimeAt(executor, { verifierPath: verifier, expectedTreeSha256: sealedDigest }),
      /complete tree integrity check/i,
      "a changed dependency is rejected before the privileged executor import",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker mint preserves the exact server-issued identity paired with its bearer", async () => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      session_id: "session-exact", session_kind: "worker", room_id: "room-exact", runtime: "cursor",
      actor_label: "CedarRidge | EmmyMay's agent | Cursor", agent_key: "emmymay/cedarridge",
      agent_instance_id: "daemon:cedar", display_name: "CedarRidge", owner_label: "EmmyMay",
      ide_label: "Cursor", created_at: "2026-08-14T00:00:00.000Z", updated_at: "2026-08-14T00:00:01.000Z",
      last_seen_at: "2026-08-14T00:00:01.000Z", ended_at: null,
      worker_bearer: "worker-secret", worker_bearer_id: "bearer-exact", worker_bearer_expires_at: null,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const minted = await productionSupervisorGrantHttp.createWorkerSession({
      apiUrl: `http://127.0.0.1:${address.port}`, grantId: "grant", supervisorGrant: "grant-secret",
      grantGeneration: 1, roomId: "room-exact", agentKey: "emmymay/cedarridge",
      agentInstanceId: "daemon:cedar", provider: "cursor", displayName: "CedarRidge",
    });
    assert.equal(minted.agentSession?.agent_key, "emmymay/cedarridge");
    assert.equal(minted.agentSession?.actor_label, "CedarRidge | EmmyMay's agent | Cursor");
    assert.equal(minted.agentSession?.owner_label, "EmmyMay");
    assert.equal(minted.agentSession?.session_id, minted.sessionId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("workplace reachability outlives the configured room long poll", () => {
  assert.equal(workplaceLivenessStaleAfterMs(""), 210_000);
  assert.equal(workplaceLivenessStaleAfterMs("999"), 210_000);
  assert.equal(workplaceLivenessStaleAfterMs("36000000"), 36_030_000);
  assert.equal(workplaceLivenessStaleAfterMs("36000000ms"), 36_030_000);
  assert.equal(workplaceLivenessStaleAfterMs("999999999"), 86_430_000);
  assert.equal(workplaceLivenessStaleAfterMs("invalid"), 210_000);
});

test("continuation repair resumes every uncommitted journal phase from the original missing conversation", () => {
  const inboxItemId = "inbox_1";
  const originalContinuation = "thread_missing";
  const promotedReplacement = "thread_replacement";
  for (const phase of ["probing", "replacement_created", "failed"] as const) {
    assert.equal(
      continuationRepairMissingContinuation({
        inbox_item_id: inboxItemId,
        phase,
        missing_continuation: originalContinuation,
      }, inboxItemId, promotedReplacement),
      originalContinuation,
      `${phase} remains owned by the interrupted repair journal`,
    );
  }
  assert.equal(
    continuationRepairMissingContinuation({
      inbox_item_id: inboxItemId,
      phase: "committed",
      missing_continuation: originalContinuation,
    }, inboxItemId, promotedReplacement),
    promotedReplacement,
    "only a committed repair makes the replacement the next missing continuation",
  );
  assert.equal(
    continuationRepairMissingContinuation({
      inbox_item_id: "another_inbox",
      phase: "replacement_created",
      missing_continuation: originalContinuation,
    }, inboxItemId, promotedReplacement),
    promotedReplacement,
    "a repair for another FIFO item cannot claim this one",
  );
});

test("continuation repair exhaustion policy treats the exact durable error as already persisted", () => {
  assert.equal(continuationRepairExhaustionNeedsPersistence(null), true);
  assert.equal(continuationRepairExhaustionNeedsPersistence("another failure"), true);
  assert.equal(
    continuationRepairExhaustionNeedsPersistence(CONTINUATION_REPAIR_EXHAUSTED_ERROR),
    false,
  );
});

test("resolveReadyReachedAt stamps ready once, monotonically, and only when running + unblocked + live (task_84)", () => {
  const now = "2026-07-17T00:00:00.000Z";
  // A bind that clears the pre-bind coordination latch reaches ready.
  assert.equal(
    resolveReadyReachedAt({ desired_state: "running", observed_state: "recovering", condition: "coordination_blocked", ready_reached_at: null }, true, now),
    now,
  );
  // An idempotent bind of an already working/none entry is ready without clearing a latch.
  assert.equal(
    resolveReadyReachedAt({ desired_state: "running", observed_state: "working", condition: "none", ready_reached_at: null }, false, now),
    now,
  );
  // Already stamped → keeps the original timestamp (monotonic, set-once).
  assert.equal(
    resolveReadyReachedAt({ desired_state: "running", observed_state: "working", condition: "none", ready_reached_at: "2026-07-16T00:00:00.000Z" }, false, now),
    "2026-07-16T00:00:00.000Z",
  );
  // Not running, or still blocked → never stamped.
  assert.equal(
    resolveReadyReachedAt({ desired_state: "paused", observed_state: "working", condition: "none", ready_reached_at: null }, false, now),
    null,
  );
  assert.equal(
    resolveReadyReachedAt({ desired_state: "running", observed_state: "recovering", condition: "auth_blocked", ready_reached_at: null }, false, now),
    null,
  );
});

test("ready_reached_at survives a manifest round-trip, defaults absent, and a stop never clears it (task_84)", async () => {
  const env = await fixture();
  try {
    const store = new ManifestStore(join(env.root, "manifest.json"));
    // An old manifest without the field loads as absent (defaults null downstream).
    await store.write(0, [{ ...entry }]);
    assert.equal((await store.load()).entries[0]?.ready_reached_at, undefined);
    // A set-once stamp survives save → load (i.e. a daemon restart round-trip).
    await store.write(1, [{ ...entry, ready_reached_at: "2026-07-17T00:00:00.000Z" }]);
    assert.equal((await store.load()).entries[0]?.ready_reached_at, "2026-07-17T00:00:00.000Z");
    // A later stop (spread-preserving mutation) must not clear the stamp.
    const loaded = (await store.load()).entries[0]!;
    await store.write(2, [{ ...loaded, desired_state: "stopped", observed_state: "absent" }]);
    const after = (await store.load()).entries[0];
    assert.equal(after?.ready_reached_at, "2026-07-17T00:00:00.000Z");
    assert.equal(after?.desired_state, "stopped");
  } finally {
    await env.cleanup();
  }
});

test("manifest state subscription returns an initial snapshot and wakes on a committed mutation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const initial = (await daemonRequest(paths.socketPath, "manifest.watch_state", {
      after_daemon_generation: 0,
      after_sequence: 0,
      wait_ms: 1_000,
    })).result as { daemon_generation: number; sequence: number; entries: DaemonManifestEntryView[] };
    assert.ok(initial.daemon_generation > 0);
    assert.ok(initial.sequence > 0);
    assert.deepEqual(initial.entries, []);

    const changed = daemonRequest(paths.socketPath, "manifest.watch_state", {
      after_daemon_generation: initial.daemon_generation,
      after_sequence: initial.sequence,
      wait_ms: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...entry, id: "state_subscription_agent" },
    });
    const snapshot = (await changed).result as {
      daemon_generation: number;
      sequence: number;
      entries: DaemonManifestEntryView[];
    };
    assert.equal(snapshot.daemon_generation, initial.daemon_generation);
    assert.ok(snapshot.sequence > initial.sequence);
    assert.equal(snapshot.entries[0]?.id, "state_subscription_agent");
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("watch_agent_stream long-polls one agent's ephemeral live feed", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const mk = (kind: string, method: string, summary: string): DaemonActivityEvent => ({
    observed_at: "2026-07-31T00:00:00.000Z", sequence: 0, provider: "open-model", kind, method,
    summary, status: "working", payload: { m: summary }, payload_truncated: false, payload_redacted: false, durable_payload_ref: null,
  });
  type StreamResult = { sequence: number; stream_generation: number; dropped_events: number; events: Array<{ sequence: number; kind: string; method: string; summary: string | null; payload: unknown }>; ended: boolean };
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      pushAgentStreamEvent: (entryId: string, event: DaemonActivityEvent) => void;
      endAgentStream: (entryId: string) => void;
    };

    // Capability advertised for graceful client degradation.
    const status = (await daemonRequest(paths.socketPath, "daemon.status")).result as { capabilities: Record<string, boolean> };
    assert.equal(status.capabilities.agent_activity_stream_v1, true);

    // Events buffered before the first poll are returned since cursor 0.
    internals.pushAgentStreamEvent("agent_a", mk("text_delta", "reasoning/summaryTextDelta", "thinking"));
    internals.pushAgentStreamEvent("agent_a", mk("text_delta", "item/agentMessage/delta", "hello"));
    const first = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", { entry_id: "agent_a", after_sequence: 0, wait_ms: 500 })).result as StreamResult;
    assert.equal(first.events.length, 2);
    assert.equal(first.sequence, 2);
    assert.equal(first.stream_generation, 1);
    assert.equal(first.dropped_events, 0);
    assert.equal(first.ended, false);
    assert.equal(first.events[0]!.summary, "thinking");

    // Long-poll blocks, then wakes on the next event (a tool call).
    const pending = daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", { entry_id: "agent_a", after_sequence: first.sequence, wait_ms: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    internals.pushAgentStreamEvent("agent_a", mk("tool_lifecycle", "item/toolCall/updated", "bash"));
    const woken = (await pending).result as StreamResult;
    assert.equal(woken.events.length, 1);
    assert.equal(woken.events[0]!.kind, "tool_lifecycle");
    assert.equal(woken.sequence, 3);

    // Strict per-entry isolation: another agent's watcher sees nothing.
    const other = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", { entry_id: "agent_b", after_sequence: 0, wait_ms: 50 })).result as StreamResult;
    assert.equal(other.events.length, 0);

    // A torn-down provider closes the feed; the watcher observes ended.
    internals.endAgentStream("agent_a");
    const ended = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", { entry_id: "agent_a", after_sequence: woken.sequence, wait_ms: 500 })).result as StreamResult;
    assert.equal(ended.ended, true);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("watch_agent_stream drains a backlog larger than one batch without gaps", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const mk = (summary: string): DaemonActivityEvent => ({
    observed_at: "2026-07-31T00:00:00.000Z", sequence: 0, provider: "open-model", kind: "text_delta", method: "item/agentMessage/delta",
    summary, status: "working", payload: { m: summary }, payload_truncated: false, payload_redacted: false, durable_payload_ref: null,
  });
  type StreamResult = { sequence: number; stream_generation: number; dropped_events: number; events: Array<{ sequence: number; summary: string | null }>; ended: boolean };
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      pushAgentStreamEvent: (entryId: string, event: DaemonActivityEvent) => void;
      endAgentStream: (entryId: string) => void;
    };
    // Buffer 100 events — more than a single 64-event batch can carry.
    for (let i = 1; i <= 100; i += 1) internals.pushAgentStreamEvent("agent_backlog", mk(`chunk-${i}`));
    internals.endAgentStream("agent_backlog");

    // The first poll returns one capped batch whose cursor is the LAST event it
    // actually carried, not the producer's newest sequence.
    const first = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", { entry_id: "agent_backlog", after_sequence: 0, wait_ms: 500 })).result as StreamResult;
    assert.equal(first.events.length, 64);
    assert.equal(first.events[0]!.sequence, 1);
    assert.equal(first.events[63]!.sequence, 64);
    assert.equal(first.sequence, 64, "cursor must be the last delivered event, never the producer high-water mark");
    assert.equal(first.stream_generation, 1);
    assert.equal(first.dropped_events, 0);
    assert.equal(first.ended, false, "a capped batch cannot end the viewer before retained backlog is delivered");

    // Resuming at that cursor drains the remainder; nothing past the cap is skipped.
    const second = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", { entry_id: "agent_backlog", after_sequence: first.sequence, wait_ms: 500 })).result as StreamResult;
    assert.equal(second.events.length, 36);
    assert.equal(second.events[0]!.sequence, 65);
    assert.equal(second.events[35]!.sequence, 100);
    assert.equal(second.sequence, 100);
    assert.equal(second.ended, true, "ended is emitted only with the generation high-water mark");

    // The two polls together reconstruct the full ordered backlog.
    const drained = [...first.events, ...second.events].map((event) => event.sequence);
    assert.deepEqual(drained, Array.from({ length: 100 }, (_, index) => index + 1));
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("watch_agent_stream reports bounded-history gaps and never replays a prior generation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const mk = (summary: string): DaemonActivityEvent => ({
    observed_at: "2026-08-06T00:00:00.000Z", sequence: 0, provider: "cursor", kind: "text_delta", method: "item/agentMessage/delta",
    summary, status: "working", payload: { delta: summary }, payload_truncated: false, payload_redacted: false, durable_payload_ref: null,
  });
  type StreamResult = { sequence: number; stream_generation: number; dropped_events: number; events: Array<{ sequence: number; summary: string | null }>; ended: boolean };
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      pushAgentStreamEvent: (entryId: string, event: DaemonActivityEvent) => void;
      resetAgentStream: (entryId: string) => void;
    };
    for (let i = 1; i <= 450; i += 1) internals.pushAgentStreamEvent("cursor_live", mk(`old-${i}`));

    const overflowed = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", {
      entry_id: "cursor_live", after_sequence: 0, wait_ms: 0,
    })).result as StreamResult;
    assert.equal(overflowed.stream_generation, 1);
    assert.equal(overflowed.dropped_events, 50, "the viewer is told exactly how much bounded history was evicted");
    assert.equal(overflowed.events[0]?.sequence, 51);
    assert.equal(overflowed.events[0]?.summary, "old-51");

    internals.resetAgentStream("cursor_live");
    internals.pushAgentStreamEvent("cursor_live", mk("new-turn-only"));
    const nextGeneration = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", {
      entry_id: "cursor_live", after_sequence: 0, wait_ms: 0,
    })).result as StreamResult;
    assert.equal(nextGeneration.stream_generation, 2);
    assert.equal(nextGeneration.dropped_events, 0, "a deliberate generation reset is not mislabeled as overflow");
    assert.deepEqual(nextGeneration.events.map((event) => event.summary), ["new-turn-only"]);
    assert.equal(nextGeneration.events[0]?.sequence, 451, "sequence remains monotonic across display generations");
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("purgeAgent drops the ephemeral live feed and settles its outstanding waiters", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const mk = (summary: string): DaemonActivityEvent => ({
    observed_at: "2026-07-31T00:00:00.000Z", sequence: 0, provider: "open-model", kind: "text_delta", method: "item/agentMessage/delta",
    summary, status: "working", payload: { m: summary }, payload_truncated: false, payload_redacted: false, durable_payload_ref: null,
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      pushAgentStreamEvent: (entryId: string, event: DaemonActivityEvent) => void;
      watchAgentStream: (input: { entryId: string; afterSequence: number; waitMs: number }) => Promise<{
        events: DaemonAgentStreamEvent[];
      }>;
    };
    const status = (await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number };
    // A fully stopped durable identity carrying a live-feed transcript.
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "purge_streams", desired_state: "stopped", observed_state: "stopped",
    } })).ok, true);
    internals.pushAgentStreamEvent("purge_streams", mk("hello"));
    assert.equal((await internals.watchAgentStream({ entryId: "purge_streams", afterSequence: 0, waitMs: 0 })).events.length, 1);

    // A drained watcher blocks before purge wakes it.
    const pending = internals.watchAgentStream({ entryId: "purge_streams", afterSequence: 1, waitMs: 5_000 });

    // A successful purge settles the waiter and drops the entry's ephemeral state.
    const purge = (await daemonRequest(paths.socketPath, "supervisor.purge_agent", {
      entry_id: "purge_streams", daemon_generation: status.generation, revoked_agent_session_id: null,
    })).result as { outcome: string };
    assert.equal(purge.outcome, "purged");
    const replay = (await daemonRequest(paths.socketPath, "supervisor.purge_agent", {
      entry_id: "purge_streams", daemon_generation: status.generation, revoked_agent_session_id: null,
    })).result as { outcome: string };
    assert.equal(replay.outcome, "purged", "a completed purge tombstone remains replayable after the identity row is gone");
    await pending; // the blocked watcher returns rather than hanging to its own timeout
    assert.deepEqual(
      (await internals.watchAgentStream({ entryId: "purge_streams", afterSequence: 0, waitMs: 0 })).events,
      [],
    );
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("purge fences an unattached exact Cursor wrapper before committing profile cleanup authority", async () => {
  const env = await fixture();
  const id = "purge_unattached_cursor";
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({
    taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id,
  });
  await durability.close();
  const connection = { kind: "cursor_cli" as const, pid: 7331, processIdentity: "cursor-wrapper-birth" };
  let stopRefs = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({
      deliveryModes: ["daemon_inbox"], resume: true, midTurnInjection: false,
      transcriptAccess: false, permissionPromptBridging: false, survivesRestart: true,
    }),
    spawn: async () => { throw new Error("purge test must not spawn"); },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("purge test must not resume"); },
    poke: async () => {},
    stop: async () => { throw new Error("purge must use the unattached exact-reference fence"); },
    stopRef: async (ref) => {
      stopRefs += 1;
      assert.equal(ref.workAttemptId, attempt.work_attempt_id);
      assert.deepEqual(ref.providerConnection, connection);
      return {
        endedAt: new Date().toISOString(), exitCode: 0, signal: null,
        terminalCause: "stopped", providerContinuationId: ref.providerContinuationId,
      };
    },
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      durability: WorkDurabilityStore;
      requestConvergence: (entryId: string) => void;
    };
    internals.requestConvergence = () => {};
    const execution = await internals.durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id,
      provider: "cursor",
      delivery_mode: "daemon_inbox",
      permission_profile_id: "read_only",
      desired_state: "stopped",
      observed_state: "stopped",
      workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id,
      last_worker_binding: null,
      run_id: execution.execution_generation_id,
      deployment_id: serializeDaemonDeploymentId(id, execution.execution_generation_id),
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id,
        provider_continuation_id: "sess-purge-cursor",
        provider_connection: connection,
        execution_generation_id: execution.execution_generation_id,
      },
    } });
    assert.equal(put.ok, true, put.error);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id, desired_state: "running",
    })).ok, true);
    let generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const refusedWhileRunning = (await daemonRequest(paths.socketPath, "supervisor.purge_agent", {
      entry_id: id, daemon_generation: generation, revoked_agent_session_id: null,
    })).result as { outcome: string; error?: string };
    assert.equal(refusedWhileRunning.outcome, "invalid");
    assert.match(refusedWhileRunning.error ?? "", /fully stopped durable lifecycle/);
    assert.equal(stopRefs, 0, "an invalid purge never stops an unattached wrapper owned by a running lifecycle");
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id, desired_state: "stopped",
    })).ok, true);
    generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const prepared = (await daemonRequest(paths.socketPath, "supervisor.purge_agent", {
      entry_id: id, daemon_generation: generation, revoked_agent_session_id: null,
    })).result as { outcome: string; revocation_kind?: string };
    assert.equal(prepared.outcome, "revocation_required", JSON.stringify(prepared));
    assert.equal(prepared.revocation_kind, "grant_only");
    assert.equal(stopRefs, 1, "purge fences the recorded wrapper before asking Electron to revoke authority");
    const committed = (await daemonRequest(paths.socketPath, "supervisor.purge_agent", {
      entry_id: id, daemon_generation: generation, revoked_agent_session_id: null,
      grant_revoked_without_worker_session: true,
    })).result as { outcome: string; purged_work_attempt_id?: string };
    assert.equal(committed.outcome, "purged");
    assert.equal(committed.purged_work_attempt_id, attempt.work_attempt_id);
    assert.equal(stopRefs, 2, "the commit retry re-proves exact wrapper absence before destructive cleanup");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("desired-state compare-and-set cannot resurrect a concurrently stopped launch", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "resume_cas",
      desired_state: "paused",
      observed_state: "starting",
    } })).ok, true);
    const activated = (await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "resume_cas",
      expected_desired_state: "paused",
      desired_state: "running",
    })).result as { applied: boolean; entry: DaemonManifestEntry };
    assert.equal(activated.applied, true);
    assert.equal(activated.entry.desired_state, "running");
    const staleRollback = (await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "resume_cas",
      expected_desired_state: "paused",
      desired_state: "stopped",
    })).result as { applied: boolean; entry: DaemonManifestEntry };
    assert.equal(staleRollback.applied, false, "a losing resume cannot roll back another activation");
    assert.equal(staleRollback.entry.desired_state, "running");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "resume_cas", desired_state: "stopped" });
    const staleActivation = (await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "resume_cas",
      expected_desired_state: "paused",
      desired_state: "running",
    })).result as { applied: boolean; entry: DaemonManifestEntry };
    assert.equal(staleActivation.applied, false, "a concurrent Stop wins over resume");
    assert.equal(staleActivation.entry.desired_state, "stopped");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("agent inspector detail socket requests require an exact string-or-null source fence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    for (const params of [
      { entry_id: "agent_1", room_id: "room_1" },
      { entry_id: "agent_1", room_id: "room_1", source_message_id: 7 },
      { entry_id: 7, room_id: "room_1", source_message_id: null },
      { entry_id: "agent_1", room_id: 7, source_message_id: null },
    ]) {
      const response = await daemonRequest(paths.socketPath, "supervisor.get_agent_inspector_detail", params);
      assert.equal(response.ok, false);
      assert.match(response.error ?? "", /requires string entry_id, string room_id, and source_message_id as string or null/);
    }
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("production publication requires a nonempty canonical id in the requested room", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const body of [{ id: "", room_id: "room_1" }, { id: "msg_1", room_id: "room_2" }]) {
      globalThis.fetch = (async () => ({ ok: true, json: async () => body })) as typeof fetch;
      await assert.rejects(
        () => productionSupervisedDeliveryHttp.publish({ roomId: "room_1", apiUrl: "https://letagents.test", bearer: "token", text: "reply", clientMessageId: "client_1", replyTo: null, threadRootId: null }),
        /omitted its canonical message identity/,
      );
    }
    const publishedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url, init) => {
      publishedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, json: async () => ({ id: "msg_1", room_id: "room_1" }) };
    }) as typeof fetch;
    assert.deepEqual(
      await productionSupervisedDeliveryHttp.publish({ roomId: "room_1", apiUrl: "https://letagents.test", bearer: "token", text: "reply", clientMessageId: "client_1", replyTo: "msg_45", threadRootId: "msg_44" }),
      { messageId: "msg_1", roomId: "room_1" },
    );
    assert.deepEqual(publishedBodies, [{
      sender: "supervised-daemon",
      text: "reply",
      client_message_id: "client_1",
      reply_to: "msg_45",
      thread_root_id: "msg_44",
    }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("legacy lane owner liveness compares the stable process birth prefix, not the whole ps line", () => {
  // Repro of the supervised Start reserve->activate failure: Electron records the
  // owner identity as start-time only (defaultGetProcessIdentity = `ps -o lstart=`),
  // but the daemon previously read `lstart + command` and compared whole strings, so
  // a live owner never matched and its reservation was pruned before activate.
  const recorded = "Wed Jul 16 02:22:00 2026";
  // Same live process, read start-time-only, is the same birth identity -> stays live.
  assert.equal(sameProcessBirthIdentity("Wed Jul 16 02:22:00 2026", recorded), true);
  // ps column padding varies; the stable prefix normalizes whitespace.
  assert.equal(sameProcessBirthIdentity("Wed Jul 16  02:22:00 2026", recorded), true);
  // Pre-2.0.12 identities appended the mutable command; the stable prefix still
  // matches a start-time-only read (live-upgrade compatibility), both directions.
  assert.equal(sameProcessBirthIdentity(
    "Wed Jul 16 02:22:00 2026",
    "Wed Jul 16 02:22:00 2026 /Applications/LetAgents.app/Contents/MacOS/Electron",
  ), true);
  assert.equal(sameProcessBirthIdentity("Wed Jul 16 02:22:00 2026 node dist-daemon/main.js", recorded), true);
  // A different start time (PID reuse) is a different process and must read dead.
  assert.equal(sameProcessBirthIdentity("Wed Jul 16 09:00:00 2026", recorded), false);
});

test("a reserved legacy lane owner recorded with a start-time-only identity survives reserve->activate->release", async () => {
  // Product-sequence regression for the supervised Start reserve->activate failure.
  // Electron records the owner identity as start-time only (defaultGetProcessIdentity
  // = `ps -o lstart=`). This live test process is the owner, so liveness is real and
  // deterministic. Pre-fix, isProcessOwnerLive read `lstart + command` and compared
  // whole strings, so the start-time-only recorded identity never matched and
  // liveLegacyLaneOwners pruned the reservation before activate -> activate threw
  // "Unknown legacy lane reservation". The birth-prefix comparison keeps it live.
  // Verified to FAIL on ea06a21f and PASS on the fix.
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"),
    auditPath: join(env.root, "audit.jsonl"),
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const ownerIdentity = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    assert.ok(ownerIdentity.length > 0);
    const reservationId = randomUUID();
    const reserve = await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: reservationId,
      room_id: "room_legacy",
      provider: "codex",
      owner_pid: process.pid,
      owner_process_identity: ownerIdentity,
    });
    assert.equal(reserve.ok, true);
    const activate = await daemonRequest(paths.socketPath, "lane.activate_legacy", {
      reservation_id: reservationId,
      session_id: "session_legacy",
    });
    assert.equal(activate.ok, true, `activate failed: ${activate.error ?? ""}`);
    const activeOwners = (await new ManifestStore(paths.manifestPath).load()).legacy_lane_owners ?? [];
    const active = activeOwners.find((candidate) => candidate.reservation_id === reservationId);
    assert.equal(active?.state, "active");
    assert.equal(active?.session_id, "session_legacy");

    // Full lifecycle: release must succeed and durably drop the owner so the fix
    // cannot silently break the release path.
    const release = await daemonRequest(paths.socketPath, "lane.release_legacy", { reservation_id: reservationId });
    assert.equal(release.ok, true, `release failed: ${release.error ?? ""}`);
    assert.equal((release.result as { released?: boolean }).released, true);
    const afterRelease = (await new ManifestStore(paths.manifestPath).load()).legacy_lane_owners ?? [];
    assert.equal(afterRelease.some((candidate) => candidate.reservation_id === reservationId), false);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("supervised native stream extracts only explicit LetAgents wait cursors", () => {
  const base = {
    workAttemptId: "attempt",
    providerContinuationId: "continuation",
    observedAt: new Date().toISOString(),
    sequence: 1,
    provider: "claude-code",
    kind: "text_delta",
    method: "assistant",
    payloadTruncated: false,
    payloadRedacted: false,
    durablePayloadRef: null,
  };
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: {
      type: "assistant",
      message: { content: [{
        type: "tool_use",
        name: "mcp__letagents__wait_for_messages",
        input: { after_message_id: "msg_3064", agent_session_id: "agent_session_exact" },
      }] },
    },
  }), "msg_3064");
  assert.deepEqual(supervisedWaitEvidenceFromProviderEvent({
    ...base,
    payload: {
      type: "tool_use",
      name: "wait_for_messages",
      input: { after_message_id: "msg_3065", agent_session_id: "agent_session_exact" },
    },
  }), { roomCursor: "msg_3065", agentSessionId: "agent_session_exact" });
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: { type: "tool_use", name: "wait_for_messages", input: { after_message_id: "msg_3065" } },
  }), null, "a cursor without exact worker-session evidence is unusable");
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: { type: "assistant", message: { content: [{ type: "text", text: "wait_for_messages after msg_999" }] } },
  }), null, "free text cannot advance durable room progress");
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__other__wait_for_messages", input: { after_message_id: "not-a-message" } }] } },
  }), null, "malformed cursors are ignored");
});

test("supervised native stream classifies structured Claude and Codex room waits as quiet polling", () => {
  const base = {
    workAttemptId: "attempt",
    providerContinuationId: "continuation",
    observedAt: new Date().toISOString(),
    sequence: 1,
    provider: "claude-code" as const,
    kind: "tool_lifecycle" as const,
    method: "assistant",
    payloadTruncated: false,
    payloadRedacted: false,
    durablePayloadRef: null,
  };
  assert.equal(isSupervisedWaitProviderEvent({
    ...base,
    payload: { type: "tool_use", name: "mcp__letagents__wait_for_messages", input: {} },
  }), true);
  assert.equal(isSupervisedWaitProviderEvent({
    ...base,
    provider: "codex",
    method: "item/started",
    payload: { item: { type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "inProgress" } },
  }), true);
  assert.equal(isSupervisedWaitProviderEvent({
    ...base,
    kind: "text_delta",
    payload: { type: "assistant", message: { content: [{ type: "text", text: "call wait_for_messages next" }] } },
  }), false, "free text cannot hide genuine user-facing work");
  assert.equal(isSupervisedWaitProviderEvent({
    ...base,
    provider: "codex",
    method: "item/started",
    payload: { item: { type: "mcpToolCall", id: "read_codex", server: "letagents", tool: "read_messages", status: "inProgress" } },
  }), false, "other room tools remain visible as real work");
});

test("supervised native stream keeps correlated empty wait results and handoffs quiet", () => {
  const claudeWait = {
    method: "assistant",
    payload: {
      type: "assistant",
      message: { content: [{
        type: "tool_use",
        id: "wait_claude",
        name: "mcp__letagents__wait_for_messages",
        input: { after_message_id: "msg_10", agent_session_id: "agent_session_exact" },
      }] },
    },
  };
  const claudeResult = (body: object, overrides: object = {}) => ({
    method: "user",
    payload: {
      type: "user",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "wait_claude",
        content: [{ type: "text", text: JSON.stringify(body) }],
        ...overrides,
      }] },
    },
  });
  const emptyResult = claudeResult({ messages: [], room_id: "focus_37" });
  assert.equal(isSupervisedQuietPollContinuation(emptyResult, [claudeWait]), true);
  assert.equal(isSupervisedQuietPollContinuation(
    claudeResult({ messages: [], last_observed_message_id: "msg_11", skipped_message_count: 1 }),
    [claudeWait],
  ), true, "silent/skipped cursor progress remains an idle poll result");
  assert.equal(isSupervisedQuietPollContinuation(
    claudeResult({ messages: [{ id: "msg_11", text: "please act" }] }),
    [claudeWait],
  ), false, "an addressed result wakes the worker visibly");
  assert.equal(isSupervisedQuietPollContinuation(
    claudeResult({ messages: [] }, { is_error: true }),
    [claudeWait],
  ), false, "poll errors are never hidden as idle");
  assert.equal(isSupervisedQuietPollContinuation(
    { method: "assistant", payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "bounded provider thought" }] } } },
    [claudeWait, emptyResult],
  ), true, "the thinking-only beat before the immediate re-wait does not flash working");
  assert.equal(isSupervisedQuietPollContinuation(
    { method: "assistant", payload: { type: "assistant", message: { content: [{ type: "text", text: "Starting the requested review" }] } } },
    [claudeWait, emptyResult],
  ), false, "user-facing assistant work remains visible without free-text heuristics");

  const codexWait = {
    method: "item/started",
    payload: {
      item: { type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "inProgress" },
      threadId: "thread_codex",
      turnId: "turn_codex",
    },
  };
  const codexProgress = {
    method: "item/mcpToolCall/progress",
    payload: { itemId: "wait_codex", message: "waiting", threadId: "thread_codex", turnId: "turn_codex" },
  };
  const codexResult = {
    method: "item/completed",
    payload: {
      item: {
        type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "completed",
        result: { content: [{ type: "text", text: JSON.stringify({ messages: [], last_observed_message_id: "msg_12" }) }], structuredContent: null, _meta: null },
        error: null,
      },
      threadId: "thread_codex",
      turnId: "turn_codex",
    },
  };
  assert.equal(isSupervisedQuietPollContinuation(codexProgress, [codexWait]), true, "real Codex progress correlates by params.itemId");
  assert.equal(isSupervisedQuietPollContinuation(codexResult, [codexWait, codexProgress]), true, "real Codex completion correlates by params.item.id");
  assert.equal(isSupervisedQuietPollContinuation({
    method: "item/completed",
    payload: {
      item: {
        type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "completed",
        result: { content: [], structuredContent: { messages: [{ id: "msg_13", text: "please act" }] }, _meta: null },
        error: null,
      },
    },
  }, [codexWait]), false, "an addressed real Codex completion remains visible work");
  assert.equal(isSupervisedQuietPollContinuation({
    method: "item/completed",
    payload: {
      item: {
        type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "failed",
        result: null, error: { message: "poll failed" },
      },
    },
  }, [codexWait]), false, "a failed real Codex completion is never hidden");
  for (let index = 0; index < 10; index += 1) {
    assert.equal(isSupervisedQuietPollContinuation(emptyResult, [claudeWait]), true, `staggered idle agent ${index + 1} stays quiet`);
  }
});

async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "letagents-daemon-"));
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
}

/** Set up the already-admitted ingress assumed by provider-lifecycle tests. */
async function admitDaemonInboxForProviderTest(daemon: SupervisorDaemon, agentId: string, roomId: string): Promise<void> {
  const internals = daemon as unknown as { supervisedInbox: SupervisedAgentInboxStore };
  await internals.supervisedInbox.bootstrapCursor({ agent_id: agentId, room_id: roomId, last_observed_message_id: null });
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs); })]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function eventually(predicate: () => Promise<boolean>, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function fakeRecoveryClock(startMs = 10_000) {
  let nowMs = startMs;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const delays: number[] = [];
  const setTimer = ((callback: () => void, delay = 0) => {
    const id = nextId++;
    const handle = { id, unref() { return handle; } } as unknown as ReturnType<typeof setTimeout>;
    timers.set(id, { at: nowMs + Number(delay), callback });
    delays.push(Number(delay));
    return handle;
  }) as typeof setTimeout;
  const clearTimer = ((handle: ReturnType<typeof setTimeout>) => {
    const id = (handle as unknown as { id?: number }).id;
    if (id !== undefined) timers.delete(id);
  }) as typeof clearTimeout;
  return {
    clock: { nowMs: () => nowMs, setTimeout: setTimer, clearTimeout: clearTimer },
    delays,
    pending: () => timers.size,
    advance: async (deltaMs: number) => {
      nowMs += deltaMs;
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= nowMs).sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
      await Promise.resolve();
    },
  };
}

async function daemonRequest(socketPath: string, method: string, params?: unknown, version = DAEMON_PROTOCOL_VERSION): Promise<{ ok: boolean; result?: unknown; error?: string; version: number }> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    let received = "";
    let settled = false;
    client.setEncoding("utf8");
    client.once("error", reject);
    client.once("close", () => {
      if (!settled) reject(new Error(`Daemon connection closed before '${method}' returned a response.`));
    });
    client.on("data", (chunk) => {
      received += chunk;
      if (!received.includes("\n")) return;
      settled = true;
      client.end();
      resolve(JSON.parse(received.slice(0, received.indexOf("\n"))));
    });
    client.on("connect", () => client.write(`${JSON.stringify({ version, id: "test", method, params })}\n`));
  });
}

function concurrentDaemonRequestBarrier(socketPath: string) {
  const clients = new Map<string, ReturnType<typeof createConnection>>();
  const requests = new Map<string, string>();
  const connected = new Set<string>();
  let released = false;

  const releaseWhenReady = () => {
    if (released || connected.size !== 2) return;
    released = true;
    for (const [label, client] of clients) client.write(requests.get(label)!);
  };

  return (label: string, method: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string; version: number }> => {
    if (clients.has(label)) throw new Error(`Duplicate barrier label: ${label}`);
    const response = new Promise<{ ok: boolean; result?: unknown; error?: string; version: number }>((resolve, reject) => {
      const client = createConnection(socketPath);
      clients.set(label, client);
      requests.set(label, `${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: `ordered_barrier_${label}`, method, params })}\n`);
      let received = "";
      client.setEncoding("utf8");
      client.once("error", reject);
      client.on("data", (chunk) => {
        received += chunk;
        if (!received.includes("\n")) return;
        client.end();
        resolve(JSON.parse(received.slice(0, received.indexOf("\n"))));
      });
      client.on("connect", () => {
        connected.add(label);
        releaseWhenReady();
      });
    });
    releaseWhenReady();
    return response;
  };
}

function orderedDaemonMutationBarrier(releaseOrder: readonly ["legacy", "supervised"] | readonly ["supervised", "legacy"]) {
  const arrived = new Set<"legacy" | "supervised">();
  const waiting = new Map<"legacy" | "supervised", () => void>();
  let released = false;
  return {
    arrived,
    gate: (request: DaemonRequest): Promise<void> => {
      const label = request.method === "lane.reserve_legacy"
        ? "legacy"
        : request.method === "manifest.put"
          ? "supervised"
          : null;
      if (!label) return Promise.resolve();
      if (arrived.has(label)) throw new Error(`Duplicate mutation barrier arrival: ${label}`);
      arrived.add(label);
      const blocked = new Promise<void>((resolve) => { waiting.set(label, resolve); });
      if (!released && arrived.size === 2) {
        released = true;
        waiting.get(releaseOrder[0])!();
        queueMicrotask(() => waiting.get(releaseOrder[1])!());
      }
      return blocked;
    },
  };
}

const TEST_OID = "a".repeat(40);
const TEST_SUPERVISOR = { supervisor_id: "test-daemon", supervisor_generation: 1 };
async function provisionedWorkspace(root: string, taskId = "task", workAttemptId = randomUUID()): Promise<{ path: string; id: string; bare: string }> {
  const bare = join(root, "repos", "repo.git");
  const path = join(root, "worktrees", "repo", workAttemptId);
  await mkdir(bare, { recursive: true });
  await mkdir(path, { recursive: true });
  await writeFile(join(path, ".letagents-work-attempt.json"), JSON.stringify({ version: 1, repo: "repo", work_attempt_id: workAttemptId, task_id: taskId, remote_url: "https://example.invalid/repo", resolved_revision: TEST_OID, bare_path: bare }));
  return { path, id: workAttemptId, bare };
}
async function committedSourceRepository(root: string, name: string): Promise<string> {
  const source = join(root, name);
  await mkdir(source);
  await execFileAsync("git", ["init", source]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
  await writeFile(join(source, "README.md"), `${name}\n`);
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", source, "remote", "add", "origin", source]);
  return source;
}
async function primeDaemonBareRepository(root: string, source: string): Promise<void> {
  const repos = join(root, "repos");
  await mkdir(repos, { recursive: true });
  await execFileAsync("git", ["clone", "--bare", source, join(repos, `${repositoryStorageKey(source)}.git`)]);
}
function fakeGit(root: string): (args: string[]) => Promise<string> {
  return async (args) => {
    if (args.includes("--git-common-dir")) return join(root, "repos", "repo.git");
    if (args.includes("remote") && args.includes("get-url")) return "https://example.invalid/repo.git";
    if (args.includes("--is-bare-repository")) return "true";
    if (args.includes("cat-file")) return "ok";
    if (args.includes("rev-parse")) return TEST_OID;
    return "";
  };
}

const entry: DaemonManifestEntry = {
  id: "agent_1", room_id: "room_1", display_name: "Agent", provider: "test", model: null, charter: "test",
  desired_state: "running", observed_state: "idle", condition: "none", permission_profile_id: null, created_by: "test", created_at: "2026-01-01T00:00:00.000Z",
};

/** Real daemon storage/lifecycle wiring with only the native observer faked. */
async function observationDaemonFixture(onExecution: NonNullable<ProviderActionPort["onExecution"]>, provider: "codex" | "claude-code" | "cursor" = "codex", overrides: Partial<ProviderActionPort> = {}, codexConnection?: Extract<NonNullable<ProviderActionHandle["providerConnection"]>, { kind: "codex_app_server" }>) {
  const env = await fixture();
  const id = "observed-agent";
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { throw new Error("observation fixture installs an existing exact handle"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("observation fixture must not resume a provider"); }, poke: async () => {},
    stop: async () => { throw new Error("observation must never control the provider"); },
    onExit: async () => () => {}, onStream: async () => () => {}, onExecution, ...overrides,
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, false);
  const internals = daemon as unknown as {
    durability: WorkDurabilityStore; store: ManifestStore; supervisedInbox: SupervisedAgentInboxStore;
    workerBindings: WorkerBindingStore; providerStreams: ProviderStreamCoordinator;
    providerCheckpoints: ProviderCheckpointCoordinator; executionCapture: ExecutionCaptureCoordinator | null;
    liveHandles: Map<string, ProviderActionHandle>;
    manifestGeneration: number;
  };
  try {
    await daemon.start();
    assert.ok(internals.executionCapture, "optional writer opens only after real protected schema initialization");
    const workspace = await provisionedWorkspace(env.root, id);
    const attempt = await internals.durability.createAttempt({
      taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id,
    });
    const execution = await internals.durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
    const handle: ProviderActionHandle = {
      workAttemptId: attempt.work_attempt_id, providerContinuationId: "observed-continuation", observedState: "working",
      pid: provider === "cursor" ? null : codexConnection?.pid ?? 7123,
      providerConnection: provider === "cursor" ? { kind: "cursor_cli", pid: null, processIdentity: null }
        : provider === "claude-code" ? { kind: "claude_cli", pid: 7123, processIdentity: "observed-birth" }
          : codexConnection ?? { kind: "codex_app_server", pid: 7123, processIdentity: "observed-birth", url: "ws://127.0.0.1:7123" },
    };
    const stored: DaemonManifestEntry = {
      ...entry, id, provider, delivery_mode: "daemon_inbox", workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id, run_id: execution.execution_generation_id,
      deployment_id: serializeDaemonDeploymentId(id, execution.execution_generation_id),
      runtime_configuration_revision: 1,
      provider_ref: { work_attempt_id: attempt.work_attempt_id, execution_generation_id: execution.execution_generation_id,
        provider_continuation_id: handle.providerContinuationId!, provider_connection: handle.providerConnection! },
    };
    const inserted = await daemonRequest(paths.socketPath, "manifest.put", { entry: stored });
    assert.equal(inserted.ok, true, inserted.error);
    handle.appliedConfigurationRevision = 1;
    const persisted = await internals.store.load();
    const current = persisted.entries.find((candidate) => candidate.id === id);
    assert.ok(current);
    const birth = await internals.store.checkpointProviderBirth(persisted.generation, {
      entry: current,
      executionGenerationId: execution.execution_generation_id,
      providerConnection: handle.providerConnection!,
      appliedRevision: 1,
      requestedAuthorityMode: "typed_shadow",
      observedAtMs: Date.now(),
    });
    internals.manifestGeneration = birth.generation;
    return { ...env, id, paths, daemon, internals, handle, port, generation: execution.execution_generation_id,
      cleanup: async () => { await daemon.stop(); await env.cleanup(); } };
  } catch (error) {
    await daemon.stop().catch(() => undefined); await env.cleanup(); throw error;
  }
}

test("configuration apply socket stops the exact idle birth and leaves the saved revision pending for its successor", async () => {
  let stops = 0;
  const env = await observationDaemonFixture(
    async () => ({ mode: "typed_shadow", dispose() {} }),
    "codex",
    {
      stop: async current => {
        assert.equal(current.providerContinuationId, "observed-continuation");
        stops += 1;
        return {
          endedAt: new Date().toISOString(),
          exitCode: 0,
          signal: null,
          terminalCause: "stopped",
          providerContinuationId: current.providerContinuationId,
        };
      },
    },
  );
  try {
    env.handle.observedState = "idle";
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    const status = await daemonRequest(env.paths.socketPath, "daemon.status");
    const daemonGeneration = (status.result as { generation: number }).generation;
    const before = await daemonRequest(env.paths.socketPath, "supervisor.get_agent_configuration", {
      entry_id: env.id,
      daemon_generation: daemonGeneration,
    });
    assert.equal(before.ok, true, before.error);
    const configuration = before.result as {
      config_revision: number;
      model: string | null;
      reasoning_effort: string | null;
      charter: string;
      permission_profile_id: string | null;
    };
    const update = await daemonRequest(env.paths.socketPath, "supervisor.update_agent_configuration", {
      entry_id: env.id,
      daemon_generation: daemonGeneration,
      expected_revision: configuration.config_revision,
      configuration: {
        model: configuration.model,
        reasoning_effort: configuration.reasoning_effort,
        charter: `${configuration.charter} with saved change`,
        permission_profile_id: configuration.permission_profile_id,
      },
    });
    assert.equal(update.ok, true, update.error);
    const saved = (update.result as {
      outcome: string;
      configuration: { config_revision: number; runtime_configuration_revision: number };
    }).configuration;
    assert.equal(saved.config_revision, 2);
    assert.equal(saved.runtime_configuration_revision, 1);

    const applied = await daemonRequest(env.paths.socketPath, "supervisor.apply_agent_configuration", {
      entry_id: env.id,
      daemon_generation: daemonGeneration,
      expected_configuration_revision: saved.config_revision,
    });
    assert.equal(applied.ok, true, applied.error);
    assert.deepEqual(applied.result, { outcome: "restarting" });
    assert.equal(stops, 1);
    assert.equal(env.internals.liveHandles.has(env.id), false);
    const after = await env.internals.store.getEntry(env.id);
    assert.equal(after?.observed_state, "recovering");
    assert.deepEqual(after?.provider_ref?.execution_generation_id, env.generation,
      "the retained continuation remains available to ordinary successor convergence");
    assert.equal((await env.internals.store.getAgentConfiguration(env.id))?.runtime_configuration_revision, 1,
      "only a successor birth may advance the applied configuration revision");
  } finally {
    await env.cleanup();
  }
});

test("reverse drain socket and daemon restart preserve stop intent without a successor or cursor bootstrap", async () => {
  let starts = 0;
  let attaches = 0;
  let stops = 0;
  const birth = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim();
  const connection = { kind: "codex_app_server" as const, pid: process.pid, processIdentity: birth, url: "ws://127.0.0.1:7123" };
  const env = await observationDaemonFixture(async () => ({ mode: "typed_shadow", dispose() {} }), "codex", {
    preflightCustodialPolling: async () => {},
    inspectTurnBoundary: async () => ({ state: "idle", providerContinuationId: "observed-continuation", nativeProcessIdentity: birth, latestProviderTurnId: null }),
    // This fixture deliberately keeps a demonstrably live process (this test)
    // alive. Returning a protocol terminal must never authorize the mode flip.
    stopRef: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "observed-continuation" }; },
    spawn: async () => { starts += 1; throw new Error("unexpected successor spawn"); },
    resume: async () => { starts += 1; throw new Error("unexpected successor resume"); },
    attach: async () => { attaches += 1; return null; },
    attachAction: async () => { attaches += 1; return { state: "absent" }; },
    runRoomTurn: async () => { throw new Error("reverse must not activate a turn"); },
  }, connection);
  let successor: SupervisorDaemon | undefined;
  try {
    const stored = (await env.internals.store.getEntry(env.id))!;
    env.internals.liveHandles.set(env.id, env.handle);
    await env.internals.supervisedInbox.bootstrapCursor({ agent_id: env.id, room_id: stored.room_id, last_observed_message_id: "100" });
    const status = await daemonRequest(env.paths.socketPath, "daemon.status");
    const generation = (status.result as { generation: number }).generation;
    const params = { entry_id: env.id, operation_id: "reverse-operation", request_id: "reverse-request", room_id: stored.room_id,
      execution_generation_id: env.generation, daemon_generation: generation };
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.prepare_delivery_drain", { ...params, daemon_generation: generation + 1 })).ok, false);
    assert.equal(await env.internals.store.unresolvedDeliveryDrain(env.id), null);
    assert.deepEqual((await env.internals.store.getEntry(env.id))?.provider_ref, stored.provider_ref);
    assert.equal(env.internals.liveHandles.get(env.id)?.providerContinuationId, "observed-continuation");
    const prepared = await daemonRequest(env.paths.socketPath, "supervisor.prepare_delivery_drain", params);
    assert.equal(prepared.ok, true, prepared.error);
    const firstDriver = env.daemon as unknown as { deliveryCutovers: { start(id: string): Promise<void> } };
    await firstDriver.deliveryCutovers.start(env.id).catch(() => {});
    assert.equal((await env.internals.store.getDeliveryDrain("reverse-operation"))?.phase, "uncertain");
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.cancel_delivery_drain", params)).ok, false);
    await env.daemon.stop();
    successor = new SupervisorDaemon(env.paths, "darwin", env.port, true);
    await successor.start();
    const restarted = successor as unknown as { store: ManifestStore; supervisedInbox: SupervisedAgentInboxStore; deliveryCutovers: { start(id: string): Promise<void> } };
    await restarted.deliveryCutovers.start(env.id).catch(() => {});
    const after = await daemonRequest(env.paths.socketPath, "daemon.status");
    const currentGeneration = (after.result as { generation: number }).generation;
    assert.notEqual(currentGeneration, generation);
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.get_delivery_drain", params)).ok, false, "old daemon controllers cannot mutate/read under stale authority");
    const read = await daemonRequest(env.paths.socketPath, "supervisor.get_delivery_drain", { ...params, daemon_generation: currentGeneration });
    assert.equal(read.ok, true, read.error);
    assert.equal((read.result as { phase: string }).phase, "uncertain");
    await assert.rejects(restarted.supervisedInbox.bootstrapCursor({ agent_id: env.id, room_id: stored.room_id, last_observed_message_id: "999" }), /freezes/);
    assert.equal((await restarted.store.getEntry(env.id))?.delivery_mode, "daemon_inbox");
    assert.equal(starts, 0);
    assert.equal(attaches, 0, "restart cannot reattach/rebind the frozen process through normal convergence");
    assert.ok(stops >= 1);
  } finally { await successor?.stop(); await env.cleanup(); }
});

for (const scenario of ["activation", "pre_activation_forward"] as const) test(scenario === "activation"
  ? "custodial polling socket activation is generation-fenced and restart never dispatches prepared or uncertain work"
  : "custodial forward socket switches only before activation and restart preserves the completed receipt", async () => {
  const oldProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { oldProcess.once("spawn", resolve); oldProcess.once("error", reject); });
  const oldPid = oldProcess.pid!;
  const birth = (pid: number) => execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
  const oldConnection = { kind: "codex_app_server" as const, pid: oldPid, processIdentity: birth(oldPid), url: "ws://127.0.0.1:7123" };
  const pollingProcess = scenario === "pre_activation_forward"
    ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }) : null;
  if (pollingProcess) await new Promise<void>((resolve, reject) => {
    pollingProcess.once("spawn", resolve);
    pollingProcess.once("error", error => { oldProcess.kill("SIGTERM"); reject(error); });
  });
  const pollingPid = pollingProcess?.pid ?? process.pid;
  const currentConnection = { ...oldConnection, pid: pollingPid, processIdentity: birth(pollingPid) };
  let nativeStarts = 0;
  let expectedPollingCursor = "100";
  let behavior: "success" | "before_dispatch_failure" | "lost_ack" = "success";
  let terminal = false;
  let currentHandle: ProviderActionHandle | undefined;
  const env = await observationDaemonFixture(async () => ({ mode: "typed_shadow", dispose() {} }), "codex", {
    preflightCustodialPolling: async () => {},
    inspectTurnBoundary: async handle => ({ state: "idle", providerContinuationId: handle.providerContinuationId!,
      nativeProcessIdentity: handle.providerConnection!.processIdentity!, latestProviderTurnId: null }),
    stopRef: async ref => {
      const target = ref.providerConnection?.pid === oldPid ? oldProcess : pollingProcess;
      assert.ok(target, "only this test's exact child process can be stopped");
      assert.deepEqual(ref.providerConnection, target === oldProcess ? oldConnection : currentConnection);
      const exited = new Promise<void>(resolve => target.once("exit", () => resolve()));
      target.kill("SIGTERM"); await exited;
      return { endedAt: new Date().toISOString(), exitCode: null, signal: "SIGTERM", terminalCause: "stopped", providerContinuationId: ref.providerContinuationId };
    },
    activateCustodialPolling: async (handle, request, callbacks) => {
      assert.equal(handle, currentHandle);
      assert.equal(request.launchReceipt.agentSessionId, "polling-worker");
      assert.deepEqual(request.launchReceipt.providerConnection, currentConnection);
      assert.equal(request.workerSession.roomCursor, expectedPollingCursor);
      if (behavior === "before_dispatch_failure") throw new Error("test transport unavailable before dispatch");
      await callbacks.beforeNativeDispatch(); nativeStarts += 1;
      if (behavior === "lost_ack") throw new Error("test native acknowledgement lost");
      await callbacks.checkpointTurnStarted("exact-polling-turn");
      return { providerTurnId: "exact-polling-turn" };
    },
    inspectCustodialPollingActivation: async (handle, turnId) => {
      assert.deepEqual(handle.providerConnection, currentConnection);
      assert.equal(turnId, "exact-polling-turn");
      return terminal ? { state: "terminal", outcome: "completed" } : { state: "active" };
    },
  }, oldConnection).catch(error => { oldProcess.kill("SIGTERM"); pollingProcess?.kill("SIGTERM"); throw error; });
  let daemon = env.daemon;
  type Internals = typeof env.internals & {
    authority: { generation: number; fenceDaemonCommit<T>(commit: () => Promise<T>): Promise<T> };
    updateManifestEntry(id: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry): Promise<DaemonManifestEntry>;
    deliveryCutovers: { start(id: string): Promise<void> };
  };
  let internals = daemon as unknown as Internals;
  const generation = async () => ((await daemonRequest(env.paths.socketPath, "daemon.status")).result as { generation: number }).generation;
  const grant = async () => {
    const response = await daemonRequest(env.paths.socketPath, "supervisor.install_host_grant", {
      entry_id: env.id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: "polling-grant", supervisor_grant: "test-parent",
      grant_generation: 1, api_url: "https://example.test", daemon_generation: await generation(),
      host_id: "host", installation_id: "installation", grant_expires_at: "2099-01-01T00:00:00.000Z", recovery_only: true,
    });
    assert.equal(response.ok, true, response.error);
    assert.equal((response.result as { status: string }).status, "installed");
  };
  try {
    assert.equal((await stat(env.paths.socketPath)).mode & 0o777, 0o600, "activation uses the owner-only control endpoint");
    internals.liveHandles.set(env.id, env.handle);
    await internals.supervisedInbox.bootstrapCursor({ agent_id: env.id, room_id: entry.room_id, last_observed_message_id: "100" });
    const reverse = await daemonRequest(env.paths.socketPath, "supervisor.prepare_delivery_drain", {
      entry_id: env.id, operation_id: "socket-reverse", request_id: "socket-reverse-request", room_id: entry.room_id,
      execution_generation_id: env.generation, daemon_generation: await generation(),
    });
    assert.equal(reverse.ok, true, reverse.error);
    await internals.deliveryCutovers.start(env.id);
    assert.equal((await internals.store.getDeliveryDrain("socket-reverse"))?.phase, "complete");
    assert.equal(oldProcess.signalCode, "SIGTERM", "real OS death, not protocol terminal data, authorized the predecessor");
    await internals.durability.recordTerminal(env.handle.workAttemptId, env.generation, {
      ended_at: new Date().toISOString(), exit_code: null, signal: "SIGTERM", stdio_archive_ref: null, stdio_tail: "",
      terminal_cause: "stopped", actor: "daemon-provider", generation: 1, provider_continuation_id: env.handle.providerContinuationId,
    });
    const execution = await internals.durability.startGeneration(env.handle.workAttemptId, "daemon-provider", 2);
    const config = (await internals.store.getAgentConfiguration(env.id))!;
    // Only the native adapter is represented by a fixture handle: its receipt
    // names the actual launch session, while both process births came from ps.
    currentHandle = { ...env.handle, pid: pollingPid, providerConnection: currentConnection, observedState: "idle",
      custodyLaunchAgentSessionId: "polling-worker", appliedConfigurationRevision: config.config_revision };
    await internals.updateManifestEntry(env.id, current => ({ ...current,
      run_id: execution.execution_generation_id, deployment_id: serializeDaemonDeploymentId(env.id, execution.execution_generation_id),
      provider_ref: { work_attempt_id: env.handle.workAttemptId, execution_generation_id: execution.execution_generation_id,
        provider_continuation_id: currentHandle!.providerContinuationId!, provider_connection: currentConnection,
        custodial_launch_agent_session_id: currentHandle!.custodyLaunchAgentSessionId! },
    }));
    const applied = await internals.store.markRuntimeConfigurationApplied(internals.authority.generation, {
      agentId: env.id, executionGenerationId: execution.execution_generation_id, appliedRevision: config.config_revision,
    }, commit => internals.authority.fenceDaemonCommit(commit));
    internals.authority.generation = applied.generation;
    const binding = await internals.workerBindings.bind({ entry_id: env.id, room_id: entry.room_id,
      work_attempt_id: env.handle.workAttemptId, execution_generation_id: execution.execution_generation_id,
      agent_session_id: "polling-worker", agent_session_token: "test-worker", api_url: "https://example.test" });
    await internals.workerBindings.checkpointCursor(env.id, binding.agent_session_id, execution.execution_generation_id, "100");
    await internals.workerBindings.recordSupervisedWorkerSession({ agent_id: env.id, room_id: entry.room_id,
      execution_generation_id: execution.execution_generation_id, agent_session_id: binding.agent_session_id,
      credential_ref: binding.credential_ref, expires_at: "2099-01-01T00:00:00.000Z" });
    internals.liveHandles.set(env.id, currentHandle); await grant();
    const params = { entry_id: env.id, operation_id: "socket-activation", request_id: "socket-activation-request",
      room_id: entry.room_id, execution_generation_id: execution.execution_generation_id, reverse_operation_id: "socket-reverse",
      daemon_generation: await generation() };
    if (scenario === "pre_activation_forward") {
      const forward = { ...params, operation_id: "socket-forward", request_id: "socket-forward-request" };
      assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.prepare_custodial_forward",
        { ...forward, daemon_generation: forward.daemon_generation + 1 })).ok, false);
      assert.equal(await internals.store.getDeliveryDrain(forward.operation_id), null);
      const prepared = await daemonRequest(env.paths.socketPath, "supervisor.prepare_custodial_forward", forward);
      assert.equal(prepared.ok, true, prepared.error);
      await internals.deliveryCutovers.start(env.id);
      const receipt = await internals.store.getDeliveryDrain(forward.operation_id);
      assert.equal(receipt?.phase, "complete");
      assert.equal(receipt?.predecessor_operation_id, "socket-reverse");
      assert.equal(pollingProcess!.signalCode, "SIGTERM", "forward also requires real native birth death");
      assert.equal((await internals.store.getEntry(env.id))?.delivery_mode, "daemon_inbox");
      assert.equal((await internals.store.getAgentConfiguration(env.id))?.polling_contract, null);
      assert.equal(nativeStarts, 0, "undoing the mode choice cannot activate polling work");
      await daemon.stop();
      daemon = new SupervisorDaemon(env.paths, "darwin", env.port, false);
      internals = daemon as unknown as Internals;
      await daemon.start(); await internals.deliveryCutovers.start(env.id);
      const duplicate = await daemonRequest(env.paths.socketPath, "supervisor.prepare_custodial_forward",
        { ...forward, daemon_generation: await generation() });
      assert.equal(duplicate.ok, true, duplicate.error);
      assert.deepEqual(duplicate.result, { ...receipt }, "restart returns the same completed journal without a second stop or cursor transfer");
      assert.equal(nativeStarts, 0);
      return;
    }
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.activate_custodial_polling", { ...params, daemon_generation: params.daemon_generation + 1 })).ok, false);
    assert.equal(await internals.store.getPollingActivation(params.operation_id), null); assert.equal(nativeStarts, 0);
    const activated = await daemonRequest(env.paths.socketPath, "supervisor.activate_custodial_polling", params);
    assert.equal(activated.ok, true, activated.error);
    const record = (await internals.store.getPollingActivation(params.operation_id))!;
    assert.equal(record.phase, "active"); assert.equal(record.provider_turn_id, "exact-polling-turn");
    assert.equal(record.execution_generation_id, execution.execution_generation_id);
    assert.equal(record.native_process_identity, currentConnection.processIdentity);
    assert.equal(record.agent_session_id, "polling-worker"); assert.equal(nativeStarts, 1);
    const negotiated = await daemonRequest(env.paths.socketPath, "daemon.negotiate");
    assert.equal((negotiated.result as { capabilities: { custodialPollingOffersV1: boolean } }).capabilities.custodialPollingOffersV1, true);
    const wait = { entry_id: env.id, room_id: entry.room_id, work_attempt_id: env.handle.workAttemptId,
      execution_generation_id: execution.execution_generation_id, agent_session_id: binding.agent_session_id,
      daemon_generation: await generation(), api_url: "https://example.test", contract: "custodial_polling_v1",
      tool_name: "wait_for_messages", phase: "before", process_incarnation_id: "01234567-89ab-4cde-8f01-23456789abcd",
      mcp_request_id: 1, room_cursor: "999" };
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", { ...wait, mcp_request_id: null })).ok, false);
    const before = await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", wait);
    assert.equal(before.ok, true, before.error);
    const receipt = before.result as { activation_id: string; binding_epoch: number; room_cursor: string; configuration_revision: number };
    assert.equal(receipt.room_cursor, "100", "unknown ACK cannot jump past unread work");
    assert.equal(receipt.activation_id, record.operation_id);
    const release = { ...wait, phase: "release", expected_activation_id: receipt.activation_id,
      expected_binding_epoch: receipt.binding_epoch, expected_configuration_revision: receipt.configuration_revision,
      input_cursor: receipt.room_cursor, offered_frontier: "102" };
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", release)).ok, true);
    const firstOffer = (await internals.store.getPollingOfferTail(record.operation_id))!;
    assert.equal(firstOffer.mcp_request_id, "1");
    assert.equal((await internals.workerBindings.get(env.id))?.room_cursor, "100", "offering does not ACK");
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", { ...release, mcp_request_id: "1", offered_frontier: "103" })).ok, true);
    const tail = (await internals.store.getPollingOfferTail(record.operation_id))!;
    assert.equal(tail.mcp_request_id, '"1"', "router must not collapse numeric and string SDK IDs");
    assert.equal(tail.predecessor_offer_id, firstOffer.offer_id);
    const staleAck = await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", { ...wait, room_cursor: "102" });
    assert.equal((staleAck.result as { room_cursor: string }).room_cursor, "100");
    // Recent-tail context reads are fenced but never grant a delivery ACK.
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", { ...wait, tool_name: "read_messages", room_cursor: "103" })).ok, true);
    assert.equal((await internals.workerBindings.get(env.id))?.room_cursor, "100");
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.checkpoint_worker_cursor", { ...wait, room_cursor: "103" })).ok, false);
    const acknowledged = await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", { ...wait, mcp_request_id: 2, room_cursor: "103" });
    assert.equal(acknowledged.ok, true, acknowledged.error);
    assert.equal((acknowledged.result as { room_cursor: string }).room_cursor, "103");
    expectedPollingCursor = "103";
    const noProgress = { ...release, mcp_request_id: 2, input_cursor: "103", offered_frontier: "103" };
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", noProgress)).ok, true);
    assert.equal((await internals.store.getPollingOfferTail(record.operation_id))?.offer_id, tail.offer_id);
    await internals.workerBindings.bind({ ...binding, agent_session_token: "test-worker" });
    const staleRelease = await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", { ...noProgress, offered_frontier: "104" });
    assert.equal(staleRelease.ok, false, "same-session rebind must invalidate the old BEFORE epoch");
    assert.equal((await internals.store.getPollingOfferTail(record.operation_id))?.offer_id, tail.offer_id);
    terminal = true;
    await eventually(async () => {
      await internals.deliveryCutovers.start(env.id);
      return (await internals.store.getPollingActivation(params.operation_id))?.phase === "complete";
    }, "exact polling terminal observation settles after any earlier coalesced active observation");
    const duplicate = await daemonRequest(env.paths.socketPath, "supervisor.activate_custodial_polling", params);
    assert.equal(duplicate.ok, true, duplicate.error);
    assert.equal((duplicate.result as { phase: string }).phase, "complete"); assert.equal(nativeStarts, 1);

    const recovery = { ...params, operation_id: "socket-recovery", request_id: "socket-recovery-request" };
    behavior = "before_dispatch_failure";
    const prepared = await daemonRequest(env.paths.socketPath, "supervisor.activate_custodial_polling", recovery);
    assert.equal(prepared.ok, false); assert.match(prepared.error ?? "", /before dispatch/);
    assert.equal((await internals.store.getPollingActivation(recovery.operation_id))?.phase, "prepared");
    for (const phase of ["prepared", "uncertain"] as const) {
      const startsBeforeRestart = nativeStarts;
      await daemon.stop();
      // Startup's unresolved-journal observer is live even with provider
      // auto-convergence disabled, exactly as in observationDaemonFixture.
      daemon = new SupervisorDaemon(env.paths, "darwin", env.port, false);
      internals = daemon as unknown as Internals;
      await daemon.start(); await internals.deliveryCutovers.start(env.id);
      assert.equal(nativeStarts, startsBeforeRestart, `${phase} startup must never start a native turn`);
      assert.equal((await internals.store.getPollingActivation(recovery.operation_id))?.phase, phase);
      assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.activate_custodial_polling", recovery)).ok, false, "retired daemon generation cannot dispatch");
      recovery.daemon_generation = await generation();
      internals.liveHandles.set(env.id, currentHandle); await grant();
      await internals.workerBindings.installCredential({ entry_id: env.id, agent_session_id: binding.agent_session_id,
        execution_generation_id: execution.execution_generation_id, agent_session_token: "test-worker" });
      behavior = "lost_ack";
      const retry = await daemonRequest(env.paths.socketPath, "supervisor.activate_custodial_polling", recovery);
      assert.equal(retry.ok, true, retry.error);
      assert.equal((retry.result as { phase: string }).phase, "uncertain");
      assert.equal(nativeStarts, phase === "prepared" ? startsBeforeRestart + 1 : startsBeforeRestart);
      assert.equal((await internals.store.getPollingActivation(recovery.operation_id))?.provider_turn_id, null);
    }
  } finally {
    await daemon.stop(); await env.cleanup();
    if (oldProcess.exitCode === null && oldProcess.signalCode === null) oldProcess.kill("SIGTERM");
    if (pollingProcess && pollingProcess.exitCode === null && pollingProcess.signalCode === null) pollingProcess.kill("SIGTERM");
  }
});

for (const shutdown of ["stop", "handoff"] as const) test(`daemon captures only committed native-turn identity and fences live observation on ${shutdown}`, async () => {
  let listener: ((event: NativeExecutionObservation) => void) | undefined;
  let disposed = 0;
  let latestSequence = 2;
  const env = await observationDaemonFixture(async (handle, callback) => {
    listener = callback;
    callback({ sourceId: "source-live", sequence: 1, observedAtMs: Date.now(), nativeProcessPid: 7123, nativeProcessIdentity: "observed-birth",
      fact: { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" } });
    callback({ sourceId: "source-live", sequence: 2, observedAtMs: Date.now(), nativeProcessPid: 7123, nativeProcessIdentity: "observed-birth",
      fact: { domain: "turn", kind: "state_changed", state: "active", sideEffects: "none",
        providerContinuationId: handle.providerContinuationId!, providerTurnId: "native-turn" } });
    return { sourceId: "source-live", position: () => ({ firstRetainedSequence: 1, latestSequence }), dispose: () => { disposed += 1; } };
  });
  const inspection = new DatabaseSync(env.paths.manifestPath, { readOnly: true });
  try {
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    await eventually(async () => inspection.prepare("SELECT COUNT(*) AS count FROM execution_facts").get()!.count === 1,
      "runtime fact without fabricated native-turn mapping");
    assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM execution_turns").get()!.count, 0);
    const [item] = await env.internals.supervisedInbox.ingestPoll({ agent_id: env.id, room_id: entry.room_id,
      last_observed_message_id: "901", messages: [{ source_message_id: "901", source_message: { text: "private source text" }, activation: {} }] });
    assert.ok(item);
    await env.internals.supervisedInbox.transition(item.inbox_item_id, "dispatching");
    await env.internals.supervisedInbox.checkpointTurnStarted(item.inbox_item_id, "native-turn", {
      work_attempt_id: env.handle.workAttemptId, origin_execution_generation_id: env.generation,
      provider_continuation_id: env.handle.providerContinuationId!,
    });
    await eventually(async () => inspection.prepare("SELECT COUNT(*) AS count FROM execution_facts").get()!.count === 2,
      "post-commit inbox notification resumes structural capture");
    const mapped = inspection.prepare(`SELECT t.agent_id,t.execution_generation_id,t.provider_continuation_id,t.provider_turn_id,
      a.room_id,a.source_message_id FROM execution_turns t JOIN execution_message_attempts a USING(attempt_id)`).get();
    assert.deepEqual({ ...mapped }, { agent_id: env.id, execution_generation_id: env.generation,
      provider_continuation_id: env.handle.providerContinuationId, provider_turn_id: "native-turn",
      room_id: entry.room_id, source_message_id: "901" });
    const before = inspection.prepare("SELECT * FROM execution_facts ORDER BY sequence").all();
    assert.ok(!JSON.stringify(before).includes("private source text"));
    if (shutdown === "stop") {
      const stopped = env.daemon.stop();
      assert.equal(disposed, 1, "stop closes capture synchronously before awaiting operational drains");
      await within(stopped, "observation-aware daemon stop");
    } else {
      const handoff = env.daemon.waitForHandoff();
      assert.equal((await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff")).ok, true);
      assert.equal(disposed, 1, "handoff acknowledgement cannot leave a live observation subscription");
      await within(handoff, "observation-aware daemon handoff");
    }
    assert.equal(disposed, 1, "capture close and stream teardown must not dispose the same native subscription twice");
    latestSequence = 3;
    listener!({ sourceId: "source-live", sequence: 3, observedAtMs: Date.now(), nativeProcessPid: 7123, nativeProcessIdentity: "observed-birth",
      fact: { domain: "control", kind: "state_changed", state: "responsive", sideEffects: "none" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((env.internals.executionCapture as unknown as { database: DatabaseSync }).database.isOpen, false);
    assert.deepEqual(inspection.prepare("SELECT * FROM execution_facts ORDER BY sequence").all(), before,
      "late native callbacks cannot persist after daemon authority closes");
  } finally { inspection.close(); await env.cleanup(); }
});

for (const shutdown of ["stop", "handoff"] as const) test(`daemon ${shutdown} does not wait for a pending native subscription and disposes its late result`, async () => {
  let release!: (subscription: NativeExecutionSubscription) => void;
  const pending = new Promise<NativeExecutionSubscription>((resolve) => { release = resolve; });
  let listener: ((event: NativeExecutionObservation) => void) | undefined;
  let subscriptions = 0;
  let disposed = 0;
  const env = await observationDaemonFixture(async (_handle, callback) => { subscriptions += 1; listener = callback; return pending; });
  try {
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    await eventually(async () => subscriptions === 1, "pending native subscription starts");
    const event: NativeExecutionObservation = { sourceId: "source-late", sequence: 1, observedAtMs: Date.now(), nativeProcessPid: 7123, nativeProcessIdentity: "observed-birth",
      fact: { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" } };
    listener!(event);
    if (shutdown === "stop") await within(env.daemon.stop(), "stop with unresolved optional subscription", 1000);
    else {
      const handoff = env.daemon.waitForHandoff();
      assert.equal((await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff")).ok, true);
      await within(handoff, "handoff with unresolved optional subscription", 1000);
    }
    release({ sourceId: "source-late", position: () => ({ firstRetainedSequence: 1, latestSequence: 1 }), dispose: () => { disposed += 1; } });
    await eventually(async () => disposed === 1, "late subscription is disposed rather than reinstalled");
    listener!(event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const inspection = new DatabaseSync(env.paths.manifestPath, { readOnly: true });
    try { assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM execution_facts").get()!.count, 0); }
    finally { inspection.close(); }
    assert.equal(subscriptions, 1);
    assert.equal((env.internals.executionCapture as unknown as { database: DatabaseSync }).database.isOpen, false);
  } finally {
    release({ sourceId: "source-late", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose: () => {} });
    await env.cleanup();
  }
});

for (const failure of ["observer_rejection", "storage_closed"] as const) test(`optional ${failure} cannot fail provider installation or a committed daemon mutation`, async () => {
  let subscriptions = 0;
  const env = await observationDaemonFixture(async (_handle, callback) => {
    subscriptions += 1;
    if (failure === "observer_rejection") throw new Error("optional observer refused");
    callback({ sourceId: "source-storage", sequence: 1, observedAtMs: Date.now(), nativeProcessPid: 7123, nativeProcessIdentity: "observed-birth",
      fact: { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" } });
    return { sourceId: "source-storage", position: () => ({ firstRetainedSequence: 1, latestSequence: 1 }), dispose: () => {} };
  });
  try {
    if (failure === "storage_closed") (env.internals.executionCapture as unknown as { database: DatabaseSync }).database.close();
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    await eventually(async () => subscriptions === 1, "optional observer invoked");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(env.internals.liveHandles.get(env.id), env.handle);
    const updated = await daemonRequest(env.paths.socketPath, "manifest.set_desired_state", { id: env.id, desired_state: "paused" });
    assert.equal(updated.ok, true, updated.error);
    assert.equal((await env.internals.store.getEntry(env.id))?.desired_state, "paused");
    assert.equal((await daemonRequest(env.paths.socketPath, "daemon.status")).ok, true);
  } finally { await env.cleanup(); }
});

test("a stream installation that completes after daemon stop cannot restart its early observation subscription", async () => {
  let subscriptions = 0;
  let disposed = 0;
  let observe!: (event: NativeExecutionObservation) => void;
  const env = await observationDaemonFixture(async (_handle, listener) => {
    subscriptions += 1;
    observe = listener;
    return { sourceId: "source-early-installed", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose: () => { disposed += 1; } };
  });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const delayedStream = new Promise<void>((resolve) => { release = resolve; });
  env.port.onStream = async () => { entered(); await delayedStream; return () => {}; };
  try {
    const installing = env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    await waiting;
    await eventually(async () => subscriptions === 1, "early optional subscription installed");
    await within(env.daemon.stop(), "stop while stream installation is pending", 1000);
    assert.equal(disposed, 1, "stop disposes the already-installed optional subscription synchronously");
    release();
    await installing;
    observe({ sourceId: "source-early-installed", sequence: 1, observedAtMs: Date.now(), nativeProcessPid: 7123, nativeProcessIdentity: "observed-birth",
      fact: { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(subscriptions, 1, "late stream completion must not start another optional subscription");
    assert.equal(disposed, 1);
    assert.equal((env.internals.executionCapture as unknown as { database: DatabaseSync }).database.isOpen, false);
    const inspection = new DatabaseSync(env.paths.manifestPath, { readOnly: true });
    try { assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM execution_facts").get()!.count, 0); }
    finally { inspection.close(); }
  } finally { release(); await env.cleanup(); }
});

for (const commit of ["normal", "recovered"] as const) test(`Cursor observation callback follows only an exact ${commit} prepared checkpoint and cannot reject it`, async () => {
  const env = await observationDaemonFixture(async () => ({
    sourceId: "source-cursor", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose: () => {},
  }), "cursor");
  const inspection = new DatabaseSync(env.paths.manifestPath, { readOnly: true });
  try {
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    await env.internals.workerBindings.bind({ entry_id: env.id, room_id: entry.room_id,
      work_attempt_id: env.handle.workAttemptId, execution_generation_id: env.generation,
      agent_session_id: "cursor-observation-worker", agent_session_token: "cursor-observation-bearer",
      credential_ref: "cursor-observation-credential", api_url: "https://letagents.example" });
    const [item] = await env.internals.supervisedInbox.ingestPoll({ agent_id: env.id, room_id: entry.room_id,
      last_observed_message_id: "902", messages: [{ source_message_id: "902", source_message: { text: "prepare" }, activation: {} }] });
    assert.ok(item);
    await env.internals.supervisedInbox.transition(item.inbox_item_id, "dispatching");
    const agent: SupervisedIngressAgent = {
      agentId: env.id, roomId: entry.room_id, provider: "cursor", deliveryMode: "daemon_inbox",
      apiUrl: "https://letagents.example", agentSessionId: "cursor-observation-worker", bearer: "cursor-observation-bearer",
      handle: env.handle, workAttemptId: env.handle.workAttemptId, providerContinuationId: env.handle.providerContinuationId,
      providerConnection: env.handle.providerConnection!, executionGenerationId: env.generation,
      daemonGeneration: ((await daemonRequest(env.paths.socketPath, "daemon.status")).result as { generation: number }).generation,
    };
    const connection = { kind: "cursor_cli" as const, pid: 7124, processIdentity: "cursor-prepared-birth" };
    env.handle.pid = connection.pid;
    env.handle.providerConnection = connection;
    const observations: Array<{ runtime: Parameters<ExecutionCaptureCoordinator["prepared"]>[0]; binding: unknown; connection: unknown }> = [];
    env.internals.executionCapture!.prepared = (runtime) => {
      observations.push({ runtime,
        binding: inspection.prepare("SELECT provider_turn_id,origin_execution_generation_id FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?").get(item.inbox_item_id),
        connection: inspection.prepare("SELECT provider_connection_pid,provider_process_identity FROM runtime_deployments WHERE agent_id=?").get(env.id) });
      throw new Error("optional observation callback failed after commit");
    };
    const input = { agent, inboxItemId: item.inbox_item_id, providerTurnId: "cursor-prepared-turn",
      providerContinuationId: env.handle.providerContinuationId!, providerConnection: connection };
    await assert.rejects(() => env.internals.providerCheckpoints.checkpointPreparedTurn({ ...input, agent: { ...agent, bearer: "wrong-bearer" } }), /exact supervised lane/);
    assert.equal(observations.length, 0, "failed exact-authority validation cannot mint observation proof");
    assert.equal((await env.internals.supervisedInbox.get(item.inbox_item_id))?.provider_turn_id, null);
    if (commit === "recovered") {
      const checkpoint = env.internals.store.checkpointCursorPreparedTurn.bind(env.internals.store);
      env.internals.store.checkpointCursorPreparedTurn = async (...args) => {
        await checkpoint(...args);
        throw new Error("transport reported failure after the prepared transaction committed");
      };
    }
    await env.internals.providerCheckpoints.checkpointPreparedTurn(input);
    assert.equal(observations.length, 1, "successful or independently recovered commit publishes exactly one optional observation proof");
    const observed = observations[0]!;
    assert.equal(observed.runtime.handle, env.handle);
    assert.equal(observed.runtime.executionGenerationId, env.generation);
    assert.equal(observed.runtime.configurationRevision, 1);
    assert.deepEqual(observed.runtime.connection, connection);
    assert.deepEqual({ ...observed.binding as object }, { provider_turn_id: "cursor-prepared-turn", origin_execution_generation_id: env.generation });
    assert.deepEqual({ ...observed.connection as object }, { provider_connection_pid: 7124, provider_process_identity: "cursor-prepared-birth" });
    assert.deepEqual(agent.providerConnection, connection, "callback failure cannot undo the operational provider snapshot");
    assert.equal((await env.internals.supervisedInbox.get(item.inbox_item_id))?.provider_turn_id, "cursor-prepared-turn");
  } finally { inspection.close(); await env.cleanup(); }
});

test("daemon is visibly gated to macOS", () => {
  assert.throws(() => assertMacOS("linux"), /macOS only/);
});

test("failed room waits remain retryable for one healthy provider execution", async () => {
  const env = await observationDaemonFixture(async () => ({
    sourceId: "source-room-wait", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose: () => {},
  }));
  try {
    env.handle.observedState = "failed";
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    const handle = env.handle;
    const internals = env.daemon as unknown as {
      handleProviderStream: (entryId: string, providerHandle: typeof handle, event: {
        workAttemptId: string; providerContinuationId: string; observedAt: string; sequence: number;
        provider: string; kind: string; method: string; summary?: string | null; payload: unknown; payloadTruncated: boolean;
        payloadRedacted: boolean; durablePayloadRef: null;
      }) => Promise<void>;
    };
    const base = {
      workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId!,
      observedAt: new Date().toISOString(),
      provider: "codex",
      payloadTruncated: false,
      payloadRedacted: false,
      durablePayloadRef: null,
    };
    await internals.handleProviderStream(env.id, handle, {
      ...base,
      sequence: 1,
      kind: "item_lifecycle",
      method: "item/completed",
      payload: {
        item: {
          type: "mcpToolCall", id: "wait_codex_failed", server: "letagents", tool: "wait_for_messages",
          status: "failed", result: null, error: { message: "poll failed" },
        },
      },
    });
    let current = await env.internals.store.getEntry(env.id);
    assert.ok(current);
    assert.equal(current.observed_state, "idle");
    assert.equal(current.activity?.at(-1)?.status, "idle");

    await internals.handleProviderStream(env.id, handle, {
      ...base,
      sequence: 2,
      kind: "text_delta",
      method: "item/agentMessage/delta",
      payload: { delta: "late evidence" },
    });
    current = await env.internals.store.getEntry(env.id);
    assert.ok(current);
    assert.equal(current.observed_state, "working", "the same healthy execution continues after a retryable wait failure");
    assert.equal(current.activity?.at(-1)?.status, "working");

    await internals.handleProviderStream(env.id, handle, {
      ...base,
      sequence: 3,
      kind: "text_delta",
      method: "item/reasoning/summaryTextDelta",
      summary: "Checking the durable room delivery path.",
      payload: {
        threadId: "thread_exact",
        turnId: "turn_exact",
        itemId: "reasoning_exact",
        summaryIndex: 0,
        delta: "Checking the durable room delivery path.",
      },
    });
    current = await env.internals.store.getEntry(env.id);
    assert.ok(current);
    assert.equal(
      current.activity?.at(-1)?.summary,
      "Checking the durable room delivery path.",
      "the daemon preserves the provider-approved display summary instead of replacing it with a protocol method",
    );
    await internals.handleProviderStream(env.id, handle, {
      ...base,
      sequence: 4,
      kind: "text_delta",
      method: "item/reasoning/textDelta",
      summary: "Codex raw reasoning text is streaming.",
      payload: {
        threadId: "thread_exact",
        turnId: "turn_exact",
        itemId: "reasoning_exact",
        delta: "private chain of thought must never enter Live",
      },
    });
    const live = (await daemonRequest(env.paths.socketPath, "supervisor.watch_agent_stream", {
      entry_id: env.id, after_sequence: 0, wait_ms: 0,
    })).result as { events: Array<{ method: string; summary: string | null }> };
    assert.deepEqual(
      live.events.map((event) => event.method),
      ["item/agentMessage/delta", "item/reasoning/summaryTextDelta"],
      "Codex's verbatim readable-reasoning method survives the Live display filter",
    );
    assert.equal(live.events[1]?.summary, "Checking the durable room delivery path.");
    assert.doesNotMatch(JSON.stringify(live), /private chain of thought/);
  } finally {
    await env.cleanup();
  }
});

test("daemon keeps empty wait results idle across the real stream handler and restart", async () => {
  const env = await observationDaemonFixture(async () => ({
    sourceId: "source-quiet-poll", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose: () => {},
  }), "claude-code");
  const { paths, handle } = env;
  type StreamEvent = {
    workAttemptId: string; providerContinuationId: string; observedAt: string; sequence: number;
    provider: string; kind: string; method: string; payload: unknown; payloadTruncated: boolean;
    payloadRedacted: boolean; durablePayloadRef: null;
  };
  type StreamInternals = {
    providerStreams: ProviderStreamCoordinator;
    workerRuntimeCustody: WorkerRuntimeCustody;
    handleProviderStream: (entryId: string, providerHandle: typeof handle, event: StreamEvent) => Promise<void>;
    publishNativeActivity: (entryId: string, method: string, status: "working" | "idle") => Promise<boolean>;
  };
  let sequence = 0;
  const event = (method: string, payload: unknown): StreamEvent => ({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId,
    observedAt: new Date(Date.now() + sequence).toISOString(),
    sequence: ++sequence,
    provider: "claude-code",
    kind: "tool_lifecycle",
    method,
    payload,
    payloadTruncated: false,
    payloadRedacted: false,
    durablePayloadRef: null,
  });
  const codexEvent = (method: string, payload: unknown): StreamEvent => ({
    ...event(method, payload),
    provider: "codex",
  });
  const wait = (id: string) => event("assistant", {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "mcp__letagents__wait_for_messages", input: {} }] },
  });
  const result = (id: string, messages: unknown[]) => event("user", {
    type: "user",
    message: { content: [{
      type: "tool_result",
      tool_use_id: id,
      content: [{ type: "text", text: JSON.stringify({ messages, room_id: "focus_37" }) }],
    }] },
  });
  const install = async (daemon: SupervisorDaemon, published: Array<"working" | "idle">): Promise<StreamInternals> => {
    const internals = daemon as unknown as StreamInternals;
    await internals.providerStreams.install(env.id, handle, env.generation, () => false);
    internals.workerRuntimeCustody.installLiveBinding(env.id, {
      agentSessionId: "session-poll",
      executionGenerationId: env.generation,
      updatedAt: new Date().toISOString(),
    });
    internals.publishNativeActivity = async (_entryId, _method, status) => { published.push(status); return true; };
    return internals;
  };

  const first = env.daemon;
  let second: SupervisorDaemon | null = null;
  try {
    const published: Array<"working" | "idle"> = [];
    const firstInternals = await install(first, published);
    await firstInternals.handleProviderStream(env.id, handle, wait("wait_1"));
    await firstInternals.handleProviderStream(env.id, handle, result("wait_1", []));
    await firstInternals.handleProviderStream(env.id, handle, event("assistant", {
      type: "assistant", message: { content: [{ type: "thinking", thinking: "provider-internal handoff" }] },
    }));
    assert.deepEqual(published, ["idle", "idle", "idle"], "empty Claude wait lifecycle never flips room presence to working");
    let projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(projection.observed_state, "idle");
    assert.deepEqual(projection.activity?.slice(-3).map((activity) => activity.status), ["idle", "idle", "idle"]);

    await firstInternals.handleProviderStream(env.id, handle, wait("wait_2"));
    await firstInternals.handleProviderStream(env.id, handle, result("wait_2", [{ id: "msg_12", text: "please review" }]));
    assert.equal(published.at(-1), "working", "a nonempty addressed wait result remains visible work");
    projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(projection.observed_state, "working");

    const codexStarted = codexEvent("item/started", {
      item: {
        type: "mcpToolCall", id: "wait_codex_real", server: "letagents", tool: "wait_for_messages",
        status: "inProgress", arguments: {}, appContext: null, pluginId: null, result: null, error: null, durationMs: null,
      },
      threadId: "thread_codex",
      turnId: "turn_codex",
      startedAtMs: Date.now(),
    });
    const codexProgress = codexEvent("item/mcpToolCall/progress", {
      itemId: "wait_codex_real", message: "waiting", threadId: "thread_codex", turnId: "turn_codex",
    });
    const codexCompleted = codexEvent("item/completed", {
      item: {
        type: "mcpToolCall", id: "wait_codex_real", server: "letagents", tool: "wait_for_messages",
        status: "completed", arguments: {}, appContext: null, pluginId: null,
        result: {
          content: [{ type: "text", text: JSON.stringify({ messages: [], last_observed_message_id: "msg_13", skipped_message_count: 1 }) }],
          structuredContent: null,
          _meta: null,
        },
        error: null,
        durationMs: 30_000,
      },
      threadId: "thread_codex",
      turnId: "turn_codex",
      completedAtMs: Date.now(),
    });
    await firstInternals.handleProviderStream(env.id, handle, codexStarted);
    await firstInternals.handleProviderStream(env.id, handle, codexProgress);
    await firstInternals.handleProviderStream(env.id, handle, codexCompleted);
    assert.deepEqual(published.slice(-3), ["idle", "idle", "idle"], "real Codex start, progress, and empty/silent completion stay idle");
    projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.deepEqual(projection.activity?.slice(-3).map((activity) => activity.status), ["idle", "idle", "idle"]);

    const addressedStarted = codexEvent("item/started", {
      item: {
        type: "mcpToolCall", id: "wait_codex_addressed", server: "letagents", tool: "wait_for_messages",
        status: "inProgress", arguments: {}, appContext: null, pluginId: null, result: null, error: null, durationMs: null,
      },
    });
    const addressedCompleted = codexEvent("item/completed", {
      item: {
        type: "mcpToolCall", id: "wait_codex_addressed", server: "letagents", tool: "wait_for_messages",
        status: "completed", arguments: {}, appContext: null, pluginId: null,
        result: { content: [], structuredContent: { messages: [{ id: "msg_14", text: "please act" }] }, _meta: null },
        error: null,
        durationMs: 1,
      },
    });
    await firstInternals.handleProviderStream(env.id, handle, addressedStarted);
    await firstInternals.handleProviderStream(env.id, handle, addressedCompleted);
    assert.deepEqual(published.slice(-2), ["idle", "working"], "a real addressed Codex completion wakes the work indicator");
    projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(projection.observed_state, "working");
    assert.equal(projection.activity?.at(-1)?.status, "working");

    await firstInternals.handleProviderStream(env.id, handle, wait("wait_restart"));
    await first.stop();
    second = new SupervisorDaemon(paths, "darwin", env.port, false);
    await second.start();
    const afterRestart: Array<"working" | "idle"> = [];
    const secondInternals = await install(second, afterRestart);
    await secondInternals.handleProviderStream(env.id, handle, result("wait_restart", []));
    assert.deepEqual(afterRestart, ["idle"], "persisted wait correlation survives a daemon restart mid-poll");
    projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(projection.observed_state, "idle");
  } finally {
    await second?.stop();
    await first.stop();
    await env.cleanup();
  }
});

test("daemon restart without Electron credential delivery retains inbox work and projects a safe waiting state", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.sqlite"), attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root, workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const id = "credentialless_restart";
  const workAttemptId = "attempt-credentialless";
  const executionGenerationId = "generation-credentialless";
  const credential = "memory-only-restart-credential";
  const first = new SupervisorDaemon(paths, "darwin");
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    const firstInternals = first as unknown as {
      putManifestEntry(entry: Record<string, unknown>): Promise<void>;
      workerBindings: WorkerBindingStore;
      supervisedInbox: import("../supervised-agent-inbox-store.js").SupervisedAgentInboxStore;
    };
    await firstInternals.putManifestEntry({
      ...entry,
      id,
      room_id: "focus_restart",
      provider: "codex",
      delivery_mode: "daemon_inbox",
      observed_state: "working",
      work_attempt_id: workAttemptId,
      provider_ref: {
        work_attempt_id: workAttemptId,
        provider_continuation_id: "thread-credentialless",
        provider_connection: { kind: "codex_app_server", url: "ws://127.0.0.1:65534", pid: 44661, processIdentity: "fixture:44661" },
        execution_generation_id: executionGenerationId,
      },
    });
    await firstInternals.workerBindings.bind({
      entry_id: id,
      room_id: "focus_restart",
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      agent_session_id: "agent_session_restart",
      agent_session_token: credential,
      api_url: "https://letagents.test",
    });
    await firstInternals.supervisedInbox.ingestPoll({
      agent_id: id,
      room_id: "focus_restart",
      last_observed_message_id: "42",
      messages: [
        { source_message_id: "41", source_message: { id: "41", text: "queued before restart" }, activation: { decision: "activate" } },
        { source_message_id: "42", source_message: { id: "42", text: "also queued" }, activation: { decision: "activate" } },
      ],
    });
    const before = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]!;
    assert.equal(before.room_agent_state?.inbox.state, "queued");
    assert.equal(before.room_agent_state?.inbox.pending_count, 2);
    await first.stop();

    second = new SupervisorDaemon(paths, "darwin");
    await second.start();
    const status = await daemonRequest(paths.socketPath, "daemon.status");
    assert.equal(status.ok, true, status.error);
    const after = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]!;
    assert.equal(after.room_agent_state?.inbox.state, "waiting_for_desktop_credentials");
    assert.equal(after.room_agent_state?.inbox.pending_count, 2, "restart preserves both durable FIFO items");
    assert.deepEqual(after.delivery_receipts?.map((receipt) => [receipt.source_message_id, receipt.state]), [
      ["41", "pending"],
      ["42", "pending"],
    ]);
    assert.equal(after.room_agent_state?.turn.state, "idle", "missing credentials cannot invent an active provider turn");
    const secondInternals = second as unknown as { workerBindings: WorkerBindingStore };
    const persistedBinding = await secondInternals.workerBindings.get(id);
    assert.ok(persistedBinding, "public exact binding metadata survives restart");
    assert.equal(await secondInternals.workerBindings.credentialFor(persistedBinding), null,
      "the successor cannot recover the retired daemon's memory-only bearer");
    const raw = await readFile(paths.manifestPath);
    assert.equal(raw.includes(Buffer.from(credential)), false, "the missing bearer was never serialized beside the retained inbox");
  } finally {
    await second?.stop().catch(() => undefined);
    await first.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("direct manifest convergence shares the per-entry reconciliation lane", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "serialized_direct_convergence");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "serialized_direct_convergence", leaseId: "serialized_direct_convergence", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  let spawnCount = 0;
  const handle = { workAttemptId: attempt.work_attempt_id, pid: 4201, providerContinuationId: "serialized-continuation", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawnCount += 1; return handle; },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { spawnCount += 1; return handle; },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  let releaseTick!: () => void;
  let tickEntered!: () => void;
  const tickStarted = new Promise<void>((resolve) => { tickEntered = resolve; });
  const tickHold = new Promise<void>((resolve) => { releaseTick = resolve; });
  try {
    await daemon.start();
    const internals = daemon as unknown as { serializeEntryTick: <T>(entryId: string, operation: () => Promise<T>) => Promise<T> };
    const heldTick = internals.serializeEntryTick("serialized_direct_convergence", async () => { tickEntered(); await tickHold; });
    await tickStarted;
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "serialized_direct_convergence", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(spawnCount, 0, "manifest convergence cannot pass an in-flight reconciliation tick");
    releaseTick();
    await heldTick;
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "serialized provider launch");
    assert.equal(spawnCount, 1);
  } finally {
    releaseTick?.();
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("post-launch worker binding retries the exact provider and preserves the real failure", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "host_grant_bind_retry");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "host_grant_bind_retry", leaseId: "host_grant_bind_retry", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  const handle = { workAttemptId: attempt.work_attempt_id, pid: 7711, providerContinuationId: "host-grant-continuation", observedState: "working" as const };
  let spawns = 0;
  let stops = 0;
  const mintCalls: Array<{ grantGeneration: number; agentInstanceId: string }> = [];
  let remoteLiveSessionId: string | null = null;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; return handle; }, attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("must not resume a fresh host-grant provider"); }, poke: async () => {},
    stop: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }; },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const grants = {
    createWorkerSession: async (input: { grantGeneration: number; agentInstanceId: string }) => {
      mintCalls.push(input);
      const prePost = new DatabaseSync(paths.manifestPath);
      try {
        const mintState = prePost.prepare("SELECT phase,agent_session_id FROM supervised_worker_mint_states WHERE agent_id=?")
          .get("host_grant_bind_retry") as { phase: string; agent_session_id: string | null };
        assert.equal(mintState.phase, "minting_unknown", "the durable none fact becomes unknown before the remote POST starts");
        assert.equal(mintState.agent_session_id, null);
      } finally { prePost.close(); }
      const evidence = new ManifestStore(paths.manifestPath);
      try {
        assert.deepEqual(await evidence.durablePurgeWorkerSessionAttestation("host_grant_bind_retry"), {
          workerSessionAttestation: "unknown",
          agentSessionId: null,
        }, "pre-POST and lost-response windows can never authorize grant-only purge");
      } finally { await evidence.close(); }
      if (mintCalls.length === 1) {
        // The server committed this stable instance tuple, but its response was
        // lost. A retry must recover the same live session rather than minting
        // a second identity.
        remoteLiveSessionId = "session-host";
        throw new Error("simulated lost response after the idempotent remote mint committed");
      }
      assert.equal(remoteLiveSessionId, "session-host");
      return { sessionId: "session-host", bearer: "host-bearer-secret", bearerId: "bearer-host", expiresAt: "2030-01-01T00:00:00.000Z" };
    },
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, grants);
  try {
    await daemon.start();
    const internals = daemon as unknown as { workerBindings: WorkerBindingStore; publishNativeActivity: () => Promise<boolean> };
    const originalBind = internals.workerBindings.bind.bind(internals.workerBindings);
    internals.publishNativeActivity = async () => true;
    let bindAttempts = 0;
    internals.workerBindings.bind = async (input) => {
      bindAttempts += 1;
      if (bindAttempts === 1) throw new Error("simulated binding write failure");
      return originalBind(input);
    };
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "host_grant_bind_retry", provider: "claude-code", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id, last_worker_binding: null,
    } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(spawns, 0, "no daemon_inbox provider can spawn without the desktop grant");
    await admitDaemonInboxForProviderTest(daemon, "host_grant_bind_retry", entry.room_id);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const install = { entry_id: "host_grant_bind_retry", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-1", supervisor_grant: "host-grant-secret", grant_generation: 7, api_url: "http://127.0.0.1:3000", host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z", daemon_generation: generation };
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", install)).ok, true);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.condition === "coordination_blocked", "post-spawn binding failure");
    assert.equal(spawns, 1);
    assert.equal(stops, 0, "credential failure must never stop the spawned provider");
    const recoveringProjection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.match(recoveringProjection.last_error ?? "", /simulated binding write failure/);
    assert.match(recoveringProjection.last_error ?? "", /retrying automatically/i);
    const exactMintState = await internals.workerBindings.supervisedWorkerMintState("host_grant_bind_retry");
    assert.deepEqual(exactMintState, {
      agent_id: "host_grant_bind_retry",
      room_id: entry.room_id,
      agent_instance_id: "daemon:host_grant_bind_retry",
      phase: "exact",
      agent_session_id: "session-host",
      updated_at: exactMintState!.updated_at,
    });
    assert.equal((await internals.workerBindings.supervisedWorkerSession("host_grant_bind_retry"))?.agent_session_id, "session-host");
    const beforeManifestBinding = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(beforeManifestBinding.last_worker_binding, null, "the exact public mint precedes the manifest binding");
    const exactEvidence = new ManifestStore(paths.manifestPath);
    try {
      assert.deepEqual(await exactEvidence.durablePurgeWorkerSessionAttestation("host_grant_bind_retry"), {
        workerSessionAttestation: "exact",
        agentSessionId: "session-host",
      }, "exact mint/session evidence outranks the retained explicit none fact");
    } finally { await exactEvidence.close(); }
    const beforeRetry = await daemonRequest(paths.socketPath, "attempt.read", { id: "host_grant_bind_retry" });
    assert.equal((beforeRetry.result as { execution_generations: Array<{ terminal: unknown }> }).execution_generations[0]?.terminal, null);
    await eventually(async () => Boolean(await internals.workerBindings.get("host_grant_bind_retry")), "automatic host worker binding retry", 5_000);
    assert.equal(bindAttempts, 2);
    assert.equal(spawns, 1, "automatic retry rebinds the exact provider rather than spawning a replacement");
    await eventually(
      async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.condition === "none",
      "successful room binding clears the recovery projection",
    );
    const recoveredProjection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(recoveredProjection.condition, "none");
    assert.equal(recoveredProjection.last_error, null);
    assert.equal(remoteLiveSessionId, "session-host", "lost-response recovery retains one remote live session id");
    assert.equal(mintCalls.every((call) => call.grantGeneration === 7 && call.agentInstanceId === "daemon:host_grant_bind_retry"), true);
    const raw = await readFile(paths.manifestPath);
    assert.equal(raw.includes(Buffer.from("host-grant-secret")), false);
    assert.equal(raw.includes(Buffer.from("host-bearer-secret")), false);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("handoff during delayed host-grant mint creates no generation and the successor launches once", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "delayed_host_grant_handoff");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "delayed_host_grant_handoff", leaseId: "delayed_host_grant_handoff", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let spawns = 0;
  const handle = { workAttemptId: attempt.work_attempt_id, pid: 8812, providerContinuationId: "successor-host-grant-continuation", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; return handle; }, attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("pre-spawn recovery must launch one fresh provider"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  let mintEntered!: () => void;
  const mintStarted = new Promise<void>((resolve) => { mintEntered = resolve; });
  let releaseMint!: () => void;
  const mintGate = new Promise<void>((resolve) => { releaseMint = resolve; });
  const first = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => {
      mintEntered();
      await mintGate;
      return { sessionId: "retired-session", bearer: "retired-bearer", bearerId: "retired-bearer-id", expiresAt: null };
    },
  });
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "delayed_host_grant_handoff", provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await admitDaemonInboxForProviderTest(first, "delayed_host_grant_handoff", entry.room_id);
    const firstGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "delayed_host_grant_handoff", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-delayed",
      supervisor_grant: "first-grant", grant_generation: 1, api_url: "https://letagents.example", daemon_generation: firstGeneration,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await mintStarted;
    const beforeHandoff = (await daemonRequest(paths.socketPath, "attempt.read", { id: "delayed_host_grant_handoff" })).result as { execution_generations: unknown[] };
    assert.equal(beforeHandoff.execution_generations.length, 0, "remote mint cannot expose an unowned durable generation");
    const handoff = first.waitForHandoff();
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    await within(handoff, "delayed mint daemon handoff", 1_000);

    second = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
      poll: async () => ({ messages: [] }), publish: async () => {},
    }, {
      createWorkerSession: async () => ({ sessionId: "successor-session", bearer: "successor-bearer", bearerId: "successor-bearer-id", expiresAt: null }),
    });
    await second.start();
    (second as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const secondGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "delayed_host_grant_handoff", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-delayed",
      supervisor_grant: "second-grant", grant_generation: 2, api_url: "https://letagents.example", daemon_generation: secondGeneration,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0];
      return spawns === 1 && current?.provider_ref?.provider_continuation_id === handle.providerContinuationId;
    }, "successor launch after retired pre-generation mint");
    const recovered = (await daemonRequest(paths.socketPath, "attempt.read", { id: "delayed_host_grant_handoff" })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.equal(recovered.execution_generations.length, 1);
    assert.equal(recovered.execution_generations[0]?.terminal, null);
    assert.equal(spawns, 1, "successor creates the only provider generation");
    releaseMint();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterLateMint = (await daemonRequest(paths.socketPath, "attempt.read", { id: "delayed_host_grant_handoff" })).result as { execution_generations: unknown[] };
    assert.equal(afterLateMint.execution_generations.length, 1);
    assert.equal(spawns, 1, "late retired mint completion cannot create a generation or provider");
  } finally {
    releaseMint?.();
    await second?.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("pause fences a launch waiting on host-grant mint before any generation or provider exists", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "pause_during_host_grant_mint");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "pause_during_host_grant_mint", leaseId: "pause_during_host_grant_mint", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let mintEntered!: () => void;
  const mintStarted = new Promise<void>((resolve) => { mintEntered = resolve; });
  let releaseMint!: () => void;
  const mintGate = new Promise<void>((resolve) => { releaseMint = resolve; });
  let spawns = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; throw new Error("paused launch must not dispatch"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("paused launch must not resume"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => {
      mintEntered();
      await mintGate;
      return { sessionId: "paused-session", bearer: "paused-bearer", bearerId: "paused-bearer-id", expiresAt: null };
    },
  });
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "pause_during_host_grant_mint", provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await admitDaemonInboxForProviderTest(daemon, "pause_during_host_grant_mint", entry.room_id);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "pause_during_host_grant_mint", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-pause",
      supervisor_grant: "pause-grant", grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await mintStarted;
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "pause_during_host_grant_mint", desired_state: "paused",
    })).ok, true);
    releaseMint();
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "paused", "paused delayed grant launch");
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id: "pause_during_host_grant_mint" })).result as { execution_generations: unknown[] };
    assert.equal(result.execution_generations.length, 0);
    assert.equal(spawns, 0);
  } finally {
    releaseMint?.();
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("stop fences a launch waiting on provider capabilities before generation creation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "stop_during_capabilities");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "stop_during_capabilities", leaseId: "stop_during_capabilities", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let capabilitiesEntered!: () => void;
  const capabilitiesStarted = new Promise<void>((resolve) => { capabilitiesEntered = resolve; });
  let releaseCapabilities!: () => void;
  const capabilitiesGate = new Promise<void>((resolve) => { releaseCapabilities = resolve; });
  let spawns = 0;
  const port: ProviderActionPort = {
    capabilities: async () => {
      capabilitiesEntered();
      await capabilitiesGate;
      return { resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true };
    },
    spawn: async () => { spawns += 1; throw new Error("stopped launch must not dispatch"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("stopped launch must not resume"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "stop_during_capabilities", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await capabilitiesStarted;
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "stop_during_capabilities", desired_state: "stopped",
    })).ok, true);
    releaseCapabilities();
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "stopped", "stopped delayed capabilities launch");
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id: "stop_during_capabilities" })).result as { execution_generations: unknown[] };
    assert.equal(result.execution_generations.length, 0);
    assert.equal(spawns, 0);
  } finally {
    releaseCapabilities?.();
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("provider delivery capabilities block mismatches while legacy omissions remain compatible", async () => {
  const runCase = async (
    id: "delivery_mode_mismatch" | "legacy_delivery_capabilities",
    deliveryModes: ReadonlyArray<"mcp_polling" | "desktop_events" | "daemon_inbox"> | undefined,
  ) => {
    const env = await fixture();
    const paths = {
      lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
      manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
      attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    };
    const workspace = await provisionedWorkspace(env.root, id);
    const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
    const attempt = await durability.createAttempt({
      taskId: id,
      leaseId: id,
      leaseEpoch: 0,
      workspacePath: workspace.path,
      workAttemptId: workspace.id,
    });
    await durability.close();
    const handle = {
      workAttemptId: attempt.work_attempt_id,
      pid: 4401,
      providerContinuationId: `${id}-continuation`,
      observedState: "working" as const,
    };
    let spawns = 0;
    const capabilities = {
      resume: false,
      midTurnInjection: false,
      transcriptAccess: true,
      permissionPromptBridging: false,
      survivesRestart: true,
      ...(deliveryModes ? { deliveryModes } : {}),
    };
    if (!deliveryModes) {
      assert.equal(Object.hasOwn(capabilities, "deliveryModes"), false, "the legacy capability really omits the new field");
    }
    const port: ProviderActionPort = {
      capabilities: async () => capabilities,
      spawn: async () => { spawns += 1; return handle; },
      attach: async () => null,
      attachAction: async () => ({ state: "absent" }),
      resume: async () => { throw new Error("fresh compatibility launch must not resume"); },
      poke: async () => {},
      stop: async () => ({
        endedAt: new Date().toISOString(),
        exitCode: 0,
        signal: null,
        terminalCause: "stopped",
        providerContinuationId: handle.providerContinuationId,
      }),
      onExit: async () => () => {},
      onStream: async () => () => {},
    };
    const daemon = new SupervisorDaemon(paths, "darwin", port, true);
    try {
      await daemon.start();
      await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        ...entry,
        id,
        provider: "claude-code",
        delivery_mode: "mcp_polling",
        observed_state: "absent",
        workspace_path: attempt.workspace_path,
        work_attempt_id: attempt.work_attempt_id,
      } });
      if (deliveryModes) {
        await eventually(async () => {
          const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0];
          return current?.observed_state === "failed" && current.condition === "coordination_blocked";
        }, "incompatible provider delivery mode rejection");
        const blocked = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
        assert.match(blocked.last_error ?? "", /Claude Code does not support mcp_polling room delivery/);
        const result = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
        assert.equal(result.execution_generations.length, 0, "an incompatible adapter cannot create a durable generation");
        assert.equal(spawns, 0, "an incompatible adapter cannot reach provider dispatch");
      } else {
        await eventually(async () => {
          const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0];
          return current?.observed_state === "working";
        }, "legacy provider capability launch");
        const result = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
        assert.equal(result.execution_generations.length, 1, "an older adapter still creates the provider generation");
        assert.equal(spawns, 1, "an older adapter still reaches provider dispatch");
      }
    } finally {
      await daemon.stop().catch(() => undefined);
      await env.cleanup();
    }
  };

  await runCase("delivery_mode_mismatch", ["daemon_inbox"]);
  await runCase("legacy_delivery_capabilities", undefined);
});

test("stop during grant mint and pause during capabilities both fence before provider dispatch", async () => {
  const runCase = async (boundary: "mint" | "capabilities", desiredState: "paused" | "stopped") => {
    const env = await fixture();
    const id = `${desiredState}_during_${boundary}`;
    const paths = {
      lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
      manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
      attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    };
    const workspace = await provisionedWorkspace(env.root, id);
    const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
    const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
    await durability.close();
    let boundaryEntered!: () => void;
    const boundaryStarted = new Promise<void>((resolve) => { boundaryEntered = resolve; });
    let releaseBoundary!: () => void;
    const boundaryGate = new Promise<void>((resolve) => { releaseBoundary = resolve; });
    let spawns = 0;
    const port: ProviderActionPort = {
      capabilities: async () => {
        if (boundary === "capabilities") { boundaryEntered(); await boundaryGate; }
        return { resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true };
      },
      spawn: async () => { spawns += 1; throw new Error("fenced delayed launch must not dispatch"); },
      attach: async () => null, attachAction: async () => ({ state: "absent" }),
      resume: async () => { throw new Error("fenced delayed launch must not resume"); }, poke: async () => {},
      stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async () => () => {}, onStream: async () => () => {},
    };
    const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
      poll: async () => ({ messages: [] }), publish: async () => {},
    }, {
      createWorkerSession: async () => {
        if (boundary === "mint") { boundaryEntered(); await boundaryGate; }
        return { sessionId: `${id}-session`, bearer: `${id}-bearer`, bearerId: `${id}-bearer-id`, expiresAt: null };
      },
    });
    try {
      await daemon.start();
      await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        ...entry, id, provider: boundary === "mint" ? "codex" : "claude-code",
        delivery_mode: boundary === "mint" ? "daemon_inbox" : "mcp_polling", observed_state: "absent",
        workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
      } });
      if (boundary === "mint") {
        await admitDaemonInboxForProviderTest(daemon, id, entry.room_id);
        const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
        assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
          entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: `grant-${id}`,
          supervisor_grant: `${id}-grant`, grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
          host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
        })).ok, true);
      }
      await boundaryStarted;
      assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id, desired_state: desiredState })).ok, true);
      releaseBoundary();
      await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === desiredState, `${desiredState} ${boundary} fence`);
      const result = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
      assert.equal(result.execution_generations.length, 0);
      assert.equal(spawns, 0);
    } finally {
      releaseBoundary?.();
      await daemon.stop().catch(() => undefined);
      await env.cleanup();
    }
  };
  await runCase("mint", "stopped");
  await runCase("capabilities", "paused");
});

test("pause arriving during provider dispatch persists and fences the exact returned handle", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "pause_during_dispatch");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "pause_during_dispatch", leaseId: "pause_during_dispatch", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let spawnEntered!: () => void;
  const spawnStarted = new Promise<void>((resolve) => { spawnEntered = resolve; });
  let releaseSpawn!: () => void;
  const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
  const returnedHandle = { workAttemptId: attempt.work_attempt_id, pid: 44551, providerContinuationId: "pause-dispatch-continuation", observedState: "working" as const };
  const stoppedHandles: typeof returnedHandle[] = [];
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawnEntered(); await spawnGate; return returnedHandle; },
    attach: async () => { throw new Error("dispatch fencing must not infer the returned handle via attach"); },
    attachAction: async () => { throw new Error("dispatch fencing must not inspect attachAction"); },
    resume: async () => { throw new Error("fresh dispatch must not resume"); }, poke: async () => {},
    stop: async (handle) => {
      stoppedHandles.push(handle as typeof returnedHandle);
      return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId };
    },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "pause_during_dispatch", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await spawnStarted;
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "pause_during_dispatch", desired_state: "paused",
    })).ok, true);
    releaseSpawn();
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "paused", "paused dispatch fence");
    const manifest = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(manifest.provider_ref?.provider_continuation_id, returnedHandle.providerContinuationId, "the exact returned identity is durable before fencing");
    assert.deepEqual(stoppedHandles, [returnedHandle]);
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id: "pause_during_dispatch" })).result as { execution_generations: Array<{ terminal: { terminal_cause: string } | null }> };
    assert.equal(result.execution_generations.length, 1);
    assert.equal(result.execution_generations[0]?.terminal?.terminal_cause, "stopped");
  } finally {
    releaseSpawn?.();
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("handoff during provider dispatch persists the exact handle for successor attach without signaling it", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "handoff_during_dispatch");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "handoff_during_dispatch", leaseId: "handoff_during_dispatch", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let spawnEntered!: () => void;
  const spawnStarted = new Promise<void>((resolve) => { spawnEntered = resolve; });
  let releaseSpawn!: () => void;
  const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
  const returnedHandle = { workAttemptId: attempt.work_attempt_id, pid: 55441, providerContinuationId: "handoff-dispatch-continuation", observedState: "working" as const };
  let spawns = 0;
  let attaches = 0;
  let stops = 0;
  let exitRegistrations = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; spawnEntered(); await spawnGate; return returnedHandle; },
    attach: async (ref) => {
      attaches += 1;
      assert.equal(ref.providerContinuationId, returnedHandle.providerContinuationId);
      return returnedHandle;
    },
    attachAction: async () => { throw new Error("handoff successor uses the durable provider ref, not action inference"); },
    resume: async () => { throw new Error("successor must attach instead of resume/spawn"); }, poke: async () => {},
    stop: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: returnedHandle.providerContinuationId }; },
    onExit: async () => { exitRegistrations += 1; return () => {}; }, onStream: async () => () => {},
  };
  const first = new SupervisorDaemon(paths, "darwin", port, true);
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "handoff_during_dispatch", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await spawnStarted;
    const handoff = first.waitForHandoff();
    const prepare = daemonRequest(paths.socketPath, "daemon.prepare_handoff");
    let handoffFinished = false;
    void handoff.then(() => { handoffFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(handoffFinished, false, "handoff holds stores only after native dispatch has begun");
    releaseSpawn();
    assert.equal((await prepare).ok, true);
    await within(handoff, "dispatch persistence handoff", 1_000);
    assert.equal(stops, 0, "handoff preserves the provider process");
    assert.equal(exitRegistrations, 0, "the retiring daemon registers no callbacks on the returned handle");

    second = new SupervisorDaemon(paths, "darwin", port, true);
    await second.start();
    await eventually(async () => attaches === 1
      && (second as unknown as { liveHandles: Map<string, typeof returnedHandle> }).liveHandles.get("handoff_during_dispatch") === returnedHandle,
    "successor exact provider attach");
    const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(current.provider_ref?.provider_continuation_id, returnedHandle.providerContinuationId);
    const live = (second as unknown as { liveHandles: Map<string, typeof returnedHandle> }).liveHandles.get("handoff_during_dispatch");
    assert.equal(live?.pid, returnedHandle.pid);
    assert.equal(live?.providerContinuationId, returnedHandle.providerContinuationId);
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id: "handoff_during_dispatch" })).result as { execution_generations: Array<{ execution_generation_id: string; terminal: unknown }> };
    assert.equal(result.execution_generations.length, 1);
    assert.equal(result.execution_generations[0]?.execution_generation_id, current.provider_ref?.execution_generation_id);
    assert.equal(result.execution_generations[0]?.terminal, null);
    assert.equal(spawns, 1);
    assert.equal(stops, 0);
  } finally {
    releaseSpawn?.();
    await second?.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("handoff winning the normal post-dispatch commit falls back to exact retirement persistence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const id = "handoff_during_provider_commit";
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  const returnedHandle = { workAttemptId: attempt.work_attempt_id, pid: 55442, providerContinuationId: "handoff-commit-continuation", observedState: "working" as const };
  let commitEntered!: () => void;
  const commitStarted = new Promise<void>((resolve) => { commitEntered = resolve; });
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let gated = false;
  let providerBirthCheckpointCalls = 0;
  let handoffRequested = false;
  let retirementConflictInjected = false;
  let spawns = 0;
  let attaches = 0;
  let stops = 0;
  let exitRegistrations = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; return returnedHandle; },
    attach: async (ref) => { attaches += 1; assert.equal(ref.providerContinuationId, returnedHandle.providerContinuationId); return returnedHandle; },
    attachAction: async () => { throw new Error("successor must use exact durable provider ref"); },
    resume: async () => { throw new Error("successor must attach"); }, poke: async () => {},
    stop: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: returnedHandle.providerContinuationId }; },
    onExit: async () => { exitRegistrations += 1; return () => {}; }, onStream: async () => () => {},
  };
  const first = new SupervisorDaemon(paths, "darwin", port, true);
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    const store = (first as unknown as { store: ManifestStore }).store;
    const originalReplace = store.replaceEntry.bind(store);
    const originalCheckpoint = store.checkpointProviderBirth.bind(store);
    store.checkpointProviderBirth = async (...args) => {
      providerBirthCheckpointCalls += 1;
      if (!gated) {
        gated = true;
        commitEntered();
        await commitGate;
      }
      if (providerBirthCheckpointCalls >= 2 && handoffRequested && !retirementConflictInjected) {
        retirementConflictInjected = true;
        const admitted = await store.getEntry(id);
        assert(admitted);
        // Charter is Inspector-owned configuration and must survive unrelated
        // lifecycle replacement. Use profile metadata to model the admitted
        // concurrent mutation this handoff fallback must preserve.
        await originalReplace(args[0], { ...admitted, display_name: `${admitted.display_name} admitted-before-handoff` }, async (commit) => commit());
        throw new ManifestConflictError("injected admitted mutation advanced the manifest generation");
      }
      return originalCheckpoint(...args);
    };
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await commitStarted;
    const handoff = first.waitForHandoff();
    handoffRequested = true;
    const prepare = daemonRequest(paths.socketPath, "daemon.prepare_handoff");
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseCommit();
    assert.equal((await prepare).ok, true);
    await within(handoff, "commit-boundary retirement persistence", 1_000);
    assert.equal(stops, 0);
    assert.equal(exitRegistrations, 0, "retiring daemon installs no callbacks after fallback persistence");

    second = new SupervisorDaemon(paths, "darwin", port, true);
    await second.start();
    await eventually(async () => attaches === 1, "successor attach after normal commit lost to handoff");
    const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: Array<{ execution_generation_id: string; terminal: unknown }> };
    assert.equal(current.provider_ref?.provider_continuation_id, returnedHandle.providerContinuationId);
    assert.match(current.display_name, /admitted-before-handoff/);
    assert.equal(result.execution_generations.length, 1);
    assert.equal(result.execution_generations[0]?.execution_generation_id, current.provider_ref?.execution_generation_id);
    assert.equal(result.execution_generations[0]?.terminal, null);
    assert.equal(spawns, 1);
    assert.equal(stops, 0);
  } finally {
    releaseCommit?.();
    await second?.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("pause and stop at the normal post-dispatch commit fence the exact returned handle", async () => {
  const runCase = async (desiredState: "paused" | "stopped") => {
    const env = await fixture();
    const id = `${desiredState}_during_provider_commit`;
    const paths = {
      lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
      manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
      attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    };
    const workspace = await provisionedWorkspace(env.root, id);
    const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
    const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
    await durability.close();
    const returnedHandle = { workAttemptId: attempt.work_attempt_id, pid: desiredState === "paused" ? 55443 : 55444, providerContinuationId: `${id}-continuation`, observedState: "working" as const };
    let commitEntered!: () => void;
    const commitStarted = new Promise<void>((resolve) => { commitEntered = resolve; });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let gated = false;
    const stopped: typeof returnedHandle[] = [];
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
      spawn: async () => returnedHandle, attach: async () => { throw new Error("control fence uses the returned handle directly"); },
      attachAction: async () => { throw new Error("control fence never infers the action"); }, resume: async () => { throw new Error("fresh launch"); }, poke: async () => {},
      stop: async (handle) => { stopped.push(handle as typeof returnedHandle); return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }; },
      onExit: async () => () => {}, onStream: async () => () => {},
    };
    const daemon = new SupervisorDaemon(paths, "darwin", port, true);
    try {
      await daemon.start();
      const store = (daemon as unknown as { store: ManifestStore }).store;
      const originalCheckpoint = store.checkpointProviderBirth.bind(store);
      store.checkpointProviderBirth = async (...args) => {
        if (!gated) {
          gated = true;
          commitEntered();
          await commitGate;
        }
        return originalCheckpoint(...args);
      };
      await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        ...entry, id, provider: "claude-code", observed_state: "absent",
        workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
      } });
      await commitStarted;
      const control = daemonRequest(paths.socketPath, "manifest.set_desired_state", { id, desired_state: desiredState });
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseCommit();
      assert.equal((await control).ok, true);
      await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === desiredState, `${desiredState} commit fence`);
      assert.deepEqual(stopped, [returnedHandle]);
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      const result = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: Array<{ terminal: unknown }> };
      assert.equal(current.provider_ref?.provider_continuation_id, returnedHandle.providerContinuationId);
      assert.equal(result.execution_generations.length, 1);
      assert.notEqual(result.execution_generations[0]?.terminal, null);
    } finally {
      releaseCommit?.();
      await daemon.stop().catch(() => undefined);
      await env.cleanup();
    }
  };
  await runCase("paused");
  await runCase("stopped");
});

test("fatal returned-handle journal and stop failure rejects handoff before acknowledgement without unhandled rejection", async () => {
  const env = await fixture();
  const id = "fatal_unjournaled_dispatch";
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  const returnedHandle = { workAttemptId: attempt.work_attempt_id, pid: 55446, providerContinuationId: "fatal-unjournaled-continuation", observedState: "working" as const };
  let stopEntered!: () => void;
  const stopStarted = new Promise<void>((resolve) => { stopEntered = resolve; });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => returnedHandle, attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("fresh launch"); }, poke: async () => {},
    stop: async () => { stopEntered(); throw new Error("injected exact-stop failure"); },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    const store = (daemon as unknown as { store: ManifestStore }).store;
    store.checkpointProviderBirth = async () => { throw new Error("injected provider journal failure"); };
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await stopStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    const prepare = await daemonRequest(paths.socketPath, "daemon.prepare_handoff");
    assert.equal(prepare.ok, false);
    assert.match(prepare.error ?? "", /exact-stop failure|journaled or exactly fenced/i);
    const status = await daemonRequest(paths.socketPath, "daemon.status");
    assert.equal(status.ok, true, "failed preflight retains socket and singleton authority");
    assert.equal(((status.result as { generation: number }).generation > 0), true);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("pause during post-install worker bind fences the exact provider before delivery starts", async () => {
  const env = await fixture();
  const id = "pause_during_post_install_bind";
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  const returnedHandle = { workAttemptId: attempt.work_attempt_id, pid: 55445, providerContinuationId: "pause-bind-continuation", observedState: "working" as const };
  let bindEntered!: () => void;
  const bindStarted = new Promise<void>((resolve) => { bindEntered = resolve; });
  let releaseBind!: () => void;
  const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
  const stopped: typeof returnedHandle[] = [];
  let deliveryStarts = 0;
  let nativePublications = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => returnedHandle, attach: async () => { throw new Error("bind control fence uses the returned handle"); },
    attachAction: async () => { throw new Error("bind control fence never infers the action"); }, resume: async () => { throw new Error("fresh launch"); }, poke: async () => {},
    stop: async (handle) => { stopped.push(handle as typeof returnedHandle); return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }; },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => ({ sessionId: "pause-bind-session", bearer: "pause-bind-bearer", bearerId: "pause-bind-bearer-id", expiresAt: null }),
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      workerBindings: WorkerBindingStore;
      publishNativeActivity: () => Promise<boolean>;
      startSupervisedDelivery: (entryId: string) => Promise<void>;
    };
    const originalBind = internals.workerBindings.bind.bind(internals.workerBindings);
    internals.workerBindings.bind = async (input) => {
      bindEntered();
      await bindGate;
      return originalBind(input);
    };
    internals.publishNativeActivity = async () => { nativePublications += 1; return true; };
    internals.startSupervisedDelivery = async () => { deliveryStarts += 1; };
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await admitDaemonInboxForProviderTest(daemon, id, entry.room_id);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-pause-bind",
      supervisor_grant: "pause-bind-parent", grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await bindStarted;
    const pause = daemonRequest(paths.socketPath, "manifest.set_desired_state", { id, desired_state: "paused" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseBind();
    assert.equal((await pause).ok, true);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "paused", "post-bind pause fence");
    assert.deepEqual(stopped, [returnedHandle]);
    assert.equal(deliveryStarts, 0);
    assert.equal(nativePublications, 0);
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.equal(result.execution_generations.length, 1);
    assert.notEqual(result.execution_generations[0]?.terminal, null);
  } finally {
    releaseBind?.();
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a live daemon rotates an expiring host worker bearer without reinstalling the grant or restarting the provider", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "host_grant_expiry_rotation");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "host_grant_expiry_rotation", leaseId: "host_grant_expiry_rotation", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let clock = Date.parse("2026-07-21T12:00:00.000Z");
  let spawns = 0;
  let mintCalls = 0;
  const handle = { workAttemptId: attempt.work_attempt_id, pid: 9914, providerContinuationId: "rotating-host-grant-continuation", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; return handle; }, attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("bearer rotation must retain the live provider"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }),
    onExit: async () => () => {}, onStream: async () => () => {},
    onExecution: async (runtime, listener) => runtimeReadySubscription(runtime, listener),
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 10, undefined, { nowMs: () => clock }, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => {
      mintCalls += 1;
      return mintCalls === 1
        ? { sessionId: "rotating-session", bearer: "first-rotating-bearer", bearerId: "first-rotating-bearer-id", expiresAt: new Date(clock + 120_000).toISOString() }
        : { sessionId: "rotating-session", bearer: "second-rotating-bearer", bearerId: "second-rotating-bearer-id", expiresAt: new Date(clock + 3_600_000).toISOString() };
    },
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as { workerBindings: WorkerBindingStore; publishNativeActivity: () => Promise<boolean> };
    internals.publishNativeActivity = async () => true;
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "host_grant_expiry_rotation", provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await admitDaemonInboxForProviderTest(daemon, "host_grant_expiry_rotation", entry.room_id);
    const daemonGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "host_grant_expiry_rotation", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-rotation",
      supervisor_grant: "rotation-grant", grant_generation: 1, api_url: "https://letagents.example", daemon_generation: daemonGeneration,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    let firstBinding: Awaited<ReturnType<WorkerBindingStore["get"]>> = null;
    await eventually(async () => {
      firstBinding = await internals.workerBindings.get("host_grant_expiry_rotation");
      return firstBinding?.credential_ref === "first-rotating-bearer-id";
    }, "initial host worker bearer binding");
    assert(firstBinding);
    assert.equal(await internals.workerBindings.credentialFor(firstBinding), "first-rotating-bearer");

    clock += 61_000;
    await eventually(async () => {
      const current = await internals.workerBindings.get("host_grant_expiry_rotation");
      return mintCalls === 2 && current?.credential_ref === "second-rotating-bearer-id";
    }, "automatic host worker bearer rotation");
    const rotated = await internals.workerBindings.get("host_grant_expiry_rotation");
    assert(rotated);
    assert.equal(await internals.workerBindings.credentialFor(rotated), "second-rotating-bearer");
    const credentialVault = (internals.workerBindings as unknown as { credentials: Map<string, unknown> }).credentials;
    assert.equal(credentialVault.has("first-rotating-bearer-id"), false, "the replaced bearer is revoked from the in-memory vault");
    assert.equal(spawns, 1, "bearer rotation must not restart the provider");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("host grant renewal retries transient failures, rotates the bearer in place, and rejects stale Electron rollback", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "host_grant_renewal_retry");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "host_grant_renewal_retry", leaseId: "host_grant_renewal_retry", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let clock = Date.parse("2026-07-21T12:00:00.000Z");
  let spawns = 0;
  let stops = 0;
  let renewalCalls = 0;
  let mintCalls = 0;
  const mintParentGrants: string[] = [];
  const handle = { workAttemptId: attempt.work_attempt_id, pid: 9915, providerContinuationId: "renewing-host-grant-continuation", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; return handle; }, attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("grant renewal must retain the exact provider"); }, poke: async () => {},
    stop: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }; },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 10, undefined, { nowMs: () => clock }, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    renewHostGrant: async (input) => {
      renewalCalls += 1;
      if (renewalCalls === 1) throw new Error("temporary renewal transport failure");
      return {
        grantId: input.grantId, supervisorGrant: "renewed-parent-secret",
        grantGeneration: input.grantGeneration, expiresAt: new Date(clock + 24 * 60 * 60_000).toISOString(),
      };
    },
    createWorkerSession: async (input) => {
      mintCalls += 1;
      mintParentGrants.push(input.supervisorGrant);
      if (mintCalls === 2) throw new Error("temporary child-session transport failure");
      return mintCalls === 1
        ? { sessionId: "renewal-session", bearer: "pre-renewal-bearer", bearerId: "pre-renewal-bearer-id", expiresAt: new Date(clock + 30_000).toISOString() }
        : { sessionId: "renewal-session", bearer: "renewed-worker-bearer", bearerId: "renewed-worker-bearer-id", expiresAt: new Date(clock + 3_600_000).toISOString() };
    },
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      workerBindings: WorkerBindingStore;
      workerRuntimeCustody: WorkerRuntimeCustody;
      publishNativeActivity: () => Promise<boolean>;
      requestConvergence: (entryId: string) => void;
    };
    internals.publishNativeActivity = async () => true;
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "host_grant_renewal_retry", provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await admitDaemonInboxForProviderTest(daemon, "host_grant_renewal_retry", entry.room_id);
    const daemonGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const staleInstall = {
      entry_id: "host_grant_renewal_retry", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-renewal",
      supervisor_grant: "pre-renewal-parent-secret", grant_generation: 1, api_url: "https://letagents.example", daemon_generation: daemonGeneration,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: new Date(clock + 30 * 60_000).toISOString(),
    };
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", staleInstall)).ok, true);
    await eventually(async () => {
      const binding = await internals.workerBindings.get("host_grant_renewal_retry");
      const grant = internals.workerRuntimeCustody.hostGrant("host_grant_renewal_retry");
      return renewalCalls >= 2 && mintCalls >= 3 && binding?.credential_ref === "renewed-worker-bearer-id"
        && grant?.supervisorGrant === "renewed-parent-secret";
    }, "parent renewal and transient child-session retry");
    const beforeStale = internals.workerRuntimeCustody.hostGrant("host_grant_renewal_retry")!;
    const cachedBeforeStale = internals.workerRuntimeCustody.workerAuthorization("host_grant_renewal_retry");
    assert.ok(cachedBeforeStale, "the latest successful bearer remains in process memory");
    assert.equal(beforeStale.supervisorGrant, "renewed-parent-secret");
    const renewedExpiry = beforeStale.expiresAt;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", staleInstall)).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterStale = internals.workerRuntimeCustody.hostGrant("host_grant_renewal_retry")!;
    assert.equal(afterStale.supervisorGrant, "renewed-parent-secret");
    assert.equal(afterStale.expiresAt, renewedExpiry);
    assert.equal(internals.workerRuntimeCustody.workerAuthorization("host_grant_renewal_retry"), cachedBeforeStale,
      "a stale install retaining the newer effective grant must retain its cached bearer");
    const mintsBeforeReconnect = mintCalls;
    let reconnectConvergenceCalls = 0;
    internals.requestConvergence = () => { reconnectConvergenceCalls += 1; };
    const credentialOnlyReplay = await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      ...staleInstall,
      credential_only: true,
    });
    assert.equal(credentialOnlyReplay.ok, true, credentialOnlyReplay.error);
    assert.equal((credentialOnlyReplay.result as { status?: string }).status, "installed");
    await eventually(async () => mintCalls === mintsBeforeReconnect + 1, "credential-only exact-provider rebind");
    const afterCredentialOnlyReplay = internals.workerRuntimeCustody.hostGrant("host_grant_renewal_retry")!;
    assert.equal(afterCredentialOnlyReplay.supervisorGrant, "renewed-parent-secret");
    assert.equal(afterCredentialOnlyReplay.expiresAt, renewedExpiry);
    assert.equal(mintParentGrants.at(-1), "renewed-parent-secret", "the rebind mints with daemon's newer grant, never stale safeStorage input");
    assert.equal(reconnectConvergenceCalls, 0, "credential-only rebind never schedules provider convergence");
    const binding = await internals.workerBindings.get("host_grant_renewal_retry");
    assert(binding);
    assert.equal(await internals.workerBindings.credentialFor(binding), "renewed-worker-bearer");
    const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.notEqual(current.condition, "auth_blocked", "transient renewal failures preserve still-valid authority");
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id: "host_grant_renewal_retry" })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.equal(result.execution_generations.length, 1);
    assert.equal(result.execution_generations[0]?.terminal, null);
    assert.equal(spawns, 1);
    assert.equal(stops, 0);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("expired and definitively rejected host grants become auth-blocked without stopping the provider", async () => {
  const runCase = async (rejection: "expired" | 401 | 403 | 409) => {
    const env = await fixture();
    const id = `host_grant_block_${rejection}`;
    const paths = {
      lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
      manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
      attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    };
    const workspace = await provisionedWorkspace(env.root, id);
    const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
    const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
    await durability.close();
    let clock = Date.parse("2026-07-21T12:00:00.000Z");
    let stops = 0;
    let renewals = 0;
    const handle = { workAttemptId: attempt.work_attempt_id, pid: 9970 + (typeof rejection === "number" ? rejection : 0), providerContinuationId: `${id}-continuation`, observedState: "working" as const };
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
      spawn: async () => handle, attach: async () => null, attachAction: async () => ({ state: "absent" }),
      resume: async () => { throw new Error("authority failure must retain the provider"); }, poke: async () => {},
      stop: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }; },
      onExit: async () => () => {}, onStream: async () => () => {},
      onExecution: async (runtime, listener) => runtimeReadySubscription(runtime, listener),
    };
    const daemon = new SupervisorDaemon(paths, "darwin", port, true, 10, undefined, { nowMs: () => clock }, {
      poll: async () => ({ messages: [] }), publish: async () => {},
    }, {
      renewHostGrant: async () => {
        renewals += 1;
        if (typeof rejection === "number") throw new SupervisorGrantRequestError(rejection, "injected renewal");
        throw new Error("expired grant must not be renewed");
      },
      createWorkerSession: async () => ({
        sessionId: `${id}-session`, bearer: `${id}-bearer`, bearerId: `${id}-bearer-id`,
        expiresAt: new Date(clock + 24 * 60 * 60_000).toISOString(),
      }),
    });
    try {
      await daemon.start();
      const internals = daemon as unknown as {
        liveHandles: Map<string, typeof handle>;
        workerRuntimeCustody: WorkerRuntimeCustody;
        publishNativeActivity: () => Promise<boolean>;
      };
      internals.publishNativeActivity = async () => true;
      await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
        workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
      } });
      await admitDaemonInboxForProviderTest(daemon, id, entry.room_id);
      const daemonGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
      assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
        entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: `grant-${id}`,
        supervisor_grant: `${id}-parent`, grant_generation: 1, api_url: "https://letagents.example", daemon_generation: daemonGeneration,
        host_id: "host-1", installation_id: "installation-1", grant_expires_at: new Date(clock + 2 * 60 * 60_000).toISOString(),
      })).ok, true);
      await eventually(async () => internals.liveHandles.get(id) === handle, `${id} initial provider`);
      clock += rejection === "expired" ? 2 * 60 * 60_000 + 1 : 61 * 60_000;
      await eventually(async () => {
        const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0];
        return current?.condition === "auth_blocked" && current.observed_state === "recovering";
      }, `${id} auth block`);
      assert.equal(internals.liveHandles.get(id), handle, "authority loss preserves the exact provider handle");
      assert.equal(internals.workerRuntimeCustody.hostGrant(id), undefined, "rejected plaintext parent authority is removed from memory");
      assert.equal(stops, 0);
      assert.equal(rejection === "expired" ? renewals === 0 : renewals >= 1, true);
    } finally {
      await daemon.stop().catch(() => undefined);
      await env.cleanup();
    }
  };
  await runCase("expired");
  await runCase(401);
  await runCase(403);
  await runCase(409);
});

test("an unattached live durable generation blocks a duplicate provider start", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "unattached_live_generation");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
  const attempt = await durability.createAttempt({ taskId: "unattached_live_generation", leaseId: "unattached_live_generation", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  const execution = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
  let spawnCount = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawnCount += 1; throw new Error("must not mint a duplicate generation"); },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { spawnCount += 1; throw new Error("must not mint a duplicate generation"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "live-continuation" }),
    onExit: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "unattached_live_generation", provider: "claude-code", observed_state: "recovering",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id,
        provider_continuation_id: "live-continuation",
        provider_connection: null,
        execution_generation_id: execution.execution_generation_id,
      },
    } })).ok, true);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.condition === "coordination_blocked" && /remains live/.test(current.last_error ?? "");
    }, "ambiguous live generation hold");
    assert.equal(spawnCount, 0);
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "unattached_live_generation" })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.equal(detail.execution_generations.length, 1);
    assert.equal(detail.execution_generations[0]?.terminal, null);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a failed provider launch terminalizes its generation and releases the shared workspace fence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "failed_launch_cleanup");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "failed_launch_cleanup", leaseId: "failed_launch_cleanup", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  let launchCount = 0;
  const recovered = { workAttemptId: attempt.work_attempt_id, pid: 4202, providerContinuationId: "recovered-continuation", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { launchCount += 1; if (launchCount === 1) throw new Error("injected launch failure"); return recovered; },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => recovered,
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: recovered.providerContinuationId }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "failed_launch_cleanup", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.condition === "coordination_blocked" && /injected launch failure/.test(current.last_error ?? "");
    }, "failed launch persistence");
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "failed_launch_cleanup" })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.ok(detail.execution_generations[0]?.terminal, "failed launch generation is durably terminal");
    const fenceDirectory = join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences");
    assert.equal((await readdir(fenceDirectory)).some((name) => name.startsWith("shared-")), false, "failed launch releases retained workspace authority");

    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "failed_launch_cleanup", desired_state: "running" })).ok, true);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "provider retry without daemon restart");
    assert.equal(launchCount, 2);
    assert.equal((await readdir(fenceDirectory)).filter((name) => name.startsWith("shared-")).length, 1, "successful retry reacquires one shared fence");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a provider handle returned already terminal is fenced and resumes under a successor generation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "returned_terminal");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({
    taskId: "returned_terminal",
    leaseId: "returned_terminal",
    leaseEpoch: 0,
    workspacePath: workspace.path,
    workAttemptId: workspace.id,
  });
  const failedHandle = {
    workAttemptId: attempt.work_attempt_id,
    pid: 4101,
    providerContinuationId: "claude-continuation",
    observedState: "failed" as const,
  };
  const recoveredHandle = {
    ...failedHandle,
    pid: 4102,
    observedState: "working" as const,
  };
  let stopCount = 0;
  let resumeCount = 0;
  const streamListeners = new Map<object, (event: any) => void>();
  const exitListeners = new Map<object, (terminal: {
    endedAt: string; exitCode: number | null; signal: string | null;
    terminalCause: "stopped"; providerContinuationId: string;
  }) => void>();
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => failedHandle,
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { resumeCount += 1; return recoveredHandle; },
    poke: async () => {},
    stop: async (handle) => {
      stopCount += 1;
      const terminal = {
        endedAt: new Date().toISOString(),
        exitCode: 1,
        signal: null,
        terminalCause: "stopped" as const,
        providerContinuationId: "claude-continuation",
      };
      queueMicrotask(() => exitListeners.get(handle as object)?.(terminal));
      return terminal;
    },
    onExit: async (handle, listener) => {
      exitListeners.set(handle as object, listener);
      return () => exitListeners.delete(handle as object);
    },
    onStream: async (handle, listener) => {
      streamListeners.set(handle as object, listener);
      if (handle === failedHandle) {
        listener({
          workAttemptId: attempt.work_attempt_id,
          providerContinuationId: "claude-continuation",
          observedAt: new Date().toISOString(),
          sequence: 1,
          provider: "claude-code",
          kind: "error",
          method: "result/error_during_execution",
          payload: { type: "result", subtype: "error_during_execution", is_error: true },
          payloadTruncated: false,
          payloadRedacted: false,
          durablePayloadRef: null,
        });
      }
      return () => streamListeners.delete(handle as object);
    },
  };
  const recovery = fakeRecoveryClock();
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, recovery.clock);
  try {
    await daemon.start();
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "returned_terminal",
      provider: "claude-code",
      observed_state: "absent",
      workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id,
    } });
    assert.equal(put.ok, true, put.error);
    await eventually(async () => stopCount === 1 && recovery.pending() === 1, "terminal fence and recovery timer");
    assert.equal(resumeCount, 0);
    await recovery.advance(999);
    await Promise.resolve();
    assert.equal(resumeCount, 0, "generation 2 cannot start before the persisted backoff");
    await recovery.advance(1);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.observed_state === "working"
        && current.provider_ref?.execution_generation_id !== undefined;
    }, "already-terminal launch recovery");
    assert.equal(stopCount, 1, "returned-state and just-installed stream paths share one idempotent terminal fence");
    assert.equal(resumeCount, 1, "the listener boundary race mints exactly one bounded successor");
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "returned_terminal" })).result as {
      execution_generations: Array<{ terminal: unknown }>;
    };
    assert.ok(detail.execution_generations[0]?.terminal, "the returned-terminal generation is durably terminal");
    assert.equal(detail.execution_generations[1]?.terminal, null, "only the successor generation remains live");

    streamListeners.get(recoveredHandle as object)?.({
      workAttemptId: attempt.work_attempt_id,
      providerContinuationId: "claude-continuation",
      observedAt: new Date().toISOString(),
      sequence: 2,
      provider: "claude-code",
      kind: "error",
      method: "result/error_during_execution",
      payload: { type: "result", subtype: "error_during_execution", is_error: true },
      payloadTruncated: false,
      payloadRedacted: false,
      durablePayloadRef: null,
    });
    await eventually(async () => recovery.pending() === 1, "second terminal recovery timer");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "returned_terminal", desired_state: "stopped" });
    assert.equal(recovery.pending(), 0, "manual Stop cancels the pending recovery timer");
    await recovery.advance(60_000);
    await Promise.resolve();
    assert.equal(resumeCount, 1, "a cancelled recovery timer cannot mint another successor");
  } finally {
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "returned_terminal", desired_state: "stopped" }).catch(() => undefined);
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("direct terminal recovery increases delay and quarantines before a sixth generation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "bounded_terminal_loop");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "bounded_terminal_loop", leaseId: "bounded_terminal_loop", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  let launchCount = 0;
  const exitListeners = new Map<object, (terminal: any) => void>();
  const failedHandle = () => ({ workAttemptId: attempt.work_attempt_id, pid: 4200 + launchCount, providerContinuationId: "bounded-continuation", observedState: "failed" as const });
  const launch = () => { launchCount += 1; return failedHandle(); };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => launch(),
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => launch(),
    poke: async () => {},
    stop: async (handle) => {
      const terminal = { endedAt: new Date().toISOString(), exitCode: 1, signal: null, terminalCause: "stopped" as const, providerContinuationId: "bounded-continuation" };
      queueMicrotask(() => exitListeners.get(handle as object)?.(terminal));
      return terminal;
    },
    onExit: async (handle, listener) => { exitListeners.set(handle as object, listener); return () => exitListeners.delete(handle as object); },
    onStream: async () => () => {},
  };
  const recovery = fakeRecoveryClock();
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, recovery.clock);
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "bounded_terminal_loop", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000].entries()) {
      await eventually(async () => launchCount === index + 1 && recovery.pending() === 1, `recovery timer ${index + 1}`);
      assert.equal(recovery.delays.at(-1), delay);
      await recovery.advance(delay - 1);
      await Promise.resolve();
      assert.equal(launchCount, index + 1);
      await recovery.advance(1);
    }
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.condition === "quarantined";
    }, "fifth terminal quarantine");
    assert.equal(launchCount, CRASH_LOOP_EXIT_LIMIT, "the threshold prevents generation 6");
    assert.equal(recovery.pending(), 0, "quarantine leaves no recovery timer");
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "bounded_terminal_loop" })).result as { execution_generations: unknown[] };
    assert.equal(detail.execution_generations.length, CRASH_LOOP_EXIT_LIMIT);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a terminal handle discovered during daemon reattach is fenced and resumes once", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "reattached_terminal");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "reattached_terminal", leaseId: "reattached_terminal", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  const liveHandle = { workAttemptId: attempt.work_attempt_id, pid: 4301, providerContinuationId: "reattach-continuation", observedState: "working" as const };
  const terminalHandle = { ...liveHandle, observedState: "idle" as const };
  const successorHandle = { ...liveHandle, pid: 4302 };
  const firstPort: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => liveHandle,
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("first daemon starts fresh"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "reattach-continuation" }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const recovery = fakeRecoveryClock();
  const first = new SupervisorDaemon(paths, "darwin", firstPort, true, 15_000, undefined, recovery.clock);
  let second: SupervisorDaemon | null = null;
  let stopCount = 0;
  let resumeCount = 0;
  const exitListeners = new Map<object, (terminal: any) => void>();
  try {
    await first.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "reattached_terminal", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "first daemon provider start");
    await first.stop();

    const secondPort: ProviderActionPort = {
      ...firstPort,
      spawn: async () => { throw new Error("reattach recovery must preserve the continuation"); },
      attach: async () => terminalHandle,
      resume: async () => { resumeCount += 1; return successorHandle; },
      stop: async (handle) => {
        stopCount += 1;
        const terminal = { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped" as const, providerContinuationId: "reattach-continuation" };
        queueMicrotask(() => exitListeners.get(handle as object)?.(terminal));
        return terminal;
      },
      onExit: async (handle, listener) => { exitListeners.set(handle as object, listener); return () => exitListeners.delete(handle as object); },
    };
    second = new SupervisorDaemon(paths, "darwin", secondPort, true, 15_000, undefined, recovery.clock);
    await second.start();
    await eventually(async () => stopCount === 1 && recovery.pending() === 1, "terminal reattach fence");
    assert.equal(resumeCount, 0);
    await recovery.advance(1_000);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "reattached successor");
    assert.equal(stopCount, 1);
    assert.equal(resumeCount, 1);
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "reattached_terminal" })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.ok(detail.execution_generations[0]?.terminal);
    assert.equal(detail.execution_generations[1]?.terminal, null);
  } finally {
    await second?.stop().catch(() => undefined);
    await first.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("direct provider convergence quarantines persisted crash loops without another spawn", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  let spawnCount = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawnCount += 1; throw new Error("quarantined entry must not spawn"); },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { spawnCount += 1; throw new Error("quarantined entry must not resume"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
    onExit: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    const now = Date.now();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "persisted_crash_loop",
      observed_state: "failed",
      reconciliation: {
        exit_timestamps_ms: Array.from({ length: CRASH_LOOP_EXIT_LIMIT }, (_, index) => now - index),
        consecutive_action_failures: CRASH_LOOP_EXIT_LIMIT,
        last_observed_state: "failed",
        next_restart_at_ms: now + 60_000,
        completed_action_ids: [],
        last_action_sequence: 0,
        pending_action: null,
      },
    } })).ok, true);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.condition === "quarantined";
    }, "persisted crash-loop quarantine");
    assert.equal(spawnCount, 0);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("reconciler policy may poke stalled addressed work but silence never proves runtime loss", () => {
  const base = {
    desiredState: "running" as const, observedState: "working" as const, condition: "none" as const,
    capabilities: { resume: true, midTurnInjection: true }, nowMs: 10_000, lastPollAtMs: 0,
    addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, exitsInWindow: 0,
  };
  assert.equal(decideReconciliation({ ...base, addressedMessagesWaiting: 0, pokeIgnored: true }, 1_000).action, "wait", "long work with an empty inbox is never touched");
  assert.equal(decideReconciliation({ ...base, lastPollAtMs: 9_999, addressedMessagesWaiting: 1, pokeIgnored: true }, 1_000).action, "wait", "quiet but polling is never touched");
  assert.equal(decideReconciliation({ ...base, addressedMessagesWaiting: 1 }, 1_000).action, "poke");
  assert.equal(decideReconciliation({ ...base, addressedMessagesWaiting: 1, pokeIgnored: true }, 1_000).action, "wait",
    "an ignored poke is not hard evidence that the provider died");
});

test("reconciler policy fences recovery, gates resume, quarantines crash loops, and backs off", () => {
  const base = {
    desiredState: "running" as const, observedState: "failed" as const, condition: "none" as const,
    capabilities: { resume: true, midTurnInjection: false }, nowMs: 0, lastPollAtMs: null,
    addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: true, fencedRebindProven: false, exitsInWindow: 0,
  };
  assert.deepEqual(decideReconciliation(base, 1_000), {
    action: "hold_coordination", observedState: "recovering", condition: "coordination_blocked", reason: "active lease requires fenced rebind before restart",
  });
  assert.equal(decideReconciliation({ ...base, fencedRebindProven: true }, 1_000).action, "restart_with_resume");
  assert.equal(decideReconciliation({ ...base, activeLease: false, capabilities: { resume: false, midTurnInjection: false } }, 1_000).action, "restart_fresh");
  assert.equal(decideReconciliation({ ...base, exitsInWindow: CRASH_LOOP_EXIT_LIMIT }, 1_000).action, "quarantine");
  assert.equal(restartBackoffMs(1), 1_000);
  assert.equal(restartBackoffMs(20), 5 * 60 * 1_000);
  assert.equal(decideReconciliation({ ...base, activeLease: false, nextRestartAtMs: 1_001, nowMs: 1_000 }, 1_000).action, "wait");
});

test("reconciliation bookkeeping keeps rolling exits independent from action backoff", () => {
  const first = advanceReconciliationState(undefined, "failed", 1_000);
  assert.deepEqual(first.exit_timestamps_ms, [1_000]);
  assert.equal(first.consecutive_action_failures, 1);
  assert.deepEqual(advanceReconciliationState(first, "failed", 1_500), first, "a polling tick cannot manufacture another exit");
  const recovered = advanceReconciliationState(first, "recovering", 2_000);
  assert.deepEqual(recovered.exit_timestamps_ms, [1_000]);
  assert.deepEqual(advanceReconciliationState(recovered, "working", 2_500).exit_timestamps_ms, [1_000], "healthy work never erases exit history");
  const later = advanceReconciliationState({ ...first, last_observed_state: "recovering" }, "failed", 2_000);
  assert.deepEqual(later.exit_timestamps_ms, [1_000, 2_000]);
  const expired = advanceReconciliationState({ ...later, last_observed_state: "recovering" }, "failed", 2_000 + 10 * 60 * 1_000 + 1);
  assert.deepEqual(expired.exit_timestamps_ms, [2_000 + 10 * 60 * 1_000 + 1]);
  const actionFailure = recordReconciliationActionFailure(first, "generation-2", 2_000);
  assert.equal(actionFailure.consecutive_action_failures, 2);
  assert.equal(recordReconciliationActionFailure(actionFailure, "generation-2", 3_000), actionFailure, "retried action is idempotent");
  const afterAnotherAction = recordReconciliationActionFailure(actionFailure, "generation-3", 4_000);
  assert.equal(recordReconciliationActionFailure(afterAnotherAction, "generation-2", 5_000), afterAnotherAction, "non-adjacent replay is rejected");
});

test("human-control manifest projection remains bounded while durable storage owns lifetime replay", () => {
  let state = advanceReconciliationState(undefined, "idle", 1_000);
  for (let index = 0; index < 80; index += 1) {
    state = rememberCompletedControlAction(state, `control-${index}`);
  }
  assert.equal(state.completed_action_ids.length, 32);
  assert.equal(state.completed_action_ids[0], "control-48");
  state = rememberCompletedControlAction(state, "control-48");
  assert.equal(state.completed_action_ids.length, 32, "an idempotent projection refresh never duplicates the id");
  assert.equal(state.completed_action_ids.at(-1), "control-48");
});

test("new turn-control admissions are bounded per agent while recovery retries remain outside the bucket", async () => {
  const env = await fixture();
  let nowMs = 10_000;
  const paths = {
    lockPath: join(env.root, "rate.lock"), socketPath: join(env.root, "rate.sock"),
    manifestPath: join(env.root, "rate.sqlite"), auditPath: join(env.root, "rate-audit.jsonl"),
    attemptsPath: join(env.root, "rate-attempts.sqlite"), attemptsRoot: join(env.root, "rate-attempts"),
    workspaceRoot: env.root, workerBindingsPath: join(env.root, "rate-bindings.json"),
  };
  const daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, { nowMs: () => nowMs });
  const internals = daemon as unknown as { admitNewTurnControl(entryId: string): void };
  try {
    for (let index = 0; index < 24; index += 1) internals.admitNewTurnControl("agent-rate");
    assert.throws(() => internals.admitNewTurnControl("agent-rate"), /temporarily rate limited/i);
    assert.doesNotThrow(() => internals.admitNewTurnControl("other-agent"), "one agent cannot consume another agent's budget");
    nowMs += 60_001;
    assert.doesNotThrow(() => internals.admitNewTurnControl("agent-rate"), "the bounded window recovers without deleting lifetime tombstones");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("reconciler executes only fenced, capability-negotiated port actions", async () => {
  const calls: string[] = [];
  const handle = { workAttemptId: "attempt", pid: 1, providerContinuationId: "thread", observedState: "failed" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: true, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
    spawn: async () => { calls.push("spawn"); return handle; }, attach: async () => null,
    resume: async () => { calls.push("resume"); return handle; }, poke: async () => { calls.push("poke"); },
    stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "thread" }), onExit: async () => () => {},
  };
  const runner = new ProviderReconciler(port);
  const base = { workAttemptId: "attempt", desiredState: "running" as const, observedState: "failed" as const, condition: "none" as const, nowMs: 1_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, exitsInWindow: 0, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle, resumeFrom: { workAttemptId: "attempt", providerContinuationId: "thread" } };
  assert.equal((await runner.reconcile({ ...base, activeLease: true, fencedRebindProven: false }, 100)).decision.action, "hold_coordination");
  assert.deepEqual(calls, []);
  assert.equal((await runner.reconcile({ ...base, activeLease: false, fencedRebindProven: false }, 100)).decision.action, "restart_with_resume");
  assert.deepEqual(calls, ["resume"]);
  const missing = await runner.reconcile({ ...base, activeLease: false, fencedRebindProven: false, resumeFrom: null }, 100);
  assert.equal(missing.decision.action, "hold_coordination");
  assert.equal(missing.disposition, "held");
});

test("reconciler dispatches fresh, poke, and stop safely and reports port faults", async () => {
  const calls: string[] = [];
  const handle = { workAttemptId: "attempt", pid: 1, providerContinuationId: "thread", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: true, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
    spawn: async () => { calls.push("spawn"); return handle; }, attach: async () => null,
    resume: async () => { calls.push("resume"); return handle; }, poke: async () => { calls.push("poke"); },
    stop: async () => { calls.push("stop"); return { endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "thread" }; }, onExit: async () => () => {},
  };
  const runner = new ProviderReconciler(port);
  const base = { workAttemptId: "attempt", desiredState: "running" as const, observedState: "failed" as const, condition: "none" as const, nowMs: 10_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, exitsInWindow: 0, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle, resumeFrom: null };
  assert.equal((await runner.reconcile(base, 100)).decision.action, "restart_fresh");
  assert.deepEqual(calls, ["spawn"]);
  const poke = await runner.reconcile({ ...base, observedState: "working", lastPollAtMs: 0, addressedMessagesWaiting: 1 }, 100);
  assert.equal(poke.decision.action, "poke");
  const stop = await runner.reconcile({ ...base, desiredState: "stopped", observedState: "working" }, 100);
  assert.equal(stop.decision.action, "stop");
  assert.deepEqual(calls, ["spawn", "poke", "stop"]);
  assert.equal((await runner.reconcile({ ...base, observedState: "working", lastPollAtMs: 0, addressedMessagesWaiting: 1, handle: null }, 100)).disposition, "held");
  assert.equal((await runner.reconcile({ ...base, desiredState: "stopped", observedState: "working", handle: null }, 100)).disposition, "held");
  for (const unsafe of [
    { desiredState: "stopped" as const },
    { condition: "quarantined" as const },
    { activeLease: true, fencedRebindProven: true },
  ]) {
    const before = calls.length;
    const held = await runner.reconcile({ ...base, forcedAction: "restart_fresh", ...unsafe }, 100);
    assert.equal(held.disposition, "held", "a durable pending restart must revalidate current stop/quarantine/lease gates");
    assert.equal(calls.length, before, "an unsafe durable restart is never dispatched");
  }
  const beforePoke = calls.length;
  const pendingPoke = await runner.reconcile({ ...base, observedState: "working", lastPollAtMs: 0, addressedMessagesWaiting: 1, activeLease: true, fencedRebindProven: true, forcedAction: "poke" }, 100);
  assert.equal(pendingPoke.disposition, "executed", "an active lease does not block a safe durable poke");
  assert.equal(calls.length, beforePoke + 1);
  const broken = new ProviderReconciler({ ...port, spawn: async () => { throw new Error("child failed"); } });
  const result = await broken.reconcile(base, 100);
  assert.equal(result.disposition, "failed");
  assert.match(result.decision.reason, /child failed/);
});

test("an exact resume method failure downgrades capabilities and the next reconcile starts fresh", async () => {
  const calls: string[] = [];
  let resumeSupported = true;
  const handle = { workAttemptId: "attempt", pid: 1, providerContinuationId: "thread", observedState: "failed" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: resumeSupported, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { calls.push("spawn"); return handle; },
    attach: async () => null,
    resume: async () => {
      calls.push("resume");
      resumeSupported = false;
      throw new Error("Codex app-server does not support thread/resume; bounded recovery must start a fresh generation.");
    },
    poke: async () => {},
    stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "thread" }),
    onExit: async () => () => {},
  };
  const runner = new ProviderReconciler(port);
  const input = {
    workAttemptId: "attempt",
    desiredState: "running" as const,
    observedState: "failed" as const,
    condition: "none" as const,
    nowMs: 1_000,
    lastPollAtMs: null,
    addressedMessagesWaiting: 0,
    pokeIgnored: false,
    exitsInWindow: 0,
    activeLease: false,
    fencedRebindProven: false,
    spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} },
    handle,
    resumeFrom: { workAttemptId: "attempt", providerContinuationId: "thread" },
  };

  const failedResume = await runner.reconcile(input, 100);
  assert.equal(failedResume.disposition, "failed");
  assert.match(failedResume.decision.reason, /bounded recovery must start a fresh generation/);
  const freshRetry = await runner.reconcile(input, 100);
  assert.equal(freshRetry.decision.action, "restart_fresh");
  assert.equal(freshRetry.disposition, "executed");
  assert.deepEqual(calls, ["resume", "spawn"]);
});

test("supervisor convergence persists the retry deadline before it can restart", async () => {
  const env = await fixture();
  try {
    const manifestPath = join(env.root, "manifest.json");
    const store = new ManifestStore(manifestPath);
    await store.write(0, [{ ...entry, observed_state: "failed" }]);
    const calls: string[] = [];
    const handle = { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "starting" as const };
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { calls.push("spawn"); return handle; }, attach: async () => null, resume: async () => handle,
      poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
    };
    const daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const daemonStore = (daemon as unknown as { store: ManifestStore }).store;
    (daemonStore as unknown as { write: () => never }).write = () => { throw new Error("reconcile must not call the full manifest write path"); };
    (daemonStore as unknown as { replaceEntries: () => never }).replaceEntries = () => { throw new Error("reconcile must not replace all entries"); };
    const input = { workAttemptId: "attempt", reconciliationActionId: "generation-1", reconciliationActionSequence: 1, nowMs: 1_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null };
    assert.equal((await daemon.reconcile(entry.id, input, 100)).decision.action, "wait");
    assert.deepEqual(calls, []);
    assert.equal((await store.load()).entries[0]?.reconciliation?.next_restart_at_ms, 2_000);
    assert.equal((await daemon.reconcile(entry.id, { ...input, nowMs: 2_000 }, 100)).decision.action, "restart_fresh");
    assert.deepEqual(calls, ["spawn"]);
    await daemon.stop();
  } finally { await env.cleanup(); }
});

test("five terminal exit edges across reload quarantine even with intermediate work", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  let reloaded: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") };
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "working" }]);
    let spawnCalls = 0;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { spawnCalls += 1; throw new Error("should not restart"); }, attach: async () => null,
      resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
    };
    const base = { workAttemptId: "attempt", lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null };
    daemon = new SupervisorDaemon(paths, "darwin", port);
    await daemon.start();
    for (let index = 0; index < 5; index += 1) {
      await daemon.transition(entry.id, "failed", "none", `terminal-exit-${index}`, "provider");
      await daemon.transition(entry.id, "working", "none", `recovered-${index}`, "provider");
    }
    await daemon.stop();
    reloaded = new SupervisorDaemon(paths, "darwin", port);
    await reloaded.start();
    const quarantined = await reloaded.reconcile(entry.id, { ...base, reconciliationActionId: "generation-5", reconciliationActionSequence: 5, nowMs: Date.now() }, 100);
    assert.equal(quarantined.decision.action, "quarantine");
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.condition, "quarantined");
    assert.equal(spawnCalls, 0, "quarantine blocks another provider launch");
    await reloaded.stop();
  } finally { await reloaded?.stop().catch(() => undefined); await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("reconciliation journals intent before provider dispatch and attaches it after reload", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  let reloaded: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") };
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [0], consecutive_action_failures: 1, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    let releaseSpawn!: () => void;
    let signalSpawn!: () => void;
    const spawned = new Promise<void>((resolve) => { signalSpawn = resolve; });
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { signalSpawn(); await new Promise<void>((resolve) => { releaseSpawn = resolve; }); return { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "starting" }; }, attach: async () => null,
      resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
    };
    const input = { workAttemptId: "attempt", reconciliationActionId: "generation-2", reconciliationActionSequence: 2, nowMs: 2_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null };
    daemon = new SupervisorDaemon(paths, "darwin", port);
    await daemon.start();
    const running = daemon.reconcile(entry.id, input, 100);
    await spawned;
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation?.pending_action?.id, "generation-2");
    releaseSpawn();
    await running;
    await daemon.stop();
    const reloadedPort: ProviderActionPort = { ...port, spawn: async () => { throw new Error("must not respawn a pending action"); }, attachAction: async (id) => id === "orphan" ? { state: "attached", handle: { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "starting" } } : { state: "absent" } };
    const stored = await new ManifestStore(manifestPath).load();
    await new ManifestStore(manifestPath).write(stored.generation, stored.entries.map((candidate) => candidate.id === entry.id ? { ...candidate, reconciliation: { ...candidate.reconciliation!, pending_action: { id: "orphan", sequence: 3, kind: "restart_fresh", recorded_at_ms: 3_000 } } } : candidate));
    reloaded = new SupervisorDaemon(paths, "darwin", reloadedPort);
    await reloaded.start();
    assert.equal((await reloaded.reconcile(entry.id, { ...input, reconciliationActionId: "generation-3", reconciliationActionSequence: 3, nowMs: 3_001 }, 100)).disposition, "held");
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation?.pending_action, null);
    await reloaded.stop();
  } finally { await reloaded?.stop().catch(() => undefined); await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("an absent pending intent redispatches its exact durable identity and kind, while ambiguity blocks", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 7, pending_action: { id: "durable-restart", sequence: 7, kind: "restart_fresh", recorded_at_ms: 1 } } }]);
    const requests: Array<{ actionId?: string }> = [];
    let attachment: "absent" | "ambiguous" = "absent";
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async (request) => { requests.push({ actionId: request.actionId }); return { workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" }; },
      attach: async () => null,
      attachAction: async () => attachment === "absent" ? { state: "absent" } : { state: "ambiguous", reason: "provider lookup timed out" },
      resume: async () => { throw new Error("the durable restart_fresh kind must not become resume"); },
      poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const input = { workAttemptId: "attempt", reconciliationActionId: "newer-tick", reconciliationActionSequence: 8, nowMs: 2_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: { workAttemptId: "attempt", providerContinuationId: "thread" } };
    assert.equal((await daemon.reconcile(entry.id, input, 100)).decision.action, "restart_fresh");
    assert.deepEqual(requests, [{ actionId: "durable-restart" }]);
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation?.last_action_sequence, 7, "redispatch never decrements the monotonic sequence");

    const stored = await new ManifestStore(manifestPath).load();
    await daemon.stop();
    daemon = null;
    await new ManifestStore(manifestPath).write(stored.generation, stored.entries.map((candidate) => candidate.id === entry.id ? { ...candidate, reconciliation: { ...candidate.reconciliation!, pending_action: { id: "ambiguous-intent", sequence: 9, kind: "restart_fresh", recorded_at_ms: 3 } } } : candidate));
    attachment = "ambiguous";
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const held = await daemon.reconcile(entry.id, { ...input, reconciliationActionId: "later-tick", reconciliationActionSequence: 10, nowMs: 3_000 }, 100);
    assert.equal(held.disposition, "held");
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.condition, "coordination_blocked");
    assert.equal(requests.length, 1, "ambiguous attachment may never redispatch");
    await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("global manifest mutation serialization preserves concurrent different-entry transitions", async () => {
  const env = await fixture();
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [entry, { ...entry, id: "agent_2" }]);
    const daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin");
    await daemon.start();
    await Promise.all([daemon.transition("agent_1", "failed", "none", "exit", "test"), daemon.transition("agent_2", "failed", "none", "exit", "test")]);
    assert.deepEqual((await new ManifestStore(manifestPath).load()).entries.map((candidate) => candidate.observed_state), ["failed", "failed"]);
    await daemon.stop();
  } finally { await env.cleanup(); }
});

test("scheduled convergence records provider exits and durable escalation notices", async () => {
  const env = await fixture();
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "working" }]);
    let onExit: ((terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void) | null = null;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }), spawn: async () => { throw new Error("unreachable"); }, attach: async () => null, resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (_handle, listener) => { onExit = listener; return () => { onExit = null; }; },
    };
    const daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const stop = await daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "working" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "generation-1", reconciliationActionSequence: 1, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 60_000);
    onExit?.({ endedAt: "now", exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: null });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.observed_state, "failed");
    await daemon.transition(entry.id, "failed", "quarantined", "five exits in window", "reconciler");
    const notices = (await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation_notices ?? [];
    assert.deepEqual(notices.map((notice) => notice.kind), ["quarantine_death"]);
    assert.equal(notices[0]?.terminal?.terminal_cause, "crashed", "quarantine escalation carries immutable terminal evidence");
    await daemon.transition(entry.id, "recovering", "coordination_blocked", "active lease needs rebind", "reconciler");
    assert.deepEqual(((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation_notices ?? []).map((notice) => notice.kind), ["quarantine_death", "coordination_escalation"]);
    await stop();
    await daemon.stop();
  } finally { await env.cleanup(); }
});

test("scheduled convergence atomically replaces exit subscriptions and preserves stop/quarantine terminals", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    const listeners = new Map<number, (terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void>();
    let subscriptions = 0;
    const poked: Array<number | null> = [];
    const replacement = { workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" as const };
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: true, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => replacement, attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async (handle) => { poked.push(handle.pid); }, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (handle, listener) => { subscriptions += 1; listeners.set(handle.pid ?? -1, listener); return () => { listeners.delete(handle.pid ?? -1); }; },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    let sequence = 0;
    const input = () => { sequence += 1; return { workAttemptId: "attempt", reconciliationActionId: `generation-${sequence}`, reconciliationActionSequence: sequence, nowMs: Date.now(), lastPollAtMs: 0, addressedMessagesWaiting: 1, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" as const }, resumeFrom: null }; };
    const [stop, sameStop] = await Promise.all([
      daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, input, 100, 5),
      daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, input, 100, 5),
    ]);
    assert.equal(subscriptions, 2, "one initial listener is atomically replaced by the spawned child listener");
    assert.equal(listeners.has(1), false, "the superseded child listener is removed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(poked.every((pid) => pid === 2) && poked.length > 0, "later scheduler ticks target the installed replacement, not input's stale handle");
    await stop(); await sameStop();

    await daemon.transition(entry.id, "working", "quarantined", "already quarantined", "test");
    await daemon.observeProviderExit(entry.id, { endedAt: "late", exitCode: 9, signal: "SIGKILL", terminalCause: "killed", providerContinuationId: null });
    const late = (await new ManifestStore(manifestPath).load()).entries[0]!;
    assert.equal(late.condition, "quarantined");
    assert.equal(late.reconciliation_notices?.at(-1)?.terminal?.terminal_cause, "killed");
    await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("a slow old replacement registration cannot overwrite a newer child listener", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    const listeners = new Map<number, (terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void>();
    let releaseSecondRegistration!: () => void;
    const secondRegistration = new Promise<void>((resolve) => { releaseSecondRegistration = resolve; });
    let signalSecondRegistration!: () => void;
    const waitingForSecondRegistration = new Promise<void>((resolve) => { signalSecondRegistration = resolve; });
    let spawnCount = 0;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { spawnCount += 1; return { workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" }; },
      attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (handle, listener) => {
        if (handle.pid === 2) { signalSecondRegistration(); await secondRegistration; }
        listeners.set(handle.pid ?? -1, listener);
        return () => { listeners.delete(handle.pid ?? -1); };
      },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    let sequence = 0;
    const input = () => { sequence += 1; return { workAttemptId: "attempt", reconciliationActionId: `g-${sequence}`, reconciliationActionSequence: sequence, nowMs: Date.now() + 10_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }; };
    const scheduled = daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, input, 100, 60_000);
    await within(waitingForSecondRegistration, "the blocked second listener registration");
    listeners.get(1)?.({ endedAt: "early", exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: null });
    releaseSecondRegistration();
    const stop = await within(scheduled, "the first scheduled convergence");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(spawnCount, 1, "a superseded child terminal cannot launch a second replacement");
    assert.deepEqual([...listeners.keys()], [2], "the promoted replacement is the only subscribed child");
    await eventually(async () => ((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation_notices ?? []).some((notice) => notice.cause.includes("stale terminal from superseded")), "durable stale-terminal evidence");
    await stop(); await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("a replacement child terminal callback enters durable convergence", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    let replacementExit: ((terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void) | null = null;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => ({ workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" }), attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (handle, listener) => { if (handle.pid === 2) replacementExit = listener; return () => {}; },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const stop = await daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "g-1", reconciliationActionSequence: 1, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 60_000);
    assert.ok(replacementExit, "the spawned child replaces the initial exit listener");
    replacementExit?.({ endedAt: "later", exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: null });
    await eventually(async () => (await new ManifestStore(manifestPath).load()).entries[0]?.observed_state === "failed", "replacement terminal persistence");
    await stop(); await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("a transient replacement listener failure retries the promoted child without a second spawn", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    let spawnCount = 0;
    let failReplacementListener = true;
    let replacementExit: ((terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void) | null = null;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { spawnCount += 1; return { workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" }; }, attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (handle, listener) => { if (handle.pid === 2 && failReplacementListener) { failReplacementListener = false; throw new Error("transient replacement listener failure"); } if (handle.pid === 2) replacementExit = listener; return () => {}; },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const stop = await daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "g-1", reconciliationActionSequence: 1, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 5);
    await eventually(async () => replacementExit !== null, "replacement listener retry");
    assert.equal(spawnCount, 1);
    replacementExit?.({ endedAt: "later", exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: null });
    await eventually(async () => (await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation?.last_terminal?.ended_at === "later", "replacement exit after listener retry");
    assert.equal(spawnCount, 1);
    await stop(); await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("desired stopped turns every terminal into a clean stopped observation and scheduler setup faults persist", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, desired_state: "stopped", observed_state: "stopping" }]);
    let failSubscribe = true;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }), spawn: async () => { throw new Error("unreachable"); }, attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async () => { if (failSubscribe) throw new Error("listener bridge unavailable"); return () => {}; },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    await daemon.observeProviderExit(entry.id, { endedAt: "now", exitCode: 0, signal: null, terminalCause: "exited", providerContinuationId: null });
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.observed_state, "stopped");
    await assert.rejects(() => daemon!.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "stopped" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "g", reconciliationActionSequence: 1, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 60_000), /listener bridge unavailable/);
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.condition, "coordination_blocked");
    failSubscribe = false;
    let unsubscribedAfterTickFailure = false;
    const tickFailurePort = { ...port, onExit: async () => () => { unsubscribedAfterTickFailure = true; } };
    await daemon.stop();
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", tickFailurePort);
    await daemon.start();
    await assert.rejects(() => daemon!.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "stopped" }, () => { throw new Error("initial tick input failed"); }, 100, 60_000), /initial tick input failed/);
    assert.equal(unsubscribedAfterTickFailure, true, "a post-subscribe initial tick failure removes the listener");
    await daemon.stop();
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const stop = await daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "stopped" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "g2", reconciliationActionSequence: 2, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 60_000);
    await stop(); await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("an intentional stop-turn terminal remains idle without restarting the running lane", async () => {
  const env = await fixture();
  const manifestPath = join(env.root, "manifest.json");
  const executionGenerationId = "stop-turn-generation";
  const stoppedTurnEntry: DaemonManifestEntry = {
    ...entry,
    desired_state: "running",
    observed_state: "working",
    work_attempt_id: "stop-turn-attempt",
    provider_ref: {
      work_attempt_id: "stop-turn-attempt",
      provider_continuation_id: "stop-turn-continuation",
      execution_generation_id: executionGenerationId,
      provider_connection: null,
    },
    last_turn_control_sequence: 1,
    turn_control: {
      action_id: "stop-turn-action",
      action_sequence: 1,
      work_attempt_id: "stop-turn-attempt",
      execution_generation_id: executionGenerationId,
      has_correction: false,
      status: "completed",
      capability: "native_interrupt",
      interrupted: true,
      resumed: false,
      state: "idle",
      stages: ["delivered", "interrupting", "applied"],
      error: null,
      recorded_at: "2026-07-17T06:59:17.996Z",
      updated_at: "2026-07-17T06:59:18.205Z",
    },
  };
  await new ManifestStore(manifestPath).write(0, [stoppedTurnEntry]);
  const daemon = new SupervisorDaemon({
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath,
    auditPath: join(env.root, "audit.jsonl"),
  }, "darwin");
  try {
    await daemon.start();
    await daemon.observeProviderExit(stoppedTurnEntry.id, {
      endedAt: "2026-07-17T06:59:18.205Z",
      exitCode: 0,
      signal: null,
      terminalCause: "stopped",
      providerContinuationId: "stop-turn-continuation",
    }, "daemon-provider", executionGenerationId);
    const current = (await new ManifestStore(manifestPath).load()).entries[0]!;
    assert.equal(current.desired_state, "running");
    assert.equal(current.observed_state, "idle");
    assert.equal(current.condition, "none");
    assert.equal(current.last_error, null);
    assert.equal(current.provider_ref?.execution_generation_id, executionGenerationId);
    assert.equal(current.turn_control?.action_id, "stop-turn-action");
    assert.equal(current.reconciliation?.last_terminal?.terminal_cause, "stopped");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("restart recovery quarantines every dispatched turn control regardless of correction strategy", async () => {
  const env = await fixture();
  const manifestPath = join(env.root, "manifest.json");
  const dispatchedControl = (actionId: string, hasCorrection: boolean, correctionStrategy: "native" | "stop_then_resend" | null) => ({
    action_id: actionId,
    action_sequence: 1,
    work_attempt_id: "attempt",
    execution_generation_id: "generation",
    has_correction: hasCorrection,
    correction_text: hasCorrection ? "one correction" : null,
    correction_strategy: correctionStrategy,
    status: "dispatching" as const,
    capability: "native_interrupt" as const,
    interrupted: null,
    resumed: null,
    state: null,
    stages: [] as [],
    error: null,
    recorded_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  });
  await new ManifestStore(manifestPath).write(0, [
    // Stop-only provider on daemon_inbox + a correction ⇒ stop-then-resend.
    { ...entry, id: "resend_agent", room_id: "room-a", provider: "open-model", delivery_mode: "daemon_inbox", work_attempt_id: "attempt", last_turn_control_sequence: 1, turn_control: dispatchedControl("control-resend", true, "stop_then_resend") },
    // Native-correction provider (midTurnCorrection) ⇒ not re-drivable blindly.
    { ...entry, id: "native_agent", room_id: "room-b", provider: "codex", delivery_mode: "daemon_inbox", work_attempt_id: "attempt", last_turn_control_sequence: 1, turn_control: dispatchedControl("control-native", true, "native") },
    // A plain Stop (no correction) is always uncertain after a dispatched crash.
    { ...entry, id: "plain_agent", room_id: "room-c", provider: "open-model", delivery_mode: "daemon_inbox", work_attempt_id: "attempt", last_turn_control_sequence: 1, turn_control: dispatchedControl("control-plain", false, null) },
  ]);
  // Recovery does not re-derive or replay any strategy after native dispatch.
  const port: ProviderActionPort = {
    capabilities: async (_workAttemptId, provider) => ({ deliveryModes: ["daemon_inbox"], resume: true, midTurnInjection: false, midTurnCorrection: provider === "codex", transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true, turnControl: "native_interrupt" }),
    spawn: async () => { throw new Error("unreachable"); }, attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
  };
  const daemon = new SupervisorDaemon({
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath,
    auditPath: join(env.root, "audit.jsonl"),
  }, "darwin", port, false);
  try {
    await daemon.start();
    const byId = new Map((await new ManifestStore(manifestPath).load()).entries.map((candidate) => [candidate.id, candidate.turn_control]));
    // Native Stop may already have applied. The exact payload is durable, but
    // recovery must never replay it against a successor turn.
    assert.equal(byId.get("resend_agent")?.status, "uncertain");
    assert.match(byId.get("resend_agent")?.error ?? "", /predates exact causal target fencing/i);
    // A native correction's provider effect is ambiguous after a crash — uncertain.
    assert.equal(byId.get("native_agent")?.status, "uncertain");
    // A plain Stop (no correction) is likewise uncertain.
    assert.equal(byId.get("plain_agent")?.status, "uncertain");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("restart treats every exact predecessor correction row state as applied evidence without replaying it", async () => {
  const env = await fixture();
  const manifestPath = join(env.root, "legacy-turn-controls.sqlite");
  const makeEntry = (id: string, roomId: string, status: "prepared" | "retryable" | "dispatching" | "uncertain"): DaemonManifestEntry => ({
    ...entry,
    id,
    room_id: roomId,
    provider: "cursor",
    observed_state: "working",
    delivery_mode: "daemon_inbox",
    work_attempt_id: "legacy-attempt",
    provider_ref: {
      work_attempt_id: "legacy-attempt",
      provider_continuation_id: "legacy-cursor-chat",
      execution_generation_id: "legacy-generation",
      provider_connection: { kind: "cursor_cli", pid: 4400, processIdentity: "cursor:4400" },
    },
    last_turn_control_sequence: 1,
    turn_control: {
      action_id: `legacy-${id}`,
      action_sequence: 1,
      work_attempt_id: "legacy-attempt",
      execution_generation_id: "legacy-generation",
      inbox_item_id: null,
      provider_turn_id: null,
      has_correction: true,
      correction_text: null,
      correction_strategy: null,
      status,
      capability: "restart_resume",
      interrupted: null,
      resumed: null,
      state: null,
      stages: [],
      error: null,
      recorded_at: "2026-08-05T00:00:00.000Z",
      updated_at: "2026-08-05T00:00:00.000Z",
    },
  });
  const evidenced = [
    makeEntry("evidence-pending", "legacy-room-pending", "prepared"),
    makeEntry("evidence-active", "legacy-room-active", "retryable"),
    makeEntry("evidence-published", "legacy-room-published", "uncertain"),
    makeEntry("evidence-blocked", "legacy-room-blocked", "dispatching"),
    makeEntry("evidence-cancelled", "legacy-room-cancelled", "uncertain"),
  ];
  const retired = makeEntry("retired", "legacy-room-retired", "retryable");
  const quarantined = makeEntry("quarantined", "legacy-room-quarantined", "uncertain");
  const seedStore = new ManifestStore(manifestPath);
  const seedInbox = new SupervisedAgentInboxStore(manifestPath);
  let daemon: ProductionSupervisorDaemon | null = null;
  try {
    await seedStore.write(0, [...evidenced, retired, quarantined].map((candidate) => ({ ...candidate, turn_control: undefined })));
    const correctionRows = new Map<string, string>();
    for (const candidate of evidenced) {
      const row = await seedInbox.enqueueCorrection({
        agent_id: candidate.id,
        room_id: candidate.room_id,
        source_message_id: `correction:${candidate.turn_control!.action_id}`,
        source_message: { text: `recover exact ${candidate.id}`, sender: { kind: "supervisor_correction" } },
        activation: { decision: "activate", reason: "human_correction", addressed: true },
      });
      correctionRows.set(candidate.id, row.inbox_item_id);
    }
    const activeId = correctionRows.get("evidence-active")!;
    await seedInbox.claimHead("evidence-active");
    const legacyProviderAuthority = {
      work_attempt_id: "legacy-attempt",
      origin_execution_generation_id: "legacy-generation",
      provider_continuation_id: "legacy-cursor-chat",
    } as const;
    await seedInbox.checkpointTurnStarted(activeId, "turn-evidence-active", legacyProviderAuthority);
    const publishedId = correctionRows.get("evidence-published")!;
    await seedInbox.claimHead("evidence-published");
    await seedInbox.checkpointTurnStarted(publishedId, "turn-evidence-published", legacyProviderAuthority);
    await seedInbox.transition(publishedId, "awaiting_result", { outcome: JSON.stringify({ kind: "no_reply" }) });
    await seedInbox.transition(publishedId, "acknowledged_no_reply");
    const blockedId = correctionRows.get("evidence-blocked")!;
    await seedInbox.claimHead("evidence-blocked");
    await seedInbox.transition(blockedId, "blocked", { last_error: "manual recovery" });
    const cancelledId = correctionRows.get("evidence-cancelled")!;
    await seedInbox.transition(cancelledId, "blocked", { last_error: "cancel before recovery" });
    await seedInbox.transition(cancelledId, "cancelled_by_user");
    const expectedStates = new Map(await Promise.all(evidenced.map(async (candidate) => [
      candidate.id,
      (await seedInbox.get(correctionRows.get(candidate.id)!))!.state,
    ] as const)));
    await seedStore.write(1, [...evidenced, retired, quarantined]);
    await seedInbox.close();
    await seedStore.close();

    daemon = new ProductionSupervisorDaemon({
      lockPath: join(env.root, "legacy-turn-controls.lock"),
      socketPath: join(env.root, "legacy-turn-controls.sock"),
      manifestPath,
      auditPath: join(env.root, "legacy-turn-controls.audit.jsonl"),
    }, "darwin", undefined, false);
    await daemon.start();
    const readStore = new ManifestStore(manifestPath);
    const byId = new Map((await readStore.load()).entries.map((candidate) => [candidate.id, candidate]));
    await readStore.close();
    const verifyInbox = new SupervisedAgentInboxStore(manifestPath);
    for (const candidate of evidenced) {
      const recovered = byId.get(candidate.id)!;
      assert.equal(recovered.turn_control?.status, "completed", `${candidate.id} journal is tombstoned`);
      assert.equal(recovered.turn_control?.correction_text, `recover exact ${candidate.id}`);
      assert.equal(recovered.turn_control?.correction_strategy, "stop_then_resend");
      assert.equal(recovered.turn_control?.resumed, true);
      assert.deepEqual(recovered.turn_control?.stages, ["delivered", "applied", "resumed"]);
      assert.equal((await verifyInbox.get(correctionRows.get(candidate.id)!))?.state, expectedStates.get(candidate.id), `${candidate.id} correction row is preserved exactly`);
    }
    await verifyInbox.close();

    assert.equal(byId.get(retired.id)?.turn_control?.status, "uncertain");
    assert.equal(byId.get(retired.id)?.turn_control?.resumed, null);
    assert.deepEqual(byId.get(retired.id)?.turn_control?.stages, []);
    assert.ok(!byId.get(retired.id)?.reconciliation?.completed_action_ids.includes(retired.turn_control!.action_id));
    assert.match(byId.get(retired.id)?.turn_control?.error ?? "", /legacy correction payload is unavailable.*reissue/i);

    assert.equal(byId.get(quarantined.id)?.turn_control?.status, "uncertain");
    assert.equal(byId.get(quarantined.id)?.turn_control?.resumed, null);
    assert.match(byId.get(quarantined.id)?.turn_control?.error ?? "", /legacy correction payload is unavailable.*reissue/i);
  } finally {
    await daemon?.stop().catch(() => undefined);
    await seedInbox.close().catch(() => undefined);
    await seedStore.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("legacy delivery cutover converges across pre-dispatch failure, dispatch crash, uncertainty, and stale generations", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "delivery-cutover.lock"),
    socketPath: join(env.root, "delivery-cutover.sock"),
    manifestPath: join(env.root, "delivery-cutover.sqlite"),
    auditPath: join(env.root, "delivery-cutover.audit.jsonl"),
  };
  const connection = {
    kind: "codex_app_server" as const,
    url: "http://127.0.0.1:47891",
    pid: 47891,
    processIdentity: "codex-cutover-birth",
  };
  const handles = new Map<string, {
    workAttemptId: string;
    pid: number;
    providerContinuationId: string;
    providerConnection: typeof connection;
    observedState: "working";
  }>();
  const controlTargets = new Map<string, Array<string | null>>();
  const inspectTargets = new Map<string, string[]>();
  const retryCalls = new Map<string, number>();
  const port: ProviderActionPort = {
    capabilities: async () => ({
      deliveryModes: ["mcp_polling", "daemon_inbox"], resume: true, midTurnInjection: false,
      transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true,
    }),
    spawn: async () => { throw new Error("cutover test must not spawn"); },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("cutover test must not resume"); },
    poke: async () => {},
    stop: async () => { throw new Error("cutover test never stops the provider process"); },
    onExit: async () => () => {},
    onStream: async () => () => {},
    inspectTurn: async (handle, turnId) => {
      const id = handle.workAttemptId;
      inspectTargets.set(id, [...(inspectTargets.get(id) ?? []), turnId]);
      if (id === "attempt-dispatch-crash") {
        return (inspectTargets.get(id)?.length ?? 0) === 1 ? "active" : "terminal";
      }
      if (id === "attempt-uncertain") return "terminal";
      return "unknown";
    },
    controlExactTurn: async (handle, options) => {
      const id = handle.workAttemptId;
      controlTargets.set(id, [...(controlTargets.get(id) ?? []), options.targetTurnId ?? null]);
      if (id === "attempt-retryable") {
        const call = (retryCalls.get(id) ?? 0) + 1;
        retryCalls.set(id, call);
        await options.checkpointTargetTurn("turn-retryable-A");
        if (call === 1) throw new Error("transient failure before native dispatch");
        await options.markDispatched();
        return { outcome: "terminal", targetTurnId: "turn-retryable-A" };
      }
      if (id === "attempt-dispatch-crash") {
        assert.equal(options.targetTurnId, "turn-dispatch-A");
        await options.checkpointTargetTurn("turn-dispatch-A");
        await options.markDispatched();
        return { outcome: "interrupt_dispatched", targetTurnId: "turn-dispatch-A" };
      }
      throw new Error(`unexpected cutover control for ${id}`);
    },
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      store: ManifestStore;
      durability: WorkDurabilityStore & { getAttempt: (workAttemptId: string) => Promise<unknown> };
      liveHandles: Map<string, (typeof handles extends Map<string, infer T> ? T : never)>;
      requestConvergence: (entryId: string) => void;
      scheduleDeliveryCutoverRetry: (entryId: string, delayMs: number) => void;
      deliveryCutovers: { start: (entryId: string) => Promise<void> };
    };
    internals.requestConvergence = () => {};
    // Timers are an availability mechanism, not part of these state-machine
    // assertions. Drive retries explicitly so every crash edge is deterministic.
    internals.scheduleDeliveryCutoverRetry = () => {};
    const liveEntry = (
      id: string,
      workAttemptId: string,
      executionGenerationId: string,
      providerContinuationId: string,
      deliveryCutover?: DaemonManifestEntry["delivery_cutover"],
    ): DaemonManifestEntry => ({
      ...entry,
      id,
      provider: "codex",
      delivery_mode: "mcp_polling",
      observed_state: "working",
      work_attempt_id: workAttemptId,
      provider_ref: {
        work_attempt_id: workAttemptId,
        execution_generation_id: executionGenerationId,
        provider_continuation_id: providerContinuationId,
        provider_connection: connection,
      },
      delivery_cutover: deliveryCutover,
    });
    const installLive = async (candidate: DaemonManifestEntry) => {
      assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: candidate })).ok, true);
      const ref = candidate.provider_ref!;
      const handle = {
        workAttemptId: candidate.work_attempt_id!, pid: connection.pid,
        providerContinuationId: ref.provider_continuation_id,
        providerConnection: connection, observedState: "working" as const,
      };
      handles.set(candidate.id, handle);
      internals.liveHandles.set(candidate.id, handle);
    };

    const retryable = liveEntry("cutover-retryable", "attempt-retryable", "run-retryable", "thread-retryable");
    await installLive(retryable);
    await internals.deliveryCutovers.start(retryable.id);
    let saved = await internals.store.getEntry(retryable.id);
    assert.equal(saved?.delivery_mode ?? "mcp_polling", "mcp_polling");
    assert.equal(saved?.delivery_cutover?.phase, "retryable");
    assert.equal(saved?.delivery_cutover?.provider_turn_id, "turn-retryable-A");
    await internals.deliveryCutovers.start(retryable.id);
    saved = await internals.store.getEntry(retryable.id);
    assert.equal(saved?.delivery_mode, "daemon_inbox", "a pre-dispatch failure retries and completes without operator repair");
    assert.equal(saved?.delivery_cutover ?? null, null);
    assert.deepEqual(controlTargets.get("attempt-retryable"), [null, "turn-retryable-A"], "retry never rediscovers or retargets A");

    const dispatchCrash = liveEntry("cutover-dispatch-crash", "attempt-dispatch-crash", "run-dispatch", "thread-dispatch", {
      work_attempt_id: "attempt-dispatch-crash", execution_generation_id: "run-dispatch",
      provider_continuation_id: "thread-dispatch", provider_turn_id: "turn-dispatch-A",
      phase: "dispatching", error: null, updated_at: "2026-08-05T12:00:00.000Z",
    });
    await installLive(dispatchCrash);
    await internals.deliveryCutovers.start(dispatchCrash.id);
    saved = await internals.store.getEntry(dispatchCrash.id);
    assert.equal(saved?.delivery_mode, "daemon_inbox", "dispatching recovery re-inspects and safely redrives exact active A");
    assert.deepEqual(inspectTargets.get("attempt-dispatch-crash"), ["turn-dispatch-A", "turn-dispatch-A"]);
    assert.deepEqual(controlTargets.get("attempt-dispatch-crash"), ["turn-dispatch-A"]);

    const uncertain = liveEntry("cutover-uncertain", "attempt-uncertain", "run-uncertain", "thread-uncertain", {
      work_attempt_id: "attempt-uncertain", execution_generation_id: "run-uncertain",
      provider_continuation_id: "thread-uncertain", provider_turn_id: "turn-uncertain-A",
      phase: "uncertain", error: "response lost", updated_at: "2026-08-05T12:01:00.000Z",
    });
    await installLive(uncertain);
    await internals.deliveryCutovers.start(uncertain.id);
    saved = await internals.store.getEntry(uncertain.id);
    assert.equal(saved?.delivery_mode, "daemon_inbox", "terminal inspection converges an ambiguous dispatch without replay");
    assert.deepEqual(inspectTargets.get("attempt-uncertain"), ["turn-uncertain-A"]);
    assert.equal(controlTargets.has("attempt-uncertain"), false);

    const terminalAttempts = new Set(["attempt-stale", "attempt-detached"]);
    internals.durability.getAttempt = async (workAttemptId: string) => terminalAttempts.has(workAttemptId) ? ({
      execution_generations: [{
        execution_generation_id: workAttemptId === "attempt-stale" ? "run-old" : "run-detached",
        terminal: { terminal_cause: "process_exit" },
      }],
    }) : null;
    const stale = liveEntry("cutover-stale", "attempt-successor", "run-successor", "thread-successor", {
      work_attempt_id: "attempt-stale", execution_generation_id: "run-old",
      provider_continuation_id: "thread-old", provider_turn_id: "turn-old-A",
      phase: "uncertain", error: "old response lost", updated_at: "2026-08-05T12:02:00.000Z",
    });
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: stale })).ok, true);
    await internals.deliveryCutovers.start(stale.id);
    saved = await internals.store.getEntry(stale.id);
    assert.equal(saved?.delivery_mode ?? "mcp_polling", "mcp_polling", "a terminal stale generation cannot flip a successor runtime's ingress owner");
    assert.equal(saved?.delivery_cutover ?? null, null);
    assert.equal(saved?.provider_ref?.execution_generation_id, "run-successor");

    const detached: DaemonManifestEntry = {
      ...entry, id: "cutover-detached", provider: "codex", delivery_mode: "mcp_polling",
      observed_state: "failed", work_attempt_id: "attempt-detached", provider_ref: undefined,
      delivery_cutover: {
        work_attempt_id: "attempt-detached", execution_generation_id: "run-detached",
        provider_continuation_id: "thread-detached", provider_turn_id: "turn-detached-A",
        phase: "uncertain", error: "daemon crashed", updated_at: "2026-08-05T12:03:00.000Z",
      },
    };
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: detached })).ok, true);
    await internals.deliveryCutovers.start(detached.id);
    saved = await internals.store.getEntry(detached.id);
    assert.equal(saved?.delivery_mode, "daemon_inbox", "terminal durability closes a detached cutover instead of leaving a permanent tombstone");
    assert.equal(saved?.delivery_cutover ?? null, null);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("simulated flock reacquires the persistent lock inode after release", async () => {
  const env = await fixture();
  const lock = join(env.root, "daemon.lock");
  const first = new DaemonSingleton(lock, "darwin");
  const second = new DaemonSingleton(lock, "darwin");
  try {
    assert.equal(await first.acquire(), 1);
    await assert.rejects(() => second.acquire(), DaemonAlreadyRunningError);
    await first.release();
    assert.equal((await stat(lock)).isFile(), true);
    assert.equal(await second.acquire(), 2);
  } finally {
    await second.release();
    await first.release();
    await env.cleanup();
  }
});

test("singleton fences a second daemon and detects a newer generation", async () => {
  const env = await fixture();
  try {
    const lock = join(env.root, "daemon.lock");
    const first = new DaemonSingleton(lock, "darwin");
    assert.equal(await first.acquire(), 1);
    await assert.rejects(() => new DaemonSingleton(lock, "darwin").acquire(), DaemonAlreadyRunningError);
    await writeFile(`${lock}.generation`, "2\n");
    await assert.rejects(() => first.assertCurrent(), DaemonFenceLostError);
    await first.release();
    assert.equal((await stat(lock)).isFile(), true, "persistent inode prevents post-release unlink races");
    await writeFile(`${lock}.generation`, "partial");
    const second = new DaemonSingleton(join(env.root, "second.lock"), "darwin");
    await second.acquire();
    await writeFile(`${join(env.root, "second.lock")}.generation`, "partial");
    await assert.rejects(() => second.assertCurrent(), /malformed/);
    await second.release();
  } finally { await env.cleanup(); }
});

test("manifest SQLite writes use generation CAS across concurrent callers", async () => {
  const env = await fixture();
  try {
    const path = join(env.root, "manifest.json");
    const store = new ManifestStore(path);
    const saved = await store.write(0, [entry]);
    assert.equal(saved.generation, 1);
    await assert.rejects(() => store.write(0, []), ManifestConflictError);
    const concurrent = await Promise.allSettled([store.write(1, [{ ...entry, id: "left" }]), store.write(1, [{ ...entry, id: "right" }])]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "rejected" && result.reason instanceof ManifestConflictError).length, 1);
    assert.equal((await store.load()).generation, 2);
    await store.close();
  } finally { await env.cleanup(); }
});

test("audit transitions append and rotate instead of truncating", async () => {
  const env = await fixture();
  try {
    const path = join(env.root, "audit.jsonl");
    const log = new AuditLog(path, 1);
    await log.append({ at: "2026-01-01T00:00:00.000Z", entry_id: "agent", from: "idle", to: "recovering", cause: "test", actor: "test", generation: 1 });
    const canary = "canary-not-a-real-audit-secret-123456789";
    await log.append({ at: "2026-01-01T00:00:01.000Z", entry_id: "agent", from: "recovering", to: "idle", cause: `Authorization: Bearer ${canary}`, actor: "test", generation: 2 });
    const names = await readdir(env.root);
    assert.ok(names.some((name) => name.startsWith("audit.jsonl.") && name.endsWith(".archive")));
    assert.match(await readFile(path, "utf8"), /"generation":2/);
    assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(canary));
    assert.match(await readFile(path, "utf8"), /REDACTED/);
  } finally { await env.cleanup(); }
});

test("daemon lifecycle diagnostics are private, redacted, and strictly bounded", async () => {
  const env = await fixture();
  try {
    const path = join(env.root, "daemon-lifecycle.jsonl");
    const canary = "canary-not-a-real-lifecycle-secret-123456789";
    const first = new DaemonLifecycleLog(path, 1);
    first.append({ event: "daemon_starting" });
    first.close();
    const second = new DaemonLifecycleLog(path, 1);
    second.append({
      event: "fatal_exception",
      detail: `Authorization: Bearer ${canary}`,
    });
    second.close();

    assert.equal((await stat(env.root)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await readdir(env.root)).filter((name) => name.startsWith("daemon-lifecycle.jsonl")).length, 2);
    const current = await readFile(path, "utf8");
    assert.match(current, /"event":"fatal_exception"/);
    assert.match(current, /REDACTED/);
    assert.doesNotMatch(current, new RegExp(canary));
  } finally { await env.cleanup(); }
});

test("daemon lifecycle diagnostics never become a startup dependency", async () => {
  const env = await fixture();
  try {
    const blockedPath = join(env.root, "not-a-directory");
    await writeFile(blockedPath, "occupied", "utf8");
    assert.doesNotThrow(() => {
      const lifecycle = new DaemonLifecycleLog(join(blockedPath, "daemon-lifecycle.jsonl"));
      lifecycle.append({ event: "daemon_starting" });
      lifecycle.close();
    });
  } finally { await env.cleanup(); }
});

test("daemon lifecycle diagnostics retain nested aggregate causes", () => {
  const detail = daemonLifecycleErrorDetail(new AggregateError([
    new Error("provider cleanup failed", { cause: new Error("socket was closed") }),
    new Error("workspace cleanup failed"),
  ], "Supervisor handoff cleanup did not complete cleanly"));
  assert.match(detail, /Supervisor handoff cleanup did not complete cleanly/);
  assert.match(detail, /provider cleanup failed/);
  assert.match(detail, /socket was closed/);
  assert.match(detail, /workspace cleanup failed/);
});

test("control socket rejects protocol mismatch explicitly", async () => {
  const env = await fixture();
  try {
    const socketPath = join(env.root, "daemon.sock");
    const socket = new DaemonControlSocket(socketPath, () => ({ healthy: true }));
    await chmod(env.root, 0o755);
    await socket.start();
    assert.equal((await stat(env.root)).mode & 0o777, 0o700);
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    const response = await new Promise<string>((resolve, reject) => {
      const client = createConnection(socketPath);
      let received = "";
      client.setEncoding("utf8");
      client.once("error", reject);
      client.on("data", (chunk) => { received += chunk; if (received.includes("\n")) { client.end(); resolve(received); } });
      client.on("connect", () => client.write(JSON.stringify({ version: DAEMON_PROTOCOL_VERSION + 1, id: "bad", method: "manifest.list" }) + "\n"));
    });
    assert.match(response, /Protocol version mismatch/);
    await socket.stop();
  } finally { await env.cleanup(); }
});

test("lifecycle handlers advertise support and reject coercible or imprecise coordinates", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const status = (await daemonRequest(paths.socketPath, "daemon.negotiate")).result as {
      generation: number;
      capabilities: { agent_lifecycle_v1: boolean };
    };
    assert.equal(status.capabilities.agent_lifecycle_v1, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "strict-lifecycle",
      desired_state: "stopped",
      observed_state: "stopped",
    } })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "retire-live-authority",
      delivery_mode: "daemon_inbox",
      desired_state: "stopped",
      observed_state: "stopped",
    } })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "retire-never-minted",
      delivery_mode: "daemon_inbox",
      desired_state: "stopped",
      observed_state: "stopped",
    } })).ok, true);
    const workerBindings = (daemon as unknown as { workerBindings: WorkerBindingStore }).workerBindings;
    await workerBindings.beginSupervisedWorkerSessionMint({
      agent_id: "retire-live-authority",
      room_id: entry.room_id,
      agent_instance_id: "daemon:retire-live-authority",
    });
    await workerBindings.recordExactSupervisedWorkerSessionMint({
      agent_id: "retire-live-authority",
      room_id: entry.room_id,
      agent_instance_id: "daemon:retire-live-authority",
      agent_session_id: "session-to-retire",
    });

    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: 123,
      desired_state: "running",
    })).ok, false, "numeric identities are never coerced into lifecycle coordinates");
    assert.equal((await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "strict-lifecycle",
      expected_desired_state: true,
      desired_state: "running",
    })).ok, false, "boolean states are never string-coerced");
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.retire_agent", {
      entry_id: "strict-lifecycle",
      daemon_generation: String(status.generation),
    })).ok, false, "generation strings are never number-coerced");
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.purge_agent", {
      entry_id: " strict-lifecycle",
      daemon_generation: status.generation,
      revoked_agent_session_id: null,
    })).ok, false, "whitespace-altered identities are rejected at the socket boundary");
    const retirementRequired = await daemonRequest(paths.socketPath, "supervisor.retire_agent", {
      entry_id: "retire-live-authority",
      daemon_generation: status.generation,
      revoked_agent_session_id: null,
      grant_revoked_without_worker_session: false,
    });
    assert.equal(retirementRequired.ok, true, retirementRequired.error);
    assert.deepEqual(retirementRequired.result, {
      outcome: "revocation_required",
      revocation_kind: "worker_session",
      agent_session_id: "session-to-retire",
    });
    const retired = await daemonRequest(paths.socketPath, "supervisor.retire_agent", {
      entry_id: "retire-live-authority",
      daemon_generation: status.generation,
      revoked_agent_session_id: "session-to-retire",
      grant_revoked_without_worker_session: false,
    });
    assert.equal(retired.ok, true, retired.error);
    assert.equal((retired.result as { outcome: string }).outcome, "retired");
    assert.equal(await workerBindings.supervisedWorkerSession("retire-live-authority"), null);
    assert.equal(await workerBindings.supervisedWorkerMintState("retire-live-authority"), null);

    const neverMintedRetirement = await daemonRequest(paths.socketPath, "supervisor.retire_agent", {
      entry_id: "retire-never-minted",
      daemon_generation: status.generation,
      revoked_agent_session_id: null,
      grant_revoked_without_worker_session: false,
    });
    assert.equal(neverMintedRetirement.ok, true, neverMintedRetirement.error);
    assert.deepEqual(neverMintedRetirement.result, {
      outcome: "revocation_required",
      revocation_kind: "grant_only",
    });
    const neverMintedRetired = await daemonRequest(paths.socketPath, "supervisor.retire_agent", {
      entry_id: "retire-never-minted",
      daemon_generation: status.generation,
      revoked_agent_session_id: null,
      grant_revoked_without_worker_session: true,
    });
    assert.equal(neverMintedRetired.ok, true, neverMintedRetired.error);
    assert.equal((neverMintedRetired.result as { outcome: string }).outcome, "retired");

    const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])
      .find((candidate) => candidate.id === "strict-lifecycle")!;
    assert.equal(current.id, "strict-lifecycle");
    assert.equal(current.desired_state, "stopped");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("cross-version negotiation is allowed before a generation handoff", async () => {
  const env = await fixture();
  try {
    const socketPath = join(env.root, "daemon.sock");
    const socket = new DaemonControlSocket(socketPath, (request) => request.method === "daemon.negotiate"
      ? { healthy: true, protocol_version: DAEMON_PROTOCOL_VERSION, generation: 9 }
      : { ok: true });
    await socket.start();
    const response = await daemonRequest(socketPath, "daemon.negotiate", undefined, DAEMON_PROTOCOL_VERSION + 1);
    assert.equal(response.ok, true);
    assert.equal((response.result as { generation: number }).generation, 9);
    await socket.stop();
  } finally { await env.cleanup(); }
});

test("normal daemon shutdown drains an admitted bounded-effect journal mutation before closing shared stores", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  let stopped = false;
  try {
    await daemon.start();
    let releaseJournal!: () => void;
    const journalGate = new Promise<void>((resolve) => { releaseJournal = resolve; });
    const admittedJournal = (daemon as unknown as {
      reserveBoundedEffectJournal: <T>(operation: () => Promise<T>) => Promise<T>;
    }).reserveBoundedEffectJournal(() => journalGate);
    const stopping = daemon.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(stopped, false, "shutdown cannot close SQLite while an admitted effect mutation is unresolved");
    releaseJournal();
    await admittedJournal;
    await within(stopping, "normal shutdown effect-journal drain", 1_000);
    assert.equal(stopped, true);
  } finally {
    if (!stopped) await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("version handoff releases authority without waiting for wedged callbacks and preserves provider work", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  const first = new SupervisorDaemon(paths, "darwin");
  let second: SupervisorDaemon | null = null;
  const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await first.start();
    const never = new Promise<void>(() => {});
    const internals = first as unknown as {
      providerStreams: { callbacks: Set<Promise<void>> };
    };
    internals.providerStreams.callbacks.add(never);

    const handoff = first.waitForHandoff();
    const prepared = await daemonRequest(paths.socketPath, "daemon.prepare_handoff");
    assert.equal(prepared.ok, true);
    await within(handoff, "handoff completion after authority cleanup", 1_000);
    second = new SupervisorDaemon(paths, "darwin");
    await within((async () => {
      while (true) {
        try { await second!.start(); return; }
        catch (error) {
          if (!(error instanceof DaemonAlreadyRunningError)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    })(), "replacement daemon authority after handoff", 1_000);
    assert.doesNotThrow(() => process.kill(provider.pid!, 0), "handoff detaches daemon observers without killing provider work");
  } finally {
    await second?.stop();
    provider.kill("SIGKILL");
    await env.cleanup();
  }
});

test("handoff observer cleanup failures still release socket, singleton, and SQLite authority", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  const first = new SupervisorDaemon(paths, "darwin");
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    (first as unknown as {
      providerStreams: {
        listenerLeases: Map<string, {
          handle: unknown;
          executionGenerationId: string;
          disposers: Array<() => void>;
        }>;
      };
    }).providerStreams.listenerLeases.set("throws", {
      handle: {},
      executionGenerationId: "generation-injected",
      disposers: [() => { throw new Error("injected observer disposal failure"); }],
    });
    const handoff = first.waitForHandoff();
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    await assert.rejects(within(handoff, "failed handoff completion", 1_000), /handoff cleanup did not complete cleanly/i);

    second = new SupervisorDaemon(paths, "darwin");
    await within(second.start(), "replacement authority after failed observer cleanup", 1_000);
    assert.equal(((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation, 2);
  } finally {
    await second?.stop();
    await env.cleanup();
  }
});

test("the daemon entrypoint exits after a completed handoff instead of retaining ref-counted handles", {
  skip: process.platform !== "darwin" ? "the production daemon entrypoint is macOS-only" : false,
}, async () => {
  const env = await fixture();
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "daemon/main.ts")], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: env.root },
    stdio: "ignore",
  });
  try {
    const socketPath = join(env.root, ".letagents", "daemon.sock");
    await eventually(async () => {
      try {
        return (await daemonRequest(socketPath, "daemon.status")).ok;
      } catch {
        // The entrypoint is still acquiring its singleton and SQLite state.
        return false;
      }
    }, "daemon entrypoint startup", 2_000);
    assert.equal((await daemonRequest(socketPath, "daemon.prepare_handoff")).ok, true);
    const exited = await within(new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }), "daemon entrypoint exit after handoff", 2_000);
    assert.deepEqual(exited, { code: 0, signal: null });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await within(exited, "daemon entrypoint cleanup", 1_000).catch(() => undefined);
    }
    await env.cleanup();
  }
});

test("SIGTERM after authority release uses default process-only termination and preserves detached providers", async () => {
  const env = await fixture();
  const mainPath = join(process.cwd(), "daemon/main.ts");
  const singletonPath = join(process.cwd(), "daemon/singleton.ts");
  const script = `
    import { spawn } from "node:child_process";
    const [{ SupervisorDaemon }, { defaultDaemonPaths }] = await Promise.all([
      import(${JSON.stringify(mainPath)}),
      import(${JSON.stringify(singletonPath)}),
    ]);
    const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    provider.unref();
    const daemon = new SupervisorDaemon(defaultDaemonPaths(), "darwin");
    // This process-lifecycle fixture has no Electron signing custodian.
    await daemon.start({ getHostApprovalPublicKey: async () => null });
    process.send({ type: "ready", providerPid: provider.pid });
    await daemon.waitForHandoff();
    process.send({ type: "authority_released", providerPid: provider.pid });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: env.root },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let providerPid: number | null = null;
  const waitForMessage = (type: string) => within(new Promise<Record<string, unknown>>((resolve) => {
    const listener = (message: unknown) => {
      if ((message as { type?: string })?.type !== type) return;
      child.off("message", listener);
      resolve(message as Record<string, unknown>);
    };
    child.on("message", listener);
  }), `child message ${type}`, 2_000);
  try {
    const ready = await waitForMessage("ready");
    providerPid = Number(ready.providerPid);
    const socketPath = join(env.root, ".letagents", "daemon.sock");
    assert.equal((await daemonRequest(socketPath, "daemon.prepare_handoff")).ok, true);
    await waitForMessage("authority_released");
    await assert.rejects(daemonRequest(socketPath, "daemon.status"));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child.kill("SIGTERM");
    assert.deepEqual(await within(exited, "SIGTERM exit after authority release", 1_000), { code: null, signal: "SIGTERM" });
    assert.doesNotThrow(() => process.kill(providerPid!, 0), "daemon SIGTERM does not initiate provider cleanup");
  } finally {
    child.kill("SIGKILL");
    if (providerPid && Number.isSafeInteger(providerPid)) {
      try { process.kill(providerPid, "SIGKILL"); } catch { /* already gone */ }
    }
    await env.cleanup();
  }
});

test("prepare_handoff fences a mutation admitted before an asynchronous request barrier", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  let releaseMutation!: () => void;
  const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
  let mutationReached!: () => void;
  const reachedMutation = new Promise<void>((resolve) => { mutationReached = resolve; });
  const daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, async (request) => {
    if (request.method !== "manifest.put") return;
    mutationReached();
    await mutationGate;
  });
  try {
    await daemon.start();
    const lateMutation = daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...entry, id: "admitted_before_handoff" },
    });
    await reachedMutation;
    const handoff = daemon.waitForHandoff();
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    releaseMutation();
    const rejected = await lateMutation;
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? "", /handoff has fenced new daemon mutations/i);
    await within(handoff, "barrier-fenced handoff", 1_000);

    const reopened = new ManifestStore(paths.manifestPath);
    try {
      assert.equal((await reopened.load()).entries.some((candidate) => candidate.id === "admitted_before_handoff"), false);
    } finally {
      await reopened.close();
    }
  } finally {
    releaseMutation();
    await env.cleanup();
  }
});

test("host approval socket operations require the enrolled signer and remain fenced across handoff", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl") };
  const host = generateKeyPairSync("ed25519"); const outsider = generateKeyPairSync("ed25519");
  let enrollments = 0; let fenceRequests = false; let arrivals = 0;
  let releaseRequests!: () => void; const gate = new Promise<void>(resolve => { releaseRequests = resolve; });
  let bothArrived!: () => void; const entered = new Promise<void>(resolve => { bothArrived = resolve; });
  // No provider port: enrolling host auth or listing an empty room must not launch native work.
  const daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, async request => {
    if (!fenceRequests || request.method !== "supervisor.host_approval_request") return;
    if (++arrivals === 2) bothArrived();
    await gate;
  });
  try {
    await daemon.start({ getHostApprovalPublicKey: async () => {
      enrollments += 1; return host.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    } });
    const challengeReply = await daemonRequest(paths.socketPath, "supervisor.host_approval_challenge");
    assert.equal(challengeReply.ok, true, challengeReply.error);
    const challenge = challengeReply.result as HostApprovalChallenge;
    assert.ok(challenge.keyFingerprint, "trusted startup enrollment must expose its challenge");
    assert.equal(enrollments, 1);
    const signed = (operation: HostApprovalOperation, input: unknown, key = host.privateKey) => {
      const issuedAt = Date.now();
      const payload = JSON.stringify({ domain: "letagents.host-approval", version: 1, ...challenge,
        operation, input, issuedAt, expiresAt: issuedAt + 30_000 });
      return { payload, signature: sign(null, Buffer.from(payload), key).toString("base64") };
    };
    for (const operation of ["list", "decide"] as const) {
      const input = operation === "list" ? { roomId: "room_1" } : { actorId: `host-${challenge.keyFingerprint}` };
      for (const envelope of [{ operation, input }, signed(operation, input, outsider.privateKey)]) {
        const refused = await daemonRequest(paths.socketPath, "supervisor.host_approval_request", envelope);
        assert.equal(refused.ok, false); assert.match(refused.error ?? "", /could not be authenticated/);
      }
    }
    const listed = await daemonRequest(paths.socketPath, "supervisor.host_approval_request", signed("list", { roomId: "room_1" }));
    assert.equal(listed.ok, true, listed.error); assert.deepEqual(listed.result, []);
    const wrongActor = await daemonRequest(paths.socketPath, "supervisor.host_approval_request", signed("decide", { actorId: "other-host" }));
    assert.equal(wrongActor.ok, false); assert.match(wrongActor.error ?? "", /actor is not the enrolled host/);
    assert.deepEqual((await daemonRequest(paths.socketPath, "manifest.list")).result, [], "auth operations leave runtime and permission defaults untouched");

    fenceRequests = true;
    const pending = [
      daemonRequest(paths.socketPath, "supervisor.host_approval_request", signed("list", { roomId: "room_1" })),
      daemonRequest(paths.socketPath, "supervisor.host_approval_request", signed("decide", { actorId: `host-${challenge.keyFingerprint}` })),
    ];
    await within(entered, "both signed approval operations admitted before handoff");
    const handoff = daemon.waitForHandoff();
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    releaseRequests();
    for (const rejected of await Promise.all(pending)) {
      assert.equal(rejected.ok, false); assert.match(rejected.error ?? "", /handoff has fenced new daemon mutations/i);
    }
    await within(handoff, "host approval handoff", 1_000);
  } finally {
    releaseRequests(); await daemon.stop().catch(() => undefined); await env.cleanup();
  }
});

test("credential-only reconnect rejects a missing exact provider without retaining a grant or converging", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  const calls = { spawn: 0, resume: 0, stop: 0, converge: 0 };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { calls.spawn += 1; throw new Error("reconnect must not spawn"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { calls.resume += 1; throw new Error("reconnect must not resume"); }, poke: async () => {},
    stop: async () => { calls.stop += 1; throw new Error("reconnect must not stop"); },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => { throw new Error("reconnect must not mint without an exact live provider"); },
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as { workerRuntimeCustody: WorkerRuntimeCustody; requestConvergence: (entryId: string) => void };
    internals.requestConvergence = () => { calls.converge += 1; };
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "credential_only_missing_provider", provider: "codex", delivery_mode: "daemon_inbox",
      desired_state: "paused", observed_state: "absent",
    } });
    calls.converge = 0;
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const result = await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "credential_only_missing_provider", room_id: entry.room_id, agent_key: "owner/agent",
      grant_id: "grant-reconnect", supervisor_grant: "reconnect-secret", grant_generation: 1,
      api_url: "https://letagents.example", host_id: "host-1", installation_id: "installation-1",
      grant_expires_at: "2099-01-01T00:00:00.000Z", daemon_generation: generation, credential_only: true,
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result, { status: "provider_unavailable" });
    assert.equal(internals.workerRuntimeCustody.hostGrant("credential_only_missing_provider"), undefined, "a rejected reconnect cannot become usable later");
    assert.deepEqual(calls, { spawn: 0, resume: 0, stop: 0, converge: 0 });
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("recovery-only authority install retains the grant without touching the dead provider or converging", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  const calls = { attach: 0, spawn: 0, resume: 0, stop: 0, converge: 0 };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { calls.spawn += 1; throw new Error("authority preparation must not spawn"); },
    attach: async () => { calls.attach += 1; throw new Error("authority preparation must not attach"); },
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { calls.resume += 1; throw new Error("authority preparation must not resume"); },
    poke: async () => {},
    stop: async () => { calls.stop += 1; throw new Error("authority preparation must not stop"); },
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      workerRuntimeCustody: WorkerRuntimeCustody;
      requestConvergence: (entryId: string) => void;
    };
    internals.requestConvergence = () => { calls.converge += 1; };
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "recovery_authority_dead_provider", provider: "open-model", delivery_mode: "daemon_inbox",
      desired_state: "running", observed_state: "failed",
    } });
    calls.converge = 0;
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const result = await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "recovery_authority_dead_provider", room_id: entry.room_id, agent_key: "owner/agent",
      grant_id: "grant-recovery", supervisor_grant: "recovery-secret", grant_generation: 1,
      api_url: "https://letagents.example", host_id: "host-1", installation_id: "installation-1",
      grant_expires_at: "2099-01-01T00:00:00.000Z", daemon_generation: generation, recovery_only: true,
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result, { status: "installed" });
    assert.ok(internals.workerRuntimeCustody.hostGrant("recovery_authority_dead_provider"));
    assert.deepEqual(calls, { attach: 0, spawn: 0, resume: 0, stop: 0, converge: 0 });
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("explicit runtime recovery retires a proven-dead provider generation without replacing the durable agent", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const id = "recover_dead_opencode_runtime";
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(
    paths.attemptsPath,
    paths.attemptsRoot,
    undefined,
    join(env.root, "worktrees"),
    undefined,
    fakeGit(env.root),
    undefined,
    TEST_SUPERVISOR,
  );
  const attempt = await durability.createAttempt({
    taskId: id,
    leaseId: id,
    leaseEpoch: 0,
    workspacePath: workspace.path,
    workAttemptId: workspace.id,
  });
  const execution = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
  await durability.close();
  const calls = { attach: 0, spawn: 0, resume: 0, converge: 0 };
  const port: ProviderActionPort = {
    capabilities: async () => ({
      deliveryModes: ["daemon_inbox"],
      resume: true,
      midTurnInjection: false,
      transcriptAccess: true,
      permissionPromptBridging: false,
      survivesRestart: true,
    }),
    spawn: async () => { calls.spawn += 1; throw new Error("recovery converges only after the RPC returns"); },
    attach: async (ref) => {
      calls.attach += 1;
      assert.equal(ref.workAttemptId, attempt.work_attempt_id);
      assert.equal(ref.providerContinuationId, "ses_dead_opencode");
      return {
        state: "terminal",
        terminal: {
          endedAt: "2099-07-29T12:00:00.000Z",
          exitCode: 1,
          signal: null,
          terminalCause: "crashed",
          providerContinuationId: "ses_dead_opencode",
        },
      };
    },
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { calls.resume += 1; throw new Error("recovery must not resume the dead provider"); },
    poke: async () => {},
    stop: async () => ({
      endedAt: "2099-07-29T12:00:00.000Z",
      exitCode: 1,
      signal: null,
      terminalCause: "crashed",
      providerContinuationId: "ses_dead_opencode",
    }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }),
    publish: async () => {},
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as { requestConvergence: (entryId: string) => void };
    internals.requestConvergence = (entryId) => {
      assert.equal(entryId, id);
      calls.converge += 1;
    };
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id,
      provider: "open-model",
      delivery_mode: "daemon_inbox",
      desired_state: "running",
      observed_state: "recovering",
      condition: "coordination_blocked",
      last_error: "convergence scheduler failure: The saved OpenCode process is no longer running.",
      workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id,
      run_id: execution.execution_generation_id,
      deployment_id: serializeDaemonDeploymentId(id, execution.execution_generation_id),
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id,
        provider_continuation_id: "ses_dead_opencode",
        provider_connection: {
          kind: "opencode_server",
          url: "http://127.0.0.1:52486",
          pid: 45_550,
          processIdentity: "opencode-birth-45550",
          serverAuthPath: join(env.root, "opencode", "server-auth.json"),
        },
        execution_generation_id: execution.execution_generation_id,
      },
    } });
    assert.equal(put.ok, true, put.error);
    calls.converge = 0;
    const blockedProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(
      blockedProjection.room_agent_state?.connection.state,
      "disconnected",
      "a blocked recovery with no live provider handle cannot masquerade as reconnecting authority",
    );
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const result = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", {
      entry_id: id,
      daemon_generation: generation,
    });
    assert.equal(result.ok, true, result.error);
    const recovered = (result.result as { entry: DaemonManifestEntryView }).entry;
    assert.equal(recovered.id, id);
    assert.equal(recovered.workspace_path, attempt.workspace_path);
    assert.equal(recovered.work_attempt_id, attempt.work_attempt_id);
    assert.equal(recovered.provider_ref, null);
    assert.equal(recovered.observed_state, "starting");
    assert.equal(recovered.condition, "none");
    assert.deepEqual(calls, { attach: 1, spawn: 0, resume: 0, converge: 1 });

    const durable = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as {
      execution_generations: Array<{ execution_generation_id: string; terminal: unknown }>;
    };
    assert.equal(durable.execution_generations.length, 1, "recovery does not start a provider generation inline");
    assert.equal(durable.execution_generations[0]?.execution_generation_id, execution.execution_generation_id);
    assert.ok(durable.execution_generations[0]?.terminal, "exact terminal evidence is persisted before replacement");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("runtime recovery atomically fails a pre-join room move without losing its activating authority evidence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "move-recovery.lock"), socketPath: join(env.root, "move-recovery.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "move-recovery-audit.jsonl"),
    attemptsPath: join(env.root, "move-recovery-attempts.json"), attemptsRoot: join(env.root, "move-recovery-attempt-data"), workspaceRoot: env.root,
  };
  const id = "recover_runtime_with_waiting_move";
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(
    paths.attemptsPath,
    paths.attemptsRoot,
    undefined,
    join(env.root, "worktrees"),
    undefined,
    fakeGit(env.root),
    undefined,
    TEST_SUPERVISOR,
  );
  const attempt = await durability.createAttempt({
    taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id,
  });
  const execution = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
  await durability.close();
  const continuation = "recovery-move-continuation";
  let attachCalls = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({
      deliveryModes: ["daemon_inbox"], resume: true, midTurnInjection: false,
      transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true,
    }),
    spawn: async () => { throw new Error("recovery test does not launch inline"); },
    attach: async () => {
      attachCalls += 1;
      return {
        state: "terminal",
        terminal: {
          endedAt: "2099-08-05T10:00:00.000Z", exitCode: 1, signal: null,
          terminalCause: "crashed", providerContinuationId: continuation,
        },
      };
    },
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("dead runtime must not resume"); },
    poke: async () => {},
    stop: async () => ({
      endedAt: "2099-08-05T10:00:00.000Z", exitCode: 1, signal: null,
      terminalCause: "crashed", providerContinuationId: continuation,
    }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  let joinCalls = 0;
  const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }),
    publish: async () => {},
    joinRoom: async (input) => { joinCalls += 1; return { roomId: input.roomId }; },
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      requestConvergence: (entryId: string) => void;
      store: ManifestStore;
      supervisedInbox: SupervisedAgentInboxStore;
      reconcileRoomMove: (move: DaemonRoomMoveRecord) => Promise<DaemonRoomMoveRecord>;
    };
    internals.requestConvergence = () => {};
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id,
      provider: "open-model",
      delivery_mode: "daemon_inbox",
      desired_state: "running",
      observed_state: "recovering",
      condition: "none",
      last_error: null,
      workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id,
      run_id: execution.execution_generation_id,
      deployment_id: serializeDaemonDeploymentId(id, execution.execution_generation_id),
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id,
        provider_continuation_id: continuation,
        provider_connection: {
          kind: "opencode_server",
          url: "http://127.0.0.1:52487",
          pid: 45_551,
          processIdentity: "opencode-birth-45551",
          serverAuthPath: join(env.root, "opencode", "server-auth.json"),
        },
        execution_generation_id: execution.execution_generation_id,
      },
    } });
    assert.equal(put.ok, true, put.error);
    const [activating] = await internals.supervisedInbox.ingestPoll({
      agent_id: id,
      room_id: entry.room_id,
      last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "move before recovery" }, activation: { decision: "activate" } }],
    });
    assert(activating);
    assert.equal((await internals.supervisedInbox.claimHead(id))?.inbox_item_id, activating.inbox_item_id);
    const providerTurnId = "recover-move-turn";
    await internals.supervisedInbox.checkpointTurnStarted(activating.inbox_item_id, providerTurnId, {
      work_attempt_id: attempt.work_attempt_id,
      origin_execution_generation_id: execution.execution_generation_id,
      provider_continuation_id: continuation,
    });
    const ambiguous = await internals.supervisedInbox.prepareRoomMoveEffect({
      agent_id: id,
      room_id: entry.room_id,
      effect_execution_generation_id: execution.execution_generation_id,
      provider_turn_id: providerTurnId,
      mcp_request_id: "recover-move-request",
      request: { name: "room-after-recovery" },
      destination_room_id: "room-after-recovery",
      daemon_generation: ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation,
      work_attempt_id: attempt.work_attempt_id,
      execution_generation_id: execution.execution_generation_id,
      provider_continuation_id: continuation,
      agent_session_id: "recover-move-session",
      activating_inbox_item_id: activating.inbox_item_id,
    });
    const pending = (await internals.store.pendingRoomMoves(id))[0]!;
    assert.equal((await internals.reconcileRoomMove(pending)).phase, "waiting_for_current_turn");
    await internals.store.advanceRoomMove({
      operationId: pending.operation_id,
      agentId: id,
      expectedDaemonGeneration: pending.daemon_generation,
      expectedExecutionGenerationId: execution.execution_generation_id,
      from: ["waiting_for_current_turn"],
      to: "joining_destination",
    });
    const blocked = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", {
      entry_id: id,
      daemon_generation: ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation,
    });
    assert.equal(blocked.ok, false);
    assert.match(String(blocked.error), /blocked while a room move may have changed destination membership/i);
    assert.equal(attachCalls, 0, "post-join recovery rejects before attaching or recording terminal evidence");
    assert.ok((((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])?.provider_ref);
    assert.equal((await internals.store.getRoomMove(`room_move:${ambiguous.effect.effect_id}`))?.phase, "joining_destination");
    assert.ok(await internals.supervisedInbox.preparedRoomMove(id, execution.execution_generation_id, providerTurnId));

    // Retire the synthetic ambiguity without claiming an external join, then
    // seed the genuine pre-join case this test originally covered.
    await internals.store.advanceRoomMove({
      operationId: pending.operation_id,
      agentId: id,
      expectedDaemonGeneration: pending.daemon_generation,
      expectedExecutionGenerationId: execution.execution_generation_id,
      from: ["joining_destination"],
      to: "failed",
      error: "Test fixture proved no external join was issued.",
    });
    const prepared = await internals.supervisedInbox.prepareRoomMoveEffect({
      agent_id: id,
      room_id: entry.room_id,
      effect_execution_generation_id: execution.execution_generation_id,
      provider_turn_id: providerTurnId,
      mcp_request_id: "recover-move-request-prejoin",
      request: { name: "room-after-recovery" },
      destination_room_id: "room-after-recovery",
      daemon_generation: ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation,
      work_attempt_id: attempt.work_attempt_id,
      execution_generation_id: execution.execution_generation_id,
      provider_continuation_id: continuation,
      agent_session_id: "recover-move-session",
      activating_inbox_item_id: activating.inbox_item_id,
    });
    const prejoin = (await internals.store.pendingRoomMoves(id))[0]!;
    assert.equal((await internals.reconcileRoomMove(prejoin)).phase, "waiting_for_current_turn");

    const result = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", {
      entry_id: id,
      daemon_generation: ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation,
    });
    assert.equal(result.ok, true, result.error);
    const recovered = (result.result as { entry: DaemonManifestEntryView }).entry;
    assert.equal(recovered.id, id);
    assert.equal(recovered.work_attempt_id, attempt.work_attempt_id);
    assert.equal(recovered.provider_ref, null);
    assert.equal(recovered.observed_state, "starting");
    assert.equal(attachCalls, 1);
    assert.equal(joinCalls, 0);
    assert.equal((await internals.store.getRoomMove(`room_move:${prepared.effect.effect_id}`))?.phase, "failed");
    assert.deepEqual(await internals.store.pendingRoomMoves(id), []);
    assert.equal((await internals.supervisedInbox.preparedRoomMove(id, execution.execution_generation_id, providerTurnId)), null);
    assert.equal((await internals.supervisedInbox.get(activating.inbox_item_id))?.state, "dispatching");
    assert.equal((await internals.supervisedInbox.providerTurnBinding(activating.inbox_item_id))?.provider_turn_id, providerTurnId);
    const durable = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as {
      execution_generations: Array<{ execution_generation_id: string; terminal: unknown }>;
    };
    assert.ok(durable.execution_generations.find((candidate) =>
      candidate.execution_generation_id === execution.execution_generation_id)?.terminal);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a provably-gone provider runtime auto-recovers with a fresh runtime instead of dead-ending in recovering", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const id = "auto_recover_gone_runtime";
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(
    paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"),
    undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR,
  );
  const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  const execution = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
  await durability.close();
  const port: ProviderActionPort = {
    capabilities: async () => ({ deliveryModes: ["daemon_inbox"], resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { throw new Error("unused in this test"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("unused in this test"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: "ses_gone" }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, { poll: async () => ({ messages: [] }), publish: async () => {} });
  try {
    await daemon.start();
    let scheduledConvergence = 0;
    const internals = daemon as unknown as {
      recordSchedulerFailure: (entryId: string, error: unknown, actor: string) => Promise<void>;
      scheduleRecoveryConvergence: (entryId: string, delayMs: number) => void;
      updateManifestEntry: (entryId: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry) => Promise<DaemonManifestEntry>;
    };
    const realSchedule = internals.scheduleRecoveryConvergence.bind(internals);
    internals.scheduleRecoveryConvergence = (entryId, delayMs) => { if (entryId === id) scheduledConvergence += 1; void realSchedule; };
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "open-model", delivery_mode: "daemon_inbox",
      desired_state: "running", observed_state: "recovering", condition: "coordination_blocked",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id, provider_continuation_id: "ses_gone",
        provider_connection: { kind: "opencode_server", url: "http://127.0.0.1:52999", pid: 46_000, processIdentity: "opencode-birth-46000", serverAuthPath: join(env.root, "opencode", "server-auth.json") },
        execution_generation_id: execution.execution_generation_id,
      },
    } });
    assert.equal(put.ok, true, put.error);

    // The daemon observed the saved runtime is provably gone (adapter marks it).
    await internals.recordSchedulerFailure(id, new OpenCodeRuntimeGoneError(), "daemon-convergence");

    const recovered = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(recovered.provider_ref, null, "the dead continuation is dropped so the next convergence spawns fresh");
    assert.equal(recovered.observed_state, "failed", "a failed edge engages the crash-loop backoff/quarantine machinery");
    assert.equal(recovered.condition, "none", "the entry is not left blocked; it is eligible for a fresh runtime");
    assert.match(String(recovered.last_error), /starting a replacement/);
    assert.equal(scheduledConvergence, 1, "a fresh-runtime convergence is scheduled automatically, no manual Recover required");

    // A non-gone durable-continuation failure must NOT drop the continuation:
    // the process may still be alive and resume must not spawn a competitor.
    // (manifest.put is idempotent for an existing id, so re-seed in place.)
    await internals.updateManifestEntry(id, (current) => ({
      ...current,
      observed_state: "recovering",
      condition: "none",
      last_error: null,
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id, provider_continuation_id: "ses_unverified",
        provider_connection: { kind: "opencode_server", url: "http://127.0.0.1:52999", pid: 46_000, processIdentity: "opencode-birth-46000", serverAuthPath: join(env.root, "opencode", "server-auth.json") },
        execution_generation_id: execution.execution_generation_id,
      },
    }));
    await internals.recordSchedulerFailure(id, new Error("The saved OpenCode process could not be authenticated; refusing to start a competing runtime."), "daemon-convergence");
    const blocked = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.ok(blocked.provider_ref, "an unverifiable (maybe-alive) runtime keeps its continuation for a bounded retry");
    assert.equal(blocked.condition, "coordination_blocked", "it rests at an actionable blocked state, not a fresh-spawn reset");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("credential-only reconnect reattaches the exact OpenCode runtime and checkpoints recovered connection evidence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const id = "credential_only_opencode_attach";
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(
    paths.attemptsPath,
    paths.attemptsRoot,
    undefined,
    join(env.root, "worktrees"),
    undefined,
    fakeGit(env.root),
    undefined,
    TEST_SUPERVISOR,
  );
  const attempt = await durability.createAttempt({
    taskId: id,
    leaseId: id,
    leaseEpoch: 0,
    workspacePath: workspace.path,
    workAttemptId: workspace.id,
  });
  const execution = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
  await durability.close();
  const recoveredConnection = {
    kind: "opencode_server" as const,
    url: "http://127.0.0.1:52486",
    pid: 45_550,
    processIdentity: "opencode-birth-45550",
    serverAuthPath: join(env.root, "opencode", "server-auth.json"),
  };
  const handle = {
    workAttemptId: attempt.work_attempt_id,
    pid: recoveredConnection.pid,
    providerContinuationId: "ses_exact_opencode",
    providerConnection: recoveredConnection,
    observedState: "idle" as const,
  };
  const calls = { attach: 0, spawn: 0, resume: 0, stop: 0, mint: 0 };
  const port: ProviderActionPort = {
    capabilities: async () => ({
      deliveryModes: ["daemon_inbox"],
      resume: true,
      midTurnInjection: false,
      transcriptAccess: true,
      permissionPromptBridging: false,
      survivesRestart: true,
    }),
    spawn: async () => { calls.spawn += 1; throw new Error("reconnect must not spawn"); },
    attach: async (ref) => {
      calls.attach += 1;
      assert.equal(ref.workAttemptId, attempt.work_attempt_id);
      assert.equal(ref.providerContinuationId, handle.providerContinuationId);
      assert.equal(ref.providerConnection, null, "the adapter owns legacy connection recovery");
      return handle;
    },
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { calls.resume += 1; throw new Error("reconnect must not resume"); },
    poke: async () => {},
    stop: async () => { calls.stop += 1; throw new Error("reconnect must not stop"); },
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }),
    publish: async () => {},
  }, {
    createWorkerSession: async () => {
      calls.mint += 1;
      return {
        sessionId: "session-opencode-reconnect",
        bearer: "opencode-reconnect-bearer",
        bearerId: "bearer-opencode-reconnect",
        expiresAt: null,
      };
    },
  });
  try {
    await daemon.start();
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id,
      provider: "open-model",
      delivery_mode: "daemon_inbox",
      observed_state: "recovering",
      condition: "coordination_blocked",
      last_error: "durable execution generation remains live without an attachable provider handle",
      workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id,
      run_id: execution.execution_generation_id,
      deployment_id: serializeDaemonDeploymentId(id, execution.execution_generation_id),
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id,
        provider_continuation_id: handle.providerContinuationId,
        provider_connection: null,
        execution_generation_id: execution.execution_generation_id,
      },
    } });
    assert.equal(put.ok, true, put.error);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const result = await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id,
      room_id: entry.room_id,
      agent_key: "owner/opencode-agent",
      grant_id: "grant-opencode-reconnect",
      supervisor_grant: "opencode-reconnect-secret",
      grant_generation: 1,
      api_url: "https://letagents.example",
      host_id: "host-1",
      installation_id: "installation-1",
      grant_expires_at: "2099-01-01T00:00:00.000Z",
      daemon_generation: generation,
      credential_only: true,
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result, {
      status: "installed",
      agent_session_id: "session-opencode-reconnect",
    });
    assert.deepEqual(calls, { attach: 1, spawn: 0, resume: 0, stop: 0, mint: 1 });
    const restored = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])
      .find((candidate) => candidate.id === id);
    assert.deepEqual(restored?.provider_ref?.provider_connection, recoveredConnection);
    assert.equal(restored?.provider_ref?.execution_generation_id, execution.execution_generation_id);
    assert.equal(restored?.provider_ref?.provider_continuation_id, handle.providerContinuationId);
    const internalStore = (daemon as unknown as { store: ManifestStore }).store;
    const restoredConfiguration = await internalStore.getAgentConfiguration(id);
    assert.ok(restoredConfiguration);
    assert.equal(await internalStore.readRuntimeLifecycleAuthority({
      agentId: id,
      executionGenerationId: execution.execution_generation_id,
      providerConnection: recoveredConnection,
      configurationRevision: restoredConfiguration.runtime_configuration_revision,
    }), "legacy", "reattach freezes the pre-existing native birth without current-policy inference");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("cursor admission repairs pre-upgrade running and stopped daemon-inbox entries without provider lifecycle work", async () => {
  for (const desiredState of ["running", "stopped"] as const) {
    const env = await fixture();
    const paths = {
      lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
      manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    };
    const lifecycle = { spawn: 0, resume: 0, stop: 0, converge: 0, mint: 0, tail: 0 };
    const tailId = desiredState === "running" ? "101" : "202";
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
      spawn: async () => { lifecycle.spawn += 1; throw new Error("cursor admission must not spawn"); },
      attach: async () => null, attachAction: async () => ({ state: "absent" }),
      resume: async () => { lifecycle.resume += 1; throw new Error("cursor admission must not resume"); }, poke: async () => {},
      stop: async () => { lifecycle.stop += 1; throw new Error("cursor admission must not stop"); },
      onExit: async () => () => {}, onStream: async () => () => {},
    };
    const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, {
      latest: async () => { lifecycle.tail += 1; return { messages: [{ id: tailId }] }; },
      poll: async () => ({ messages: [] }), publish: async () => {},
    }, {
      createWorkerSession: async () => {
        lifecycle.mint += 1;
        return { sessionId: `admission-${desiredState}`, bearer: "admission-bearer", bearerId: "admission-bearer-id", expiresAt: null };
      },
    });
    try {
      await daemon.start();
      const internals = daemon as unknown as { requestConvergence: (entryId: string) => void; supervisedInbox: SupervisedAgentInboxStore };
      const id = `cursorless_${desiredState}`;
      assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", desired_state: desiredState,
        observed_state: desiredState === "running" ? "working" : "stopped",
      } })).ok, true);
      let cursorObservedByConvergence: string | null | undefined;
      internals.requestConvergence = (entryId) => {
        lifecycle.converge += 1;
        void internals.supervisedInbox.cursor(entryId).then((cursor) => {
          cursorObservedByConvergence = cursor?.last_observed_message_id ?? null;
        });
      };
      const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
      assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
        entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: `grant-${desiredState}`,
        supervisor_grant: "admission-secret", grant_generation: 1, api_url: "https://letagents.example",
        host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z", daemon_generation: generation,
      })).ok, true);
      assert.deepEqual(lifecycle, { spawn: 0, resume: 0, stop: 0, converge: 0, mint: 0, tail: 0 }, "grant install cannot queue cursorless provider convergence");
      assert.equal(await internals.supervisedInbox.cursor(id), null, "no provider work is admitted before the first tail boundary");
      const admitted = await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", { entry_id: id, daemon_generation: generation });
      assert.equal(admitted.ok, true, admitted.error);
      assert.deepEqual(admitted.result, { status: "bootstrapped", last_observed_message_id: tailId });
      assert.equal((await internals.supervisedInbox.cursor(id))?.last_observed_message_id, tailId, "history is skipped at the observed tail");
      if (desiredState === "running") {
        await eventually(async () => cursorObservedByConvergence !== undefined, "post-admission running convergence");
        assert.equal(cursorObservedByConvergence, tailId, "running convergence observes the committed admission cursor");
      } else {
        assert.equal(cursorObservedByConvergence, undefined, "stopped admission never queues provider convergence");
      }
      assert.deepEqual(lifecycle, {
        spawn: 0, resume: 0, stop: 0,
        converge: desiredState === "running" ? 1 : 0,
        mint: 1, tail: 1,
      }, "admission mints only a tail-reader session and never starts, resumes, or stops a provider");
    } finally {
      await daemon.stop().catch(() => undefined);
      await env.cleanup();
    }
  }
});

test("fresh desktop bootstrap queues its initial message exactly once while legacy bootstrap queues none", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { throw new Error("stopped bootstrap must not spawn"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("stopped bootstrap must not resume"); }, poke: async () => {},
    stop: async () => { throw new Error("stopped bootstrap must not stop"); },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, {
    latest: async () => ({ messages: [{ id: "44" }] }),
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => ({
      sessionId: "initial-message-session", bearer: "initial-message-bearer",
      bearerId: "initial-message-bearer-id", expiresAt: null,
    }),
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as { supervisedInbox: SupervisedAgentInboxStore };
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    for (const id of ["fresh_initial_message", "legacy_without_initial_message"]) {
      assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        ...entry, id, provider: "codex", delivery_mode: "daemon_inbox",
        desired_state: "stopped", observed_state: "stopped",
      } })).ok, true);
      assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
        entry_id: id, room_id: entry.room_id, agent_key: `owner/${id}`, grant_id: `grant-${id}`,
        supervisor_grant: `grant-secret-${id}`, grant_generation: 1, api_url: "https://letagents.example",
        host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
        daemon_generation: generation,
      })).ok, true);
    }

    const first = await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
      entry_id: "fresh_initial_message", daemon_generation: generation,
      initial_message: "join the room and say hi",
    });
    assert.equal(first.ok, true, first.error);
    const queued = await internals.supervisedInbox.head("fresh_initial_message");
    assert.equal(queued?.source_message_id, "desktop-initial-message:fresh_initial_message");
    assert.equal((queued?.source_message as { text?: string }).text, "join the room and say hi");
    assert.equal((queued?.source_message as { source?: string }).source, "desktop_initial_message");

    const retried = await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
      entry_id: "fresh_initial_message", daemon_generation: generation,
      initial_message: "a retry must not replace or duplicate the first message",
    });
    assert.equal(retried.ok, true, retried.error);
    const afterRetry = await internals.supervisedInbox.receipts("fresh_initial_message");
    assert.equal(afterRetry.length, 1);
    assert.equal(afterRetry[0]?.inbox_item_id, queued?.inbox_item_id);
    assert.equal((afterRetry[0]?.source_message as { text?: string }).text, "join the room and say hi");

    const legacy = await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
      entry_id: "legacy_without_initial_message", daemon_generation: generation,
    });
    assert.equal(legacy.ok, true, legacy.error);
    assert.equal(await internals.supervisedInbox.head("legacy_without_initial_message"), null);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("bootstrap and launch reuse one fresh host worker mint before creating one provider generation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const source = await committedSourceRepository(env.root, "bootstrap_reuse_source");
  await primeDaemonBareRepository(env.root, source);
  let mintCalls = 0;
  let spawns = 0;
  let mintedProvider: string | null = null;
  let mintedDisplayName: string | null = null;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (input) => {
      spawns += 1;
      return { workAttemptId: input.workAttemptId, pid: 9211, providerContinuationId: "bootstrap-reuse-continuation", observedState: "working" };
    },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("fresh bootstrap launch must not resume"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "bootstrap-reuse-continuation" }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    latest: async () => ({ messages: [] }), poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async (input) => {
      mintCalls += 1;
      mintedProvider = input.provider;
      mintedDisplayName = input.displayName;
      return { sessionId: "bootstrap-reuse-session", bearer: "bootstrap-reuse-bearer", bearerId: "bootstrap-reuse-bearer-id", expiresAt: "2099-01-01T00:00:00.000Z" };
    },
  });
  try {
    await daemon.start();
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const id = "bootstrap_reuses_mint";
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent", source_repo_path: source,
    } })).ok, true);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-bootstrap-reuse", supervisor_grant: "bootstrap-reuse-grant",
      grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", { entry_id: id, daemon_generation: generation })).ok, true);
    await eventually(async () => spawns === 1, "bootstrap launch provider spawn");
    assert.equal(mintCalls, 1, "bootstrap tail admission and launch share the same fresh worker mint");
    assert.equal(mintedProvider, "codex", "the worker session retains its real provider identity");
    assert.equal(mintedDisplayName, "Agent", "the worker session retains its agent display name");
    const attempt = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
    assert.equal(attempt.execution_generations.length, 1, "only one durable execution generation is created after credential success");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("Open Model launches with its exact memory-only endpoint credential", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const source = await committedSourceRepository(env.root, "open_model_credential_source");
  await primeDaemonBareRepository(env.root, source);
  const providerSecret = "open-model-provider-secret-never-persist";
  let spawnInput: Parameters<ProviderActionPort["spawn"]>[0] | null = null;
  const port: ProviderActionPort = {
    capabilities: async () => ({
      deliveryModes: ["daemon_inbox"],
      resume: true,
      midTurnInjection: false,
      transcriptAccess: true,
      permissionPromptBridging: false,
      survivesRestart: true,
    }),
    spawn: async (input) => {
      spawnInput = input;
      return {
        workAttemptId: input.workAttemptId,
        pid: 9311,
        providerContinuationId: "opencode-session-1",
        providerConnection: {
          kind: "opencode_server",
          url: "http://127.0.0.1:19311",
          pid: 9311,
          processIdentity: "opencode-process-birth",
          serverAuthPath: join(env.root, "opencode-server-auth.json"),
        },
        observedState: "idle",
      };
    },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("fresh Open Model launch must not resume"); },
    poke: async () => {},
    stop: async (handle) => ({
      endedAt: new Date().toISOString(),
      exitCode: 0,
      signal: null,
      terminalCause: "stopped",
      providerContinuationId: handle.providerContinuationId,
    }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    latest: async () => ({ messages: [] }),
    poll: async () => ({ messages: [] }),
    publish: async () => {},
  }, {
    createWorkerSession: async () => ({
      sessionId: "open-model-worker",
      bearer: "open-model-worker-bearer",
      bearerId: "open-model-worker-bearer-id",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
  });
  try {
    await daemon.start();
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const id = "open_model_memory_credential";
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id,
      provider: "open-model",
      model: "open-model/test",
      permission_profile_id: "full_access",
      delivery_mode: "daemon_inbox",
      observed_state: "absent",
      source_repo_path: source,
    } })).ok, true);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const installed = await daemonRequest(paths.socketPath, "supervisor.install_open_model_credential", {
      entry_id: id,
      api_key: providerSecret,
      base_url: "https://models.example.test/v1/",
      model: "open-model/test",
      daemon_generation: generation,
    });
    assert.equal(installed.ok, true, installed.error);
    assert.deepEqual(installed.result, { status: "installed" });
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id,
      room_id: entry.room_id,
      agent_key: "owner/open-model-agent",
      grant_id: "grant-open-model",
      supervisor_grant: "open-model-host-grant",
      grant_generation: 1,
      api_url: "https://letagents.example",
      daemon_generation: generation,
      host_id: "host-open-model",
      installation_id: "installation-open-model",
      grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
      entry_id: id,
      daemon_generation: generation,
    })).ok, true);
    await eventually(async () => spawnInput !== null, "Open Model provider spawn");
    assert.deepEqual(spawnInput!.providerCredential, {
      apiKey: providerSecret,
      baseUrl: "https://models.example.test/v1",
      model: "open-model/test",
    });
    assert.equal(spawnInput!.provider, "open-model");
    assert.equal(spawnInput!.deliveryMode, "daemon_inbox");
    assert.deepEqual(spawnInput!.launchPolicy, { permission: { "*": "allow" } });
    const raw = await readFile(paths.manifestPath);
    assert.equal(raw.includes(Buffer.from(providerSecret)), false, "the endpoint key is never serialized into daemon state");
    assert.equal((await readFile(paths.auditPath)).includes(Buffer.from(providerSecret)), false, "the endpoint key is never written to audit");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("string-thrown transient worker mint failures redact credentials and automatically reconverge", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "transient_worker_mint_retry");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const durableAttempt = await durability.createAttempt({ taskId: "transient_worker_mint_retry", leaseId: "transient_worker_mint_retry", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  const recovery = fakeRecoveryClock();
  let mintCalls = 0;
  let failMints = true;
  let spawns = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (input) => {
      spawns += 1;
      return { workAttemptId: input.workAttemptId, pid: 9212, providerContinuationId: "transient-mint-continuation", observedState: "working" };
    },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("transient credential recovery must start only once"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "transient-mint-continuation" }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 10, undefined, recovery.clock, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => {
      mintCalls += 1;
      if (failMints) throw "worker mint transport failed; Authorization: Bearer transient-mint-secret";
      return { sessionId: "transient-mint-session", bearer: "transient-mint-bearer", bearerId: "transient-mint-bearer-id", expiresAt: "2099-01-01T00:00:00.000Z" };
    },
  });
  try {
    await daemon.start();
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const id = "transient_worker_mint_retry";
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: durableAttempt.workspace_path, work_attempt_id: durableAttempt.work_attempt_id,
    } })).ok, true);
    await admitDaemonInboxForProviderTest(daemon, id, entry.room_id);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-transient-mint", supervisor_grant: "transient-mint-grant",
      grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await eventually(async () => mintCalls === 1, "first transient mint attempt");
    await recovery.advance(100);
    await eventually(async () => mintCalls === 2, "second transient mint attempt");
    await recovery.advance(100);
    await eventually(async () => mintCalls === 3, "third transient mint attempt");
    await eventually(async () => recovery.pending() === 1, "automatic convergence timer after exhausted transient mint");
    const beforeRetry = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
    assert.equal(beforeRetry.execution_generations.length, 0, "no execution generation exists before a credential is successfully minted");
    const failed = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.match(failed.last_error ?? "", /Authorization: Bearer \[REDACTED\]/i, "string-thrown credential evidence is redacted before persistence");
    assert.doesNotMatch(failed.last_error ?? "", /transient-mint-secret/, "the raw string-thrown credential never reaches durable state");
    failMints = false;
    await recovery.advance(10);
    await eventually(async () => spawns === 1 && mintCalls === 4, "automatic post-failure convergence without another RPC");
    const recovered = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
    assert.equal(recovered.execution_generations.length, 1, "automatic recovery creates exactly one provider generation");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("429 worker mint failures retry three times and automatically reconverge", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "rate_limited_worker_mint_retry");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const durableAttempt = await durability.createAttempt({ taskId: "rate_limited_worker_mint_retry", leaseId: "rate_limited_worker_mint_retry", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  const recovery = fakeRecoveryClock();
  let mintCalls = 0;
  let rateLimited = true;
  let spawns = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (input) => {
      spawns += 1;
      return { workAttemptId: input.workAttemptId, pid: 9213, providerContinuationId: "rate-limit-mint-continuation", observedState: "working" };
    },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("rate-limited fresh launch must not resume"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "rate-limit-mint-continuation" }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 10, undefined, recovery.clock, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => {
      mintCalls += 1;
      if (rateLimited) throw new SupervisorGrantRequestError(429, "Supervisor worker session mint");
      return { sessionId: "rate-limit-session", bearer: "rate-limit-bearer", bearerId: "rate-limit-bearer-id", expiresAt: "2099-01-01T00:00:00.000Z" };
    },
  });
  try {
    await daemon.start();
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const id = "rate_limited_worker_mint_retry";
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: durableAttempt.workspace_path, work_attempt_id: durableAttempt.work_attempt_id,
    } })).ok, true);
    await admitDaemonInboxForProviderTest(daemon, id, entry.room_id);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-rate-limit-mint", supervisor_grant: "rate-limit-mint-grant",
      grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await eventually(async () => mintCalls === 1, "first 429 mint attempt");
    await recovery.advance(100);
    await eventually(async () => mintCalls === 2, "second 429 mint attempt");
    await recovery.advance(100);
    await eventually(async () => mintCalls === 3, "third 429 mint attempt");
    await eventually(async () => recovery.pending() === 1, "automatic convergence after exhausted 429 mint attempts");
    const beforeRecovery = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
    assert.equal(beforeRecovery.execution_generations.length, 0, "rate limiting cannot create a durable execution before credentials exist");
    rateLimited = false;
    await recovery.advance(10);
    await eventually(async () => mintCalls === 4 && spawns === 1, "automatic 429 recovery without another RPC");
    const recovered = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
    assert.equal(recovered.execution_generations.length, 1, "automatic 429 recovery creates one generation only after mint success");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("definitive worker mint rejection attempts once and never schedules automatic convergence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "definitive_worker_mint_rejection");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const durableAttempt = await durability.createAttempt({ taskId: "definitive_worker_mint_rejection", leaseId: "definitive_worker_mint_rejection", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  const recovery = fakeRecoveryClock();
  let mintCalls = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { throw new Error("a definitive credential rejection cannot spawn"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("a definitive credential rejection cannot resume"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 10, undefined, recovery.clock, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => {
      mintCalls += 1;
      throw new SupervisorGrantRequestError(401, "Supervisor worker session mint");
    },
  });
  try {
    await daemon.start();
    const id = "definitive_worker_mint_rejection";
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: durableAttempt.workspace_path, work_attempt_id: durableAttempt.work_attempt_id,
    } })).ok, true);
    await admitDaemonInboxForProviderTest(daemon, id, entry.room_id);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-definitive-mint", supervisor_grant: "definitive-mint-grant",
      grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await eventually(async () => mintCalls === 1, "single definitive mint attempt");
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0];
      return Boolean(current?.last_error);
    }, "definitive scheduler failure persistence");
    assert.equal(mintCalls, 1, "401 is definitive and must not enter the mint retry loop");
    assert.equal(recovery.pending(), 0, "a definitive mint rejection must not schedule recovery convergence");
    const failed = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.match(failed.last_error ?? "", /failed after 1 attempt/i, "failure evidence reports the actual single attempt");
    const attempt = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
    assert.equal(attempt.execution_generations.length, 0, "definitive credential rejection occurs before execution generation creation");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("handoff aborts a hung pre-observation room bootstrap without creating a cursor", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  let mintEntered!: () => void;
  const mintStarted = new Promise<void>((resolve) => { mintEntered = resolve; });
  let mintAborted = false;
  let tailReads = 0;
  const daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, {
    latest: async () => { tailReads += 1; return { messages: [{ id: "must-not-observe" }] }; },
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async ({ signal }) => new Promise((_resolve, reject) => {
      mintEntered();
      signal?.addEventListener("abort", () => { mintAborted = true; reject(new Error("mint aborted by handoff")); }, { once: true });
    }),
  });
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "hung_room_bootstrap", provider: "codex", delivery_mode: "daemon_inbox",
      desired_state: "paused", observed_state: "absent",
    } });
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "hung_room_bootstrap", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-bootstrap",
      supervisor_grant: "bootstrap-secret", grant_generation: 1, api_url: "https://letagents.example",
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z", daemon_generation: generation,
    })).ok, true);
    const bootstrap = daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", { entry_id: "hung_room_bootstrap", daemon_generation: generation });
    await mintStarted;
    const handoff = daemon.waitForHandoff();
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    const rejected = await bootstrap;
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? "", /aborted|cancelled/i);
    await within(handoff, "hung bootstrap handoff", 1_000);
    assert.equal(mintAborted, true);
    assert.equal(tailReads, 0);
    const reopened = new SupervisedAgentInboxStore(paths.manifestPath);
    try {
      assert.equal(await reopened.cursor("hung_room_bootstrap"), null);
    } finally { await reopened.close(); }
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("handoff drains an observed room tail commit and the successor inherits that exact cursor", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  let commitEntered!: () => void;
  const commitStarted = new Promise<void>((resolve) => { commitEntered = resolve; });
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let firstTailReads = 0;
  const first = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, {
    latest: async () => { firstTailReads += 1; return { messages: [{ id: "50" }] }; },
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => ({ sessionId: "first-session", bearer: "first-bearer", bearerId: "first-bearer-id", expiresAt: null }),
  });
  let successor: SupervisorDaemon | null = null;
  try {
    await first.start();
    const firstInbox = (first as unknown as { supervisedInbox: SupervisedAgentInboxStore }).supervisedInbox;
    const originalBootstrapCursor = firstInbox.bootstrapCursor.bind(firstInbox);
    firstInbox.bootstrapCursor = async (input) => {
      commitEntered();
      await commitGate;
      return originalBootstrapCursor(input);
    };
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "observed_tail_commit", provider: "codex", delivery_mode: "daemon_inbox",
      desired_state: "paused", observed_state: "absent",
    } });
    const firstGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "observed_tail_commit", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-first-tail",
      supervisor_grant: "first-tail-secret", grant_generation: 1, api_url: "https://letagents.example",
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z", daemon_generation: firstGeneration,
    })).ok, true);
    const bootstrap = daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", { entry_id: "observed_tail_commit", daemon_generation: firstGeneration });
    await commitStarted;
    assert.equal(firstTailReads, 1);
    let handoffComplete = false;
    const handoff = first.waitForHandoff().then(() => { handoffComplete = true; });
    // prepare_handoff intentionally does not acknowledge until it has drained
    // the committing bootstrap operation, so leave this socket request pending
    // while proving the lock is still held.
    const prepare = daemonRequest(paths.socketPath, "daemon.prepare_handoff");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(handoffComplete, false, "authority remains with the observer until tail N is durable");
    releaseCommit();
    assert.equal((await prepare).ok, true);
    const bootstrapped = await bootstrap;
    assert.equal(bootstrapped.ok, true, bootstrapped.error);
    assert.deepEqual(bootstrapped.result, { status: "bootstrapped", last_observed_message_id: "50" });
    await within(handoff, "observed-tail commit handoff", 1_000);

    let successorTailReads = 0;
    successor = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, {
      latest: async () => { successorTailReads += 1; return { messages: [{ id: "51" }] }; },
      poll: async () => ({ messages: [] }), publish: async () => {},
    }, {
      createWorkerSession: async () => { throw new Error("successor must not mint before an existing cursor check"); },
    });
    await successor.start();
    const successorGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const inherited = await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
      entry_id: "observed_tail_commit", daemon_generation: successorGeneration,
    });
    assert.equal(inherited.ok, true, inherited.error);
    assert.deepEqual(inherited.result, { status: "existing", last_observed_message_id: "50" });
    assert.equal(successorTailReads, 0, "the successor must not move the already observed boundary");
  } finally {
    releaseCommit?.();
    await successor?.stop().catch(() => undefined);
    await first.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a host-grant install queued before handoff cannot retain plaintext or report installed after retirement", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  let installAdmitted!: () => void;
  const admitted = new Promise<void>((resolve) => { installAdmitted = resolve; });
  let mintCalls = 0;
  const daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, async (request) => {
    if (request.method === "supervisor.install_host_grant") installAdmitted();
  }, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => {
      mintCalls += 1;
      return { sessionId: "must-not-mint", bearer: "must-not-retain", bearerId: "must-not-record", expiresAt: null };
    },
  });
  let releaseTick!: () => void;
  const tickGate = new Promise<void>((resolve) => { releaseTick = resolve; });
  let tickEntered!: () => void;
  const tickStarted = new Promise<void>((resolve) => { tickEntered = resolve; });
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "queued_host_grant", provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
    } });
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const internals = daemon as unknown as {
      serializeEntryTick: <T>(entryId: string, operation: () => Promise<T>) => Promise<T>;
      workerRuntimeCustody: WorkerRuntimeCustody;
    };
    const heldTick = internals.serializeEntryTick("queued_host_grant", async () => { tickEntered(); await tickGate; });
    await tickStarted;
    const queuedInstall = daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "queued_host_grant", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-queued",
      supervisor_grant: "queued-plaintext-grant", grant_generation: 3, api_url: "https://letagents.example",
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
      daemon_generation: generation,
    });
    await admitted;
    const handoff = daemon.waitForHandoff();
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    releaseTick();
    await heldTick;
    const rejected = await queuedInstall;
    assert.equal(rejected.ok, true);
    assert.deepEqual(rejected.result, { status: "stale" });
    assert.equal(mintCalls, 0, "a retired daemon cannot mint a worker session");
    assert.equal(internals.workerRuntimeCustody.hostGrant("queued_host_grant"), undefined, "a retired daemon retains no plaintext grant");
    await within(handoff, "queued host-grant handoff", 1_000);
  } finally {
    releaseTick?.();
    await env.cleanup();
  }
});

test("handoff destroys open control sockets and fences a mutation paused before commit", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"),
    auditPath: join(env.root, "audit.jsonl"),
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const first = new SupervisorDaemon(paths, "darwin");
  let second: SupervisorDaemon | null = null;
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let reachedCommit!: () => void;
  const commitReached = new Promise<void>((resolve) => { reachedCommit = resolve; });
  let releaseBindingCommit!: () => void;
  const bindingCommitGate = new Promise<void>((resolve) => { releaseBindingCommit = resolve; });
  let reachedBindingCommit!: () => void;
  const bindingCommitReached = new Promise<void>((resolve) => { reachedBindingCommit = resolve; });
  let heldSocket: ReturnType<typeof createConnection> | null = null;
  try {
    await first.start();
    const store = (first as unknown as { store: ManifestStore }).store;
    const originalWrite = store.write.bind(store);
    store.write = (expected, entries, owners, commitFence) => originalWrite(expected, entries, owners, async (commit) => {
      reachedCommit();
      await commitGate;
      if (commitFence) await commitFence(commit);
      else await commit();
    });
    const lateMutation = daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...entry, id: "must_not_commit_after_handoff" },
    }).catch(() => null);
    const bindingStore = (first as unknown as { workerBindings: WorkerBindingStore }).workerBindings;
    const rawBindingStore = bindingStore as unknown as { write: (value: unknown) => Promise<void> };
    const originalBindingWrite = rawBindingStore.write.bind(rawBindingStore);
    rawBindingStore.write = async (value) => {
      reachedBindingCommit();
      await bindingCommitGate;
      await originalBindingWrite(value);
    };
    const lateBinding = bindingStore.bind({
      entry_id: "binding_race", room_id: "focus_37", work_attempt_id: "attempt_old",
      execution_generation_id: "execution_old", agent_session_id: "session_old",
      agent_session_token: "old-secret", api_url: "https://letagents.chat",
    }).catch(() => null);
    await Promise.all([commitReached, bindingCommitReached]);

    heldSocket = createConnection(paths.socketPath);
    await new Promise<void>((resolve, reject) => {
      heldSocket!.once("connect", resolve);
      heldSocket!.once("error", reject);
    });
    const heldClosed = new Promise<void>((resolve) => heldSocket!.once("close", () => resolve()));
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    second = new SupervisorDaemon(paths, "darwin");
    await within((async () => {
      while (true) {
        try { await second!.start(); return; }
        catch (error) {
          if (!(error instanceof DaemonAlreadyRunningError)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    })(), "replacement daemon while an old control socket is open", 1_000);
    await within(heldClosed, "old control connection destruction", 1_000);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "binding_race", room_id: "focus_37", observed_state: "working", work_attempt_id: "attempt_old",
      provider_ref: {
        work_attempt_id: "attempt_old", provider_continuation_id: "continuation_successor",
        provider_connection: null, execution_generation_id: "execution_old",
      },
    } })).ok, true);
    const replacementBindings = (second as unknown as { workerBindings: WorkerBindingStore }).workerBindings;
    const predecessorBinding = await replacementBindings.bind({
      entry_id: "binding_race", room_id: "focus_37", work_attempt_id: "attempt_old",
      execution_generation_id: "execution_old", agent_session_id: "session_old",
      agent_session_token: "old-secret", api_url: "https://letagents.chat",
    });
    const staleHandle = {
      workAttemptId: "attempt_old", pid: null, providerContinuationId: "continuation_old",
      providerConnection: null, observedState: "working" as const,
    };
    const successorHandle = { ...staleHandle, providerContinuationId: "continuation_successor" };
    let releaseTerminalLoad!: () => void;
    const terminalLoadGate = new Promise<void>((resolve) => { releaseTerminalLoad = resolve; });
    let reachedTerminalLoad!: () => void;
    const terminalLoadReached = new Promise<void>((resolve) => { reachedTerminalLoad = resolve; });
    const replacementInternals = second as unknown as {
      liveHandles: Map<string, typeof staleHandle>;
      workerRuntimeCustody: WorkerRuntimeCustody;
      store: ManifestStore;
      durability: {
        getAttempt: (id: string) => Promise<{ execution_generations: Array<{ execution_generation_id: string; terminal: unknown; actor: string; generation: number }> }>;
        recordTerminal: (workAttemptId: string, executionGenerationId: string, terminal: unknown) => Promise<void>;
      };
      providerTerminals: { observeExit(
        entryId: string,
        terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "stopped"; providerContinuationId: string },
        actor: string,
        expectedExecutionGenerationId: string,
        expectedHandle: typeof staleHandle,
      ): Promise<void> };
    };
    replacementInternals.liveHandles.set("binding_race", staleHandle);
    const predecessorIdentity = {
      agentSessionId: predecessorBinding.agent_session_id,
      executionGenerationId: predecessorBinding.execution_generation_id,
      updatedAt: predecessorBinding.updated_at,
    };
    replacementInternals.workerRuntimeCustody.installLiveBinding("binding_race", predecessorIdentity);
    const fakeExecutions = [
      { execution_generation_id: "execution_old", terminal: null as unknown, actor: "old-worker", generation: 1 },
      { execution_generation_id: "execution_successor", terminal: null as unknown, actor: "successor-worker", generation: 2 },
    ];
    replacementInternals.durability.getAttempt = async () => ({ execution_generations: fakeExecutions });
    replacementInternals.durability.recordTerminal = async (_workAttemptId, executionGenerationId, terminal) => {
      const execution = fakeExecutions.find((candidate) => candidate.execution_generation_id === executionGenerationId)!;
      execution.terminal = terminal;
    };
    const originalReplacementLoad = replacementInternals.store.load.bind(replacementInternals.store);
    let gateNextLoad = true;
    replacementInternals.store.load = async () => {
      if (gateNextLoad) {
        gateNextLoad = false;
        reachedTerminalLoad();
        await terminalLoadGate;
      }
      return originalReplacementLoad();
    };
    const staleTerminal = replacementInternals.providerTerminals.observeExit("binding_race", {
      endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "continuation_old",
    }, "daemon-provider", "execution_old", staleHandle);
    await terminalLoadReached;
    const successorBinding = await replacementBindings.bind({
      entry_id: "binding_race", room_id: "focus_37", work_attempt_id: "attempt_new",
      execution_generation_id: "execution_old", agent_session_id: "session_new",
      agent_session_token: "new-secret", api_url: "https://letagents.chat",
    });
    replacementInternals.liveHandles.set("binding_race", successorHandle);
    replacementInternals.workerRuntimeCustody.installLiveBinding("binding_race", {
      agentSessionId: successorBinding.agent_session_id,
      executionGenerationId: successorBinding.execution_generation_id,
      updatedAt: successorBinding.updated_at,
    });
    releaseTerminalLoad();
    await staleTerminal;
    const afterStaleTerminal = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])
      .find((candidate) => candidate.id === "binding_race")!;
    assert.equal(afterStaleTerminal.observed_state, "working", "a stale terminal callback cannot transition the successor manifest entry");
    assert.equal(afterStaleTerminal.provider_ref?.provider_continuation_id, "continuation_successor");
    assert.equal(replacementInternals.liveHandles.get("binding_race"), successorHandle, "the successor provider handle remains live");
    assert.equal(fakeExecutions[0]!.terminal, null, "the stale callback cannot terminalize the shared execution after its handle was replaced");
    assert.equal(fakeExecutions[1]!.terminal, null, "the successor execution remains live");

    releaseCommit();
    releaseBindingCommit();
    await Promise.all([lateMutation, lateBinding]);
    const listed = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.equal(listed.some((candidate) => candidate.id === "must_not_commit_after_handoff"), false);
    assert.doesNotMatch(await readFile(paths.auditPath, "utf8").catch(() => ""), /must_not_commit_after_handoff/);
    assert.equal((await replacementBindings.get("binding_race"))?.agent_session_id, "session_new", "a stale bind cannot overwrite its successor generation");
  } finally {
    releaseCommit();
    releaseBindingCommit();
    heldSocket?.destroy();
    await second?.stop();
    await env.cleanup();
  }
});

test("daemon control surface persists three-axis state, dual-axis liveness, and bounded activity", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const status = await daemonRequest(paths.socketPath, "daemon.status");
    assert.equal(status.ok, true);
    assert.equal((status.result as { generation: number }).generation, 1);
    assert.deepEqual((status.result as { recovery_diagnostics: unknown }).recovery_diagnostics, {
      daemon_inbox_wait_evidence_dependency: 0,
      lifecycle_projection: unavailableLifecycleProjectionDiagnostics(),
      lifecycle_capture_admission: { codex: "unavailable", "claude-code": "unavailable", cursor: "unavailable", "open-model": "unavailable" },
      lifecycle_local_conformance_eligible: { codex: false, "claude-code": false, cursor: false, "open-model": false },
    });
    const providerStreams = (daemon as unknown as {
      providerStreams: { acceptsLegacyWaitAuthority(entry: DaemonManifestEntry): boolean };
    }).providerStreams;
    assert.equal(providerStreams.acceptsLegacyWaitAuthority({ ...entry, delivery_mode: "daemon_inbox" }), false);
    const negotiated = await daemonRequest(paths.socketPath, "daemon.negotiate");
    assert.deepEqual((negotiated.result as { recovery_diagnostics: unknown }).recovery_diagnostics, {
      daemon_inbox_wait_evidence_dependency: 1,
      lifecycle_projection: unavailableLifecycleProjectionDiagnostics(),
      lifecycle_capture_admission: { codex: "unavailable", "claude-code": "unavailable", cursor: "unavailable", "open-model": "unavailable" },
      lifecycle_local_conformance_eligible: { codex: false, "claude-code": false, cursor: false, "open-model": false },
    });
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: { ...entry, workspace_path: "/tmp/work" } });
    assert.equal(put.ok, true);
    const listed = await daemonRequest(paths.socketPath, "manifest.list");
    const saved = (listed.result as DaemonManifestEntry[])[0];
    assert.equal(saved.desired_state, "running");
    assert.equal(saved.workplace_liveness?.state, "unknown");
    assert.equal(saved.native_liveness?.state, "unknown");
    const paused = await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: entry.id, desired_state: "paused" });
    assert.equal((paused.result as DaemonManifestEntry).desired_state, "paused");
    const event = { observed_at: "2026-01-01T00:00:01.000Z", sequence: 1, provider: "codex", kind: "turn_lifecycle", method: "turn/started", summary: "Working on the task", status: "working", payload: {}, payload_truncated: false, payload_redacted: true, durable_payload_ref: null };
    const active = await daemonRequest(paths.socketPath, "manifest.append_activity", { id: entry.id, event });
    assert.equal((active.result as DaemonManifestEntry).observed_state, "working");
    assert.equal((active.result as DaemonManifestEntry).native_liveness?.state, "active");
    await daemonRequest(paths.socketPath, "manifest.update_workplace_liveness", { id: entry.id, state: "reachable", detail: "heartbeat", observed_at: "2026-01-01T00:00:01.000Z" });
    const stale = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0];
    assert.equal(stale.workplace_liveness?.state, "stale");
    assert.equal(stale.native_liveness?.state, "stale");
    assert.equal(stale.observed_state, "working", "stale axes are a probe/suspect signal, never manufactured death");
    assert.equal(stale.condition, "none");
    const detail = await daemonRequest(paths.socketPath, "attempt.read", { id: entry.id });
    assert.equal((detail.result as { workspace_path: string | null }).workspace_path, null, "attempt.read never launders a manifest placeholder into durability authority");
    assert.equal((detail.result as { activity: unknown[] }).activity.length, 1);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("daemon ingress redacts provider credentials before manifest, DTO, and audit persistence", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const canary = "canary-not-a-real-credential-123456789";
  const workerBearer = `lasb_${"A".repeat(43)}`;
  const hostGrant = `lashg_${"b".repeat(43)}`;
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: { ...entry, id: "credential_firewall" } });
    const response = await daemonRequest(paths.socketPath, "manifest.append_activity", {
      id: "credential_firewall",
      event: {
        observed_at: "2026-01-01T00:00:01.000Z",
        sequence: 1,
        provider: "claude-code",
        kind: "tool_result",
        method: `tool/result Authorization: Bearer ${canary}`,
        summary: `LETAGENTS_TOKEN=${canary}`,
        status: "working",
        payload: {
          nested: [{ LETAGENTS_TOKEN: canary }, { api_key: canary }, { clientSecret: canary, dbPassword: canary, privateKey: canary, setCookie: canary }],
          json: JSON.stringify({ LETAGENTS_TOKEN: canary }),
          header: `Authorization: Bearer ${canary}`,
          basic: `Authorization: Basic ${canary}`,
          arbitraryAuthorization: `Authorization: ${canary}`,
          stringifiedHeaders: JSON.stringify({ bearer: `Authorization: Bearer ${canary}`, basic: `Authorization: Basic ${canary}`, arbitrary: `Authorization: ${canary}` }),
          stringifiedCamelCase: JSON.stringify({ clientSecret: canary, dbPassword: canary, privateKey: canary, setCookie: canary }),
          standaloneOwnedTokens: `worker=${workerBearer} host=${hostGrant}`,
          stringifiedOwnedTokens: JSON.stringify({ message: `${workerBearer} ${hostGrant}` }),
        },
        payload_truncated: false,
        payload_redacted: false,
        durable_payload_ref: `Authorization: Bearer ${canary}`,
      },
    });
    assert.equal(response.ok, true, response.error);
    const dto = response.result as DaemonManifestEntry;
    assert.equal(dto.activity?.[0]?.payload_redacted, true);
    assert.doesNotMatch(JSON.stringify(dto), new RegExp(canary));
    assert.doesNotMatch(JSON.stringify(dto), new RegExp(workerBearer));
    assert.doesNotMatch(JSON.stringify(dto), new RegExp(hostGrant));
    const inspection = new ManifestStore(paths.manifestPath);
    const persistedActivity = JSON.stringify(await inspection.load());
    await inspection.close();
    assert.doesNotMatch(persistedActivity, new RegExp(canary));
    assert.doesNotMatch(persistedActivity, new RegExp(workerBearer));
    assert.doesNotMatch(persistedActivity, new RegExp(hostGrant));

    await daemon.transition("credential_firewall", "failed", "coordination_blocked", `Authorization: Bearer ${canary}`, `LETAGENTS_TOKEN=${canary}`, {
      exit_timestamps_ms: [],
      consecutive_action_failures: 0,
      last_observed_state: "failed",
      next_restart_at_ms: null,
      completed_action_ids: [],
      last_action_sequence: 0,
      pending_action: null,
      last_terminal: {
        ended_at: "2026-01-01T00:00:02.000Z",
        exit_code: 1,
        signal: null,
        stdio_archive_ref: `LETAGENTS_TOKEN=${canary}`,
        stdio_tail: `Authorization: Bearer ${canary}`,
        terminal_cause: `OPENAI_API_KEY=${canary}`,
        actor: `LETAGENTS_TOKEN=${canary}`,
        generation: 1,
        provider_continuation_id: `Authorization: Bearer ${canary}`,
      },
    });
    const postTransitionInspection = new ManifestStore(paths.manifestPath);
    const persisted = JSON.stringify(await postTransitionInspection.load());
    await postTransitionInspection.close();
    assert.doesNotMatch(persisted, new RegExp(canary));
    assert.match(persisted, /REDACTED/);
    assert.doesNotMatch(await readFile(paths.auditPath, "utf8"), new RegExp(canary));
    assert.match(await readFile(paths.auditPath, "utf8"), /REDACTED/);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("concurrent Claude Code creation ids create independent durable owners", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  let daemon = new SupervisorDaemon(paths, "darwin");
  const candidate = (id: string): DaemonManifestEntry => ({
    ...entry,
    id,
    room_id: "focus_37",
    provider: "claude-code",
    desired_state: "paused",
    observed_state: "paused",
  });
  try {
    await daemon.start();
    const [firstCreate, secondCreate] = await Promise.all([
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("claude_alpha") }),
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("claude_bravo") }),
    ]);
    assert.equal(firstCreate.ok, true);
    assert.equal(secondCreate.ok, true);

    for (const id of ["claude_alpha", "claude_bravo"]) {
      assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
        id,
        desired_state: "running",
      })).ok, true);
    }
    const retry = await daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("claude_alpha") });
    assert.equal(retry.ok, true);
    assert.equal((retry.result as DaemonManifestEntry).desired_state, "running", "a stale creation retry cannot rewind lifecycle state");
    const conflictingRetry = await daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...candidate("claude_alpha"), charter: "different agent" },
    });
    assert.equal(conflictingRetry.ok, false);
    assert.match(conflictingRetry.error ?? "", /already bound to different agent parameters/);

    await daemon.stop();
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.equal(manifest.filter((item) => item.room_id === "focus_37" && item.provider === "claude-code").length, 2);
    assert.ok(manifest.every((item) => item.desired_state === "running"));
    assert.equal((await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_blocked_by_any_supervised", room_id: "focus_37", provider: "claude-code", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    })).ok, false, "any active supervised Claude agent keeps the legacy provider engine fenced out");
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("distinct supervised Codex entries coexist in one room without weakening legacy fencing", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  let daemon = new SupervisorDaemon(paths, "darwin");
  const candidate = (id: string): DaemonManifestEntry => ({
    ...entry,
    id,
    room_id: "codex_roundtable",
    provider: "codex",
    desired_state: "paused",
    observed_state: "paused",
  });
  try {
    await daemon.start();
    const [firstCreate, secondCreate] = await Promise.all([
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("codex_alpha") }),
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("codex_bravo") }),
    ]);
    assert.equal(firstCreate.ok, true);
    assert.equal(secondCreate.ok, true);
    assert.equal(((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[]).length, 2);

    const firstResume = await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "codex_alpha", expected_desired_state: "paused", desired_state: "running",
    });
    assert.equal((firstResume.result as { applied: boolean }).applied, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "codex_bravo", desired_state: "running",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "codex_alpha", desired_state: "paused",
    })).ok, true);
    const resumedAgain = await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "codex_alpha", expected_desired_state: "paused", desired_state: "running",
    });
    assert.equal((resumedAgain.result as { applied: boolean }).applied, true);

    const retried = await daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("codex_alpha") });
    assert.equal(retried.ok, true);
    assert.equal((retried.result as DaemonManifestEntry).desired_state, "running", "same entry retries remain idempotent and never rewind its lifecycle");

    await daemon.stop();
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    const afterRestart = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.equal(afterRestart.filter((item) => item.room_id === "codex_roundtable" && item.provider === "codex").length, 2);
    assert.ok(afterRestart.every((item) => item.desired_state === "running"), "restart preserves multiple Codex owners instead of quarantining them");

    const blockedLegacy = await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_codex_roundtable", room_id: "codex_roundtable", provider: "codex", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    });
    assert.equal(blockedLegacy.ok, false, "any live supervised Codex entry continues to fence the legacy Electron runtime");
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

for (const modeCase of ["mcp_polling", "daemon_inbox", "custodial_polling_v1"] as const) {
const custodial = modeCase === "custodial_polling_v1";
const deliveryMode = modeCase === "daemon_inbox" ? "daemon_inbox" : "mcp_polling";
const expectedReadyState = deliveryMode === "daemon_inbox" ? "idle" : "working";
test(`two Codex room agents keep independent provider executions across stop, resume, and daemon handoff (${modeCase})`, async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const sources = await Promise.all([
    committedSourceRepository(env.root, "multi-codex-alpha-source"),
    committedSourceRepository(env.root, "multi-codex-bravo-source"),
  ]);
  // Prime only the shared immutable clone. Each agent must still ask the
  // daemon to derive and provision its own work attempt from source_repo_path.
  await Promise.all(sources.map((source) => primeDaemonBareRepository(env.root, source)));
  const identities = [
    { entryId: "codex_runtime_alpha" },
    { entryId: "codex_runtime_bravo" },
  ] as const;

  type RuntimeState = "starting" | "working" | "idle" | "stopping" | "stopped" | "failed";
  type Runtime = {
    workAttemptId: string;
    pid: number;
    continuation: string;
    state: RuntimeState;
    exitListeners: Set<(terminal: {
      endedAt: string; exitCode: number | null; signal: string | null;
      terminalCause: "stopped"; providerContinuationId: string;
    }) => void>;
  };
  const runtimes = new Map<string, Runtime>();
  type ProviderIdentityTuple = [workAttemptId: string, continuation: string, url: string, pid: number, processIdentity: string];
  const spawnRequests: Array<[entryId: string, workAttemptId: string]> = [];
  const attachRequests: ProviderIdentityTuple[] = [];
  const resumeRequests: Array<[entryId: string, workAttemptId: string, continuation: string]> = [];
  const stopRequests: string[] = [];
  const deliveredTurns: Array<{ workAttemptId: string; turnId: string }> = [];
  let nextPid = 6100;
  const nativeHandle = (runtime: Runtime) => ({
    workAttemptId: runtime.workAttemptId,
    pid: runtime.pid,
    providerContinuationId: runtime.continuation,
    providerConnection: {
      kind: "codex_app_server" as const,
      url: `ws://127.0.0.1:${runtime.pid}`,
      pid: runtime.pid,
      processIdentity: `fake-codex:${runtime.pid}`,
    },
    observedState: () => runtime.state,
  });
  const connectionFor = (runtime: Runtime) => nativeHandle(runtime).providerConnection;
  const identityTuple = (runtime: Runtime): ProviderIdentityTuple => {
    const connection = connectionFor(runtime);
    return [runtime.workAttemptId, runtime.continuation, connection.url, connection.pid, connection.processIdentity];
  };
  const adapter: NativeProviderAdapter = {
    capabilities: () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (request) => {
      spawnRequests.push([request.supervisorEntryId ?? "missing-entry", request.workAttemptId]);
      const runtime: Runtime = {
        workAttemptId: request.workAttemptId,
        pid: ++nextPid,
        continuation: `thread_${request.supervisorEntryId}`,
        state: "working",
        exitListeners: new Set(),
      };
      runtimes.set(runtime.workAttemptId, runtime);
      return nativeHandle(runtime);
    },
    attach: async (ref) => {
      const runtime = runtimes.get(ref.workAttemptId);
      const connection = ref.providerConnection;
      attachRequests.push([
        ref.workAttemptId,
        ref.providerContinuationId,
        connection?.kind === "codex_app_server" ? connection.url : "missing-url",
        connection?.pid ?? -1,
        connection?.processIdentity ?? "missing-process-identity",
      ]);
      const expected = runtime ? connectionFor(runtime) : null;
      if (
        !runtime
        || runtime.state === "stopped"
        || runtime.continuation !== ref.providerContinuationId
        || connection?.kind !== "codex_app_server"
        || connection.url !== expected?.url
        || connection.pid !== expected.pid
        || connection.processIdentity !== expected.processIdentity
      ) return null;
      return nativeHandle(runtime);
    },
    resume: async (ref, request) => {
      resumeRequests.push([request.supervisorEntryId ?? "missing-entry", request.workAttemptId, ref.providerContinuationId]);
      const runtime: Runtime = {
        workAttemptId: request.workAttemptId,
        pid: ++nextPid,
        continuation: ref.providerContinuationId,
        state: "working",
        exitListeners: new Set(),
      };
      runtimes.set(runtime.workAttemptId, runtime);
      return nativeHandle(runtime);
    },
    poke: async () => {},
    controlTurn: async () => ({ capability: "native_interrupt", interrupted: true, resumed: true, state: "working" }),
    stop: async (handle) => {
      stopRequests.push(handle.workAttemptId);
      const runtime = runtimes.get(handle.workAttemptId)!;
      runtime.state = "stopped";
      const terminal = {
        endedAt: new Date().toISOString(), exitCode: 0, signal: null,
        terminalCause: "stopped" as const, providerContinuationId: runtime.continuation,
      };
      queueMicrotask(() => {
        for (const listener of [...runtime.exitListeners]) listener(terminal);
      });
      return terminal;
    },
    onExit: (handle, listener) => {
      const listeners = runtimes.get(handle.workAttemptId)!.exitListeners;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    runRoomTurn: async (handle, request, options) => {
      const runtime = runtimes.get(handle.workAttemptId)!;
      assert.notEqual(runtime.state, "stopped");
      assert.equal(handle.pid, runtime.pid);
      assert.equal(handle.providerContinuationId, runtime.continuation);
      assert.deepEqual(handle.providerConnection, connectionFor(runtime));
      const turnId = `native_${(request.sourceMessage as { id: string }).id}`;
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.(turnId);
      deliveredTurns.push({ workAttemptId: handle.workAttemptId, turnId });
      return { turnId, outcome: "no_reply", text: null };
    },
    onStream: () => () => {},
    onExecution: (handle, listener) => runtimeReadySubscription(handle, listener),
  };
  const router = () => new ProviderActionPortRouter({ codex: async () => adapter });
  let activeRouter = router();
  let tailReads = 0;
  const polls: Array<{ bearer: string; afterMessageId: string | null }> = [];
  const pendingPolls = new Map<string, (response: Awaited<ReturnType<SupervisedDeliveryHttp["poll"]>>) => void>();
  const createDaemon = () => {
    const instance = new SupervisorDaemon(paths, "darwin", activeRouter, true, 15_000, undefined, {}, {
      latest: async () => { tailReads += 1; return { messages: [{ id: "msg_41" }] }; },
      poll: ({ signal, bearer, afterMessageId }) => new Promise((resolve) => {
        polls.push({ bearer, afterMessageId });
        pendingPolls.set(bearer, resolve);
        if (signal.aborted) resolve({ messages: [] });
        else signal.addEventListener("abort", () => {
          if (pendingPolls.get(bearer) === resolve) pendingPolls.delete(bearer);
          resolve({ messages: [] });
        }, { once: true });
      }),
      publish: async () => {},
    }, {
      createWorkerSession: async ({ agentInstanceId }) => ({
        sessionId: `session_${agentInstanceId.replace(/:/g, "_")}`,
        bearer: randomUUID(), bearerId: randomUUID(), expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    });
    // Native presence publication is not the readiness proof under test.
    // No provider stream/wait events or manual worker binds are supplied.
    (instance as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    return instance;
  };
  let daemon = createDaemon();
  const installGrants = async () => {
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    for (const { entryId } of identities) {
      const installed = await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
        entry_id: entryId, room_id: "codex_runtime_roundtable", agent_key: `owner/${entryId}`,
        grant_id: `grant_${entryId}_${generation}`, supervisor_grant: `grant-secret-${entryId}`,
        grant_generation: generation, api_url: "http://127.0.0.1:9", daemon_generation: generation,
        host_id: "host-test", installation_id: "installation-test", grant_expires_at: "2099-01-01T00:00:00.000Z",
      });
      assert.equal(installed.ok, true, installed.error);
    }
  };
  const assertOwnedBindings = async (manifest: DaemonManifestEntry[]) => {
    assert.ok(manifest.every((current) => (current.delivery_mode ?? "mcp_polling") === deliveryMode));
    if (deliveryMode !== "daemon_inbox" && !custodial) return;
    const internals = daemon as unknown as {
      workerBindings: WorkerBindingStore;
      supervisedInbox: SupervisedAgentInboxStore;
      providerStreams: { recoveryDiagnostics(): ProviderRecoveryDiagnostics };
    };
    for (const current of manifest) {
      await eventually(async () => {
        const observed = await internals.workerBindings.get(current.id);
        return observed?.execution_generation_id === current.provider_ref?.execution_generation_id
          && Boolean(observed && await internals.workerBindings.credentialFor(observed));
      }, "exact restored worker binding becomes usable");
      const binding = await internals.workerBindings.get(current.id);
      assert.equal(current.condition, "none", "owned readiness cannot retain a legacy wait latch");
      assert.equal(binding?.room_id, current.room_id);
      assert.equal(binding?.work_attempt_id, current.work_attempt_id);
      assert.equal(binding?.execution_generation_id, current.provider_ref?.execution_generation_id);
      assert.equal(binding?.agent_session_id, `session_daemon_${current.id}`);
      const credential = binding && await internals.workerBindings.credentialFor(binding);
      assert.ok(credential, "the current generation has a usable in-memory worker credential");
      if (custodial) {
        assert.equal(binding?.room_cursor, "msg_47", "restart/remint preserves the latest acknowledged polling cursor");
        assert.equal(polls.length, 0, "custodial grant recovery must not start daemon inbox delivery");
        const daemonGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
        const admitted = await daemonRequest(paths.socketPath, "supervisor.authorize_custodial_polling", {
          entry_id: current.id, room_id: current.room_id, work_attempt_id: current.work_attempt_id,
          execution_generation_id: current.provider_ref!.execution_generation_id, agent_session_id: binding!.agent_session_id,
          daemon_generation: daemonGeneration, api_url: "http://127.0.0.1:9", contract: "custodial_polling_v1",
          phase: "before", tool_name: "read_messages",
        });
        assert.equal(admitted.ok, false, "grant recovery cannot activate a dormant custodial runtime");
        assert.match(admitted.error ?? "", /activation/);
        continue;
      }
      await eventually(async () => polls.some((poll) => poll.bearer === credential && poll.afterMessageId === "msg_41"),
        "owned ingress uses the exact restored credential and existing cursor");
      const cursor = await internals.supervisedInbox.cursor(current.id);
      assert.equal(cursor?.room_id, current.room_id);
      assert.equal(cursor?.last_observed_message_id, "msg_41", "recovery does not reset the admitted room cursor");
    }
    assert.equal(internals.providerStreams.recoveryDiagnostics().daemon_inbox_wait_evidence_dependency, 0);
  };
  try {
    await daemon.start();
    const entries = identities.map(({ entryId }, index): DaemonManifestEntry => ({
      ...entry,
      id: entryId,
      room_id: "codex_runtime_roundtable",
      provider: "codex",
      delivery_mode: deliveryMode,
      desired_state: "paused",
      observed_state: "paused",
      source_repo_path: sources[index],
      workspace_path: null,
      work_attempt_id: null,
    }));
    const created = await Promise.all(entries.map((candidate) =>
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate })));
    assert.ok(created.every((result) => result.ok));
    if (deliveryMode === "daemon_inbox") {
      await installGrants();
      const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
      for (const candidate of entries) {
        const admitted = await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
          entry_id: candidate.id, daemon_generation: generation,
        });
        assert.equal(admitted.ok, true, admitted.error);
      }
      assert.equal(tailReads, 2);
    }

    const activated = await Promise.all(entries.map((candidate) =>
      daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
        id: candidate.id, expected_desired_state: "paused", desired_state: "running",
      })));
    assert.ok(activated.every((result) => result.ok && (result.result as { applied: boolean }).applied));
    try {
      await eventually(async () => {
        const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
        return manifest.length === 2 && manifest.every((candidate) => candidate.observed_state === expectedReadyState
          && candidate.condition === "none");
      }, "both Codex provider executions", 5_000);
    } catch (error) {
      const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result;
      throw new Error(`${(error as Error).message}: ${JSON.stringify(manifest)}`);
    }

    const beforeRestart = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    if (custodial) {
      // Dormant prerequisite fixture only: install the persisted contract and
      // an exact acknowledged boundary. This is not a production mode switch.
      const db = new DatabaseSync(paths.manifestPath);
      try { db.exec("UPDATE agent_configurations SET polling_contract='custodial_polling_v1'"); }
      finally { db.close(); }
      const durability = (daemon as unknown as { durability: WorkDurabilityStore }).durability;
      for (const current of beforeRestart) await durability.checkpoint(current.work_attempt_id!, {
        room_cursor: "msg_47", provider_continuation_id: current.provider_ref!.provider_continuation_id,
      });
      await installGrants();
      const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
      for (const current of beforeRestart) {
        const params = {
          entry_id: current.id, room_id: current.room_id, work_attempt_id: current.work_attempt_id,
          execution_generation_id: current.provider_ref!.execution_generation_id, agent_session_id: `session_daemon_${current.id}`,
          daemon_generation: generation, api_url: "http://127.0.0.1:9", contract: "custodial_polling_v1",
          phase: "before", tool_name: "wait_for_messages",
          process_incarnation_id: "01234567-89ab-4cde-8f01-23456789abcd", mcp_request_id: 1, room_cursor: "msg_47",
        };
        const admitted = await daemonRequest(paths.socketPath, "supervisor.authorize_custodial_polling", params);
        assert.equal(admitted.ok, false, "changing the contract does not authorize native work");
        assert.match(admitted.error ?? "", /activation/);
        // Active expiry/revision/identity tests now live beside the explicit
        // activation gate in worker-authority-coordinator.test.ts. This older
        // fixture proves only dormant grant/worker recovery, not activation.
        const released = await daemonRequest(paths.socketPath, "supervisor.authorize_custodial_polling", {
          ...params, phase: "release", expected_configuration_revision: 1,
          expected_activation_id: "unactivated", expected_binding_epoch: 1,
          input_cursor: "msg_47", offered_frontier: "msg_48",
        });
        assert.equal(released.ok, false);
        assert.match(released.error ?? "", /activation/);
        assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
          ...params, room_cursor: "msg_48",
        })).ok, false, "dormant processes cannot advance the acknowledged cursor");
      }
    }
    await assertOwnedBindings(beforeRestart);
    const alphaBefore = beforeRestart.find((candidate) => candidate.id === identities[0].entryId)!;
    const bravoBefore = beforeRestart.find((candidate) => candidate.id === identities[1].entryId)!;
    assert.equal(spawnRequests.length, 2);
    assert.deepEqual(
      [...spawnRequests].sort(([left], [right]) => left.localeCompare(right)),
      [
        [identities[0].entryId, alphaBefore.work_attempt_id],
        [identities[1].entryId, bravoBefore.work_attempt_id],
      ],
    );
    assert.equal(alphaBefore.source_repo_path, sources[0]);
    assert.equal(bravoBefore.source_repo_path, sources[1]);
    assert.ok(alphaBefore.workspace_path?.startsWith(join(env.root, "worktrees")));
    assert.ok(bravoBefore.workspace_path?.startsWith(join(env.root, "worktrees")));
    assert.notEqual(alphaBefore.workspace_path, bravoBefore.workspace_path);
    assert.notEqual(alphaBefore.work_attempt_id, bravoBefore.work_attempt_id);
    assert.notEqual(alphaBefore.provider_ref?.execution_generation_id, bravoBefore.provider_ref?.execution_generation_id);
    assert.notEqual(alphaBefore.provider_ref?.provider_continuation_id, bravoBefore.provider_ref?.provider_continuation_id);
    assert.notEqual(alphaBefore.provider_ref?.provider_connection?.pid, bravoBefore.provider_ref?.provider_connection?.pid);

    const alphaConnection = alphaBefore.provider_ref?.provider_connection;
    const bravoConnection = bravoBefore.provider_ref?.provider_connection;
    assert.equal(alphaConnection?.kind, "codex_app_server");
    assert.equal(bravoConnection?.kind, "codex_app_server");
    const crossWire = await activeRouter.attach({
      workAttemptId: alphaBefore.work_attempt_id!,
      providerContinuationId: alphaBefore.provider_ref!.provider_continuation_id,
      provider: "codex",
      providerConnection: bravoConnection,
    });
    assert.equal(crossWire, null, "matching attempt and continuation cannot attach through another agent's provider connection");
    assert.equal(attachRequests.length, 0, "the production router rejects a cross-wired ref before the adapter can attach it");

    const handoff = daemon.waitForHandoff();
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    await within(handoff, "multi-agent daemon handoff", 1_000);
    activeRouter = router();
    daemon = createDaemon();
    await daemon.start();
    if (deliveryMode === "daemon_inbox" || custodial) await installGrants();
    await eventually(async () => {
      const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
      return manifest.length === 2
        && manifest.every((candidate) => candidate.observed_state === expectedReadyState && candidate.condition === "none")
        && attachRequests.length === 2;
    }, "independent Codex provider reattachment", 5_000);
    assert.equal(attachRequests.length, 2);
    assert.deepEqual(
      [...attachRequests].sort(([left], [right]) => left.localeCompare(right)),
      [
        identityTuple(runtimes.get(alphaBefore.work_attempt_id!)!),
        identityTuple(runtimes.get(bravoBefore.work_attempt_id!)!),
      ].sort(([left], [right]) => left.localeCompare(right)),
    );
    const afterRestart = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    await assertOwnedBindings(afterRestart);
    for (const prior of beforeRestart) {
      const reattached = afterRestart.find((candidate) => candidate.id === prior.id)!;
      assert.equal(reattached.work_attempt_id, prior.work_attempt_id);
      assert.equal(reattached.provider_ref?.execution_generation_id, prior.provider_ref?.execution_generation_id);
      assert.equal(reattached.provider_ref?.provider_continuation_id, prior.provider_ref?.provider_continuation_id);
      assert.equal(reattached.provider_ref?.provider_connection?.pid, prior.provider_ref?.provider_connection?.pid);
    }
    type AttemptDetail = {
      work_attempt_id: string;
      execution_generations: Array<{ execution_generation_id: string; terminal: unknown }>;
    };
    const attemptDetail = async (entryId: string) =>
      (await daemonRequest(paths.socketPath, "attempt.read", { id: entryId })).result as AttemptDetail;
    const alphaAfterRestartAttempt = await attemptDetail(alphaBefore.id);
    const bravoAfterRestartAttempt = await attemptDetail(bravoBefore.id);
    for (const [manifestEntry, detail] of [
      [alphaBefore, alphaAfterRestartAttempt],
      [bravoBefore, bravoAfterRestartAttempt],
    ] as const) {
      assert.equal(detail.work_attempt_id, manifestEntry.work_attempt_id);
      assert.equal(detail.execution_generations.length, 1);
      assert.equal(detail.execution_generations[0]?.execution_generation_id, manifestEntry.provider_ref?.execution_generation_id);
      assert.equal(detail.execution_generations[0]?.terminal, null);
    }

    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: identities[0].entryId, desired_state: "paused",
    })).ok, true);
    await eventually(async () => {
      const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
      return manifest.find((candidate) => candidate.id === identities[0].entryId)?.observed_state === "paused";
    }, "independent Codex pause", 5_000);
    const bravoWhileAlphaPaused = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])
      .find((candidate) => candidate.id === identities[1].entryId)!;
    assert.equal(bravoWhileAlphaPaused.observed_state, expectedReadyState);
    assert.equal(bravoWhileAlphaPaused.provider_ref?.execution_generation_id, bravoBefore.provider_ref?.execution_generation_id);
    assert.equal(runtimes.get(bravoBefore.work_attempt_id!)?.state, "working");
    assert.deepEqual(stopRequests, [alphaBefore.work_attempt_id]);

    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: identities[0].entryId, desired_state: "running",
    })).ok, true);
    await eventually(async () => {
      const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
      const current = manifest.find((candidate) => candidate.id === identities[0].entryId);
      return current?.observed_state === expectedReadyState && current.condition === "none";
    }, "independent Codex resume", 5_000);
    const afterResume = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    await assertOwnedBindings(afterResume);
    assert.equal(tailReads, deliveryMode === "daemon_inbox" ? 2 : 0,
      "restart and native resume never bootstrap a new room tail");
    const alphaAfter = afterResume.find((candidate) => candidate.id === identities[0].entryId)!;
    const bravoAfter = afterResume.find((candidate) => candidate.id === identities[1].entryId)!;
    assert.equal(resumeRequests.length, 1);
    assert.deepEqual(resumeRequests, [[
      identities[0].entryId,
      alphaBefore.work_attempt_id,
      alphaBefore.provider_ref!.provider_continuation_id,
    ]]);
    assert.equal(alphaAfter.work_attempt_id, alphaBefore.work_attempt_id);
    assert.notEqual(alphaAfter.provider_ref?.execution_generation_id, alphaBefore.provider_ref?.execution_generation_id);
    assert.notEqual(alphaAfter.provider_ref?.provider_connection?.pid, alphaBefore.provider_ref?.provider_connection?.pid);
    assert.equal(bravoAfter.provider_ref?.execution_generation_id, bravoBefore.provider_ref?.execution_generation_id);
    assert.equal(bravoAfter.provider_ref?.provider_connection?.pid, bravoBefore.provider_ref?.provider_connection?.pid);
    const alphaAfterResumeAttempt = await attemptDetail(alphaAfter.id);
    const bravoAfterAlphaResumeAttempt = await attemptDetail(bravoAfter.id);
    assert.equal(alphaAfterResumeAttempt.execution_generations.length, 2);
    assert.notEqual(alphaAfter.provider_ref?.execution_generation_id, alphaBefore.provider_ref?.execution_generation_id);
    assert.ok(alphaAfterResumeAttempt.execution_generations.find((generation) =>
      generation.execution_generation_id === alphaBefore.provider_ref?.execution_generation_id)?.terminal);
    assert.equal(alphaAfterResumeAttempt.execution_generations.find((generation) =>
      generation.execution_generation_id === alphaAfter.provider_ref?.execution_generation_id)?.terminal, null);
    assert.deepEqual(bravoAfterAlphaResumeAttempt.execution_generations, bravoAfterRestartAttempt.execution_generations);
    assert.equal(bravoAfterAlphaResumeAttempt.execution_generations.length, 1);
    assert.equal(bravoAfterAlphaResumeAttempt.execution_generations[0]?.execution_generation_id, bravoBefore.provider_ref?.execution_generation_id);
    assert.equal(bravoAfterAlphaResumeAttempt.execution_generations[0]?.terminal, null);
    if (deliveryMode === "daemon_inbox") {
      const internals = daemon as unknown as { workerBindings: WorkerBindingStore; supervisedInbox: SupervisedAgentInboxStore };
      const binding = await internals.workerBindings.get(alphaAfter.id);
      const credential = await internals.workerBindings.credentialFor(binding!);
      let resolvePoll: ((response: Awaited<ReturnType<SupervisedDeliveryHttp["poll"]>>) => void) | undefined;
      await eventually(async () => Boolean(resolvePoll = pendingPolls.get(credential!)),
        "the recovered worker has an active exact-credential poll");
      assert(resolvePoll);
      resolvePoll({ messages: [{ id: "msg_42", text: "assess the project", source: "human",
        activation: { for_current_agent: { decision: "activate", reason: "explicit_mention", addressed: true } },
      }], last_observed_message_id: "msg_42" });
      await eventually(async () => (await internals.supervisedInbox.getBySourceMessage(
        alphaAfter.id, alphaAfter.room_id, "msg_42",
      ))?.state === "acknowledged_no_reply", "a post-recovery message reaches and settles the exact native turn");
      const receipt = await internals.supervisedInbox.getBySourceMessage(alphaAfter.id, alphaAfter.room_id, "msg_42");
      const turnBinding = await internals.supervisedInbox.providerTurnBinding(receipt!.inbox_item_id);
      assert.equal(turnBinding?.origin_execution_generation_id, alphaAfter.provider_ref?.execution_generation_id);
      assert.equal(turnBinding?.provider_turn_id, "native_msg_42");
      assert.deepEqual(deliveredTurns, [{ workAttemptId: alphaAfter.work_attempt_id, turnId: "native_msg_42" }]);
      assert.equal((await internals.supervisedInbox.cursor(alphaAfter.id))?.last_observed_message_id, "msg_42");
      assert.equal((await internals.supervisedInbox.cursor(bravoAfter.id))?.last_observed_message_id, "msg_41");
    }
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});
}

test("two supervised Codex claims wait together behind one legacy Codex owner", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const sources = await Promise.all([
    committedSourceRepository(env.root, "legacy-handoff-alpha-source"),
    committedSourceRepository(env.root, "legacy-handoff-bravo-source"),
  ]);
  await Promise.all(sources.map((source) => primeDaemonBareRepository(env.root, source)));
  const spawned: Array<[entryId: string, workAttemptId: string]> = [];
  let nextPid = 7100;
  const adapter: NativeProviderAdapter = {
    capabilities: () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (request) => {
      spawned.push([request.supervisorEntryId ?? "missing-entry", request.workAttemptId]);
      const pid = ++nextPid;
      return {
        workAttemptId: request.workAttemptId,
        pid,
        providerContinuationId: `thread_${request.supervisorEntryId}`,
        providerConnection: { kind: "codex_app_server", url: `ws://127.0.0.1:${pid}`, pid, processIdentity: `fake-codex:${pid}` },
        observedState: () => "working",
      };
    },
    attach: async () => null,
    resume: async () => { throw new Error("legacy release activates fresh Codex agents"); },
    poke: async () => {},
    controlTurn: async () => ({ capability: "native_interrupt", interrupted: true, resumed: true, state: "working" }),
    stop: async (handle) => ({
      endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId,
    }),
    onExit: () => () => {},
    onStream: () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", new ProviderActionPortRouter({ codex: async () => adapter }), true);
  const candidate = (id: string): DaemonManifestEntry => ({
    ...entry,
    id,
    room_id: "codex_legacy_handoff",
    provider: "codex",
    desired_state: "paused",
    observed_state: "paused",
    source_repo_path: id.endsWith("alpha") ? sources[0] : sources[1],
    workspace_path: null,
    work_attempt_id: null,
  });
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_codex_owner", room_id: "codex_legacy_handoff", provider: "codex",
      owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    })).ok, true);
    const created = await Promise.all(["codex_waiting_alpha", "codex_waiting_bravo"].map((id) =>
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate(id) })));
    assert.ok(created.every((result) => result.ok), "both paused supervised claims may be saved during legacy teardown");

    const blocked = await Promise.all(["codex_waiting_alpha", "codex_waiting_bravo"].map((id) =>
      daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
        id, expected_desired_state: "paused", desired_state: "running",
      })));
    assert.ok(blocked.every((result) => !result.ok && /legacy reservation/.test(result.error ?? "")));
    assert.equal((await daemonRequest(paths.socketPath, "lane.release_legacy", { reservation_id: "legacy_codex_owner" })).ok, true);

    const activated = await Promise.all(["codex_waiting_alpha", "codex_waiting_bravo"].map((id) =>
      daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
        id, expected_desired_state: "paused", desired_state: "running",
      })));
    assert.ok(activated.every((result) => result.ok && (result.result as { applied: boolean }).applied));
    await eventually(async () => {
      const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
      return manifest.length === 2 && manifest.every((item) => item.desired_state === "running" && item.observed_state === "working");
    }, "both Codex providers after legacy release", 5_000);
    const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    const alpha = manifest.find((item) => item.id === "codex_waiting_alpha")!;
    const bravo = manifest.find((item) => item.id === "codex_waiting_bravo")!;
    assert.equal(spawned.length, 2);
    assert.deepEqual([...spawned].sort(([left], [right]) => left.localeCompare(right)), [
      [alpha.id, alpha.work_attempt_id],
      [bravo.id, bravo.work_attempt_id],
    ]);
    assert.notEqual(alpha.work_attempt_id, bravo.work_attempt_id);
    assert.notEqual(alpha.provider_ref?.execution_generation_id, bravo.provider_ref?.execution_generation_id);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("daemon restart preserves multiple isolated Cursor owners from older manifests", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const duplicate = (id: string): DaemonManifestEntry => ({
    ...entry,
    id,
    room_id: "room_upgrade_duplicate",
    provider: "cursor",
    desired_state: "paused",
    observed_state: "paused",
  });
  await new ManifestStore(paths.manifestPath).write(0, [duplicate("old_owner_a"), duplicate("old_owner_b")]);
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.equal(manifest.length, 2);
    assert.ok(manifest.every((item) => item.desired_state === "paused"));
    assert.ok(manifest.every((item) => !item.last_error?.includes("multiple supervised agents")));
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...duplicate("replacement"), desired_state: "paused", observed_state: "paused" },
    })).ok, true, "each Cursor entry owns an isolated profile and continuation");
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("idle daemon-inbox Cursor resumes the same durable execution after restart without duplicate spawn", async () => {
  const env = await fixture();
  const id = "cursor_idle_restart";
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({
    taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id,
  });
  await durability.close();

  const continuation = "cursor-session-durable";
  const idleHandle = {
    workAttemptId: attempt.work_attempt_id,
    pid: null,
    providerContinuationId: continuation,
    providerConnection: { kind: "cursor_cli" as const, pid: null, processIdentity: null },
    observedState: "idle" as const,
  };
  let spawns = 0;
  let resumes = 0;
  let firstExecutionGenerationId = "";
  const port = (): ProviderActionPort => ({
    capabilities: async () => ({
      deliveryModes: ["daemon_inbox"], resume: true, midTurnInjection: false,
      transcriptAccess: false, permissionPromptBridging: false, survivesRestart: true,
      turnControl: "restart_resume",
    }),
    spawn: async () => { spawns += 1; return idleHandle; },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async (ref) => {
      resumes += 1;
      assert.equal(ref.workAttemptId, attempt.work_attempt_id);
      assert.equal(ref.providerContinuationId, continuation);
      assert.deepEqual(ref.providerConnection, idleHandle.providerConnection);
      return idleHandle;
    },
    poke: async () => {},
    stop: async () => ({
      endedAt: new Date().toISOString(), exitCode: 0, signal: null,
      terminalCause: "stopped", providerContinuationId: continuation,
    }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  });
  const deliveryHttp: SupervisedDeliveryHttp = {
    poll: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ messages: [] }), { once: true });
    }),
    publish: async () => {},
  };
  const workers = {
    createWorkerSession: async () => ({
      sessionId: "cursor-restart-session", bearer: randomUUID(), bearerId: randomUUID(),
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
  };
  let first: SupervisorDaemon | null = new SupervisorDaemon(paths, "darwin", port(), true, 15_000, undefined, {}, deliveryHttp, workers);
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    (first as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "cursor", delivery_mode: "daemon_inbox", observed_state: "absent",
      permission_profile_id: "read_only", workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await admitDaemonInboxForProviderTest(first, id, entry.room_id);
    const firstGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id, room_id: entry.room_id, agent_key: "owner/cursor", grant_id: "grant-cursor-first",
      supervisor_grant: "cursor-first-grant", grant_generation: 1, api_url: "https://letagents.example",
      daemon_generation: firstGeneration, host_id: "host-cursor", installation_id: "installation-cursor",
      grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0];
      firstExecutionGenerationId = current?.provider_ref?.execution_generation_id ?? "";
      return current?.observed_state === "idle" && Boolean(firstExecutionGenerationId);
    }, "initial process-less Cursor lane", 8_000);
    assert.equal(spawns, 1);
    assert.equal(resumes, 0);
    const before = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as {
      execution_generations: Array<{ execution_generation_id: string; terminal: unknown }>;
    };
    assert.equal(before.execution_generations.length, 1);
    assert.equal(before.execution_generations[0]?.terminal, null);

    await first.stop();
    first = null;
    second = new SupervisorDaemon(paths, "darwin", port(), true, 15_000, undefined, {}, deliveryHttp, workers);
    await second.start();
    (second as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const secondGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id, room_id: entry.room_id, agent_key: "owner/cursor", grant_id: "grant-cursor-second",
      supervisor_grant: "cursor-second-grant", grant_generation: 2, api_url: "https://letagents.example",
      daemon_generation: secondGeneration, host_id: "host-cursor", installation_id: "installation-cursor",
      grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    try {
      await eventually(async () => {
        const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0];
        return current?.observed_state === "idle" && resumes === 1;
      }, "restarted Cursor lane resumes", 8_000);
    } catch (error) {
      const current = (await daemonRequest(paths.socketPath, "manifest.list")).result;
      const durable = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result;
      throw new Error(`${error instanceof Error ? error.message : String(error)}; spawns=${spawns}; resumes=${resumes}; manifest=${JSON.stringify(current)}; attempt=${JSON.stringify(durable)}`);
    }
    const after = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as {
      execution_generations: Array<{ execution_generation_id: string; terminal: unknown }>;
    };
    assert.equal(spawns, 1, "restart must not redispatch a fresh Cursor continuation");
    assert.equal(resumes, 1, "restart performs exactly one native continuation resume");
    assert.equal(after.execution_generations.length, 1, "process-less restart reuses the active execution generation");
    assert.equal(after.execution_generations[0]?.execution_generation_id, firstExecutionGenerationId);
    assert.equal(after.execution_generations[0]?.terminal, null);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(resumes, 1, "repeated convergence cannot kill or duplicate the healthy idle Cursor lane");
  } finally {
    await second?.stop().catch(() => undefined);
    await first?.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("Cursor bounded effects and credential borrowing reject a prior provider-turn capability", async () => {
  const env = await fixture();
  const id = "cursor_turn_capability";
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const workspace = await provisionedWorkspace(env.root, id);
  const providerNeutralId = "provider_neutral_effect";
  const providerNeutralWorkspace = await provisionedWorkspace(env.root, providerNeutralId);
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  const providerNeutralAttempt = await durability.createAttempt({
    taskId: providerNeutralId, leaseId: providerNeutralId, leaseEpoch: 0,
    workspacePath: providerNeutralWorkspace.path, workAttemptId: providerNeutralWorkspace.id,
  });
  await durability.close();
  const handle = {
    workAttemptId: attempt.work_attempt_id, pid: null, providerContinuationId: "cursor-cap-session",
    providerConnection: { kind: "cursor_cli" as const, pid: null, processIdentity: null }, observedState: "working" as const,
  };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { throw new Error("capability test does not launch a provider"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("capability test does not resume a provider"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const executedTools: Array<Record<string, unknown>> = [];
  let releaseDisconnectedRead!: () => void;
  const disconnectedReadGate = new Promise<void>((resolve) => { releaseDisconnectedRead = resolve; });
  let releaseHandoffRead!: () => void;
  const handoffReadGate = new Promise<void>((resolve) => { releaseHandoffRead = resolve; });
  const toolRuntime = {
    supervisedToolIsMutation: (toolName: string) => toolName !== "get_board",
    executeDaemonTool: async (input: Record<string, unknown>) => {
      executedTools.push(input);
      if (input.requestId === "effect-disconnect") await disconnectedReadGate;
      if (input.requestId === "effect-handoff") await handoffReadGate;
      if (input.requestId === "effect-error") throw new Error("provider callback failed");
      return {
        liveResult: { content: [{ type: "text", text: `live:${String(input.requestId)}` }] },
        durableResult: { content: [{ type: "text", text: `durable:${String(input.requestId)}` }] },
      };
    },
  };
  const exactAgentSession = (input: {
    entryId: string; sessionId: string; roomId: string; runtime: string; displayName: string; agentKey: string;
  }): DaemonToolAgentSession => ({
    session_id: input.sessionId, session_token: "", room_id: input.roomId, session_kind: "worker",
    runtime: input.runtime, actor_label: `${input.displayName} | EmmyMay's agent | ${input.runtime === "cursor" ? "Cursor" : "Codex"}`,
    agent_key: input.agentKey, agent_instance_id: `daemon:${input.entryId}`, display_name: input.displayName,
    owner_label: "EmmyMay", ide_label: input.runtime === "cursor" ? "Cursor" : "Codex",
    created_at: "2026-08-14T00:00:00.000Z", updated_at: "2026-08-14T00:00:01.000Z",
    last_seen_at: "2026-08-14T00:00:01.000Z", ended_at: null,
  });
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, undefined, async () => toolRuntime);
  try {
    await daemon.start();
    const execution = await (daemon as unknown as { durability: WorkDurabilityStore }).durability.startGeneration(
      attempt.work_attempt_id,
      "daemon-provider",
      1,
    );
    const inserted = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "cursor", desired_state: "running", observed_state: "working",
      delivery_mode: "daemon_inbox", permission_profile_id: "read_only",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
      run_id: execution.execution_generation_id,
      deployment_id: serializeDaemonDeploymentId(id, execution.execution_generation_id),
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id, provider_continuation_id: handle.providerContinuationId,
        provider_connection: handle.providerConnection, execution_generation_id: execution.execution_generation_id,
      },
    } });
    assert.equal(inserted.ok, true, inserted.error);
    const internals = daemon as unknown as {
      liveHandles: Map<string, typeof handle>;
      workerBindings: WorkerBindingStore;
      workerRuntimeCustody: WorkerRuntimeCustody;
      completeBoundedEffectOnce: (
        input: Record<string, unknown>,
        admittedBeforeHandoff?: boolean,
      ) => Promise<Record<string, unknown>>;
      supervisedInbox: SupervisedAgentInboxStore;
      supervisedDelivery: { activeTurn: (agent: { agentId: string }) => { inboxItemId: string; sourceMessageId: string; phase: "dispatching" } | null };
    };
    internals.liveHandles.set(id, handle);
    await internals.workerBindings.bind({
      entry_id: id, room_id: entry.room_id, work_attempt_id: attempt.work_attempt_id,
      execution_generation_id: execution.execution_generation_id, agent_session_id: "cursor-cap-worker",
      agent_session_token: "cursor-cap-bearer", credential_ref: "cursor-cap-bearer-id",
      api_url: "https://letagents.example",
    });
    internals.workerRuntimeCustody.installWorkerAuthorization({
      entryId: id, agentSessionId: "cursor-cap-worker", bearer: "cursor-cap-bearer", bearerId: "cursor-cap-bearer-id",
      agentKey: "emmymay/cedarridge", roomId: entry.room_id, workAttemptId: attempt.work_attempt_id,
      grantId: "grant-cursor-cap", grantGeneration: 1, daemonGeneration: 1,
      apiUrl: "https://letagents.example", expiresAt: "2099-01-01T00:00:00.000Z", mintedAtMs: Date.now(),
      agentSession: exactAgentSession({
        entryId: id, sessionId: "cursor-cap-worker", roomId: entry.room_id, runtime: "cursor",
        displayName: "CedarRidge", agentKey: "emmymay/cedarridge",
      }),
    } satisfies CachedWorkerAuthorization);
    const [item] = await internals.supervisedInbox.ingestPoll({
      agent_id: id, room_id: entry.room_id, last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "current" }, activation: {} }],
    });
    assert(item);
    await internals.supervisedInbox.transition(item.inbox_item_id, "dispatching");
    const providerTurnOriginGeneration = "cursor-cap-origin-generation";
    await internals.supervisedInbox.checkpointTurnStarted(item.inbox_item_id, "cursor-turn-current", {
      work_attempt_id: attempt.work_attempt_id,
      origin_execution_generation_id: providerTurnOriginGeneration,
      provider_continuation_id: handle.providerContinuationId,
    });
    internals.supervisedDelivery.activeTurn = () => ({
      inboxItemId: item.inbox_item_id, sourceMessageId: item.source_message_id, phase: "dispatching",
    });
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const coordinates = {
      entry_id: id, room_id: entry.room_id, work_attempt_id: attempt.work_attempt_id,
      execution_generation_id: execution.execution_generation_id, agent_session_id: "cursor-cap-worker",
      daemon_generation: generation, api_url: "https://letagents.example",
    };

    const staleEffect = await daemonRequest(paths.socketPath, "supervisor.prepare_bounded_effect", {
      ...coordinates, provider_turn_id: "cursor-turn-prior", mcp_request_id: "effect-stale",
      tool_name: "send_message", input: { text: "must not run" }, mutation: true,
    });
    assert.equal(staleEffect.ok, false);
    assert.match(staleEffect.error ?? "", /provider turn capability is stale/i);
    const staleExecution = await daemonRequest(paths.socketPath, "supervisor.execute_bounded_tool", {
      ...coordinates, provider_turn_id: "cursor-turn-prior", mcp_request_id: "execute-stale",
      tool_name: "get_board", input: {},
    });
    assert.equal(staleExecution.ok, false);
    assert.match(staleExecution.error ?? "", /provider turn capability is stale/i);
    assert.equal(executedTools.length, 0, "stale authority is rejected before the runtime callback");
    const staleBorrow = await daemonRequest(paths.socketPath, "supervisor.borrow_worker_credential", {
      ...coordinates, provider_turn_id: "cursor-turn-prior",
    });
    assert.deepEqual(staleBorrow.result, { status: "stale" });

    const currentEffect = await daemonRequest(paths.socketPath, "supervisor.prepare_bounded_effect", {
      ...coordinates, provider_turn_id: "cursor-turn-current", mcp_request_id: "effect-current",
      tool_name: "send_message", input: { text: "allowed" }, mutation: true,
    });
    assert.equal(currentEffect.ok, true, currentEffect.error);
    const effectId = String((currentEffect.result as { effect_id: string }).effect_id);
    const completedEffect = await daemonRequest(paths.socketPath, "supervisor.complete_bounded_effect", {
      ...coordinates, provider_turn_id: "cursor-turn-current", effect_id: effectId,
      result: { delivered: true },
    });
    assert.equal(completedEffect.ok, true, completedEffect.error);
    const exactRetry = await daemonRequest(paths.socketPath, "supervisor.prepare_bounded_effect", {
      ...coordinates, provider_turn_id: "cursor-turn-current", mcp_request_id: "effect-current",
      tool_name: "send_message", input: { text: "allowed" }, mutation: true,
    });
    assert.equal(exactRetry.ok, true, exactRetry.error);
    assert.deepEqual(exactRetry.result, { state: "completed", result: { delivered: true }, room_id: entry.room_id },
      "a successor execution reaches the same origin-scoped effect journal");

    const interruptedMutationParams = {
      ...coordinates, provider_turn_id: "cursor-turn-current", mcp_request_id: "effect-uncertain",
      tool_name: "send_message", input: { text: "send at most once" }, mutation: true,
    };
    const interruptedMutation = await daemonRequest(
      paths.socketPath, "supervisor.prepare_bounded_effect", interruptedMutationParams,
    );
    assert.equal(interruptedMutation.ok, true, interruptedMutation.error);
    assert.equal((interruptedMutation.result as { action: string }).action, "execute");
    const uncertainRetry = await daemonRequest(
      paths.socketPath, "supervisor.prepare_bounded_effect", interruptedMutationParams,
    );
    assert.equal(uncertainRetry.ok, true, uncertainRetry.error);
    assert.equal((uncertainRetry.result as { state: string }).state, "uncertain");
    assert.match(String((uncertainRetry.result as { error: string }).error), /may have completed.*verify external state/i);

    const interruptedReadParams = {
      ...coordinates, provider_turn_id: "cursor-turn-current", mcp_request_id: "effect-read-redrive",
      tool_name: "get_board", input: {}, mutation: false,
    };
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.prepare_bounded_effect", interruptedReadParams)).ok, true);
    const readRetry = await daemonRequest(paths.socketPath, "supervisor.prepare_bounded_effect", interruptedReadParams);
    assert.equal(readRetry.ok, true, readRetry.error);
    assert.deepEqual(readRetry.result, {
      state: "prepared",
      effect_id: (readRetry.result as { effect_id: string }).effect_id,
      action: "execute",
      mutation: false,
      room_id: entry.room_id,
    }, "the exact read-only request safely reacquires execution authority");
    const readCompletion = await daemonRequest(paths.socketPath, "supervisor.complete_bounded_effect", {
      ...coordinates,
      provider_turn_id: "cursor-turn-current",
      effect_id: String((readRetry.result as { effect_id: string }).effect_id),
      result: { tasks: [] },
    });
    assert.equal(readCompletion.ok, true, readCompletion.error);

    const inspector = await daemonRequest(paths.socketPath, "supervisor.get_agent_inspector_detail", {
      entry_id: id, room_id: entry.room_id, source_message_id: null,
    });
    assert.equal(inspector.ok, true, inspector.error);
    assert.equal((inspector.result as { uncertain_effects: Array<{ effect_id: string }> }).uncertain_effects.length, 1);
    const effectInspection = new DatabaseSync(paths.manifestPath);
    try {
      const rows = effectInspection.prepare(`SELECT execution_generation_id FROM supervised_agent_effects
        WHERE agent_id=? AND provider_turn_id=? AND mcp_request_id=?`).all(id, "cursor-turn-current", "effect-current") as Array<{ execution_generation_id: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.execution_generation_id, providerTurnOriginGeneration);
    } finally { effectInspection.close(); }
    const currentBorrow = await daemonRequest(paths.socketPath, "supervisor.borrow_worker_credential", {
      ...coordinates, provider_turn_id: "cursor-turn-current",
    });
    assert.deepEqual(currentBorrow.result, { status: "available", credential: "cursor-cap-bearer" });

    const executeParams = {
      ...coordinates, provider_turn_id: "cursor-turn-current", mcp_request_id: "effect-daemon-owned",
      tool_name: "get_board", input: {},
    };
    const daemonOwned = await daemonRequest(paths.socketPath, "supervisor.execute_bounded_tool", executeParams);
    assert.equal(daemonOwned.ok, true, daemonOwned.error);
    assert.deepEqual(daemonOwned.result, {
      state: "completed", room_id: entry.room_id,
      result: { content: [{ type: "text", text: "live:effect-daemon-owned" }] },
    });
    const exactDaemonOwnedRetry = await daemonRequest(paths.socketPath, "supervisor.execute_bounded_tool", executeParams);
    assert.deepEqual(exactDaemonOwnedRetry.result, {
      state: "completed", room_id: entry.room_id,
      result: { content: [{ type: "text", text: "durable:effect-daemon-owned" }] },
    }, "an exact replay returns the journal result without redriving the tool");
    assert.equal(executedTools.filter((call) => call.requestId === "effect-daemon-owned").length, 1);
    const exactCall = executedTools.find((call) => call.requestId === "effect-daemon-owned")!;
    assert.equal(exactCall.provider, "cursor");
    assert.equal(exactCall.roomId, entry.room_id);
    assert.equal(exactCall.bearer, "cursor-cap-bearer");
    assert.equal(exactCall.cwd, attempt.workspace_path);
    assert.equal((exactCall.agentSession as { runtime: string }).runtime, "cursor");
    assert.deepEqual(
      {
        agent_key: (exactCall.agentSession as DaemonToolAgentSession).agent_key,
        actor_label: (exactCall.agentSession as DaemonToolAgentSession).actor_label,
        owner_label: (exactCall.agentSession as DaemonToolAgentSession).owner_label,
      },
      {
        agent_key: "emmymay/cedarridge",
        actor_label: "CedarRidge | EmmyMay's agent | Cursor",
        owner_label: "EmmyMay",
      },
      "task mutations receive the exact bearer identity instead of a synthesized desktop identity",
    );

    const originalCompletion = internals.completeBoundedEffectOnce.bind(daemon);
    let rejectSuccessCheckpoint = true;
    internals.completeBoundedEffectOnce = async (completionInput, admittedBeforeHandoff) => {
      if (rejectSuccessCheckpoint && Object.hasOwn(completionInput, "result")) {
        rejectSuccessCheckpoint = false;
        throw new Error("injected successful-result checkpoint failure");
      }
      return originalCompletion(completionInput, admittedBeforeHandoff);
    };
    const checkpointFailureParams = {
      ...executeParams, mcp_request_id: "effect-success-checkpoint-failure",
      tool_name: "send_message", input: { text: "external effect succeeds once" },
    };
    const checkpointFailure = await daemonRequest(
      paths.socketPath,
      "supervisor.execute_bounded_tool",
      checkpointFailureParams,
    );
    assert.equal(checkpointFailure.ok, false);
    assert.match(checkpointFailure.error ?? "", /successful-result checkpoint failure/i);
    const checkpointRetry = await daemonRequest(
      paths.socketPath,
      "supervisor.execute_bounded_tool",
      checkpointFailureParams,
    );
    assert.equal(checkpointRetry.ok, true, checkpointRetry.error);
    assert.match(JSON.stringify(checkpointRetry.result), /SUPERVISED_EFFECT_OUTCOME_UNCERTAIN/);
    assert.equal(
      executedTools.filter((call) => call.requestId === "effect-success-checkpoint-failure").length,
      1,
      "a successful mutation is never rerun or relabeled as callback failure when only checkpointing fails",
    );

    const failed = await daemonRequest(paths.socketPath, "supervisor.execute_bounded_tool", {
      ...executeParams, mcp_request_id: "effect-error", tool_name: "post_status",
    });
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? "", /provider callback failed/);
    const failedRetry = await daemonRequest(paths.socketPath, "supervisor.execute_bounded_tool", {
      ...executeParams, mcp_request_id: "effect-error", tool_name: "post_status",
    });
    assert.equal(failedRetry.ok, false);
    assert.match(failedRetry.error ?? "", /provider callback failed/i);
    assert.equal(executedTools.filter((call) => call.requestId === "effect-error").length, 1);

    const disconnectedParams = {
      ...executeParams, mcp_request_id: "effect-disconnect", tool_name: "get_board",
    };
    const abandoned = createConnection(paths.socketPath);
    await new Promise<void>((resolve, reject) => {
      abandoned.once("connect", resolve);
      abandoned.once("error", reject);
    });
    abandoned.write(`${JSON.stringify({
      version: DAEMON_PROTOCOL_VERSION, id: "abandoned", method: "supervisor.execute_bounded_tool",
      params: disconnectedParams,
    })}\n`);
    await eventually(() => executedTools.some((call) => call.requestId === "effect-disconnect"), "disconnected tool begins");
    abandoned.destroy();
    releaseDisconnectedRead();
    await eventually(async () => {
      const replay = await daemonRequest(paths.socketPath, "supervisor.execute_bounded_tool", disconnectedParams);
      return replay.ok && JSON.stringify(replay.result).includes("durable:effect-disconnect");
    }, "disconnected tool finishes durably");
    assert.equal(executedTools.filter((call) => call.requestId === "effect-disconnect").length, 1,
      "provider socket loss cannot cancel or duplicate daemon-owned work");

    // Completion is deliberately last for this exact provider turn. Once it
    // commits, production correctly rejects every new effect request.
    const completionProposal = await daemonRequest(paths.socketPath, "supervisor.prepare_bounded_effect", {
      ...coordinates, provider_turn_id: "cursor-turn-current", mcp_request_id: "completion-current",
      tool_name: "complete_room_turn", input: { outcome: "reply", text: "Exact public answer." }, mutation: true,
    });
    assert.equal(completionProposal.ok, true, completionProposal.error);
    assert.equal((completionProposal.result as { state: string }).state, "completed");
    const deterministicCompletionResult = (completionProposal.result as { result: unknown }).result;
    assert.deepEqual((deterministicCompletionResult as { structuredContent?: unknown }).structuredContent, {
      accepted: true,
      outcome: "reply",
      instruction: "The daemon recorded this exact turn completion. End the provider turn without sending the activating reply through another tool.",
    });
    const completionRetry = await daemonRequest(paths.socketPath, "supervisor.prepare_bounded_effect", {
      ...coordinates, provider_turn_id: "cursor-turn-current", mcp_request_id: "completion-retry-new-id",
      tool_name: "complete_room_turn", input: { outcome: "reply", text: "Exact public answer." }, mutation: true,
    });
    assert.deepEqual(completionRetry.result, { state: "completed", result: deterministicCompletionResult, room_id: entry.room_id },
      "an exact completion retry converges on the one durable proposal even with a new transport request id");
    const conflictingCompletion = await daemonRequest(paths.socketPath, "supervisor.prepare_bounded_effect", {
      ...coordinates, provider_turn_id: "cursor-turn-current", mcp_request_id: "completion-conflict",
      tool_name: "complete_room_turn", input: { outcome: "no_reply" }, mutation: true,
    });
    assert.equal(conflictingCompletion.ok, false);
    assert.match(conflictingCompletion.error ?? "", /different completion proposal/i);

    const providerNeutralExecution = await (daemon as unknown as { durability: WorkDurabilityStore }).durability.startGeneration(
      providerNeutralAttempt.work_attempt_id,
      "daemon-provider",
      1,
    );
    const providerNeutralHandle = {
      ...handle,
      workAttemptId: providerNeutralAttempt.work_attempt_id,
      providerContinuationId: "provider-neutral-continuation",
    };
    const codexProjection = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: providerNeutralId, room_id: "provider-neutral-room", provider: "codex",
      desired_state: "running", observed_state: "working",
      delivery_mode: "daemon_inbox", permission_profile_id: "read_only",
      workspace_path: providerNeutralAttempt.workspace_path, work_attempt_id: providerNeutralAttempt.work_attempt_id,
      run_id: providerNeutralExecution.execution_generation_id,
      deployment_id: serializeDaemonDeploymentId(providerNeutralId, providerNeutralExecution.execution_generation_id),
      provider_ref: {
        work_attempt_id: providerNeutralAttempt.work_attempt_id,
        provider_continuation_id: providerNeutralHandle.providerContinuationId,
        provider_connection: providerNeutralHandle.providerConnection,
        execution_generation_id: providerNeutralExecution.execution_generation_id,
      },
    } });
    assert.equal(codexProjection.ok, true, codexProjection.error);
    internals.liveHandles.set(providerNeutralId, providerNeutralHandle);
    await internals.workerBindings.bind({
      entry_id: providerNeutralId, room_id: "provider-neutral-room",
      work_attempt_id: providerNeutralAttempt.work_attempt_id,
      execution_generation_id: providerNeutralExecution.execution_generation_id,
      agent_session_id: "provider-neutral-worker", agent_session_token: "provider-neutral-bearer",
      credential_ref: "provider-neutral-bearer-id", api_url: "https://letagents.example",
    });
    internals.workerRuntimeCustody.installWorkerAuthorization({
      entryId: providerNeutralId, agentSessionId: "provider-neutral-worker", bearer: "provider-neutral-bearer",
      bearerId: "provider-neutral-bearer-id", agentKey: "emmymay/pinefield", roomId: "provider-neutral-room",
      workAttemptId: providerNeutralAttempt.work_attempt_id, grantId: "grant-provider-neutral",
      grantGeneration: 1, daemonGeneration: 1, apiUrl: "https://letagents.example",
      expiresAt: "2099-01-01T00:00:00.000Z", mintedAtMs: Date.now(),
      agentSession: exactAgentSession({
        entryId: providerNeutralId, sessionId: "provider-neutral-worker", roomId: "provider-neutral-room", runtime: "codex",
        displayName: "PineField", agentKey: "emmymay/pinefield",
      }),
    } satisfies CachedWorkerAuthorization);
    const [providerNeutralItem] = await internals.supervisedInbox.ingestPoll({
      agent_id: providerNeutralId, room_id: "provider-neutral-room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "provider neutral" }, activation: {} }],
    });
    assert(providerNeutralItem);
    await internals.supervisedInbox.transition(providerNeutralItem.inbox_item_id, "dispatching");
    await internals.supervisedInbox.checkpointTurnStarted(providerNeutralItem.inbox_item_id, "provider-neutral-turn", {
      work_attempt_id: providerNeutralAttempt.work_attempt_id,
      origin_execution_generation_id: providerNeutralExecution.execution_generation_id,
      provider_continuation_id: providerNeutralHandle.providerContinuationId,
    });
    internals.supervisedDelivery.activeTurn = (agent) => agent.agentId === providerNeutralId
      ? { inboxItemId: providerNeutralItem.inbox_item_id, sourceMessageId: providerNeutralItem.source_message_id, phase: "dispatching" }
      : { inboxItemId: item.inbox_item_id, sourceMessageId: item.source_message_id, phase: "dispatching" };
    const providerNeutralCoordinates = {
      entry_id: providerNeutralId, room_id: "provider-neutral-room",
      work_attempt_id: providerNeutralAttempt.work_attempt_id,
      execution_generation_id: providerNeutralExecution.execution_generation_id,
      agent_session_id: "provider-neutral-worker", daemon_generation: generation,
      api_url: "https://letagents.example",
    };
    const providerNeutralCompletionChannel = await daemonRequest(paths.socketPath, "supervisor.prepare_bounded_effect", {
      ...providerNeutralCoordinates, provider_turn_id: "", mcp_request_id: "completion-provider-neutral",
      tool_name: "complete_room_turn", input: { outcome: "no_reply" }, mutation: true,
    });
    assert.equal(providerNeutralCompletionChannel.ok, false);
    assert.match(providerNeutralCompletionChannel.error ?? "", /reserved for supervised Cursor turns/i);
    const providerNeutral = await daemonRequest(paths.socketPath, "supervisor.prepare_bounded_effect", {
      ...providerNeutralCoordinates, provider_turn_id: "", mcp_request_id: "effect-provider-neutral",
      tool_name: "claim_task", input: { task_id: "provider-neutral" }, mutation: true,
    });
    assert.equal(providerNeutral.ok, true, providerNeutral.error);
    const providerNeutralEffectId = String((providerNeutral.result as { effect_id: string }).effect_id);
    const providerNeutralCompletion = await daemonRequest(paths.socketPath, "supervisor.complete_bounded_effect", {
      ...providerNeutralCoordinates, provider_turn_id: "", effect_id: providerNeutralEffectId,
      result: { claimed: true },
    });
    assert.equal(providerNeutralCompletion.ok, true, providerNeutralCompletion.error);

    const handoffTool = daemonRequest(paths.socketPath, "supervisor.execute_bounded_tool", {
      ...providerNeutralCoordinates, provider_turn_id: "", mcp_request_id: "effect-handoff",
      tool_name: "get_board", input: {},
    });
    await eventually(() => executedTools.some((call) => call.requestId === "effect-handoff"), "handoff tool begins");
    let handoffSettled = false;
    const handoff = daemonRequest(paths.socketPath, "daemon.prepare_handoff").finally(() => { handoffSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(handoffSettled, false, "handoff waits for admitted daemon-owned tool execution");
    releaseHandoffRead();
    assert.equal((await handoffTool).ok, true);
    assert.equal((await handoff).ok, true);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("Pause and Stop fence room-move reconciliation while the activating turn remains restartable", async () => {
  for (const desiredState of ["paused", "stopped"] as const) {
    const env = await fixture();
    const id = `room_move_lifecycle_${desiredState}`;
    const paths = {
      lockPath: join(env.root, `${desiredState}.lock`),
      socketPath: join(env.root, `${desiredState}.sock`),
      manifestPath: join(env.root, `${desiredState}.sqlite`),
      auditPath: join(env.root, `${desiredState}-audit.jsonl`),
      workerBindingsPath: join(env.root, `${desiredState}-bindings.json`),
    };
    const workAttemptId = `attempt_${desiredState}`;
    const executionGenerationId = `run_${desiredState}`;
    const providerContinuationId = `continuation_${desiredState}`;
    const port: ProviderActionPort = {
      capabilities: async () => ({
        deliveryModes: ["daemon_inbox"], resume: true, midTurnInjection: false,
        transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true,
      }),
      spawn: async () => { throw new Error("lifecycle test does not launch providers"); },
      attach: async () => null,
      attachAction: async () => ({ state: "absent" }),
      resume: async () => { throw new Error("lifecycle test does not resume providers"); },
      poke: async () => {},
      stop: async () => ({
        endedAt: new Date().toISOString(), exitCode: 0, signal: null,
        terminalCause: "stopped", providerContinuationId,
      }),
      onExit: async () => () => {},
      onStream: async () => () => {},
      runRoomTurn: async () => ({ turnId: "unused", outcome: "no_reply", text: null }),
    };
    let joinCalls = 0;
    const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, {
      poll: async () => ({ messages: [] }),
      publish: async () => {},
      joinRoom: async (input) => { joinCalls += 1; return { roomId: input.roomId }; },
    });
    try {
      await daemon.start();
      const internals = daemon as unknown as {
        requestConvergence: (entryId: string) => void;
        store: ManifestStore;
        workerBindings: WorkerBindingStore;
        supervisedInbox: SupervisedAgentInboxStore;
        supervisedDelivery: {
          stop: (agentId: string) => Promise<void>;
          ensureStarted: (agent: unknown) => Promise<void>;
        };
        providerStreams: { isDeliveryAdmitted: (entryId: string) => boolean };
        reconcileRoomMove: (move: DaemonRoomMoveRecord) => Promise<DaemonRoomMoveRecord>;
        startSupervisedDelivery: (entryId: string, mode: "ensure") => Promise<void>;
      };
      internals.requestConvergence = () => {};
      // This test begins after lifecycle admission so it can isolate the room
      // move restart boundary without fabricating a provider process birth.
      internals.providerStreams.isDeliveryAdmitted = () => true;
      let resumedExactWaiter = 0;
      internals.supervisedDelivery.ensureStarted = async () => { resumedExactWaiter += 1; };
      const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        ...entry,
        id,
        room_id: `source_${desiredState}`,
        provider: "codex",
        delivery_mode: "daemon_inbox",
        desired_state: "running",
        observed_state: "working",
        condition: "none",
        last_error: null,
        work_attempt_id: workAttemptId,
        provider_ref: {
          work_attempt_id: workAttemptId,
          provider_continuation_id: providerContinuationId,
          provider_connection: null,
          execution_generation_id: executionGenerationId,
        },
      } });
      assert.equal(put.ok, true, put.error);
      await internals.workerBindings.bind({
        entry_id: id,
        room_id: `source_${desiredState}`,
        work_attempt_id: workAttemptId,
        execution_generation_id: executionGenerationId,
        agent_session_id: `session_${desiredState}`,
        agent_session_token: `secret_${desiredState}`,
        api_url: "https://letagents.example",
      });
      const [activating] = await internals.supervisedInbox.ingestPoll({
        agent_id: id,
        room_id: `source_${desiredState}`,
        last_observed_message_id: "1",
        messages: [{ source_message_id: "1", source_message: { text: "move" }, activation: { decision: "activate" } }],
      });
      assert(activating);
      assert.equal((await internals.supervisedInbox.claimHead(id))?.inbox_item_id, activating.inbox_item_id);
      const providerTurnId = `turn_${desiredState}`;
      await internals.supervisedInbox.checkpointTurnStarted(activating.inbox_item_id, providerTurnId, {
        work_attempt_id: workAttemptId,
        origin_execution_generation_id: executionGenerationId,
        provider_continuation_id: providerContinuationId,
      });
      const prepared = await internals.supervisedInbox.prepareRoomMoveEffect({
        agent_id: id,
        room_id: `source_${desiredState}`,
        effect_execution_generation_id: executionGenerationId,
        provider_turn_id: providerTurnId,
        mcp_request_id: `move_request_${desiredState}`,
        request: { name: `destination_${desiredState}` },
        destination_room_id: `destination_${desiredState}`,
        daemon_generation: ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation,
        work_attempt_id: workAttemptId,
        execution_generation_id: executionGenerationId,
        provider_continuation_id: providerContinuationId,
        agent_session_id: `session_${desiredState}`,
        activating_inbox_item_id: activating.inbox_item_id,
      });
      const pending = (await internals.store.pendingRoomMoves(id))[0]!;
      const waiting = await internals.reconcileRoomMove(pending);
      assert.equal(waiting.phase, "waiting_for_current_turn");

      const [normalized] = await internals.supervisedInbox.normalizeStartupRecovery(id);
      assert.equal(normalized?.inbox_item_id, activating.inbox_item_id);
      assert.equal(normalized?.state, "pending", "first restart normalizes the exact started turn for recovery");
      assert.equal(normalized?.provider_turn_id, providerTurnId, "normalization preserves the exact recovery identity");

      await internals.startSupervisedDelivery(id, "ensure");
      assert.equal(resumedExactWaiter, 1,
        "a second restart resumes the normalized exact activating turn instead of wedging behind its own move");

      let enterDrain!: () => void;
      const drainEntered = new Promise<void>((resolve) => { enterDrain = resolve; });
      let releaseDrain!: () => void;
      const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
      const originalStop = internals.supervisedDelivery.stop.bind(internals.supervisedDelivery);
      internals.supervisedDelivery.stop = async (agentId) => {
        enterDrain();
        await drainGate;
        await originalStop(agentId);
      };
      const lifecycle = daemonRequest(paths.socketPath, "manifest.set_desired_state", {
        id,
        desired_state: desiredState,
      });
      await drainEntered;
      const duringDrain = await internals.reconcileRoomMove(waiting);
      assert.equal(duringDrain.phase, "waiting_for_current_turn");
      assert.equal(joinCalls, 0, "reconciliation cannot begin destination join during lifecycle drain");
      releaseDrain();
      const lifecycleResult = await lifecycle;
      assert.equal(lifecycleResult.ok, true, lifecycleResult.error);
      assert.equal((lifecycleResult.result as DaemonManifestEntry).desired_state, desiredState);
      assert.equal((await internals.store.getRoomMove(waiting.operation_id))?.phase, "failed");
      assert.deepEqual(await internals.store.pendingRoomMoves(id), []);
      assert.equal((await internals.supervisedInbox.preparedRoomMove(id, executionGenerationId, providerTurnId)), null);
      assert.equal((await internals.supervisedInbox.get(activating.inbox_item_id))?.state, "pending");
      assert.equal((await internals.supervisedInbox.providerTurnBinding(activating.inbox_item_id))?.provider_turn_id, providerTurnId);
      assert.equal(joinCalls, 0);
    } finally {
      await daemon.stop().catch(() => undefined);
      await env.cleanup();
    }
  }
});

test("Open Model admits multiple isolated supervised agents in one room", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const candidate = (id: string): DaemonManifestEntry => ({
    ...entry,
    id,
    room_id: "open_model_multi_agent_room",
    provider: "open-model",
    display_name: id === "open_model_alpha" ? "QuartzCove" : "GardenSignal",
    desired_state: "paused",
    observed_state: "paused",
  });
  try {
    await daemon.start();
    const created = await Promise.all([
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("open_model_alpha") }),
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("open_model_bravo") }),
    ]);
    assert.ok(created.every((result) => result.ok));
    const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.deepEqual(manifest.map((item) => item.id).sort(), ["open_model_alpha", "open_model_bravo"]);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("display-name repair preserves the exact supervised runtime", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const original: DaemonManifestEntry = {
    ...entry,
    id: "open_model_identity_repair",
    provider: "open-model",
    display_name: "Open Model supervised agent",
    desired_state: "paused",
    observed_state: "paused",
  };
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: original })).ok, true);
    const renamed = await daemonRequest(paths.socketPath, "manifest.set_display_name", {
      id: original.id,
      display_name: "QuartzCove",
    });
    assert.equal(renamed.ok, true);
    const result = renamed.result as DaemonManifestEntry;
    assert.equal(result.display_name, "QuartzCove");
    assert.equal(result.id, original.id);
    assert.equal(result.provider, original.provider);
    assert.equal(result.work_attempt_id, original.work_attempt_id);
    assert.deepEqual(result.provider_ref, original.provider_ref);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("concurrent Claude Code creation mints one isolated provider generation per agent", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const creationIds = ["race_generation_a", "race_generation_b"] as const;
  const workspaces = await Promise.all(creationIds.map((creationId) => provisionedWorkspace(env.root, creationId)));
  const attempts = await Promise.all(workspaces.map((workspace, index) => durability.createAttempt({
    taskId: creationIds[index]!,
    leaseId: creationIds[index]!,
    leaseEpoch: 0,
    workspacePath: workspace.path,
    workAttemptId: workspace.id,
  })));
  let spawnCount = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (request) => {
      spawnCount += 1;
      return {
        workAttemptId: request.workAttemptId,
        pid: 4400 + spawnCount,
        providerContinuationId: `race-generation-continuation-${spawnCount}`,
        observedState: "working" as const,
      };
    },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("a fresh winning owner must spawn"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "race-generation-continuation" }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  const candidate = (index: number): DaemonManifestEntry => ({
    ...entry,
    id: creationIds[index]!,
    room_id: "room_generation_race",
    provider: "claude-code",
    desired_state: "paused",
    observed_state: "paused",
    workspace_path: attempts[index]!.workspace_path,
    work_attempt_id: attempts[index]!.work_attempt_id,
  });
  try {
    await daemon.start();
    const results = await Promise.all([
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate(0) }),
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate(1) }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 2);
    const owners = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.equal(owners.length, 2);
    for (const owner of owners) {
      assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
        id: owner.id,
        desired_state: "running",
      })).ok, true);
    }
    await eventually(async () => spawnCount === 2, "one isolated supervised generation per Claude agent");

    const durable = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
    for (const owner of owners) {
      const persisted = await durable.getAttempt(owner.work_attempt_id!);
      assert.equal(persisted.execution_generations.length, 1);
      assert.equal(persisted.execution_generations.filter((generation) => generation.terminal === null).length, 1);
    }
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("legacy and supervised lanes share one durable linearization point in both flip directions", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const candidate = (id: string, roomId: string): DaemonManifestEntry => ({
    ...entry,
    id,
    room_id: roomId,
    provider: "codex",
    desired_state: "paused",
    observed_state: "paused",
  });
  try {
    await daemon.start();

    // Legacy wins the first linearization point. A paused transfer claim may
    // be recorded, but it cannot activate/spawn until the legacy owner exits.
    assert.equal((await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_first", room_id: "room_legacy_first", provider: "codex", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: candidate("supervised_pending", "room_legacy_first"),
    })).ok, true);
    const blockedActivation = await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "supervised_pending", desired_state: "running",
    });
    assert.equal(blockedActivation.ok, false);
    assert.match(blockedActivation.error ?? "", /legacy reservation/);
    assert.equal((await daemonRequest(paths.socketPath, "lane.activate_legacy", {
      reservation_id: "legacy_first", session_id: "legacy_session_first",
    })).ok, true);

    // After the confirmed legacy stop/release, the pending supervised claim
    // is the only engine allowed to activate.
    assert.equal((await daemonRequest(paths.socketPath, "lane.release_legacy", {
      session_id: "legacy_session_first",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "supervised_pending", desired_state: "running",
    })).ok, true);

    // Supervised wins the opposite direction before a legacy spawn. The
    // legacy reservation fails, so its caller cannot enter runtime.start.
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: candidate("supervised_first", "room_supervised_first"),
    })).ok, true);
    const blockedLegacy = await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_loser", room_id: "room_supervised_first", provider: "codex", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    });
    assert.equal(blockedLegacy.ok, false);
    assert.match(blockedLegacy.error ?? "", /supervised entry/);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "supervised_first", desired_state: "running",
    })).ok, true);

    // Barrier edge: the legacy runtime became visible before its reservation
    // was bound to a session. Supervised teardown releases by lane, so the
    // pending supervised claim activates and the late legacy bind is fenced.
    assert.equal((await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_mid_spawn", room_id: "room_mid_spawn", provider: "codex", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: candidate("supervised_mid_spawn", "room_mid_spawn"),
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "lane.release_legacy", {
      room_id: "room_mid_spawn", provider: "codex",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "supervised_mid_spawn", desired_state: "running",
    })).ok, true);
    const lateLegacyBind = await daemonRequest(paths.socketPath, "lane.activate_legacy", {
      reservation_id: "legacy_mid_spawn", session_id: "legacy_session_late",
    });
    assert.equal(lateLegacyBind.ok, false);
    assert.match(lateLegacyBind.error ?? "", /Unknown legacy lane reservation/);

    const durable = await new ManifestStore(paths.manifestPath).load();
    assert.deepEqual(durable.legacy_lane_owners ?? [], []);
    assert.equal(durable.entries.filter((owner) => owner.desired_state === "running").length, 3);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("public-socket barrier races observe exactly one real mixed-engine product-path callback in both winner directions", async () => {
  for (const releaseOrder of [["legacy", "supervised"], ["supervised", "legacy"]] as const) {
    const env = await fixture();
    const paths = {
      lockPath: join(env.root, "daemon.lock"),
      socketPath: join(env.root, "daemon.sock"),
      manifestPath: join(env.root, "daemon-state.sqlite"),
      auditPath: join(env.root, "audit.jsonl"),
      attemptsPath: join(env.root, "attempts.json"),
      attemptsRoot: join(env.root, "attempt-data"),
      workspaceRoot: env.root,
    };
    const roomId = `room_product_race_${releaseOrder[0]}`;
    const supervisedId = `supervised_product_race_${releaseOrder[0]}`;
    const reservationId = `legacy_product_race_${releaseOrder[0]}`;
    const workspace = await provisionedWorkspace(env.root, supervisedId);
    const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
    const attempt = await durability.createAttempt({
      taskId: supervisedId,
      leaseId: supervisedId,
      leaseEpoch: 0,
      workspacePath: workspace.path,
      workAttemptId: workspace.id,
    });
    let legacyStarts = 0;
    let supervisedSpawns = 0;
    let supervisedStreamDeliveries = 0;
    const handle = {
      workAttemptId: attempt.work_attempt_id,
      pid: 42,
      providerContinuationId: `continuation_${releaseOrder[0]}`,
      observedState: "working" as const,
    };
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
      spawn: async (request) => {
        supervisedSpawns += 1;
        assert.equal(request.workAttemptId, attempt.work_attempt_id);
        return handle;
      },
      attach: async () => null,
      attachAction: async () => ({ state: "absent" }),
      resume: async () => { throw new Error("fresh mixed-engine race must not resume"); },
      poke: async () => {},
      stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }),
      onExit: async () => () => {},
      onStream: async (_providerHandle, listener) => {
        queueMicrotask(() => {
          supervisedStreamDeliveries += 1;
          listener({
            workAttemptId: attempt.work_attempt_id,
            providerContinuationId: handle.providerContinuationId,
            observedAt: new Date().toISOString(),
            sequence: 1,
            provider: "codex",
            kind: "turn_lifecycle",
            method: "turn/product-path-delivery",
            payload: { releaseOrder },
            payloadTruncated: false,
            payloadRedacted: false,
            durablePayloadRef: null,
          });
        });
        return () => {};
      },
    };
    const mutationBarrier = orderedDaemonMutationBarrier(releaseOrder);
    const daemon = new SupervisorDaemon(paths, "darwin", port, true, 60_000, mutationBarrier.gate);
    try {
      await daemon.start();
      const barrierRequest = concurrentDaemonRequestBarrier(paths.socketPath);
      const legacy = launchLegacyWithOwnership({
        reserve: async () => {
          const result = await barrierRequest("legacy", "lane.reserve_legacy", {
            reservation_id: reservationId,
            room_id: roomId,
            provider: "codex",
            owner_pid: process.pid,
            owner_process_identity: TEST_PROCESS_IDENTITY,
          });
          if (!result.ok) throw new Error(result.error);
        },
        start: async () => {
          legacyStarts += 1;
          return { sessionId: `legacy_session_${releaseOrder[0]}` };
        },
        activate: async (started) => {
          const result = await daemonRequest(paths.socketPath, "lane.activate_legacy", {
            reservation_id: reservationId,
            session_id: started.sessionId,
          });
          if (!result.ok) throw new Error(result.error);
        },
        stop: async () => { legacyStarts -= 1; },
        release: async () => {
          await daemonRequest(paths.socketPath, "lane.release_legacy", { reservation_id: reservationId });
        },
      });
      const supervised = barrierRequest("supervised", "manifest.put", {
        entry: {
          ...entry,
          id: supervisedId,
          room_id: roomId,
          provider: "codex",
          desired_state: "running",
          observed_state: "absent",
          workspace_path: attempt.workspace_path,
          work_attempt_id: attempt.work_attempt_id,
        },
      });
      const [legacyResult, supervisedResult] = await Promise.allSettled([legacy, supervised]);
      assert.deepEqual([...mutationBarrier.arrived].sort(), ["legacy", "supervised"], "both public claim frames reach the daemon before either mutation is released");

      if (releaseOrder[0] === "legacy") {
        assert.equal(legacyResult.status, "fulfilled");
        assert.equal(supervisedResult.status, "fulfilled");
        assert.equal(supervisedResult.value.ok, false);
        assert.match(supervisedResult.value.error ?? "", /legacy reservation/);
      } else {
        assert.equal(supervisedResult.status, "fulfilled");
        assert.equal(supervisedResult.value.ok, true, supervisedResult.value.error);
        assert.equal(legacyResult.status, "rejected");
        assert.match(String(legacyResult.reason), /supervised entry/);
        await eventually(async () => supervisedSpawns === 1 && supervisedStreamDeliveries === 1, "supervised spawn and stream delivery callbacks");
        await eventually(async () => {
          const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
          return manifest.find((candidate) => candidate.id === supervisedId)?.activity?.some((event) => event.method === "turn/product-path-delivery") === true;
        }, "supervised stream delivery persisted through the daemon product path");
      }

      const expected = releaseOrder[0] === "legacy" ? [1, 0] : [0, 1];
      assert.deepEqual([legacyStarts, supervisedSpawns], expected, "real legacy start and ProviderActionPort.spawn callbacks have exactly one winner");
      assert.equal(supervisedStreamDeliveries, expected[1], "only the supervised winner installs and receives its provider stream delivery");
    } finally {
      await daemon.stop();
      await env.cleanup();
    }
  }
});

test("daemon start deterministically removes crash-orphaned reserved legacy lanes", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  await new ManifestStore(paths.manifestPath).write(0, [], [{
    reservation_id: "orphaned_reservation",
    room_id: "room_orphaned",
    provider: "codex",
    owner_pid: 2_147_483_647,
    owner_process_identity: "orphaned-process-identity",
    state: "reserved",
    session_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  }]);
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    assert.deepEqual((await new ManifestStore(paths.manifestPath).load()).legacy_lane_owners ?? [], []);
    const claim = await daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...entry, id: "supervised_after_orphan", room_id: "room_orphaned", provider: "codex", desired_state: "paused" },
    });
    assert.equal(claim.ok, true, claim.error);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("restart fences a title-mutated orphan, durably closes its generation, and resumes one successor", async () => {
  const env = await fixture();
  const source = join(env.root, "source");
  await mkdir(source);
  await execFileAsync("git", ["init", source]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
  await writeFile(join(source, "README.md"), "durable\n");
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", source, "remote", "add", "origin", source]);
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const continuation = "claude-session-durable";
  let activeChild: ChildProcess | null = null;
  let originalPid: number | null = null;
  let recordedBirthIdentity: string | null = null;
  let workAttemptId = "";
  let fencedBeforeTerminalEvidence = false;
  let resumeCount = 0;

  const launch = async (mutateTitle: boolean) => {
    const script = mutateTitle
      ? "setTimeout(() => { process.title = 'claude'; }, 50); setInterval(() => {}, 1000)"
      : "setInterval(() => {}, 1000)";
    activeChild = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    await eventually(async () => typeof defaultGetProcessIdentity(activeChild!.pid!) === "string", "provider birth identity");
    return activeChild;
  };
  const publicHandle = () => ({
    workAttemptId,
    pid: activeChild?.pid ?? null,
    providerContinuationId: continuation,
    providerConnection: {
      kind: "claude_cli" as const,
      pid: activeChild?.pid ?? null,
      processIdentity: defaultGetProcessIdentity(activeChild!.pid!) ?? null,
    },
    observedState: "working" as const,
  });
  const firstPort: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
    spawn: async (request) => {
      workAttemptId = request.workAttemptId;
      await launch(true);
      originalPid = activeChild!.pid!;
      recordedBirthIdentity = defaultGetProcessIdentity(originalPid);
      return publicHandle();
    },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("first daemon must not resume"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: "SIGTERM", terminalCause: "stopped", providerContinuationId: continuation }),
    onExit: async () => () => {},
  };
  const secondPort: ProviderActionPort = {
    capabilities: firstPort.capabilities,
    spawn: async () => { throw new Error("durable Claude continuation must resume, not spawn"); },
    attach: async (ref) => {
      assert.equal(ref.providerContinuationId, continuation);
      assert.equal(ref.providerConnection?.processIdentity, recordedBirthIdentity);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(defaultGetProcessIdentity(originalPid!), recordedBirthIdentity, "process title mutation cannot change birth identity");
      const exited = new Promise<void>((resolve) => activeChild!.once("exit", () => resolve()));
      activeChild!.kill("SIGTERM");
      await exited;
      assert.equal(defaultGetProcessIdentity(originalPid!), null, "old writer is gone before terminal evidence crosses the adapter boundary");
      fencedBeforeTerminalEvidence = true;
      return {
        state: "terminal",
        terminal: { endedAt: new Date().toISOString(), exitCode: null, signal: "SIGTERM", terminalCause: "stopped", providerContinuationId: continuation },
      };
    },
    attachAction: async () => ({ state: "absent" }),
    resume: async (ref) => {
      assert.equal(fencedBeforeTerminalEvidence, true);
      assert.equal(ref.providerContinuationId, continuation);
      const persisted = await new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees")).getAttempt(ref.workAttemptId);
      assert.notEqual(persisted.execution_generations[0]!.terminal, null, "old generation is durable terminal before successor launch");
      resumeCount += 1;
      await launch(false);
      return publicHandle();
    },
    poke: async () => {},
    stop: firstPort.stop,
    onExit: async () => () => {},
  };

  const first = new SupervisorDaemon(paths, "darwin", firstPort, true);
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "supervised_claude_fence",
      room_id: "focus_37",
      provider: "claude-code",
      observed_state: "absent",
      source_repo_path: source,
      workspace_path: null,
      work_attempt_id: null,
      provider_launch_policy: { permissionMode: "acceptEdits" },
    } });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working"), "first Claude generation");
    const original = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_claude_fence" })).result as { execution_generations: Array<{ execution_generation_id: string }> });
    assert.equal(original.execution_generations.length, 1);
    const originalGenerationId = original.execution_generations[0]!.execution_generation_id;

    await first.stop();
    second = new SupervisorDaemon(paths, "darwin", secondPort, true);
    await second.start();
    await eventually(async () => {
      const manifest = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return manifest.observed_state === "working" && manifest.provider_ref?.execution_generation_id !== originalGenerationId;
    }, "bounded successor resume", 8_000);
    const recovered = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_claude_fence" })).result as {
      execution_generations: Array<{ terminal: { terminal_cause: string } | null }>;
    };
    assert.equal(fencedBeforeTerminalEvidence, true);
    assert.equal(recovered.execution_generations.length, 2, "recovery mints exactly one successor generation");
    assert.equal(recovered.execution_generations[0]!.terminal?.terminal_cause, "stopped");
    assert.equal(recovered.execution_generations[1]!.terminal, null);
    assert.equal(resumeCount, 1);
  } finally {
    await first.stop().catch(() => undefined);
    await second?.stop().catch(() => undefined);
    if (activeChild?.pid) {
      try { activeChild.kill("SIGKILL"); } catch {}
    }
    await env.cleanup();
  }
});

test("generation handoff reattaches the same provider and publishes its supervised native stream to the exact worker endpoint", async () => {
  const env = await fixture();
  const nativeRequests: Array<{ headers: import("node:http").IncomingHttpHeaders; body: any }> = [];
  let rejectNativeActivity = false;
  let nativeRequestsInFlight = 0;
  let maxNativeRequestsInFlight = 0;
  const nativeServer = createHttpServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { raw += chunk; });
    request.on("end", async () => {
      nativeRequestsInFlight += 1;
      maxNativeRequestsInFlight = Math.max(maxNativeRequestsInFlight, nativeRequestsInFlight);
      const body = JSON.parse(raw);
      nativeRequests.push({ headers: request.headers, body });
      if (body.method === "turn/same-millisecond-a") await new Promise((resolve) => setTimeout(resolve, 30));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: !rejectNativeActivity, presence: { status: "working" }, lease_heartbeats: rejectNativeActivity ? [] : [{ id: "lease_exact", epoch: 7 }] }));
      nativeRequestsInFlight -= 1;
    });
  });
  await new Promise<void>((resolve, reject) => { nativeServer.once("error", reject); nativeServer.listen(0, "127.0.0.1", resolve); });
  const nativeAddress = nativeServer.address() as AddressInfo;
  const apiUrl = `http://127.0.0.1:${nativeAddress.port}`;
  const source = join(env.root, "source");
  await mkdir(source);
  await execFileAsync("git", ["init", source]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
  await writeFile(join(source, "README.md"), "durable\n");
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", source, "remote", "add", "origin", source]);

  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  let child: ChildProcess | null = null;
  let continuation = "thread-durable";
  let sequence = 0;
  let resumeCount = 0;
  let resumeSupported = true;
  let deliveryPolls = 0;
  const resumeRequests: Array<Parameters<ProviderActionPort["resume"]>[1]> = [];
  const streamListeners = new Set<(event: any) => void>();
  const exitListeners = new Set<(terminal: any) => void>();
  const handle = () => ({
    workAttemptId: "", pid: child?.pid ?? null, providerContinuationId: continuation,
    providerConnection: { kind: "codex_app_server" as const, url: "ws://127.0.0.1:65534", pid: child?.pid ?? null, processIdentity: `fixture:${child?.pid}` },
    observedState: "working" as const,
  });
  let workAttemptId = "";
  const launchChild = () => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    child.once("exit", (code, signal) => {
      for (const listener of exitListeners) listener({ endedAt: new Date().toISOString(), exitCode: code, signal, terminalCause: "stopped", providerContinuationId: continuation });
    });
  };
  const port = (): ProviderActionPort => ({
    capabilities: async () => ({ resume: resumeSupported, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (request) => {
      workAttemptId = request.workAttemptId;
      launchChild();
      return { ...handle(), workAttemptId };
    },
    attach: async (ref) => child?.pid && ref.providerContinuationId === continuation
      ? { ...handle(), workAttemptId: ref.workAttemptId }
      : null,
    attachAction: async () => ({ state: "absent" }),
    resume: async (ref, request) => {
      resumeCount += 1;
      resumeRequests.push(request);
      workAttemptId = ref.workAttemptId;
      launchChild();
      return { ...handle(), workAttemptId };
    },
    poke: async () => {},
    stop: async () => new Promise((resolveStop) => {
      const terminal = { endedAt: new Date().toISOString(), exitCode: 0, signal: "SIGTERM", terminalCause: "stopped" as const, providerContinuationId: continuation };
      child?.once("exit", () => resolveStop(terminal));
      child?.kill("SIGTERM");
    }),
    onExit: async (_providerHandle, listener) => { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    onStream: async (_providerHandle, listener) => { streamListeners.add(listener); return () => streamListeners.delete(listener); },
    runRoomTurn: async () => ({ turnId: "unused-room-turn", outcome: "no_reply", text: null }),
  });

  const first = new SupervisorDaemon(paths, "darwin", port(), true, 2_000, undefined, {}, {
    poll: ({ signal }) => new Promise((resolve) => {
      deliveryPolls += 1;
      signal.addEventListener("abort", () => resolve({}), { once: true });
    }),
    publish: async () => {},
  });
  let second: SupervisorDaemon | null = null;
  let third: SupervisorDaemon | null = null;
  try {
    await first.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "supervised_handoff", room_id: "focus_37", provider: "codex", observed_state: "absent",
      source_repo_path: source, workspace_path: null, work_attempt_id: null,
      provider_launch_policy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    } });
    try {
      await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working"), "daemon-owned provider start", 8_000);
    } catch (error) {
      const state = (await daemonRequest(paths.socketPath, "manifest.list")).result;
      throw new Error(`${(error as Error).message}: ${JSON.stringify(state)}`);
    }
    const before = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    const originalPid = before.provider_ref?.provider_connection?.pid;
    const executionGenerationId = before.provider_ref?.execution_generation_id;
    assert.equal(originalPid, child?.pid);
    const bound = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff",
      room_id: "focus_37",
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret",
      api_url: apiUrl,
    });
    assert.equal(bound.ok, true, bound.error);
    const boundProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(boundProjection.worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(boundProjection.worker_binding?.work_attempt_id, workAttemptId);
    assert.equal(boundProjection.worker_binding?.execution_generation_id, executionGenerationId);
    assert.equal(boundProjection.last_worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(boundProjection.workplace_liveness?.state, "reachable", "fresh exact binding marks the MCP workplace reachable");
    assert.doesNotMatch(JSON.stringify(boundProjection), /session-secret|api_url/, "renderer projection never exposes worker authority");
    await daemonRequest(paths.socketPath, "manifest.update_workplace_liveness", {
      id: "supervised_handoff",
      state: "reachable",
      detail: "original bind timestamp",
      observed_at: "2026-01-01T00:00:00.000Z",
    });
    const heartbeatProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(heartbeatProjection.workplace_liveness?.state, "reachable", "fresh exact wait authority outranks the old manifest bind timestamp");
    assert.equal(heartbeatProjection.workplace_liveness?.observed_at, heartbeatProjection.worker_binding?.updated_at);
    await eventually(async () => nativeRequests.some((request) => request.body.method === "native_harness.bound"), "initial daemon worker binding activity");
    const initialBindingPublication = nativeRequests.find((request) => request.body.method === "native_harness.bound")!;
    assert.equal(initialBindingPublication.headers.authorization, "Bearer session-secret");
    assert.equal(initialBindingPublication.body.agent_session_id, undefined);
    assert.equal(initialBindingPublication.body.agent_session_token, undefined,
      "the scoped bearer travels only in the Authorization header");
    const deliveryRecoveryInternals = first as unknown as {
      updateManifestEntry: (entryId: string, mutate: (current: DaemonManifestEntry) => DaemonManifestEntry) => Promise<DaemonManifestEntry>;
      supervisedDelivery: { stop: (entryId: string) => Promise<void> };
    };
    await deliveryRecoveryInternals.updateManifestEntry("supervised_handoff", (current) => ({ ...current, delivery_mode: "daemon_inbox" }));
    await first.transition(
      "supervised_handoff",
      "recovering",
      "coordination_blocked",
      "Provider is running; waiting for desktop credential handoff.",
      "test-stale-handoff-latch",
    );
    const heartbeatCountBeforeRecovery = nativeRequests.filter((request) => request.body.method === "native_harness.heartbeat").length;
    await eventually(
      async () => nativeRequests.filter((request) => request.body.method === "native_harness.heartbeat").length > heartbeatCountBeforeRecovery,
      "credential handoff latch recovery heartbeat",
      5_000,
    );
    await eventually(async () => {
      const current = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
      return current.condition === "none" && current.observed_state === "working";
    }, "credential handoff latch self-heal");
    const recoveredFromStaleHandoff = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(recoveredFromStaleHandoff.condition, "none");
    assert.equal(recoveredFromStaleHandoff.observed_state, "working");
    assert.equal(recoveredFromStaleHandoff.last_error, null);
    assert.equal(recoveredFromStaleHandoff.workplace_liveness?.detail, "scoped worker bearer verified");
    assert.ok(recoveredFromStaleHandoff.ready_reached_at);
    await eventually(async () => deliveryPolls > 0, "credential recovery resumes daemon inbox polling");
    await deliveryRecoveryInternals.supervisedDelivery.stop("supervised_handoff");
    await deliveryRecoveryInternals.updateManifestEntry("supervised_handoff", (current) => ({ ...current, delivery_mode: "mcp_polling" }));
    const manifestAfterFirstBind = await new ManifestStore(paths.manifestPath).load();
    const workplaceObservedAtAfterFirstBind = manifestAfterFirstBind.entries
      .find((candidate) => candidate.id === "supervised_handoff")?.workplace_liveness?.observed_at;
    const repeatedBind = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff",
      room_id: "focus_37",
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret",
      api_url: apiUrl,
    });
    assert.equal(repeatedBind.ok, true, repeatedBind.error);
    const manifestAfterRepeatedBind = await new ManifestStore(paths.manifestPath).load();
    assert.equal(
      manifestAfterRepeatedBind.generation,
      manifestAfterFirstBind.generation,
      "an unchanged exact binding performs no full manifest commit",
    );
    assert.equal(
      manifestAfterRepeatedBind.entries.find((candidate) => candidate.id === "supervised_handoff")?.workplace_liveness?.observed_at,
      workplaceObservedAtAfterFirstBind,
      "an unchanged exact binding does not refresh manifest liveness or request another manifest write",
    );
    const emitCompatWaitCursor = (roomCursor: string, agentSessionId: string | null = "agent_session_exact") => {
      for (const listener of streamListeners) listener({
        workAttemptId,
        providerContinuationId: continuation,
        observedAt: new Date().toISOString(),
        sequence: ++sequence,
        provider: "claude-code",
        kind: "text_delta",
        method: "assistant",
        payload: {
          type: "assistant",
          message: { content: [{
            type: "tool_use",
            name: "mcp__letagents__wait_for_messages",
            input: {
              after_message_id: roomCursor,
              ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
            },
          }] },
        },
        payloadTruncated: false,
        payloadRedacted: false,
        durablePayloadRef: null,
      });
    };
    emitCompatWaitCursor("msg_2818");
    await eventually(async () => (await new WorkerBindingStore(paths.workerBindingsPath, undefined, paths.manifestPath).get("supervised_handoff"))?.room_cursor === "msg_2818", "published-runtime native wait cursor checkpoint");
    const pollingProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    assert.equal(pollingProjection.observed_state, "idle", "Claude room polling is reachable but not projected as active work");
    assert.equal(pollingProjection.activity?.at(-1)?.status, "idle");
    await eventually(async () => {
      const attempt = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: Array<{ room_cursor: string | null }> };
      return attempt.checkpoints.at(-1)?.room_cursor === "msg_2818";
    }, "published-runtime durable wait cursor checkpoint");
    const nativeCursorAttempt = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: Array<{ room_cursor: string | null }> };
    assert.equal(nativeCursorAttempt.checkpoints.at(-1)?.room_cursor, "msg_2818");
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_2820",
    })).ok, true);
    const regressiveFormalCursor = await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_2819",
    });
    assert.equal(regressiveFormalCursor.ok, true);
    assert.equal((regressiveFormalCursor.result as { room_cursor: string }).room_cursor, "msg_2820",
      "out-of-order formal acknowledgements report and preserve the newest durable cursor");
    emitCompatWaitCursor("msg_2819");
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 2), "delayed compatibility cursor evidence");
    const formalCursorWins = await new WorkerBindingStore(paths.workerBindingsPath, undefined, paths.manifestPath).get("supervised_handoff");
    assert.equal(formalCursorWins?.room_cursor, "msg_2820", "delayed compatibility evidence cannot regress the formal response cursor");
    const formalCursorAttempt = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: Array<{ room_cursor: string | null }> };
    assert.equal(formalCursorAttempt.checkpoints.at(-1)?.room_cursor, "msg_2820", "durable attempt progress follows the same serialized no-regression order");
    for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: new Date().toISOString(), sequence: ++sequence, provider: "codex", kind: "tool_lifecycle", method: "item/toolCall/started", payload: { tool: "test" }, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 3), "first native stream event after cursor evidence");
    await eventually(async () => nativeRequests.some((request) => request.body.method === "item/toolCall/started"), "daemon-supervised stream HTTP publication");
    const workingProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    assert.equal(workingProjection.observed_state, "working", "real Codex tool work restores the active projection");
    const diagnosticProjection = workingProjection as DaemonManifestEntryView;
    assert.deepEqual(diagnosticProjection.delivery_receipts, [], "raw provider notifications remain diagnostics, not room deliveries");
    assert.equal(diagnosticProjection.room_agent_state?.turn.state, "idle", "diagnostic provider work cannot invent an inbox turn");
    assert.equal(diagnosticProjection.native_liveness?.state, "active", "the native presence axis still truthfully reflects provider work");
    const published = nativeRequests.find((request) => request.body.method === "item/toolCall/started")!;
    assert.equal(published.headers.authorization, "Bearer session-secret", "daemon sends only the scoped worker bearer");
    assert.equal(published.body.agent_session_id, undefined);
    assert.equal(published.body.agent_session_token, undefined);
    assert.equal(published.body.status, "working");
    assert.equal(typeof published.body.sequence, "number");
    assert.ok(published.body.sequence > 0);
    assert.equal((await stat(paths.manifestPath)).mode & 0o777, 0o600);
    await assert.rejects(() => readFile(paths.workerBindingsPath, "utf8"), { code: "ENOENT" });
    assert.doesNotMatch(JSON.stringify((await daemonRequest(paths.socketPath, "manifest.list")).result), /session-secret/);
    const nativeCanary = "canary-not-a-real-native-secret-123456789";
    const nativeInternals = first as unknown as { publishNativeActivity: (entryId: string, method: string, status: "working" | "idle") => Promise<boolean> };
    await nativeInternals.publishNativeActivity("supervised_handoff", `tool Authorization: Bearer ${nativeCanary}`, "working");
    const canaryPublication = nativeRequests.at(-1)!;
    assert.doesNotMatch(JSON.stringify(canaryPublication.body), new RegExp(nativeCanary));
    assert.match(canaryPublication.body.method, /REDACTED/);

    const sameObservedAt = new Date().toISOString();
    for (const [method, eventObservedAt] of [
      ["turn/same-millisecond-a", sameObservedAt],
      ["turn/same-millisecond-b", sameObservedAt],
      ["turn/reordered-older", new Date(Date.parse(sameObservedAt) - 60_000).toISOString()],
    ] as const) {
      for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: eventObservedAt, sequence: ++sequence, provider: "codex", kind: "turn_lifecycle", method, payload: {}, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    }
    await eventually(async () => nativeRequests.filter((request) => /same-millisecond|reordered-older/.test(request.body.method)).length === 3, "same-ms and reordered native publications");
    const orderedPublications = ["item/toolCall/started", "turn/same-millisecond-a", "turn/same-millisecond-b", "turn/reordered-older"]
      .map((method) => nativeRequests.find((request) => request.body.method === method)!.body);
    for (let index = 1; index < orderedPublications.length; index += 1) {
      assert.ok(orderedPublications[index]!.sequence > orderedPublications[index - 1]!.sequence);
      assert.ok(Date.parse(orderedPublications[index]!.observed_at) > Date.parse(orderedPublications[index - 1]!.observed_at));
    }
    assert.equal(maxNativeRequestsInFlight, 1, "the durable publication mutex remains held through fetch completion");
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 6), "serialized local native events");

    await first.stop();
    assert.doesNotThrow(() => process.kill(originalPid!, 0), "provider survives daemon handoff");
    second = new SupervisorDaemon(paths, "darwin", port(), true);
    await second.start();
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working"), "replacement daemon attach");
    await eventually(async () => streamListeners.size === 1, "replacement native stream subscription");
    await daemonRequest(paths.socketPath, "manifest.update_workplace_liveness", {
      id: "supervised_handoff",
      state: "unknown",
      detail: "replacement daemon awaiting exact persisted bind",
      observed_at: new Date().toISOString(),
    });
    const replacementDaemonGeneration = Number(((await daemonRequest(paths.socketPath, "daemon.negotiate")).result as { generation: number }).generation);
    const retiredCredential = await daemonRequest(paths.socketPath, "supervisor.borrow_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId,
      daemon_generation: replacementDaemonGeneration, api_url: apiUrl,
    });
    assert.deepEqual(retiredCredential.result, { status: "deferred" },
      "the replacement retains the exact public route but cannot borrow the retired daemon's credential");
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    })).ok, true);
    const after = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    assert.equal(after.provider_ref?.provider_connection?.pid, originalPid);
    assert.equal(after.provider_ref?.provider_continuation_id, continuation);
    assert.equal(after.work_attempt_id, workAttemptId);
    assert.equal(after.provider_ref?.execution_generation_id, executionGenerationId,
      "handoff reattaches the same live execution generation instead of minting a replacement");
    assert.equal((after as DaemonManifestEntryView).worker_binding?.agent_session_id, "agent_session_exact", "daemon handoff preserves the public exact-session projection");
    assert.equal(after.workplace_liveness?.state, "reachable", "idempotent persisted bind restores workplace reachability after daemon replacement");
    sequence = 0; // A freshly attached adapter has a fresh local counter.
    for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: new Date().toISOString(), sequence: ++sequence, provider: "codex", kind: "item_lifecycle", method: "item/completed", payload: {}, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 7), "reattached stream event");
    await eventually(async () => nativeRequests.some((request) => request.body.method === "item/completed"), "replacement daemon native stream publication");
    assert.equal(after.activity?.at(-1)?.sequence, 6);
    const withReattachedStream = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    assert.equal(withReattachedStream.activity?.at(-1)?.sequence, 7, "daemon preserves global activity ordering across adapter counter reset");
    assert.equal(withReattachedStream.observed_state, "idle", "a completion notification truthfully returns native presence to idle");
    assert.equal(withReattachedStream.native_liveness?.state, "idle");
    assert.deepEqual((withReattachedStream as DaemonManifestEntryView).delivery_receipts, [],
      "provider completion diagnostics cannot fabricate a delivery receipt after handoff");
    const firstPublished = nativeRequests.find((request) => request.body.method === "item/toolCall/started")!;
    const reattachedPublished = nativeRequests.find((request) => request.body.method === "item/completed")!;
    assert.ok(reattachedPublished.body.sequence > firstPublished.body.sequence, "durable publisher sequence survives daemon generation handoff");

    rejectNativeActivity = true;
    for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: new Date().toISOString(), sequence: ++sequence, provider: "codex", kind: "turn_lifecycle", method: "turn/rejected-for-successor", payload: {}, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    await eventually(async () => nativeRequests.some((request) => request.body.method === "turn/rejected-for-successor"), "successor fence rejection");
    await eventually(async () => (await new WorkerBindingStore(paths.workerBindingsPath, undefined, paths.manifestPath).get("supervised_handoff")) === null, "stale worker binding removal");
    const requestsAfterFence = nativeRequests.length;
    for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: new Date().toISOString(), sequence: ++sequence, provider: "codex", kind: "turn_lifecycle", method: "turn/must-not-publish-after-fence", payload: {}, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 9), "local post-fence stream evidence");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(nativeRequests.length, requestsAfterFence, "successor rejection fences later native publications");

    const generationsBeforeBindingRecovery = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { execution_generations: unknown[] }).execution_generations.length;
    const recoveryInternals = second as unknown as {
      transition: (entryId: string, observed: "recovering", condition: "coordination_blocked", cause: string, actor: string) => Promise<void>;
    };
    await recoveryInternals.transition("supervised_handoff", "recovering", "coordination_blocked", "lost current worker binding during exact-generation recovery", "test-recovery");
    const latchedProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(latchedProjection.worker_binding, null);
    assert.equal(latchedProjection.last_worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(latchedProjection.condition, "coordination_blocked");
    assert.equal(latchedProjection.reconciliation?.pending_action, null);

    // Room access is restored only when the bound observation is accepted
    // remotely. A rejected publication must fail the bind, keep the
    // coordination latch, and never project the agent as working — otherwise
    // the bounded room-access retry resets and flickers on every cycle.
    const rejectedBind = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    });
    assert.equal(rejectedBind.ok, false, "a bind whose native publication is rejected must not report success");
    assert.match(String(rejectedBind.error), /stale daemon observation/);
    const stillLatchedProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(stillLatchedProjection.condition, "coordination_blocked",
      "a rejected room publication cannot clear the coordination latch");
    assert.notEqual(stillLatchedProjection.observed_state, "working",
      "a rejected room publication cannot project the agent as working");

    rejectNativeActivity = false;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_2822",
    })).ok, true);
    const recoveredProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(recoveredProjection.observed_state, "working");
    assert.equal(recoveredProjection.condition, "none", "exact worker rebind clears the coordination latch");
    assert.equal(recoveredProjection.last_error, null);
    assert.equal(recoveredProjection.worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(recoveredProjection.worker_binding?.execution_generation_id, executionGenerationId);
    assert.equal(recoveredProjection.last_worker_binding?.agent_session_id, "agent_session_exact");
    const generationsAfterBindingRecovery = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { execution_generations: unknown[] }).execution_generations.length;
    assert.equal(generationsAfterBindingRecovery, generationsBeforeBindingRecovery, "binding recovery cannot mint a duplicate execution generation");
    assert.equal(resumeCount, 0, "binding recovery reuses the same worker before a later intentional pause/resume");
    const checkpointsBeforeNoop = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: unknown[] }).checkpoints.length;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_2822",
    })).ok, true);
    const checkpointsAfterNoop = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: unknown[] }).checkpoints.length;
    assert.equal(checkpointsAfterNoop, checkpointsBeforeNoop, "an unchanged poll cursor appends no durability checkpoint");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "paused" });
    await eventually(async () => !child?.pid || (() => { try { process.kill(child.pid!, 0); return false; } catch { return true; } })(), "daemon stop authority");
    await eventually(async () => (await new WorkerBindingStore(paths.workerBindingsPath, undefined, paths.manifestPath).get("supervised_handoff"))?.agent_session_id === "agent_session_exact", "paused attempt retains exact private worker continuity");
    const stoppedProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(stoppedProjection.worker_binding, null, "paused terminal generation is not projected as live worker authority");
    assert.equal(stoppedProjection.last_worker_binding?.agent_session_id, "agent_session_exact", "pause preserves the non-secret exact control route");
    await eventually(async () => {
      const stopped = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return stopped.observed_state === "paused" && stopped.condition === "none";
    }, "intentional pause remains unblocked after the terminal callback");

    const stoppedPid = child?.pid;
    const stoppedGenerationId = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!.provider_ref!.execution_generation_id;
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "running" });
    await eventually(async () => {
      const resumed = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return resumed.observed_state === "recovering" && resumed.condition === "coordination_blocked" && resumed.provider_ref?.execution_generation_id !== stoppedGenerationId;
    }, "intentional stop resumes under a successor awaiting exact wait proof");
    const awaitingWait = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(awaitingWait.id, "supervised_handoff");
    assert.equal(awaitingWait.work_attempt_id, workAttemptId, "resume preserves the durable work attempt");
    assert.equal(awaitingWait.provider_ref?.provider_continuation_id, continuation, "resume preserves provider continuation identity");
    assert.notEqual(awaitingWait.provider_ref?.provider_connection?.pid, stoppedPid, "resume installs the replacement provider process");
    assert.equal(awaitingWait.worker_binding, null, "predecessor authority is not projected onto an unproven successor");
    assert.equal(resumeCount, 1);
    assert.deepEqual(resumeRequests[0]?.supervisorWorkerSession, {
      agentSessionId: "agent_session_exact",
      roomCursor: "msg_2822",
    }, "resume receives the exact prior worker identity and cursor without its secret");
    assert.doesNotMatch(JSON.stringify(resumeRequests[0]), /session-secret/, "provider request never receives worker session authority");
    const resumedGenerationId = awaitingWait.provider_ref!.execution_generation_id;
    const predecessorBeforeProof = await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff");
    assert.equal(predecessorBeforeProof?.execution_generation_id, stoppedGenerationId, "private credential remains on its terminal predecessor before verification");
    const stagingInternals = second as unknown as {
      stageWorkerBindingAfterResume: (
        manifestEntry: DaemonManifestEntry,
        binding: NonNullable<typeof predecessorBeforeProof>,
        successorExecutionGenerationId: string,
        providerHandle: ReturnType<typeof handle>,
      ) => Promise<void>;
    };
    await assert.rejects(stagingInternals.stageWorkerBindingAfterResume(
      {
        ...awaitingWait,
        provider_ref: { ...awaitingWait.provider_ref!, provider_continuation_id: "thread-changed" },
      },
      predecessorBeforeProof!,
      resumedGenerationId,
      { ...handle(), workAttemptId, providerContinuationId: "thread-changed" },
    ), /different provider continuation/, "restart reconstruction cannot carry a credential across a changed provider continuation");
    await second.stop();
    second = new SupervisorDaemon(paths, "darwin", port(), true);
    await second.start();
    await eventually(async () => {
      const reattached = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]!;
      return reattached.provider_ref?.execution_generation_id === resumedGenerationId
        && ["recovering", "working"].includes(reattached.observed_state)
        && reattached.condition === "coordination_blocked"
        && reattached.worker_binding === null
        && streamListeners.size === 1
        && (second as unknown as { workerRuntimeCustody: WorkerRuntimeCustody }).workerRuntimeCustody.hasPendingResumeBinding("supervised_handoff");
    }, "daemon restart reconstructs the staged successor before its first wait", 8_000);
    assert.equal(resumeCount, 1, "staging reconstruction attaches the single live successor without another resume");
    assert.equal((await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff"))?.execution_generation_id, stoppedGenerationId, "restart-window reconstruction preserves predecessor authority until proof");
    const activityBeforeInvalidWaits = awaitingWait.activity?.length ?? 0;
    emitCompatWaitCursor("msg_2823", "agent_session_peer");
    emitCompatWaitCursor("msg_2823", null);
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length ?? 0) >= activityBeforeInvalidWaits + 2, "invalid successor wait evidence persisted without authority");
    const afterInvalidWaits = await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff");
    assert.equal(afterInvalidWaits?.execution_generation_id, stoppedGenerationId, "mismatched or missing wait identity cannot roll the predecessor credential");
    assert.equal(afterInvalidWaits?.room_cursor, "msg_2822", "mismatched or missing wait identity cannot advance the cursor");
    assert.equal((((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!.condition, "coordination_blocked");

    // A fresh daemon never recovers a secret from SQLite. A terminal
    // predecessor is not a valid credential route, even while the resumed
    // provider is waiting for room delivery to be re-established.
    const daemonGeneration = Number(((await daemonRequest(paths.socketPath, "daemon.negotiate")).result as { generation: number }).generation);
    const installed = await daemonRequest(paths.socketPath, "supervisor.install_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: stoppedGenerationId, agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret", daemon_generation: daemonGeneration,
    });
    assert.equal((installed.result as { status: string }).status, "stale");
    const oldBorrow = await daemonRequest(paths.socketPath, "supervisor.borrow_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: stoppedGenerationId, agent_session_id: "agent_session_exact", daemon_generation: daemonGeneration, api_url: apiUrl,
    });
    assert.equal((oldBorrow.result as { status: string }).status, "stale", "terminal predecessor cannot borrow while the successor is recovering");

    // The replacement must establish the active successor route first. Only
    // then can Electron's exact-generation delivery be installed/borrowed.
    const successorBind = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: resumedGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    });
    assert.equal(successorBind.ok, true, successorBind.error);
    const successorInstall = await daemonRequest(paths.socketPath, "supervisor.install_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: resumedGenerationId, agent_session_id: "agent_session_exact",
      agent_session_token: "desktop-delivered-successor-secret", daemon_generation: daemonGeneration,
    });
    assert.equal((successorInstall.result as { status: string }).status, "installed");
    const successorBorrow = await daemonRequest(paths.socketPath, "supervisor.borrow_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: resumedGenerationId, agent_session_id: "agent_session_exact", daemon_generation: daemonGeneration, api_url: apiUrl,
    });
    assert.deepEqual(successorBorrow.result, { status: "available", credential: "desktop-delivered-successor-secret" });
    const crossOriginBorrow = await daemonRequest(paths.socketPath, "supervisor.borrow_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: resumedGenerationId, agent_session_id: "agent_session_exact", daemon_generation: daemonGeneration,
      api_url: "https://attacker.invalid",
    });
    assert.deepEqual(crossOriginBorrow.result, { status: "stale" }, "credential borrowing is bound to the registered API origin");
    const rebound = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: resumedGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    });
    assert.equal(rebound.ok, true, rebound.error);
    const reboundProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(reboundProjection.worker_binding?.agent_session_id, "agent_session_exact", "the successor execution restores the same worker binding");
    assert.equal(reboundProjection.last_worker_binding?.agent_session_id, "agent_session_exact", "the durable exact control route remains unchanged");
    assert.equal(reboundProjection.worker_binding?.execution_generation_id, resumedGenerationId);
    assert.doesNotMatch(JSON.stringify(reboundProjection), /session-secret/);
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: resumedGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_2824",
    })).ok, true);
    for (const listener of streamListeners) listener({
      workAttemptId,
      providerContinuationId: continuation,
      observedAt: new Date().toISOString(),
      sequence: ++sequence,
      provider: "claude-code",
      kind: "error",
      method: "result/error_during_execution",
      payload: { type: "result", subtype: "error_during_execution", is_error: true },
      payloadTruncated: false,
      payloadRedacted: false,
      durablePayloadRef: null,
    });
    await eventually(async () => {
      const recovered = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return recovered.observed_state === "recovering"
        && recovered.condition === "coordination_blocked"
        && recovered.provider_ref?.execution_generation_id !== resumedGenerationId;
    }, "terminal provider turn enters a bounded resume generation awaiting wait proof");
    const recoveredAwaitingWait = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    const recoveredGenerationId = recoveredAwaitingWait.provider_ref!.execution_generation_id;
    assert.equal(resumeCount, 2);
    assert.deepEqual(resumeRequests[1]?.supervisorWorkerSession, {
      agentSessionId: "agent_session_exact",
      roomCursor: "msg_2824",
    });
    assert.equal((await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff"))?.execution_generation_id, resumedGenerationId);
    emitCompatWaitCursor("msg_2825");
    await eventually(async () => {
      const recovered = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]!;
      return recovered.observed_state === "working"
        && recovered.condition === "none"
        && recovered.worker_binding?.execution_generation_id === recoveredGenerationId;
    }, "terminal-turn successor exact wait restores coordination");
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: recoveredGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    })).ok, true, "the recovered generation rebinds the same exact worker session");
    const staleBind = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_stale",
      work_attempt_id: workAttemptId, execution_generation_id: stoppedGenerationId,
      agent_session_token: "stale-secret", api_url: apiUrl,
    });
    assert.equal(staleBind.ok, false, "a terminal predecessor generation cannot bind a worker session");
    assert.match(staleBind.error ?? "", /terminal|active supervised manifest entry/);
    const wrongAttemptBind = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_unrelated",
      work_attempt_id: randomUUID(), execution_generation_id: recoveredGenerationId,
      agent_session_token: "unrelated-secret", api_url: apiUrl,
    });
    assert.equal(wrongAttemptBind.ok, false, "another work attempt cannot bind through a copied stable context");
    assert.match(wrongAttemptBind.error ?? "", /work attempt/);
    const resumedAttempt = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { restart_count: number; execution_generations: Array<{ terminal: unknown }> };
    assert.equal(resumedAttempt.restart_count, 2);
    assert.ok(resumedAttempt.execution_generations[0]?.terminal, "the predecessor terminal remains immutable after resume");
    assert.ok(resumedAttempt.execution_generations[1]?.terminal, "the native terminal-turn generation is durably terminal");
    assert.equal(resumedAttempt.execution_generations[2]?.terminal, null, "the recovered successor is the only live generation");

    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "stopped" });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "stopped"), "second intentional stop");
    await second.stop();
    second = null;
    third = new SupervisorDaemon(paths, "darwin", port(), true);
    await third.start();
    await eventually(async () => {
      const stopped = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return stopped.observed_state === "stopped" && stopped.condition === "none";
    }, "replacement daemon keeps a terminal generation stopped without stale attachment");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "running" });
    await eventually(async () => {
      const resumedAfterHandoff = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return resumedAfterHandoff.observed_state === "recovering" && resumedAfterHandoff.condition === "coordination_blocked";
    }, "replacement daemon resumes the stopped work attempt awaiting wait proof");
    const retainedAfterHandoff = await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff");
    assert.ok(retainedAfterHandoff);
    const thirdGeneration = Number(((await daemonRequest(paths.socketPath, "daemon.negotiate")).result as { generation: number }).generation);
    const retiredInstall = await daemonRequest(paths.socketPath, "supervisor.install_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: retainedAfterHandoff.execution_generation_id, agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret", daemon_generation: thirdGeneration,
    });
    assert.equal((retiredInstall.result as { status: string }).status, "stale");
    const activeAfterHandoff = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!.provider_ref!.execution_generation_id;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: activeAfterHandoff, agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret", api_url: apiUrl,
    })).ok, true);
    const thirdInstall = await daemonRequest(paths.socketPath, "supervisor.install_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: activeAfterHandoff, agent_session_id: "agent_session_exact",
      agent_session_token: "desktop-delivered-after-handoff", daemon_generation: thirdGeneration,
    });
    assert.equal((thirdInstall.result as { status: string }).status, "installed");
    emitCompatWaitCursor("msg_2826");
    await eventually(async () => {
      const resumedAfterHandoff = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return resumedAfterHandoff.observed_state === "working" && resumedAfterHandoff.condition === "none";
    }, "replacement daemon exact wait restores the stopped work attempt");
    assert.equal(resumeCount, 3);

    const exactGenerationBeforeFreshStart = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!.provider_ref!.execution_generation_id;
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "stopped" });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "stopped"), "fresh-start negative terminal predecessor");
    resumeSupported = false;
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "running" });
    await eventually(async () => {
      const fresh = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]!;
      return fresh.provider_ref?.execution_generation_id !== exactGenerationBeforeFreshStart
        && fresh.observed_state === "recovering"
        && fresh.condition === "coordination_blocked"
        && fresh.worker_binding === null;
    }, "fresh spawn with a terminal predecessor credential fails closed awaiting formal bind");
    assert.equal(resumeCount, 3, "fresh-spawn negative does not masquerade as native resume");
    assert.equal((third as unknown as { workerRuntimeCustody: WorkerRuntimeCustody }).workerRuntimeCustody.hasPendingResumeBinding("supervised_handoff"), false, "fresh spawn cannot enter compatibility rollover");
    assert.equal((await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff"))?.execution_generation_id, exactGenerationBeforeFreshStart, "fresh spawn preserves terminal predecessor authority without rolling it");
  } finally {
    await third?.stop().catch(() => undefined);
    await second?.stop().catch(() => undefined);
    await first.stop().catch(() => undefined);
    if (child?.pid) { try { process.kill(child.pid, "SIGKILL"); } catch { /* already stopped */ } }
    await new Promise<void>((resolve) => nativeServer.close(() => resolve()));
    await env.cleanup();
  }
});

test("ambiguous destination join retries when the server commits before the response is lost", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "room-move-lost-response.lock"),
    socketPath: join(env.root, "room-move-lost-response.sock"),
    manifestPath: join(env.root, "room-move-lost-response.sqlite"),
    auditPath: join(env.root, "room-move-lost-response-audit.jsonl"),
    workerBindingsPath: join(env.root, "room-move-lost-response-bindings.json"),
  };
  let destinationMembership = false;
  let joinAttempts = 0;
  const deliveryHttp: SupervisedDeliveryHttp = {
    async poll() { return { messages: [] }; },
    async latest() { return { messages: [] }; },
    async publish(input) { return { messageId: "published", roomId: input.roomId }; },
    async joinRoom(input) {
      joinAttempts += 1;
      if (input.roomId === "destination-room") {
        destinationMembership = true;
        if (joinAttempts === 1) throw new Error("connection reset after server commit");
      }
      return { roomId: input.roomId };
    },
  };
  type Internals = {
    store: ManifestStore;
    workerBindings: WorkerBindingStore;
    reconcileRoomMove: (move: DaemonRoomMoveRecord) => Promise<DaemonRoomMoveRecord>;
  };
  const daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, deliveryHttp);
  try {
    await daemon.start();
    const generation = Number(((await daemonRequest(paths.socketPath, "daemon.negotiate")).result as { generation: number }).generation);
    const moving: DaemonManifestEntry = {
      ...entry, id: "lost_response_move", room_id: "source-room", delivery_mode: "daemon_inbox",
      work_attempt_id: "attempt_lost_response",
      provider_ref: {
        ...entry.provider_ref!, work_attempt_id: "attempt_lost_response",
        execution_generation_id: "run_lost_response",
      },
      last_worker_binding: null,
    };
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: moving })).ok, true);
    const internals = daemon as unknown as Internals;
    await internals.workerBindings.bind({
      entry_id: moving.id, room_id: moving.room_id, work_attempt_id: moving.work_attempt_id!,
      execution_generation_id: moving.provider_ref!.execution_generation_id,
      agent_session_id: "session_source", agent_session_token: "secret_source",
      api_url: "https://letagents.test",
    });
    const prepared = (await internals.store.prepareRoomMove({
      operation_id: "move_lost_response", request_id: "move_lost_response", agent_id: moving.id,
      source_room_id: "source-room", destination_room_id: "destination-room", daemon_generation: generation,
      work_attempt_id: moving.work_attempt_id, execution_generation_id: moving.provider_ref!.execution_generation_id,
      agent_session_id: "session_source", activating_inbox_item_id: null, provider_turn_id: null,
      effect_id: null, phase: "prepared",
    })).move;
    const joining = await internals.store.advanceRoomMove({
      operationId: prepared.operation_id, agentId: prepared.agent_id, expectedDaemonGeneration: generation,
      expectedExecutionGenerationId: prepared.execution_generation_id, from: ["prepared"], to: "joining_destination",
    });

    let move = await internals.reconcileRoomMove(joining);
    assert.equal(destinationMembership, true, "the simulated server committed destination membership");
    assert.equal(move.phase, "joining_destination");
    assert.match(move.error ?? "", /ambiguous and will retry/);
    assert.equal((await internals.store.getEntry(moving.id))?.room_id, "source-room");

    move = await internals.reconcileRoomMove(move);
    assert.equal(joinAttempts, 2);
    assert.equal(move.phase, "rotating_credentials");
    assert.equal(move.source_credentials_revoked, false);
    assert.equal((await internals.store.getEntry(moving.id))?.room_id, "destination-room");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("handoff drains an admitted room join and leaves its ambiguity for the successor without stale commits", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "move-handoff.lock"),
    socketPath: join(env.root, "move-handoff.sock"),
    manifestPath: join(env.root, "move-handoff.sqlite"),
    auditPath: join(env.root, "move-handoff-audit.jsonl"),
    workerBindingsPath: join(env.root, "move-handoff-bindings.json"),
  };
  let joinEntered!: () => void;
  const entered = new Promise<void>((resolve) => { joinEntered = resolve; });
  let releaseJoin!: () => void;
  const joinGate = new Promise<void>((resolve) => { releaseJoin = resolve; });
  let deferJoin = true;
  const joinedRooms: string[] = [];
  const deliveryHttp: SupervisedDeliveryHttp = {
    poll: async () => ({ messages: [] }),
    publish: async () => {},
    latest: async () => ({ messages: [] }),
    joinRoom: async ({ roomId }) => {
      joinedRooms.push(roomId);
      if (deferJoin) { joinEntered(); await joinGate; }
      return { roomId };
    },
  };
  type Internals = {
    store: ManifestStore;
    workerBindings: WorkerBindingStore;
    reconcileRoomMove: (move: DaemonRoomMoveRecord) => Promise<DaemonRoomMoveRecord>;
  };
  let first: SupervisorDaemon | null = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, deliveryHttp);
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    const generation = Number(((await daemonRequest(paths.socketPath, "daemon.negotiate")).result as { generation: number }).generation);
    const moving: DaemonManifestEntry = {
      ...entry,
      id: "move_handoff",
      room_id: "source-room",
      delivery_mode: "daemon_inbox",
      condition: "none",
      work_attempt_id: "attempt-move-handoff",
      provider_ref: {
        ...entry.provider_ref!,
        work_attempt_id: "attempt-move-handoff",
        execution_generation_id: "generation-move-handoff",
      },
      last_worker_binding: null,
    };
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: moving })).ok, true);
    const internals = first as unknown as Internals;
    await internals.workerBindings.bind({
      entry_id: moving.id,
      room_id: moving.room_id,
      work_attempt_id: moving.work_attempt_id!,
      execution_generation_id: moving.provider_ref!.execution_generation_id,
      agent_session_id: "move-handoff-session",
      agent_session_token: "move-handoff-secret",
      api_url: "https://letagents.test",
    });
    const prepared = (await internals.store.prepareRoomMove({
      operation_id: "move-handoff-operation",
      request_id: "move-handoff-operation",
      agent_id: moving.id,
      source_room_id: moving.room_id,
      destination_room_id: "destination-room",
      daemon_generation: generation,
      work_attempt_id: moving.work_attempt_id,
      execution_generation_id: moving.provider_ref!.execution_generation_id,
      agent_session_id: "move-handoff-session",
      activating_inbox_item_id: null,
      provider_turn_id: null,
      effect_id: null,
      phase: "prepared",
    })).move;
    const reconciliation = internals.reconcileRoomMove(prepared);
    await entered;
    const handoffCompletion = first.waitForHandoff();
    let acknowledged = false;
    const prepareHandoff = daemonRequest(paths.socketPath, "daemon.prepare_handoff").then((result) => {
      acknowledged = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(acknowledged, false, "handoff acknowledgement waits for the admitted bounded room effect");
    releaseJoin();
    assert.equal((await prepareHandoff).ok, true);
    await within(handoffCompletion, "room-move handoff drain", 1_000);
    await reconciliation;
    first = null;

    const inspection = new ManifestStore(paths.manifestPath);
    const durable = await inspection.getRoomMove(prepared.operation_id);
    assert.equal(durable?.phase, "joining_destination", "the fenced old daemon cannot claim a post-await journal commit");
    await inspection.close();

    deferJoin = false;
    second = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, deliveryHttp);
    await second.start();
    const successor = second as unknown as Internals;
    await successor.workerBindings.bind({
      entry_id: moving.id,
      room_id: moving.room_id,
      work_attempt_id: moving.work_attempt_id!,
      execution_generation_id: moving.provider_ref!.execution_generation_id,
      agent_session_id: "move-handoff-session",
      agent_session_token: "move-handoff-successor-secret",
      api_url: "https://letagents.test",
    });
    const adopted = await successor.reconcileRoomMove((await successor.store.getRoomMove(prepared.operation_id))!);
    assert.equal(adopted.phase, "rotating_credentials", "the successor idempotently resumes the durable join ambiguity");
    assert.deepEqual(joinedRooms, ["destination-room", "destination-room"]);
  } finally {
    await second?.stop().catch(() => undefined);
    await first?.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("shutdown wakes a room move queued behind unrelated entry work without waiting or touching closed stores", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "queued-move.lock"),
    socketPath: join(env.root, "queued-move.sock"),
    manifestPath: join(env.root, "queued-move.sqlite"),
    auditPath: join(env.root, "queued-move-audit.jsonl"),
  };
  let joinCalls = 0;
  let daemon: SupervisorDaemon | null = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }),
    publish: async () => {},
    joinRoom: async ({ roomId }) => { joinCalls += 1; return { roomId }; },
  });
  try {
    await daemon.start();
    const generation = Number(((await daemonRequest(paths.socketPath, "daemon.negotiate")).result as { generation: number }).generation);
    const moving: DaemonManifestEntry = {
      ...entry,
      id: "queued_move_shutdown",
      room_id: "source-room",
      delivery_mode: "daemon_inbox",
      condition: "none",
      work_attempt_id: "attempt-queued-move",
      provider_ref: {
        ...entry.provider_ref!,
        work_attempt_id: "attempt-queued-move",
        execution_generation_id: "generation-queued-move",
      },
    };
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: moving })).ok, true);
    const internals = daemon as unknown as {
      store: ManifestStore;
      serializeEntryTick: <T>(entryId: string, operation: () => Promise<T>) => Promise<T>;
      reconcileRoomMove: (move: DaemonRoomMoveRecord) => Promise<DaemonRoomMoveRecord>;
    };
    const prepared = (await internals.store.prepareRoomMove({
      operation_id: "queued-move-operation",
      request_id: "queued-move-operation",
      agent_id: moving.id,
      source_room_id: moving.room_id,
      destination_room_id: "destination-room",
      daemon_generation: generation,
      work_attempt_id: moving.work_attempt_id,
      execution_generation_id: moving.provider_ref!.execution_generation_id,
      agent_session_id: "queued-move-session",
      activating_inbox_item_id: null,
      provider_turn_id: null,
      effect_id: null,
      phase: "prepared",
    })).move;
    let laneEntered!: () => void;
    const entered = new Promise<void>((resolve) => { laneEntered = resolve; });
    let releaseLane!: () => void;
    const laneGate = new Promise<void>((resolve) => { releaseLane = resolve; });
    const heldLane = internals.serializeEntryTick(moving.id, async () => {
      laneEntered();
      await laneGate;
    });
    await entered;
    const queuedReconciliation = internals.reconcileRoomMove(prepared);
    const stopped = daemon.stop();
    await within(stopped, "shutdown with queued room move", 1_000);
    daemon = null;
    assert.equal((await queuedReconciliation).phase, "prepared");
    assert.equal(joinCalls, 0);
    releaseLane();
    await heldLane;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(joinCalls, 0, "the queued callback returns its captured snapshot after store closure");
  } finally {
    await daemon?.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a restarted joining-destination mismatch requires source compensation instead of claiming pre-join failure", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "ambiguous.lock"),
    socketPath: join(env.root, "ambiguous.sock"),
    manifestPath: join(env.root, "ambiguous.sqlite"),
    auditPath: join(env.root, "ambiguous-audit.jsonl"),
    workerBindingsPath: join(env.root, "ambiguous-bindings.json"),
  };
  const joinedRooms: string[] = [];
  const daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }),
    publish: async () => {},
    joinRoom: async ({ roomId }) => { joinedRooms.push(roomId); return { roomId }; },
  });
  try {
    await daemon.start();
    const generation = Number(((await daemonRequest(paths.socketPath, "daemon.negotiate")).result as { generation: number }).generation);
    const moving: DaemonManifestEntry = {
      ...entry,
      id: "ambiguous_join_mismatch",
      room_id: "source-room",
      delivery_mode: "daemon_inbox",
      condition: "none",
      work_attempt_id: "attempt-ambiguous-join",
      provider_ref: {
        ...entry.provider_ref!,
        work_attempt_id: "attempt-ambiguous-join",
        execution_generation_id: "generation-ambiguous-join",
      },
      last_worker_binding: null,
    };
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: moving })).ok, true);
    const internals = daemon as unknown as {
      store: ManifestStore;
      workerBindings: WorkerBindingStore;
      updateManifestEntry: (entryId: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry) => Promise<DaemonManifestEntry>;
      reconcileRoomMove: (move: DaemonRoomMoveRecord) => Promise<DaemonRoomMoveRecord>;
    };
    await internals.workerBindings.bind({
      entry_id: moving.id,
      room_id: moving.room_id,
      work_attempt_id: moving.work_attempt_id!,
      execution_generation_id: moving.provider_ref!.execution_generation_id,
      agent_session_id: "source-session",
      agent_session_token: "source-secret",
      api_url: "https://letagents.test",
    });
    const prepared = (await internals.store.prepareRoomMove({
      operation_id: "ambiguous-mismatch-move",
      request_id: "ambiguous-mismatch-move",
      agent_id: moving.id,
      source_room_id: moving.room_id,
      destination_room_id: "requested-destination",
      daemon_generation: generation,
      work_attempt_id: moving.work_attempt_id,
      execution_generation_id: moving.provider_ref!.execution_generation_id,
      agent_session_id: "source-session",
      activating_inbox_item_id: null,
      provider_turn_id: null,
      effect_id: null,
      phase: "prepared",
    })).move;
    const joining = await internals.store.advanceRoomMove({
      operationId: prepared.operation_id,
      agentId: moving.id,
      expectedDaemonGeneration: generation,
      expectedExecutionGenerationId: moving.provider_ref!.execution_generation_id,
      from: ["prepared"],
      to: "joining_destination",
    });
    await internals.updateManifestEntry(moving.id, (current) => ({ ...current, desired_state: "paused" }));

    const ambiguous = await internals.reconcileRoomMove(joining);
    assert.equal(ambiguous.phase, "rollback_required");
    assert.equal(ambiguous.remote_room_id, null);
    assert.deepEqual(joinedRooms, [], "runtime mismatch never claims that the ambiguous destination join was absent");

    const compensated = await internals.reconcileRoomMove(ambiguous);
    assert.equal(compensated.phase, "failed");
    assert.deepEqual(joinedRooms, ["source-room"], "unknown canonical destination is compensated by exact source rejoin");
    assert.equal((await internals.store.getEntry(moving.id))?.room_id, "source-room");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("alias room move journals its canonical destination before local membership and resumes after that crash gap", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "room-move-alias.lock"),
    socketPath: join(env.root, "room-move-alias.sock"),
    manifestPath: join(env.root, "room-move-alias.sqlite"),
    auditPath: join(env.root, "room-move-alias-audit.jsonl"),
    workerBindingsPath: join(env.root, "room-move-alias-bindings.json"),
  };
  const destinationAlias = "destination-alias";
  const canonicalDestination = "canonical-destination";
  const deliveryHttp: SupervisedDeliveryHttp = {
    async poll() { return { messages: [] }; },
    async latest() { return { messages: [] }; },
    async publish(input) { return { messageId: "published", roomId: input.roomId }; },
    async joinRoom(input) {
      return { roomId: input.roomId === destinationAlias ? canonicalDestination : input.roomId };
    },
  };
  type Internals = {
    store: ManifestStore;
    workerBindings: WorkerBindingStore;
    workerRuntimeCustody: WorkerRuntimeCustody;
    updateManifestEntry: (entryId: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry) => Promise<DaemonManifestEntry>;
    reconcileRoomMove: (move: DaemonRoomMoveRecord) => Promise<DaemonRoomMoveRecord>;
  };
  const bind = async (daemon: SupervisorDaemon, roomId: string) => {
    const internals = daemon as unknown as Internals;
    await internals.workerBindings.bind({
      entry_id: "alias_move", room_id: roomId, work_attempt_id: "attempt_alias_move",
      execution_generation_id: "run_alias_move", agent_session_id: `session_${roomId}`,
      agent_session_token: `secret_${roomId}`, api_url: "https://letagents.test",
    });
  };
  let daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, deliveryHttp);
  try {
    await daemon.start();
    const generation = Number(((await daemonRequest(paths.socketPath, "daemon.negotiate")).result as { generation: number }).generation);
    const moving: DaemonManifestEntry = {
      ...entry,
      id: "alias_move",
      room_id: "source-room",
      delivery_mode: "daemon_inbox",
      work_attempt_id: "attempt_alias_move",
      provider_ref: {
        ...entry.provider_ref!,
        work_attempt_id: "attempt_alias_move",
        execution_generation_id: "run_alias_move",
      },
      last_worker_binding: null,
    };
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: moving })).ok, true);
    await bind(daemon, "source-room");
    let internals = daemon as unknown as Internals;
    const prepared = (await internals.store.prepareRoomMove({
      operation_id: "move_alias_crash", request_id: "move_alias_crash", agent_id: moving.id,
      source_room_id: "source-room", destination_room_id: destinationAlias, daemon_generation: generation,
      work_attempt_id: "attempt_alias_move", execution_generation_id: "run_alias_move", agent_session_id: "session_source-room",
      activating_inbox_item_id: null, provider_turn_id: null, effect_id: null, phase: "prepared",
    })).move;
    const joining = await internals.store.advanceRoomMove({
      operationId: prepared.operation_id, agentId: prepared.agent_id, expectedDaemonGeneration: generation,
      expectedExecutionGenerationId: prepared.execution_generation_id, from: ["prepared"], to: "joining_destination",
    });

    const originalUpdate = internals.updateManifestEntry.bind(internals);
    let injectCrash = true;
    internals.updateManifestEntry = async (...args) => {
      const updated = await originalUpdate(...args);
      if (injectCrash) {
        injectCrash = false;
        throw new Error("injected crash after canonical membership commit");
      }
      return updated;
    };
    await assert.rejects(() => internals.reconcileRoomMove(joining), /injected crash after canonical membership commit/);
    const crashJournal = await internals.store.getRoomMove(prepared.operation_id);
    assert.equal(crashJournal?.phase, "joining_destination");
    assert.equal(crashJournal?.remote_room_id, canonicalDestination, "canonical identity is durable before manifest membership");
    assert.equal((await internals.store.getEntry(moving.id))?.room_id, canonicalDestination);
    internals.updateManifestEntry = originalUpdate;
    await daemon.stop();

    daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, deliveryHttp);
    await daemon.start();
    internals = daemon as unknown as Internals;
    await bind(daemon, "source-room");
    let resumed = await internals.reconcileRoomMove((await internals.store.getRoomMove(prepared.operation_id))!);
    assert.equal(resumed.phase, "rotating_credentials");
    assert.equal(resumed.source_credentials_revoked, false, "missing process-memory source grant is never treated as revocation evidence");
    assert.equal(resumed.remote_room_id, canonicalDestination);
    assert.equal((await internals.store.getEntry(moving.id))?.room_id, canonicalDestination);
    const discovered = await daemonRequest(paths.socketPath, "supervisor.get_current_room_move", {
      entry_id: moving.id,
      daemon_generation: resumed.daemon_generation,
    });
    assert.equal(discovered.ok, true);
    assert.equal((discovered.result as DaemonRoomMoveRecord).operation_id, resumed.operation_id);
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.get_current_room_move", {
      entry_id: moving.id,
      daemon_generation: resumed.daemon_generation + 1,
    })).ok, false, "current move discovery is fenced by the exact daemon generation");

    const wrongAck = await daemonRequest(paths.socketPath, "supervisor.acknowledge_room_move_source_revocation", {
      operation_id: resumed.operation_id, entry_id: resumed.agent_id,
      source_agent_session_id: "session_wrong", daemon_generation: resumed.daemon_generation,
    });
    assert.equal(wrongAck.ok, false, "a different or absent source session can never prove revocation");
    const exactAck = await daemonRequest(paths.socketPath, "supervisor.acknowledge_room_move_source_revocation", {
      operation_id: resumed.operation_id, entry_id: resumed.agent_id,
      source_agent_session_id: "session_source-room", daemon_generation: resumed.daemon_generation,
    });
    assert.equal(exactAck.ok, true);
    resumed = exactAck.result as DaemonRoomMoveRecord;
    assert.equal(resumed.source_credentials_revoked, true);
    await bind(daemon, canonicalDestination);
    internals.workerRuntimeCustody.installHostGrant({
      entryId: moving.id, roomId: canonicalDestination, agentKey: "owner/alias_move",
      grantId: "grant_destination", supervisorGrant: "secret_destination_grant", grantGeneration: 2,
      apiUrl: "https://letagents.test", daemonGeneration: resumed.daemon_generation,
      hostId: "host_1", installationId: "install_1", expiresAt: "2099-01-01T00:00:00.000Z",
    } satisfies InstalledHostGrant);
    resumed = await internals.reconcileRoomMove(resumed);
    assert.equal(resumed.phase, "active");
    assert.equal(resumed.remote_room_id, canonicalDestination);
    assert.equal((await internals.store.getEntry(moving.id))?.room_id, canonicalDestination);
    const noCurrent = await daemonRequest(paths.socketPath, "supervisor.get_current_room_move", {
      entry_id: moving.id,
      daemon_generation: resumed.daemon_generation,
    });
    assert.equal(noCurrent.ok, true);
    assert.equal(noCurrent.result, null, "terminal moves are not returned by current-move discovery");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("room-move rollback replays every external and local crash edge across daemon restart", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "room-move.lock"),
    socketPath: join(env.root, "room-move.sock"),
    manifestPath: join(env.root, "room-move.sqlite"),
    auditPath: join(env.root, "room-move-audit.jsonl"),
    workerBindingsPath: join(env.root, "room-move-bindings.json"),
  };
  let rejectSourceJoin = true;
  let joinCalls = 0;
  const deliveryHttp: SupervisedDeliveryHttp = {
    async poll() { return { messages: [] }; },
    async latest() { return { messages: [] }; },
    async publish(input) { return { messageId: "published", roomId: input.roomId }; },
    async joinRoom(input) {
      joinCalls += 1;
      if (rejectSourceJoin) throw new Error("injected source join failure");
      return { roomId: input.roomId };
    },
  };
  type Internals = {
    store: ManifestStore;
    workerBindings: WorkerBindingStore;
    supervisedInbox: SupervisedAgentInboxStore;
    updateManifestEntry: (entryId: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry) => Promise<DaemonManifestEntry>;
    reconcileRoomMove: (move: DaemonRoomMoveRecord) => Promise<DaemonRoomMoveRecord>;
  };
  const bind = async (daemon: SupervisorDaemon, roomId: string) => {
    const internals = daemon as unknown as Internals;
    await internals.workerBindings.bind({
      entry_id: "rollback_move", room_id: roomId, work_attempt_id: "attempt_move",
      execution_generation_id: "run_move", agent_session_id: `session_${roomId}`,
      agent_session_token: `secret_${roomId}`, api_url: "https://letagents.test",
    });
  };
  let daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, deliveryHttp);
  try {
    await daemon.start();
    const generation = Number(((await daemonRequest(paths.socketPath, "daemon.negotiate")).result as { generation: number }).generation);
    const moving: DaemonManifestEntry = {
      ...entry,
      id: "rollback_move",
      room_id: "destination-room",
      delivery_mode: "daemon_inbox",
      work_attempt_id: "attempt_move",
      provider_ref: {
        ...entry.provider_ref!,
        work_attempt_id: "attempt_move",
        execution_generation_id: "run_move",
      },
      last_worker_binding: null,
    };
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: moving })).ok, true);
    let internals = daemon as unknown as Internals;
    await internals.supervisedInbox.bootstrapCursor({
      agent_id: moving.id, room_id: "source-room", last_observed_message_id: "msg_17",
    });
    await bind(daemon, "destination-room");
    const prepared = (await internals.store.prepareRoomMove({
      operation_id: "move_rollback", request_id: "move_rollback", agent_id: moving.id,
      source_room_id: "source-room", destination_room_id: "destination-room", daemon_generation: generation,
      work_attempt_id: "attempt_move", execution_generation_id: "run_move", agent_session_id: "session_destination-room",
      activating_inbox_item_id: null, provider_turn_id: null, effect_id: null, phase: "prepared",
    })).move;
    assert.equal(prepared.source_cursor, "msg_17");
    let move = await internals.store.advanceRoomMove({
      operationId: prepared.operation_id, agentId: prepared.agent_id, expectedDaemonGeneration: generation,
      expectedExecutionGenerationId: prepared.execution_generation_id, from: ["prepared"], to: "rollback_required",
      remoteRoomId: "destination-room", error: "injected post-join failure",
    });

    move = await internals.reconcileRoomMove(move);
    assert.equal(move.phase, "rollback_required");
    assert.match(move.error ?? "", /source join failure/);
    assert.equal(joinCalls, 1);
    await daemon.stop();

    // A successor adopts only the journal generation. It cannot invent the
    // failed external acknowledgement and waits for a freshly supplied bearer.
    daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, deliveryHttp);
    await daemon.start();
    internals = daemon as unknown as Internals;
    assert.equal((await internals.store.getRoomMove("move_rollback"))?.phase, "rollback_required");
    await bind(daemon, "destination-room");
    rejectSourceJoin = false;

    // Crash after the idempotent external source rejoin but before local
    // membership mutation: the journal remains rollback_required.
    const originalUpdate = internals.updateManifestEntry.bind(internals);
    let failLocalCommit = true;
    internals.updateManifestEntry = async (...args) => {
      if (failLocalCommit) { failLocalCommit = false; throw new Error("injected local membership crash"); }
      return originalUpdate(...args);
    };
    let pendingRollback = (await internals.store.getRoomMove("move_rollback"))!;
    await assert.rejects(() => internals.reconcileRoomMove(pendingRollback), /local membership crash/);
    assert.equal((await internals.store.getRoomMove("move_rollback"))?.phase, "rollback_required");
    assert.equal((await internals.store.getEntry(moving.id))?.room_id, "destination-room");
    internals.updateManifestEntry = originalUpdate;

    // Crash after local source membership but before ingress restoration.
    const originalIngressRollback = internals.supervisedInbox.rollbackRoomMoveIngress.bind(internals.supervisedInbox);
    let failIngressCommit = true;
    internals.supervisedInbox.rollbackRoomMoveIngress = async (...args) => {
      if (failIngressCommit) { failIngressCommit = false; throw new Error("injected ingress restoration crash"); }
      return originalIngressRollback(...args);
    };
    pendingRollback = (await internals.store.getRoomMove("move_rollback"))!;
    await assert.rejects(() => internals.reconcileRoomMove(pendingRollback), /ingress restoration crash/);
    assert.equal((await internals.store.getRoomMove("move_rollback"))?.phase, "rollback_required");
    assert.equal((await internals.store.getEntry(moving.id))?.room_id, "source-room");
    internals.supervisedInbox.rollbackRoomMoveIngress = originalIngressRollback;

    // Crash after ingress and destination-credential retirement but before the
    // terminal journal edge. Rebinding source authority lets the replay finish.
    const originalAdvance = internals.store.advanceRoomMove.bind(internals.store);
    let failTerminalCommit = true;
    internals.store.advanceRoomMove = async (...args) => {
      if (failTerminalCommit && args[0].from.includes("rollback_required") && args[0].to === "failed") {
        failTerminalCommit = false;
        throw new Error("injected terminal journal crash");
      }
      return originalAdvance(...args);
    };
    pendingRollback = (await internals.store.getRoomMove("move_rollback"))!;
    await assert.rejects(() => internals.reconcileRoomMove(pendingRollback), /terminal journal crash/);
    assert.equal((await internals.store.getRoomMove("move_rollback"))?.phase, "rollback_required");
    assert.equal((await internals.supervisedInbox.cursor(moving.id))?.room_id, "source-room");
    assert.equal((await internals.supervisedInbox.cursor(moving.id))?.last_observed_message_id, "msg_17");
    assert.equal(await internals.workerBindings.get(moving.id), null);
    internals.store.advanceRoomMove = originalAdvance;
    await bind(daemon, "source-room");

    move = await internals.reconcileRoomMove((await internals.store.getRoomMove("move_rollback"))!);
    assert.equal(move.phase, "failed");
    assert.equal((await internals.store.getEntry(moving.id))?.room_id, "source-room");
    assert.equal((await internals.supervisedInbox.cursor(moving.id))?.last_observed_message_id, "msg_17");
    const later = await internals.store.prepareRoomMove({
      operation_id: "move_after_rollback", request_id: "move_after_rollback", agent_id: moving.id,
      source_room_id: "source-room", destination_room_id: "third-room", daemon_generation: move.daemon_generation,
      work_attempt_id: "attempt_move", execution_generation_id: "run_move", agent_session_id: "session_source-room",
      activating_inbox_item_id: null, provider_turn_id: null, effect_id: null, phase: "prepared",
    });
    assert.equal(later.created, true, "terminal compensation releases the unique active-move fence");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("fence loss fatally stops the control endpoint", async () => {
  const env = await fixture();
  try {
    const lockPath = join(env.root, "fatal.lock");
    const socketPath = join(env.root, "fatal.sock");
    const daemon = new SupervisorDaemon({ lockPath, socketPath, manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") }, "darwin");
    await daemon.start();
    await writeFile(`${lockPath}.generation`, "2\n");
    await new Promise<void>((resolve, reject) => {
      const client = createConnection(socketPath); client.once("error", reject);
      client.on("connect", () => client.write(JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, method: "manifest.list" }) + "\n"));
      client.on("close", () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(() => new Promise<void>((resolve, reject) => {
      const client = createConnection(socketPath); client.once("connect", () => resolve()); client.once("error", reject);
    }));
    await daemon.stop();
  } finally { await env.cleanup(); }
});

test("control socket bounds an oversized JSON-lines frame", async () => {
  const env = await fixture();
  try {
    const socketPath = join(env.root, "bounded.sock");
    const socket = new DaemonControlSocket(socketPath, () => ({ ok: true }), undefined, 16);
    await socket.start();
    await new Promise<void>((resolve, reject) => {
      const client = createConnection(socketPath); client.once("error", reject);
      client.on("connect", () => client.write("x".repeat(17)));
      client.on("close", () => resolve());
    });
    await socket.stop();
  } finally { await env.cleanup(); }
});

test("work attempts survive generations and lease rebinds while terminal payloads stay immutable", async () => {
  const env = await fixture();
  let tick = 0;
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => `2026-01-01T00:00:0${tick++}.000Z`, join(env.root, "worktrees"), undefined, undefined, undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease-1", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await store.checkpoint(attempt.work_attempt_id, { room_cursor: "msg_12", provider_continuation_id: "provider-1" });
    const historyGuard = new DatabaseSync(join(env.root, "daemon-state.sqlite"));
    historyGuard.exec(`
      CREATE TRIGGER forbid_checkpoint_rewrite BEFORE DELETE ON work_attempt_checkpoints BEGIN SELECT RAISE(ABORT, 'checkpoint history rewritten'); END;
      CREATE TRIGGER forbid_epoch_rewrite BEFORE DELETE ON work_attempt_lease_epochs BEGIN SELECT RAISE(ABORT, 'epoch history rewritten'); END;
      CREATE TRIGGER forbid_execution_rewrite BEFORE DELETE ON work_attempt_executions BEGIN SELECT RAISE(ABORT, 'execution history rewritten'); END;
    `);
    historyGuard.close();
    const execution = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    const terminal = { ended_at: "2026-01-01T00:00:09.000Z", exit_code: 137, signal: "SIGKILL", stdio_archive_ref: "stdio.log.1.archive", stdio_tail: "last line", terminal_cause: "crash", actor: "daemon", generation: 1, provider_continuation_id: "provider-1" };
    const storedTerminal = await store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ...terminal, stdio_tail: "x".repeat(20) }, 8);
    assert.equal(storedTerminal.terminal?.stdio_tail, "x".repeat(8));
    await assert.rejects(() => store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, terminal), ImmutableExecutionError);
    await store.rebindAttempt(attempt.work_attempt_id, "lease-2", 2);
    await store.checkpoint(attempt.work_attempt_id, { room_cursor: "msg_13", provider_continuation_id: "provider-2" });
    const resumed = await store.startGeneration(attempt.work_attempt_id, "daemon", 2);
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).workspace_path, workspace.path);
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).epoch_history.length, 2);
    assert.equal(resumed.generation, 2);
    const terminalCanary = "canary-not-a-real-terminal-secret-123456789";
    const resumedTerminal = await store.recordTerminal(attempt.work_attempt_id, resumed.execution_generation_id, { ended_at: "2026-01-01T00:00:10.000Z", exit_code: 0, signal: null, stdio_archive_ref: `LETAGENTS_TOKEN=${terminalCanary}`, stdio_tail: `Authorization: Bearer ${terminalCanary}`, terminal_cause: `OPENAI_API_KEY=${terminalCanary}`, actor: "daemon", generation: 2, provider_continuation_id: null });
    assert.doesNotMatch(JSON.stringify(resumedTerminal.terminal), new RegExp(terminalCanary));
    assert.doesNotMatch(JSON.stringify(await store.getAttempt(attempt.work_attempt_id)), new RegExp(terminalCanary));
    assert.match(JSON.stringify(resumedTerminal.terminal), /REDACTED/);
    const releaseHistoryGuard = new DatabaseSync(join(env.root, "daemon-state.sqlite"));
    releaseHistoryGuard.exec("DROP TRIGGER forbid_checkpoint_rewrite; DROP TRIGGER forbid_epoch_rewrite; DROP TRIGGER forbid_execution_rewrite");
    releaseHistoryGuard.close();
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "reviewed", postmortemDiff: "diff --git a/a b/a" });
    await assert.rejects(() => store.rebindAttempt(attempt.work_attempt_id, "lease-3", 3), ImmutableExecutionError);
  } finally { await env.cleanup(); }
});

test("independent SQLite connections cannot start two live generations for one attempt", async () => {
  const env = await fixture();
  try {
    const path = join(env.root, "attempts.json");
    const root = join(env.root, "attempt-data");
    const workspace = await provisionedWorkspace(env.root);
    const first = new WorkDurabilityStore(path, root, undefined, join(env.root, "worktrees"), undefined, undefined, undefined, { supervisor_id: "race-a", supervisor_generation: 1 });
    const second = new WorkDurabilityStore(path, root, undefined, join(env.root, "worktrees"), undefined, undefined, undefined, { supervisor_id: "race-b", supervisor_generation: 1 });
    const attempt = await first.createAttempt({ taskId: "task", leaseId: "race", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const results = await Promise.allSettled([
      first.startGeneration(attempt.work_attempt_id, "daemon", 1),
      second.startGeneration(attempt.work_attempt_id, "daemon", 1),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await first.getAttempt(attempt.work_attempt_id)).execution_generations.filter((item) => item.terminal === null).length, 1);
    await first.close();
    await second.close();
  } finally { await env.cleanup(); }
});

test("stdio rotates append-only and GC protects active, ambiguous, quarantined, and unreviewed attempts", async () => {
  const env = await fixture();
  let tick = 0;
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const create = async () => {
      const workspace = await provisionedWorkspace(env.root);
      const attempt = await store.createAttempt({ taskId: "task", leaseId: `lease-${tick}`, leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
      return attempt;
    };
    const first = await create(); const second = await create(); const latest = await create(); const protectedAttempt = await create();
    await store.concludeAttempt(first.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "first" });
    await store.concludeAttempt(second.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "second" });
    await store.concludeAttempt(latest.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "latest" });
    await store.markState(protectedAttempt.work_attempt_id, "quarantined");
    const log = await store.appendStdio(first.work_attempt_id, "x".repeat(8), 8);
    await store.appendStdio(first.work_attempt_id, "next", 8);
    const stdioCanary = "canary-not-a-real-stdio-secret-123456789";
    const credentialLog = await store.appendStdio(protectedAttempt.work_attempt_id, "Authorization: Bearer ", 1_024);
    await store.appendStdio(protectedAttempt.work_attempt_id, stdioCanary, 1_024);
    assert.doesNotMatch(await readFile(credentialLog, "utf8"), new RegExp(stdioCanary));
    assert.match(await readFile(credentialLog, "utf8"), /REDACTED/);
    assert.ok((await readdir(dirname(log))).some((name) => name.includes("stdio.log.") && name.endsWith(".archive")));
    const removed = await store.garbageCollect(1);
    assert.deepEqual(new Set(removed), new Set([first.work_attempt_id, second.work_attempt_id]));
    await assert.rejects(() => stat(first.workspace_path));
    assert.equal((await stat(latest.workspace_path)).isDirectory(), true);
    assert.equal((await stat(protectedAttempt.workspace_path)).isDirectory(), true);
  } finally { await env.cleanup(); }
});

test("workspace provisioner uses daemon-owned clones, reuses attempts, and rejects dev-checkout escapes", async () => {
  const env = await fixture();
  try {
    const commands: string[][] = [];
    let rejectMarkerlessRecovery = false;
    const provisioner = new WorkspaceProvisioner(env.root, async (args) => {
      commands.push(args);
      if (args.includes("worktree") && args.includes("add")) { rejectMarkerlessRecovery = false; await mkdir(args.at(-2)!, { recursive: true }); }
      else if (args[0] === "clone") await mkdir(args.at(-1)!, { recursive: true });
      if (args.includes("--is-bare-repository")) return "true";
      if (args.includes("remote") && args.includes("get-url")) return "https://example.invalid/repo.git";
      if (args.includes("cat-file")) return "ok";
      if (args.includes("rev-parse")) {
        if (args.includes("--git-common-dir")) return rejectMarkerlessRecovery ? join(env.root, "repos", "wrong.git") : join(env.root, "repos", "repo.git");
        return TEST_OID;
      }
      return "";
    });
    assert.throws(() => provisioner.workspacePath("../dev", "attempt"), /Unsafe repository/);
    assert.throws(() => provisioner.workspacePath(".", "attempt"), /Unsafe repository/);
    const workAttemptId = randomUUID();
    const first = await provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" });
    const second = await provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "moved-branch" });
    assert.equal(first.reused, false); assert.equal(second.reused, true); assert.ok(commands.length > 2);
    const refresh = commands.findIndex((args) => args.includes("fetch"));
    const resolution = commands.findIndex((args) => args.includes("abc^{commit}"));
    assert.ok(refresh >= 0 && refresh < resolution, "the verified origin is refreshed before revision resolution");
    assert.equal(commands[refresh]![1], await realpath(join(env.root, "repos", "repo.git")));
    assert.deepEqual(commands[refresh], [
      "--git-dir", await realpath(join(env.root, "repos", "repo.git")),
      "fetch", "--prune", "--no-tags", "origin",
      "+refs/heads/*:refs/letagents/remotes/origin/*",
      "+refs/tags/*:refs/letagents/tags/*",
    ]);
    assert.match(first.path, new RegExp(`worktrees/repo/${workAttemptId}$`));
    assert.ok(commands[0]!.includes("--bare"));
    await rm(join(first.path, ".letagents-work-attempt.json"));
    const recovered = await provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" });
    assert.equal(recovered.reused, true, "an add-before-marker crash is recoverable");
    await rm(join(first.path, ".letagents-work-attempt.json"));
    rejectMarkerlessRecovery = true;
    const reprovisioned = await provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" });
    assert.equal(reprovisioned.reused, false, "an unprovable markerless partial is quarantined and reprovisioned");
    const remove = commands.findIndex((args) => args.includes("worktree") && args.includes("remove") && args.includes(first.path));
    const replacementAdd = commands.findIndex((args, index) => index > remove && args.includes("worktree") && args.includes("add") && args.includes(first.path));
    assert.ok(remove >= 0 && replacementAdd > remove, "the exact stale worktree registration is removed before re-adding");
    await assert.rejects(() => provisioner.provision({ repo: "repo", workAttemptId: randomUUID(), taskId: "task", remoteUrl: "https://token@example.invalid/repo.git", revision: "abc" }), /userinfo/);
    await assert.rejects(() => provisioner.provision({ repo: "repo", workAttemptId: randomUUID(), taskId: "task", remoteUrl: "https://evil.invalid/repo.git", revision: "abc" }), /identity/);
    await rm(first.path, { recursive: true });
    const outside = join(env.root, "outside"); await mkdir(outside);
    await symlink(outside, first.path);
    await assert.rejects(() => provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" }), /symlink/);
  } finally { await env.cleanup(); }
});

test("repository storage keys preserve full project identity across same-basename remotes", () => {
  const first = repositoryStorageKey("https://git.example.invalid/owner-a/shared-project.git");
  const equivalent = repositoryStorageKey("https://git.example.invalid/owner-a/shared-project.git/");
  const second = repositoryStorageKey("https://git.example.invalid/owner-b/shared-project.git");
  assert.equal(first, equivalent);
  assert.notEqual(first, second);
  assert.notEqual(repositoryStorageKey("file:///tmp/shared-project.git"), repositoryStorageKey("file:///tmp/shared-project"));
  assert.notEqual(repositoryStorageKey("./shared-project.git"), repositoryStorageKey("./shared-project"));
  assert.equal(repositoryStorageKey("git@github.com:owner-a/shared-project.git"), repositoryStorageKey("git@github.com:owner-a/shared-project"));
  assert.match(first, /^shared-project-[0-9a-f]{16}$/);
  assert.match(second, /^shared-project-[0-9a-f]{16}$/);
});

test("filesystem remotes that differ by a literal .git suffix remain isolated during local revision import", async () => {
  const env = await fixture();
  try {
    const remoteWithSuffix = join(env.root, "same.git");
    const remoteWithoutSuffix = join(env.root, "same");
    const sourceWithSuffix = join(env.root, "source-with-suffix");
    const sourceWithoutSuffix = join(env.root, "source-without-suffix");
    const daemonRoot = join(env.root, "daemon");
    await execFileAsync("git", ["init", "--bare", remoteWithSuffix]);
    await execFileAsync("git", ["init", "--bare", remoteWithoutSuffix]);

    const initializeSource = async (source: string, remote: string, content: string) => {
      await execFileAsync("git", ["init", source]);
      await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
      await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
      await writeFile(join(source, "README.md"), content);
      await execFileAsync("git", ["-C", source, "add", "README.md"]);
      await execFileAsync("git", ["-C", source, "commit", "-m", "initial"]);
      await execFileAsync("git", ["-C", source, "remote", "add", "origin", remote]);
      await execFileAsync("git", ["-C", source, "push", "origin", "HEAD:refs/heads/main"]);
    };
    await initializeSource(sourceWithSuffix, remoteWithSuffix, "suffix remote\n");
    await initializeSource(sourceWithoutSuffix, remoteWithoutSuffix, "plain remote\n");
    await writeFile(join(sourceWithoutSuffix, "README.md"), "plain remote local only\n");
    await execFileAsync("git", ["-C", sourceWithoutSuffix, "add", "README.md"]);
    await execFileAsync("git", ["-C", sourceWithoutSuffix, "commit", "-m", "local only"]);

    const firstKey = repositoryStorageKey(remoteWithSuffix);
    const secondKey = repositoryStorageKey(remoteWithoutSuffix);
    assert.notEqual(firstKey, secondKey, "literal filesystem paths must not inherit hosted-remote .git equivalence");
    const firstRevision = (await execFileAsync("git", ["-C", sourceWithSuffix, "rev-parse", "HEAD"])).stdout.trim();
    const secondRevision = (await execFileAsync("git", ["-C", sourceWithoutSuffix, "rev-parse", "HEAD"])).stdout.trim();
    const provisioner = new WorkspaceProvisioner(daemonRoot, createGitCommand(daemonRoot));
    await provisioner.provision({
      repo: firstKey,
      workAttemptId: randomUUID(),
      taskId: "suffix_remote",
      remoteUrl: remoteWithSuffix,
      revision: firstRevision,
      sourceRepoPath: sourceWithSuffix,
    });
    await assert.rejects(
      () => provisioner.provision({
        repo: firstKey,
        workAttemptId: randomUUID(),
        taskId: "cross_wired_source",
        remoteUrl: remoteWithSuffix,
        revision: secondRevision,
        sourceRepoPath: sourceWithoutSuffix,
      }),
      /Local source repository remote identity does not match/,
    );
    const second = await provisioner.provision({
      repo: secondKey,
      workAttemptId: randomUUID(),
      taskId: "plain_remote",
      remoteUrl: remoteWithoutSuffix,
      revision: secondRevision,
      sourceRepoPath: sourceWithoutSuffix,
    });
    assert.equal((await execFileAsync("git", ["-C", second.path, "rev-parse", "HEAD"])).stdout.trim(), secondRevision);
    assert.notEqual(
      join(daemonRoot, "repos", `${firstKey}.git`),
      join(daemonRoot, "repos", `${secondKey}.git`),
    );
  } finally { await env.cleanup(); }
});

test("workspace provisioner refreshes an existing bare clone before resolving a new source revision", async () => {
  const env = await fixture();
  try {
    const remote = join(env.root, "origin.git");
    const source = join(env.root, "source");
    const daemonRoot = join(env.root, "daemon");
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["init", source]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
    await writeFile(join(source, "README.md"), "first\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "first"]);
    await execFileAsync("git", ["-C", source, "branch", "-M", "main"]);
    await execFileAsync("git", ["-C", source, "remote", "add", "origin", remote]);
    await execFileAsync("git", ["-C", source, "push", "-u", "origin", "main"]);
    await execFileAsync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    const firstRevision = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();

    const provisioner = new WorkspaceProvisioner(daemonRoot, createGitCommand(daemonRoot));
    const first = await provisioner.provision({
      repo: "repo",
      workAttemptId: randomUUID(),
      taskId: "task_first",
      remoteUrl: remote,
      revision: firstRevision,
    });
    assert.equal((await execFileAsync("git", ["-C", first.path, "rev-parse", "HEAD"])).stdout.trim(), firstRevision);

    await writeFile(join(source, "README.md"), "second\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "second"]);
    const secondRevision = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", source, "push", "origin", "HEAD:refs/heads/fresh-after-clone"]);

    const second = await provisioner.provision({
      repo: "repo",
      workAttemptId: randomUUID(),
      taskId: "task_second",
      remoteUrl: remote,
      revision: secondRevision,
    });
    assert.equal((await execFileAsync("git", ["-C", second.path, "rev-parse", "HEAD"])).stdout.trim(), secondRevision);
    assert.equal(
      (await execFileAsync("git", ["--git-dir", join(daemonRoot, "repos", "repo.git"), "rev-parse", "refs/letagents/remotes/origin/fresh-after-clone"])).stdout.trim(),
      secondRevision,
    );

    await writeFile(join(source, "README.md"), "local only\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "local only"]);
    const localOnlyRevision = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    await assert.rejects(
      () => execFileAsync("git", ["--git-dir", remote, "cat-file", "-e", `${localOnlyRevision}^{commit}`]),
      "the remote must not contain the unpushed source commit",
    );
    const localAttemptId = randomUUID();
    const localOnly = await provisioner.provision({
      repo: "repo",
      workAttemptId: localAttemptId,
      taskId: "task_local_only",
      remoteUrl: remote,
      revision: localOnlyRevision,
      sourceRepoPath: source,
    });
    assert.equal((await execFileAsync("git", ["-C", localOnly.path, "rev-parse", "HEAD"])).stdout.trim(), localOnlyRevision);
    assert.equal(
      (await execFileAsync("git", ["--git-dir", join(daemonRoot, "repos", "repo.git"), "rev-parse", `refs/letagents/sources/${localAttemptId}^{commit}`])).stdout.trim(),
      localOnlyRevision,
      "the daemon retains the exact local commit under an attempt-scoped private ref",
    );

    await execFileAsync("git", ["-C", source, "checkout", "--detach", secondRevision]);
    await writeFile(join(source, "README.md"), "tag only\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "tag only"]);
    await execFileAsync("git", ["-C", source, "tag", "release-only"]);
    const tagOnlyRevision = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", source, "push", "origin", "refs/tags/release-only"]);

    const tagged = await provisioner.provision({
      repo: "repo",
      workAttemptId: randomUUID(),
      taskId: "task_tag_only",
      remoteUrl: remote,
      revision: tagOnlyRevision,
    });
    assert.equal((await execFileAsync("git", ["-C", tagged.path, "rev-parse", "HEAD"])).stdout.trim(), tagOnlyRevision);
    assert.equal(
      (await execFileAsync("git", ["--git-dir", join(daemonRoot, "repos", "repo.git"), "rev-parse", "refs/letagents/tags/release-only^{commit}"])).stdout.trim(),
      tagOnlyRevision,
    );
  } finally { await env.cleanup(); }
});

test("workspace provisioning survives deletion of the daemon's inherited launch cwd", async () => {
  const env = await fixture();
  try {
    const source = join(env.root, "source");
    const launchCwd = join(env.root, "ephemeral-launch-cwd");
    const daemonRoot = join(env.root, "stable-daemon-root");
    await mkdir(source);
    await mkdir(launchCwd);
    await mkdir(daemonRoot);
    await execFileAsync("git", ["init", source]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
    await writeFile(join(source, "README.md"), "stable cwd\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);

    const moduleUrl = new URL("../workspace-provisioner.ts", import.meta.url).href;
    const tsxImport = import.meta.resolve("tsx");
    const workAttemptId = randomUUID();
    const script = [
      `import { rm } from "node:fs/promises";`,
      `import { createGitCommand, WorkspaceProvisioner } from ${JSON.stringify(moduleUrl)};`,
      `const git = createGitCommand(${JSON.stringify(daemonRoot)});`,
      `process.chdir(${JSON.stringify(launchCwd)});`,
      `await rm(${JSON.stringify(launchCwd)}, { recursive: true });`,
      `const provisioner = new WorkspaceProvisioner(${JSON.stringify(daemonRoot)}, git);`,
      `const result = await provisioner.provision(${JSON.stringify({
        repo: "repo",
        workAttemptId,
        taskId: "task_deleted_cwd",
        remoteUrl: source,
        revision: "HEAD",
      })});`,
      `process.stdout.write(JSON.stringify({ path: result.path, reused: result.reused }));`,
    ].join("\n");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", tsxImport, "--input-type=module", "-e", script],
      { cwd: launchCwd, maxBuffer: 8 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout) as { path: string; reused: boolean };
    assert.equal(result.reused, false);
    assert.equal(result.path, join(daemonRoot, "worktrees", "repo", workAttemptId));
    assert.equal((await stat(result.path)).isDirectory(), true);
  } finally {
    await env.cleanup();
  }
});

test("durability store validates destructive identities, serializes GC, and quarantines tampering", async () => {
  const env = await fixture();
  let releaseGc!: () => void;
  let reserved!: () => void;
  const gcReserved = new Promise<void>((resolve) => { reserved = resolve; });
  const gcRelease = new Promise<void>((resolve) => { releaseGc = resolve; });
  try {
    const path = join(env.root, "attempts.json");
    const store = new WorkDurabilityStore(path, join(env.root, "attempt-data"), () => "2026-01-01T00:00:00.000Z", join(env.root, "worktrees"), async () => { reserved(); await gcRelease; }, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    await assert.rejects(() => store.appendStdio("../../outside", "nope"), /UUID/);
    const collecting = store.garbageCollect(0);
    await gcReserved;
    await assert.rejects(() => store.markState(attempt.work_attempt_id, "quarantined"), /GC reservation/);
    releaseGc();
    assert.deepEqual(await collecting, [attempt.work_attempt_id]);

    const protectedWorkspace = await provisionedWorkspace(env.root);
    const protectedAttempt = await store.createAttempt({ taskId: "task", leaseId: "lease-2", leaseEpoch: 2, workspacePath: protectedWorkspace.path, workAttemptId: protectedWorkspace.id });
    await store.concludeAttempt(protectedAttempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    await writeFile(path, "{\"version\":2,\"attempts\":[],\"checksum\":\"tampered\"}");
    const recovered = new WorkDurabilityStore(path, join(env.root, "attempt-data"), () => "2026-01-01T00:00:01.000Z", join(env.root, "worktrees"));
    await assert.rejects(() => recovered.garbageCollect(0), CorruptAttemptStoreError);
    assert.equal((await stat(protectedWorkspace.path)).isDirectory(), true);
    assert.ok((await readdir(env.root)).some((name) => name.startsWith("attempts.json.corrupt.")));

    const legacyWorkspace = await provisionedWorkspace(env.root);
    const legacyDatabase = join(env.root, "legacy-state.sqlite");
    const legacyStore = new WorkDurabilityStore(join(env.root, "legacy-attempts.json"), join(env.root, "attempt-data"), () => "2026-01-01T00:00:02.000Z", join(env.root, "worktrees"), undefined, undefined, undefined, TEST_SUPERVISOR, undefined, legacyDatabase);
    const legacyAttempt = await legacyStore.createAttempt({ taskId: "task", leaseId: "lease-3", leaseEpoch: 3, workspacePath: legacyWorkspace.path, workAttemptId: legacyWorkspace.id });
    await legacyStore.concludeAttempt(legacyAttempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    const legacySnapshot = await legacyStore.getAttempt(legacyAttempt.work_attempt_id);
    await legacyStore.close();
    await rm(legacyDatabase, { force: true });
    await rm(`${legacyDatabase}-wal`, { force: true });
    await rm(`${legacyDatabase}-shm`, { force: true });
    await writeFile(join(env.root, "legacy-attempts.json"), JSON.stringify({ version: 1, attempts: [legacySnapshot] }));
    assert.equal((await (new WorkDurabilityStore(join(env.root, "legacy-attempts.json"), join(env.root, "attempt-data"), () => "2026-01-01T00:00:03.000Z", join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, legacyDatabase)).getAttempt(legacyAttempt.work_attempt_id)).state, "unreviewed");
  } finally { await env.cleanup(); }
});

test("execution identities prohibit parallel, duplicate, and laundered terminal generations", async () => {
  const env = await fixture();
  try {
    const workspace = await provisionedWorkspace(env.root);
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => "2026-01-01T00:00:00.000Z", join(env.root, "worktrees"), undefined, undefined, undefined, TEST_SUPERVISOR);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const first = await store.startGeneration(attempt.work_attempt_id, "starter", 1);
    await assert.rejects(() => store.startGeneration(attempt.work_attempt_id, "starter", 2), /one execution generation/);
    await assert.rejects(() => store.recordTerminal(attempt.work_attempt_id, first.execution_generation_id, { ended_at: "2025-01-01T00:00:00.000Z", exit_code: 1, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "", actor: "other", generation: 1, provider_continuation_id: null }), /runtime schema|identity/);
    await assert.rejects(() => store.recordTerminal(attempt.work_attempt_id, first.execution_generation_id, { ended_at: "2026-01-01T00:00:01.000Z", exit_code: 1.5, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "crash", actor: "starter", generation: 1, provider_continuation_id: null }), /runtime schema/);
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).execution_generations[0]?.terminal, null, "invalid runtime input must never poison the persisted authority record");
    await store.recordTerminal(attempt.work_attempt_id, first.execution_generation_id, { ended_at: "2026-01-01T00:00:01.000Z", exit_code: 1, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "crash", actor: "starter", generation: 1, provider_continuation_id: null });
    await assert.rejects(() => store.startGeneration(attempt.work_attempt_id, "starter", 1), /strictly monotonic/);
  } finally { await env.cleanup(); }
});

test("execution fencing fails closed without an injected P1a supervisor identity", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"));
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await assert.rejects(() => store.startGeneration(attempt.work_attempt_id, "daemon", 1), /P1a supervisor identity/);
  } finally { await env.cleanup(); }
});

test("postmortem capture failure releases the retained execution fence", async () => {
  const env = await fixture();
  try {
    const git = async (args: string[]) => {
      if (args.includes("status")) throw new Error("injected postmortem failure");
      return fakeGit(env.root)(args);
    };
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, git, undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const execution = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    await store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ended_at: "2027-01-01T00:00:01.000Z", exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "done", actor: "daemon", generation: 1, provider_continuation_id: null });
    await assert.rejects(() => store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done" }), /postmortem failure/);
    const fenceDir = join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences");
    assert.equal((await readdir(fenceDir)).some((name) => name.startsWith("shared-")), false);
  } finally { await env.cleanup(); }
});

test("live generations block every conclusion before Git capture", async () => {
  const env = await fixture();
  let gitCalls = 0;
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, async (args) => { gitCalls += 1; return fakeGit(env.root)(args); }, undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    await assert.rejects(() => store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done" }), /terminal attestation/);
    await assert.rejects(() => store.concludeAttempt(attempt.work_attempt_id, { state: "abandoned", cause: "stopped" }), /terminal attestation/);
    assert.equal(gitCalls, 0);
  } finally { await env.cleanup(); }
});

test("attempt creation requires a final provisioned marker and enforces unique exact worktree layout", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"));
    const id = randomUUID();
    const unmarked = join(env.root, "worktrees", "repo", id); await mkdir(unmarked, { recursive: true });
    await assert.rejects(() => store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: unmarked, workAttemptId: id }), /marker/);
    const first = await provisionedWorkspace(env.root);
    await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: first.path, workAttemptId: first.id });
    await assert.rejects(() => store.createAttempt({ taskId: "task", leaseId: "lease-2", leaseEpoch: 2, workspacePath: first.path, workAttemptId: first.id }), /already exists/);
    const duplicatePath = await provisionedWorkspace(env.root, "task", randomUUID());
    await assert.rejects(() => store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: duplicatePath.path, workAttemptId: first.id }), /marker/);
    const sibling = join(env.root, "worktrees", "repo", "not-the-attempt"); await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, ".letagents-work-attempt.json"), JSON.stringify({ version: 1, repo: "repo", work_attempt_id: id, task_id: "task", remote_url: "https://example.invalid/repo", resolved_revision: TEST_OID, bare_path: join(env.root, "repos", "repo.git") }));
    await assert.rejects(() => store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: sibling, workAttemptId: id }), /exact daemon worktree layout/);
  } finally { await env.cleanup(); }
});

test("GC replays every pending tombstone and refuses a Git identity mismatch", async () => {
  const env = await fixture();
  let release!: () => void;
  let reserved!: () => void;
  const entered = new Promise<void>((resolve) => { reserved = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    const path = join(env.root, "attempts.json");
    const workspace = await provisionedWorkspace(env.root);
    const first = new WorkDurabilityStore(path, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), async () => { reserved(); await blocked; }, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const attempt = await first.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await first.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    assert.match(await readFile(join(env.root, "attempt-data", attempt.work_attempt_id, "postmortem.diff"), "utf8"), /status --porcelain/);
    const collecting = first.garbageCollect(0); await entered;
    const recovery = new WorkDurabilityStore(path, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root));
    assert.deepEqual(await recovery.garbageCollect(99), [attempt.work_attempt_id], "pending GC must not be hidden behind retention");
    release(); await collecting;

    const mismatch = await provisionedWorkspace(env.root);
    let evilRemote = false;
    const guarded = new WorkDurabilityStore(join(env.root, "mismatch.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, async (args) => evilRemote && args.includes("remote") ? "https://evil.invalid/repo.git" : await fakeGit(env.root)(args), undefined, TEST_SUPERVISOR);
    const other = await guarded.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: mismatch.path, workAttemptId: mismatch.id });
    await guarded.concludeAttempt(other.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    evilRemote = true;
    assert.deepEqual(await guarded.garbageCollect(0), []);
    assert.equal((await stat(mismatch.path)).isDirectory(), true);
  } finally { await env.cleanup(); }
});

test("a retained live generation permits provisioning a distinct sibling workspace", async () => {
  const env = await fixture();
  try {
    const bare = join(env.root, "repos", "repo.git");
    const provisioner = new WorkspaceProvisioner(env.root, async (args) => {
      if (args[0] === "clone") await mkdir(args.at(-1)!, { recursive: true });
      else if (args.includes("worktree") && args.includes("add")) await mkdir(args.at(-2)!, { recursive: true });
      if (args.includes("--is-bare-repository")) return "true";
      if (args.includes("remote") && args.includes("get-url")) return "https://example.invalid/repo.git";
      if (args.includes("cat-file")) return "ok";
      if (args.includes("rev-parse")) return args.includes("--git-common-dir") ? bare : TEST_OID;
      return "";
    });
    const firstId = randomUUID();
    const first = await provisioner.provision({
      repo: "repo",
      workAttemptId: firstId,
      taskId: "first",
      remoteUrl: "https://example.invalid/repo.git",
      revision: TEST_OID,
    });
    const retained = await acquireWorkspaceFence(first.path, "live-supervisor", 1, "shared");
    try {
      const secondId = randomUUID();
      const second = await provisioner.provision({
        repo: "repo",
        workAttemptId: secondId,
        taskId: "second",
        remoteUrl: "https://example.invalid/repo.git",
        revision: TEST_OID,
      });
      assert.equal(second.path, join(env.root, "worktrees", "repo", secondId));
      assert.equal((await stat(second.path)).isDirectory(), true);
    } finally { await retained.release(); }
  } finally { await env.cleanup(); }
});

test("target-exclusive provisioning remains mutually exclusive for the same workspace", async () => {
  const env = await fixture();
  try {
    const target = join(env.root, "worktrees", "repo", randomUUID());
    const sibling = join(env.root, "worktrees", "repo", randomUUID());
    let siblingRan = false;
    await withWorkspaceFence(target, async () => {
      await assert.rejects(() => withWorkspaceFence(target, async () => undefined), /fenced by a live supervisor generation/);
      await assert.rejects(
        () => acquireWorkspaceFence(target, "generation-during-provision", 1, "shared"),
        /fenced by a live supervisor generation/,
      );
      await withWorkspaceFence(sibling, async () => { siblingRan = true; });
    });
    assert.equal(siblingRan, true, "a distinct target remains independently provisionable");

    siblingRan = false;
    const retained = await acquireWorkspaceFence(target, "live-generation", 1, "shared");
    try {
      await assert.rejects(() => withWorkspaceFence(target, async () => undefined), /fenced by a live supervisor generation/);
      await withWorkspaceFence(sibling, async () => { siblingRan = true; });
    } finally { await retained.release(); }
    assert.equal(siblingRan, true, "a sibling remains provisionable beside a retained generation");
  } finally { await env.cleanup(); }
});

test("repo-exclusive GC authority conflicts with every live fence in both acquisition orders", async () => {
  const env = await fixture();
  try {
    const active = join(env.root, "worktrees", "repo", randomUUID());
    const doomed = join(env.root, "worktrees", "repo", randomUUID());
    const retained = await acquireWorkspaceFence(active, "live-supervisor", 1, "shared");
    try {
      await assert.rejects(
        () => acquireWorkspaceFence(doomed, "gc", 1, "exclusive", "repo"),
        /fenced by a live supervisor generation/,
      );
    } finally { await retained.release(); }

    const gc = await acquireWorkspaceFence(doomed, "gc", 1, "exclusive", "repo");
    try {
      await assert.rejects(
        () => withWorkspaceFence(active, async () => undefined),
        /fenced by a live supervisor generation/,
      );
      await assert.rejects(
        () => acquireWorkspaceFence(active, "successor-supervisor", 2, "shared"),
        /fenced by a live supervisor generation/,
      );
    } finally { await gc.release(); }
  } finally { await env.cleanup(); }
});

test("workspace fences remove stale PIDs and treat live pre-scope records as repo-wide", async () => {
  const env = await fixture();
  try {
    const target = join(env.root, "worktrees", "repo", randomUUID());
    const sibling = join(env.root, "worktrees", "repo", randomUUID());
    const directory = join(dirname(target), ".letagents-supervisor-workspace.fences");
    await mkdir(directory, { recursive: true });
    const legacyRecord = (pid: number) => JSON.stringify({
      owner: "legacy-daemon",
      generation: 1,
      pid,
      workspace_path: target,
      mode: "exclusive",
      created_at: "2026-07-16T00:00:00.000Z",
    });

    const stalePath = join(directory, "exclusive-stale.json");
    await writeFile(stalePath, legacyRecord(2_147_483_647));
    let ran = false;
    await withWorkspaceFence(target, async () => { ran = true; });
    assert.equal(ran, true);
    assert.equal((await readdir(directory)).includes("exclusive-stale.json"), false);

    const livePath = join(directory, "exclusive-live-legacy.json");
    await writeFile(livePath, legacyRecord(process.pid));
    try {
      await assert.rejects(
        () => withWorkspaceFence(sibling, async () => undefined),
        /fenced by a live supervisor generation/,
      );
    } finally { await rm(livePath, { force: true }); }
  } finally { await env.cleanup(); }
});

test("workspace fences and terminal attestation protect clean GC", async () => {
  const env = await fixture();
  try {
    const workspace = await provisionedWorkspace(env.root);
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const execution = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    await assert.rejects(() => store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" }), /terminal attestation/);
    await store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ended_at: "2027-01-01T00:00:01.000Z", exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "done", actor: "daemon", generation: 1, provider_continuation_id: null });
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    await withWorkspaceFence(workspace.path, async () => {
      assert.deepEqual(await store.garbageCollect(0), []);
      assert.equal((await stat(workspace.path)).isDirectory(), true);
    });
  } finally { await env.cleanup(); }
});

test("retained shared fences permit concurrent work and prevent GC from deleting a swapped active workspace", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const doomedWorkspace = await provisionedWorkspace(env.root, "doomed");
    const activeWorkspace = await provisionedWorkspace(env.root, "active");
    const doomed = await store.createAttempt({ taskId: "doomed", leaseId: "lease-doomed", leaseEpoch: 1, workspacePath: doomedWorkspace.path, workAttemptId: doomedWorkspace.id });
    const active = await store.createAttempt({ taskId: "active", leaseId: "lease-active", leaseEpoch: 1, workspacePath: activeWorkspace.path, workAttemptId: activeWorkspace.id });
    await store.concludeAttempt(doomed.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    const activeGeneration = await store.startGeneration(active.work_attempt_id, "daemon", 1);
    // Independent supervisor generations share read authority instead of
    // serializing all agents behind a global exclusive lock.
    const secondWorkspace = await provisionedWorkspace(env.root, "second");
    const second = await store.createAttempt({ taskId: "second", leaseId: "lease-second", leaseEpoch: 1, workspacePath: secondWorkspace.path, workAttemptId: secondWorkspace.id });
    await store.startGeneration(second.work_attempt_id, "daemon", 1);
    assert.equal((await readdir(join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences"))).filter((name) => name.startsWith("shared-")).length, 2);
    // Simulate an uncooperative filesystem attacker: it does not acquire any
    // helper fence. GC must fail closed before it can act on either pathname.
    await rm(doomedWorkspace.path, { recursive: true });
    await symlink(activeWorkspace.path, doomedWorkspace.path);
    assert.deepEqual(await store.garbageCollect(0), []);
    assert.equal((await stat(activeWorkspace.path)).isDirectory(), true);
    await store.recordTerminal(active.work_attempt_id, activeGeneration.execution_generation_id, { ended_at: "2027-01-01T00:00:01.000Z", exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "done", actor: "daemon", generation: 1, provider_continuation_id: null });
  } finally { await env.cleanup(); }
});

test("worker binding cursor survives an exact-session generation rebind and fences stale writers", async () => {
  const env = await fixture();
  try {
    const store = new WorkerBindingStore(join(env.root, "worker-bindings.json"));
    await store.bind({
      entry_id: "entry_exact",
      room_id: "focus_37",
      work_attempt_id: "attempt_exact",
      execution_generation_id: "execution_1",
      agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret",
      api_url: "https://letagents.chat",
    });
    await store.checkpointCursor("entry_exact", "agent_session_exact", "execution_1", "msg_2819");
    const internals = store as unknown as { write: (value: unknown) => Promise<void> };
    const originalWrite = internals.write.bind(internals);
    let writes = 0;
    internals.write = async (value) => { writes += 1; await originalWrite(value); };
    await store.checkpointCursor("entry_exact", "agent_session_exact", "execution_1", "msg_2819");
    assert.equal(writes, 0, "a repeated empty poll cursor performs no credential-store write");
    assert.equal((await store.checkpointCursorMonotonic("entry_exact", "agent_session_exact", "execution_1", "msg_2820")).advanced, true);
    assert.equal((await store.checkpointCursorMonotonic("entry_exact", "agent_session_exact", "execution_1", "msg_2818")).advanced, false);
    assert.equal((await store.get("entry_exact"))?.room_cursor, "msg_2820", "out-of-order compatibility evidence cannot regress progress");
    await store.checkpointCursor("entry_exact", "agent_session_exact", "execution_1", "msg_2822");
    assert.equal((await store.checkpointCursorMonotonic("entry_exact", "agent_session_exact", "execution_1", "msg_2821")).advanced, false);
    assert.equal((await store.get("entry_exact"))?.room_cursor, "msg_2822", "a newer formal response checkpoint wins over delayed compatibility evidence");
    let verifiedPredecessorGeneration: string | null = null;
    const reboundResult = await store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact",
      roomId: "focus_37",
      workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_1",
      toExecutionGenerationId: "execution_2",
      agentSessionId: "agent_session_exact",
    }, async ({ binding }) => {
      verifiedPredecessorGeneration = binding.execution_generation_id;
      return { accepted: true };
    });
    const rebound = reboundResult.binding;
    assert.equal(verifiedPredecessorGeneration, "execution_1", "credential verification runs before durable generation mutation");
    assert.equal(rebound.room_cursor, "msg_2822");
    assert.equal(await store.credentialFor(rebound), "session-secret", "generation rollover preserves only the private in-memory authority");
    let racedVerificationCalled = false;
    assert.equal((await store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact", roomId: "focus_37", workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_1", toExecutionGenerationId: "execution_2",
      agentSessionId: "agent_session_exact",
    }, async () => { racedVerificationCalled = true; return { accepted: true }; })).binding.execution_generation_id, "execution_2", "a formal bind winning the successor race is idempotent");
    assert.equal(racedVerificationCalled, false);
    const rejectedRollover = await store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact", roomId: "focus_37", workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_2", toExecutionGenerationId: "execution_3",
      agentSessionId: "agent_session_exact",
    }, async () => ({ accepted: false }));
    assert.equal(rejectedRollover.advanced, false);
    assert.equal((await store.get("entry_exact"))?.execution_generation_id, "execution_2", "rejected verification preserves predecessor authority");
    await assert.rejects(store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact", roomId: "focus_37", workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_2", toExecutionGenerationId: "execution_3",
      agentSessionId: "agent_session_exact",
    }, async () => { throw new Error("verification timeout"); }), /verification timeout/);
    assert.equal((await store.get("entry_exact"))?.execution_generation_id, "execution_2", "verification timeout preserves predecessor authority");
    await assert.rejects(store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact", roomId: "focus_other", workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_2", toExecutionGenerationId: "execution_3",
      agentSessionId: "agent_session_exact",
    }, async () => ({ accepted: true })), /does not match the durable worker identity/);
    await assert.rejects(
      store.checkpointCursor("entry_exact", "agent_session_exact", "execution_1", "msg_stale"),
      /does not match the active supervised binding/,
    );
    await store.bind({
      entry_id: "entry_peer_b",
      room_id: "focus_37",
      work_attempt_id: "attempt_peer_b",
      execution_generation_id: "execution_peer_b",
      agent_session_id: "agent_session_peer_b",
      agent_session_token: "peer-b-secret",
      api_url: "https://letagents.chat",
    });
    await store.checkpointCursor("entry_peer_b", "agent_session_peer_b", "execution_peer_b", "msg_peer_b");
    assert.equal((await store.get("entry_exact"))?.room_cursor, "msg_2822", "peer B cannot advance peer A's same-room cursor");
    assert.equal((await store.get("entry_peer_b"))?.room_cursor, "msg_peer_b");

    const replacementIdentity = await store.bind({
      entry_id: "entry_exact",
      room_id: "focus_37",
      work_attempt_id: "attempt_exact",
      execution_generation_id: "execution_3",
      agent_session_id: "agent_session_other",
      agent_session_token: "other-secret",
      api_url: "https://letagents.chat",
    });
    assert.equal(replacementIdentity.room_cursor, null, "a different worker identity cannot inherit another session's cursor");
  } finally {
    await env.cleanup();
  }
});

test("one retained supervisor handle survives terminal, rebind, and successor start", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease-1", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const first = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    const fenceDirectory = join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences");
    const held = (await readdir(fenceDirectory)).find((name) => name.startsWith("shared-"));
    assert.ok(held);
    await store.recordTerminal(attempt.work_attempt_id, first.execution_generation_id, { ended_at: "2027-01-01T00:00:01.000Z", exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "done", actor: "daemon", generation: 1, provider_continuation_id: null });
    await store.rebindAttempt(attempt.work_attempt_id, "lease-2", 2);
    await store.startGeneration(attempt.work_attempt_id, "daemon", 2);
    assert.equal((await readdir(fenceDirectory)).filter((name) => name.startsWith("shared-")).join(), held, "handoff must retain the same fence record without a release/reacquire gap");
  } finally { await env.cleanup(); }
});

test("a live fence in an unrelated repository does not starve safe GC", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    const unrelated = join(env.root, "worktrees", "other-repo", randomUUID());
    await mkdir(unrelated, { recursive: true });
    const live = await acquireWorkspaceFence(unrelated, "other-supervisor", 1, "shared");
    try { assert.deepEqual(await store.garbageCollect(0), [attempt.work_attempt_id]); }
    finally { await live.release(); }
  } finally { await env.cleanup(); }
});

test("supervisor quiescence lets same-repository GC progress without stopping live work", async () => {
  const env = await fixture();
  let quiesced: string[] = [];
  let resumed = false;
  try {
    const store = new WorkDurabilityStore(
      join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root),
      async (attempts) => { quiesced = attempts.map((attempt) => attempt.work_attempt_id); return async () => { resumed = true; }; }, TEST_SUPERVISOR,
    );
    const doomedWorkspace = await provisionedWorkspace(env.root, "doomed");
    const liveWorkspace = await provisionedWorkspace(env.root, "live");
    const doomed = await store.createAttempt({ taskId: "doomed", leaseId: "lease-doomed", leaseEpoch: 1, workspacePath: doomedWorkspace.path, workAttemptId: doomedWorkspace.id });
    const live = await store.createAttempt({ taskId: "live", leaseId: "lease-live", leaseEpoch: 1, workspacePath: liveWorkspace.path, workAttemptId: liveWorkspace.id });
    await store.concludeAttempt(doomed.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    await store.startGeneration(live.work_attempt_id, "daemon", 1);
    assert.deepEqual(await store.garbageCollect(0), [doomed.work_attempt_id]);
    assert.deepEqual(quiesced, [live.work_attempt_id]);
    assert.equal(resumed, true);
    assert.equal((await stat(liveWorkspace.path)).isDirectory(), true);
    assert.equal((await readdir(join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences"))).filter((name) => name.startsWith("shared-")).length, 1, "live generation fence is restored before it resumes");
  } finally { await env.cleanup(); }
});

test("quiescence failures never resume a partially unfenced live generation", async () => {
  const env = await fixture();
  let resumed = 0;
  try {
    const store = new WorkDurabilityStore(
      join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root),
      async () => async () => { resumed += 1; }, { supervisor_id: "daemon-host", supervisor_generation: 7 },
      { before_release: async (_attempt, index) => { if (index === 1) throw new Error("injected partial-release failure"); } },
    );
    const targetWorkspace = await provisionedWorkspace(env.root, "target");
    const firstWorkspace = await provisionedWorkspace(env.root, "first");
    const secondWorkspace = await provisionedWorkspace(env.root, "second");
    const target = await store.createAttempt({ taskId: "target", leaseId: "lease-target", leaseEpoch: 1, workspacePath: targetWorkspace.path, workAttemptId: targetWorkspace.id });
    const first = await store.createAttempt({ taskId: "first", leaseId: "lease-first", leaseEpoch: 1, workspacePath: firstWorkspace.path, workAttemptId: firstWorkspace.id });
    const second = await store.createAttempt({ taskId: "second", leaseId: "lease-second", leaseEpoch: 1, workspacePath: secondWorkspace.path, workAttemptId: secondWorkspace.id });
    await store.concludeAttempt(target.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    await store.startGeneration(first.work_attempt_id, "daemon", 1);
    await store.startGeneration(second.work_attempt_id, "daemon", 1);
    assert.deepEqual(await store.garbageCollect(0), []);
    assert.equal(resumed, 0);
    assert.equal((await store.getAttempt(first.work_attempt_id)).state, "coordination_blocked");
    assert.equal((await store.getAttempt(second.work_attempt_id)).state, "coordination_blocked");
  } finally { await env.cleanup(); }
});

test("quiescence restore failure never resumes unfenced work", async () => {
  const env = await fixture();
  let resumed = 0;
  try {
    const store = new WorkDurabilityStore(
      join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root),
      async () => async () => { resumed += 1; }, { supervisor_id: "daemon-host", supervisor_generation: 7 },
      { before_restore: async () => { throw new Error("injected restore failure"); } },
    );
    const targetWorkspace = await provisionedWorkspace(env.root, "target");
    const liveWorkspace = await provisionedWorkspace(env.root, "live");
    const target = await store.createAttempt({ taskId: "target", leaseId: "lease-target", leaseEpoch: 1, workspacePath: targetWorkspace.path, workAttemptId: targetWorkspace.id });
    const live = await store.createAttempt({ taskId: "live", leaseId: "lease-live", leaseEpoch: 1, workspacePath: liveWorkspace.path, workAttemptId: liveWorkspace.id });
    await store.concludeAttempt(target.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    await store.startGeneration(live.work_attempt_id, "daemon", 1);
    assert.deepEqual(await store.garbageCollect(0), []);
    assert.equal(resumed, 0);
    assert.equal((await store.getAttempt(live.work_attempt_id)).state, "coordination_blocked");
  } finally { await env.cleanup(); }
});

test("quiescence resume failure blocks the live attempt", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(
      join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root),
      async () => async () => { throw new Error("injected resume failure"); }, { supervisor_id: "daemon-host", supervisor_generation: 7 },
    );
    const targetWorkspace = await provisionedWorkspace(env.root, "target");
    const liveWorkspace = await provisionedWorkspace(env.root, "live");
    const target = await store.createAttempt({ taskId: "target", leaseId: "lease-target", leaseEpoch: 1, workspacePath: targetWorkspace.path, workAttemptId: targetWorkspace.id });
    const live = await store.createAttempt({ taskId: "live", leaseId: "lease-live", leaseEpoch: 1, workspacePath: liveWorkspace.path, workAttemptId: liveWorkspace.id });
    await store.concludeAttempt(target.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    await store.startGeneration(live.work_attempt_id, "daemon", 1);
    assert.deepEqual(await store.garbageCollect(0), []);
    assert.equal((await store.getAttempt(live.work_attempt_id)).state, "coordination_blocked");
  } finally { await env.cleanup(); }
});

test("providerStreamLifecycle never fails the agent on a tool call's own error status", () => {
  const base = { workAttemptId: "attempt", providerContinuationId: "thread", observedAt: "2026-08-01T00:00:00.000Z", sequence: 1, provider: "open-model", summary: null, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null };
  // The #860 Live-tab emitToolCall path: a tool with status "error" (a tool
  // crash, a permission denial, or a tool aborted by a Stop). This must NOT
  // classify the whole agent as failed — that would SIGKILL the OpenCode server
  // mid-turn (and, once stop-then-resend coexists, kill the session the
  // correction was about to resume on).
  assert.equal(providerStreamLifecycle({ ...base, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { status: "error", partId: "tool-1" } }), "working");
  assert.equal(providerStreamLifecycle({ ...base, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { status: "running", partId: "tool-1" } }), "working");
  // A failed Codex turn leaves its reusable runtime available. Genuine process
  // failures still classify failed.
  assert.equal(providerStreamLifecycle({ ...base, provider: "codex", kind: "turn_lifecycle", method: "turn/failed", payload: {} }), "terminal");
  assert.equal(providerStreamLifecycle({ ...base, kind: "error", method: "result", payload: { is_error: true } }), "failed");
  assert.equal(providerStreamLifecycle({ ...base, provider: "codex", kind: "command_output", method: "process/systemError", payload: { status: "systemError" } }), "failed");
});
