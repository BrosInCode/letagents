import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { supervisedAgentTest as test } from "../../electron/__tests__/platform.js";
import { WorkDurabilityStore } from "../durability-store.js";
import { ManifestStore } from "../manifest-store.js";
import { SupervisorDaemon as ProductionSupervisorDaemon, SupervisorGrantRequestError } from "../main.js";
import { type DaemonManifestEntry } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { WorkerRuntimeCustody } from "../worker-runtime-custody.js";
import { ConvergencePacer, ConvergencePacerClosedError, INTERACTIVE_RESERVED_AUTHORITY_SLOTS, SERVER_AUTHORITY_CONCURRENCY } from "../convergence-pacer.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { CRASH_LOOP_EXIT_LIMIT, CRASH_LOOP_WINDOW_MS, decideReconciliation, restartBackoffMs, restartsAfterNextFailure } from "../reconciler-policy.js";
import { ProviderReconciler } from "../reconciler-runner.js";
import { advanceReconciliationState, recordReconciliationActionFailure, rememberCompletedControlAction } from "../reconciler-state.js";
import type { ProviderActionPort } from "../provider-action-port.js";
import {
  runtimeReadySubscription,
  SupervisorDaemon,
  noWorkLeaseHttp,
  fixture,
  admitDaemonInboxForProviderTest,
  within,
  eventually,
  fakeRecoveryClock,
  daemonRequest,
  TEST_SUPERVISOR,
  provisionedWorkspace,
  fakeGit,
  entry,
} from "./helpers/daemon-fixture.js";

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
    ...noWorkLeaseHttp,
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
      ...noWorkLeaseHttp,
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

test("the lane outlook mirrors the crash-loop check that runs before every provider restart", () => {
  const now = 50_000_000;
  const recent = (count: number) => Array.from({ length: count }, (_, index) => now - 1_000 * (index + 1));
  assert.equal(restartsAfterNextFailure([], now), true);
  assert.equal(restartsAfterNextFailure(recent(CRASH_LOOP_EXIT_LIMIT - 2), now), true, "the next ending is the last one still restarted");
  assert.equal(restartsAfterNextFailure(recent(CRASH_LOOP_EXIT_LIMIT - 1), now), false, "the next ending reaches the limit, so the agent is quarantined");
  assert.equal(restartsAfterNextFailure(Array.from({ length: CRASH_LOOP_EXIT_LIMIT }, () => now - CRASH_LOOP_WINDOW_MS - 1), now), true,
    "endings outside the window do not count");
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

test("retirement cancels queued paced work at once instead of admitting it during the retire window", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "pace.lock"), socketPath: join(env.root, "pace.sock"),
    manifestPath: join(env.root, "pace.sqlite"), auditPath: join(env.root, "pace-audit.jsonl"),
    attemptsPath: join(env.root, "pace-attempts.sqlite"), attemptsRoot: join(env.root, "pace-attempts"),
    workspaceRoot: env.root, workerBindingsPath: join(env.root, "pace-bindings.json"),
  };
  const daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, { random: () => 0 });
  const internals = daemon as unknown as {
    convergencePacer: ConvergencePacer;
    handoff: { options: { beginRetirement(): void } };
  };
  try {
    const holders = await Promise.all(Array.from({ length: SERVER_AUTHORITY_CONCURRENCY - INTERACTIVE_RESERVED_AUTHORITY_SLOTS },
      (_, index) => internals.convergencePacer.acquire("authority", `holder-${index}`)));
    const queued = internals.convergencePacer.acquire("authority", "queued-mint");
    await new Promise((resolve) => setImmediate(resolve));
    internals.handoff.options.beginRetirement();
    await within(assert.rejects(queued, ConvergencePacerClosedError, "a queued mint is cancelled, not admitted"),
      "queued work cancelled at retirement", 1_000);
    await assert.rejects(internals.convergencePacer.acquire("launch", "late-launch"), ConvergencePacerClosedError);
    for (const release of holders) release();
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
    let observePoke!: () => void;
    const pokeObserved = new Promise<void>((resolve) => { observePoke = resolve; });
    const replacement = { workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" as const };
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: true, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => replacement, attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async (handle) => { poked.push(handle.pid); observePoke(); }, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
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
    await within(pokeObserved, "scheduled replacement poke");
    await stop(); await sameStop();
    assert.ok(poked.every((pid) => pid === 2) && poked.length > 0, "later scheduler ticks target the installed replacement, not input's stale handle");

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
