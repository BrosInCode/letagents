import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { supervisedAgentTest as test } from "../../electron/__tests__/platform.js";
import { DatabaseSync } from "node:sqlite";
import { WorkDurabilityStore } from "../durability-store.js";
import { ManifestStore } from "../manifest-store.js";
import { serializeDaemonDeploymentId } from "../manifest-entry-projection.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonManifestEntry, type DaemonRoomMoveRecord } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { WorkerRuntimeCustody, type CachedWorkerAuthorization } from "../worker-runtime-custody.js";
import { type DaemonToolAgentSession } from "../supervised-tool-runtime.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { type SupervisedDeliveryHttp } from "../supervised-agent-delivery.js";
import type { ProviderActionPort } from "../provider-action-port.js";
import type { ProviderRecoveryDiagnostics } from "../provider-stream-coordinator.js";
import { ProviderActionPortRouter, type NativeProviderAdapter } from "../provider-action-port-router.js";
import { defaultGetProcessIdentity } from "../../electron/main/agents/provider-evidence.js";
import { connectDaemon } from "../../../../shared/daemon-endpoint.mjs";
import {
  runtimeReadySubscription,
  SupervisorDaemon,
  execFileAsync,
  noWorkLeaseHttp,
  fixture,
  admitDaemonInboxForProviderTest,
  within,
  eventually,
  daemonRequest,
  provisionedWorkspace,
  committedSourceRepository,
  primeDaemonBareRepository,
  entry, testDaemonEndpoint } from "./helpers/daemon-fixture.js";

for (const modeCase of ["mcp_polling", "daemon_inbox", "custodial_polling_v1"] as const) {
const custodial = modeCase === "custodial_polling_v1";
const deliveryMode = modeCase === "daemon_inbox" ? "daemon_inbox" : "mcp_polling";
const expectedReadyState = deliveryMode === "daemon_inbox" ? "idle" : "working";
test(`two Codex room agents keep independent provider executions across stop, resume, and daemon handoff (${modeCase})`, async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
  const router = () => {
    const port = new ProviderActionPortRouter({ codex: async () => adapter });
    // This legacy fixture has no exact-turn control and tests lifecycle
    // isolation, not automatic migration to daemon inbox delivery.
    return modeCase === "mcp_polling" ? new Proxy(port, {
      get(target, property, receiver) {
        if (property === "controlExactTurn") return undefined;
        return Reflect.get(target, property, receiver);
      },
    }) : port;
  };
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
      ...noWorkLeaseHttp,
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

    // Select the cutover retry ordering around the exact terminal boundary;
    // this lifecycle fixture must retain its requested delivery mode there too.
    const cutovers = (daemon as unknown as {
      deliveryCutovers: { start(entryId: string): Promise<void> };
    }).deliveryCutovers;
    if (modeCase === "mcp_polling") await cutovers.start(identities[0].entryId);

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

    if (modeCase === "mcp_polling") await cutovers.start(identities[0].entryId);

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

test("daemon restart preserves multiple isolated Cursor owners from older manifests", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    ...noWorkLeaseHttp,
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
      tool_name: "send_message", input: { reply_to: "other-message", text: "allowed" }, mutation: true,
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
      tool_name: "send_message", input: { reply_to: "other-message", text: "allowed" }, mutation: true,
    });
    assert.equal(exactRetry.ok, true, exactRetry.error);
    assert.deepEqual(exactRetry.result, { state: "completed", result: { delivered: true }, room_id: entry.room_id },
      "a successor execution reaches the same origin-scoped effect journal");

    const interruptedMutationParams = {
      ...coordinates, provider_turn_id: "cursor-turn-current", mcp_request_id: "effect-uncertain",
      tool_name: "send_message", input: { reply_to: "other-message", text: "send at most once" }, mutation: true,
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
      tool_name: "send_message", input: { reply_to: "other-message", text: "external effect succeeds once" },
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
    const abandoned = connectDaemon(paths.socketPath);
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
      // Not Read-only: a Read-only Codex agent may not claim a task, and this test is about the turn capability.
      delivery_mode: "daemon_inbox", permission_profile_id: "full_access",
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
    ...testDaemonEndpoint(env.root),
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
    ...testDaemonEndpoint(env.root),
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
