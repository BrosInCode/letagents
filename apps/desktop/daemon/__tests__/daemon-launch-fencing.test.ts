import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mapEntry } from "../../electron/main/supervisor-daemon.js";
import { canReconnectRoomAgent, canRecoverSavedRoomAgent } from "../../renderer/src/domain/room-agent-delivery.js";
import { WorkDurabilityStore } from "../durability-store.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import { SupervisorGrantRequestError } from "../main.js";
import { type DaemonManifestEntry, type DaemonManifestEntryView } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { ProviderActionHandle, ProviderActionPort } from "../provider-action-port.js";
import type { NativeExecutionObservation } from "../../shared/execution-protocol.js";
import type { ProviderStreamCoordinator } from "../provider-stream-coordinator.js";
import {
  runtimeReadySubscription,
  SupervisorDaemon,
  noWorkLeaseHttp,
  fixture,
  admitDaemonInboxForProviderTest,
  within,
  eventually,
  daemonRequest,
  provisionedWorkspace,
  entry, testDaemonEndpoint } from "./helpers/daemon-fixture.js";

test("daemon restart without Electron credential delivery retains inbox work and projects a safe waiting state", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    spawn: async input => {
      const db = new DatabaseSync(paths.manifestPath);
      try {
        const receipt = db.prepare("SELECT * FROM worker_execution_bindings WHERE entry_id=? AND execution_generation_id=? AND agent_session_id=?")
          .get("host_grant_bind_retry", input.supervisorExecutionGenerationId!, input.supervisorWorkerSession!.agentSessionId);
        assert.equal(receipt?.work_attempt_id, attempt.work_attempt_id, "exact worker custody commits before provider spawn");
        assert.equal(receipt?.grant_id, "grant-1");
      } finally { db.close(); }
      spawns += 1; return handle;
    }, attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("must not resume a fresh host-grant provider"); }, poke: async () => {},
    stop: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }; },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const grants = {
    ...noWorkLeaseHttp,
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
    const internals = daemon as unknown as { workerBindings: WorkerBindingStore; store: ManifestStore;
      providerStreams: ProviderStreamCoordinator; publishNativeActivity: () => Promise<boolean> };
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
    await eventually(async () => (await internals.store.getEntry("host_grant_bind_retry"))?.condition === "coordination_blocked", "post-spawn binding failure");
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
      async () => (await internals.store.getEntry("host_grant_bind_retry"))?.condition === "none",
      "successful room binding clears its durable recovery condition",
    );
    const recovered = (await internals.store.getEntry("host_grant_bind_retry"))!;
    assert.equal(recovered.last_error, null);
    const recoveredProjection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    // This fixture deliberately has no native execution observer. Restoring
    // its exact worker binding cannot manufacture operational readiness.
    assert.equal(recoveredProjection.condition, "coordination_blocked");
    assert.match(recoveredProjection.last_error ?? "", /readiness evidence is unavailable/);
    assert.equal(internals.providerStreams.deliveryAdmission(recovered), "unavailable");
    assert.equal(internals.providerStreams.isDeliveryAdmitted("host_grant_bind_retry"), false);
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    ...noWorkLeaseHttp,
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
      ...noWorkLeaseHttp,
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    ...noWorkLeaseHttp,
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    deliveryModes: ReadonlyArray<"mcp_polling" | "daemon_inbox"> | undefined,
  ) => {
    const env = await fixture();
    const paths = {
      lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
      lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
      ...noWorkLeaseHttp,
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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

for (const survivesRestart of [true, false]) test(`handoff during provider dispatch ${survivesRestart ? "persists the exact surviving handle for successor attach" : "retains live custody of an admitted non-surviving launch"}`, async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
  const returnedHandle = { workAttemptId: attempt.work_attempt_id, pid: 55441, providerContinuationId: "handoff-dispatch-continuation", observedState: "working" as "working" | "idle" };
  let spawns = 0;
  let attaches = 0;
  let stops = 0;
  const stopActions: string[] = [];
  let exitRegistrations = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart }),
    spawn: async () => { spawns += 1; spawnEntered(); await spawnGate; return returnedHandle; },
    attach: async (ref) => {
      attaches += 1;
      assert.equal(ref.providerContinuationId, returnedHandle.providerContinuationId);
      return returnedHandle;
    },
    attachAction: async () => { throw new Error("handoff successor uses the durable provider ref, not action inference"); },
    resume: async () => { throw new Error("successor must attach instead of resume/spawn"); }, poke: async () => {},
    stop: async (_handle, options) => { stops += 1; stopActions.push(options.actionId); return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: returnedHandle.providerContinuationId }; },
    onExit: async () => {
      assert.equal(stops, 0, "ownership and terminal observation are installed before any terminal fence");
      exitRegistrations += 1;
      return () => {};
    }, onStream: async () => () => {},
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
    const prepared = await prepare;
    if (!survivesRestart) {
      assert.equal(prepared.ok, false);
      assert.match(prepared.error ?? "", /Update deferred/);
      assert.equal(exitRegistrations, 1, "admitted launch installs its current ownership before deferring");
      assert.equal((first as unknown as { liveHandles: Map<string, unknown> }).liveHandles.get("handoff_during_dispatch"), returnedHandle);
      assert.equal(stops, 0);
      assert.equal(handoffFinished, false);
      returnedHandle.observedState = "idle";
      assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    } else assert.equal(prepared.ok, true);
    await within(handoff, "dispatch persistence handoff", 1_000);
    assert.equal(stops, 0, "handoff preserves the provider process");
    assert.equal(exitRegistrations, survivesRestart ? 0 : 1, "surviving launches retain immediate handoff; non-surviving launches retain live custody through deferral");

    second = new SupervisorDaemon(paths, "darwin", port, true);
    await second.start();
    await eventually(async () => attaches === 1
      && (second as unknown as { liveHandles: Map<string, typeof returnedHandle> }).liveHandles.get("handoff_during_dispatch") === returnedHandle,
    "successor exact provider attach");
    await (second as unknown as { providerExecution: { drainConvergence(): Promise<void> } }).providerExecution.drainConvergence();
    assert.equal(exitRegistrations, survivesRestart ? 1 : 2, "successor installs its terminal observer before convergence completes");
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
    // This legacy, non-grant fixture is terminal once idle. Its successor
    // fences that exact installation only after attaching its observers.
    assert.equal(stops, survivesRestart ? 0 : 1);
    assert.deepEqual(stopActions, survivesRestart ? [] : [
      `manifest:handoff_during_dispatch:reattached-terminal:${current.provider_ref?.execution_generation_id}`,
    ]);
  } finally {
    releaseSpawn?.();
    await second?.stop().catch(() => undefined);
    await first.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("handoff winning the normal post-dispatch commit falls back to exact retirement persistence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
      lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    ...noWorkLeaseHttp,
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

for (const [rotationFailures, rotationStatus, providerName] of [[0, 500, "codex"], [1, 500, "codex"], [18, 500, "codex"], [3, 403, "codex"], [3, 403, "cursor"]] as const) test(`a live daemon rotates its bearer after ${rotationFailures} HTTP ${rotationStatus} responses without replacing ${providerName}`, async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
  let stops = 0;
  const pendingTimers = new Map<ReturnType<typeof setTimeout>, { callback: () => void; delay: number }>();
  const handle: ProviderActionHandle = {
    workAttemptId: attempt.work_attempt_id, providerContinuationId: "rotating-host-grant-continuation",
    ...(providerName === "cursor"
      ? { pid: null, providerConnection: { kind: "cursor_cli" as const, pid: null, processIdentity: null }, observedState: "idle" as const }
      : { pid: 9914, observedState: "working" as const }),
  };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; return handle; }, attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("bearer rotation must retain the live provider"); }, poke: async () => {},
    stop: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }; },
    onExit: async () => () => {}, onStream: async () => () => {},
    ...(providerName === "codex" ? { onExecution: async (runtime: ProviderActionHandle, listener: (event: NativeExecutionObservation) => void) => runtimeReadySubscription(runtime, listener) } : {}),
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, rotationFailures ? 60_000 : 10, undefined, {
    nowMs: () => clock,
    setTimeout: ((callback: () => void, delay: number) => {
      if (delay < 1_000) return setTimeout(callback, delay);
      const timer = setTimeout(() => undefined, 3_600_000);
      timer.unref();
      pendingTimers.set(timer, { callback, delay });
      return timer;
    }) as typeof setTimeout,
    clearTimeout: ((timer: ReturnType<typeof setTimeout>) => {
      pendingTimers.delete(timer);
      clearTimeout(timer);
    }) as typeof clearTimeout,
    // The test drives recovery timers by hand; mint backoff inside one pass
    // is not what it measures, and jitter would move timers off the fake clock.
    sleep: async () => undefined,
    random: () => 0,
  }, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    ...noWorkLeaseHttp,
    createWorkerSession: async () => {
      mintCalls += 1;
      if (mintCalls > 1 && mintCalls <= rotationFailures + 1) {
        throw new SupervisorGrantRequestError(rotationStatus, "worker rotation");
      }
      return mintCalls === 1
        ? { sessionId: "rotating-session", bearer: "first-rotating-bearer", bearerId: "first-rotating-bearer-id", expiresAt: new Date(clock + 120_000).toISOString() }
        : { sessionId: "rotating-session", bearer: "second-rotating-bearer", bearerId: "second-rotating-bearer-id", expiresAt: new Date(clock + 3_600_000).toISOString() };
    },
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      workerBindings: WorkerBindingStore;
      supervisedInbox: SupervisedAgentInboxStore;
      store: ManifestStore;
      providerExecution: {
        request(entryId: string): void;
        drainConvergence(): Promise<void>;
        recoveryTimers: Map<string, ReturnType<typeof setTimeout>>;
      };
      publishNativeActivity: () => Promise<boolean>;
    };
    internals.publishNativeActivity = async () => true;
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "host_grant_expiry_rotation", provider: providerName, delivery_mode: "daemon_inbox", observed_state: "absent",
      ...(providerName === "cursor" ? { permission_profile_id: "read_only" } : {}),
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await admitDaemonInboxForProviderTest(daemon, "host_grant_expiry_rotation", entry.room_id);
    const daemonGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const installedGrant = {
      entry_id: "host_grant_expiry_rotation", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-rotation",
      supervisor_grant: "rotation-grant", grant_generation: 1, api_url: "https://letagents.example", daemon_generation: daemonGeneration,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    };
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", installedGrant)).ok, true);
    let firstBinding: Awaited<ReturnType<WorkerBindingStore["get"]>> = null;
    await eventually(async () => {
      firstBinding = await internals.workerBindings.get("host_grant_expiry_rotation");
      return firstBinding?.credential_ref === "first-rotating-bearer-id";
    }, "initial host worker bearer binding");
    assert(firstBinding);
    assert.equal(await internals.workerBindings.credentialFor(firstBinding), "first-rotating-bearer");

    await internals.providerExecution.drainConvergence();
    const initial = await internals.store.getEntry("host_grant_expiry_rotation");
    if (providerName === "cursor") {
      const head = await internals.supervisedInbox.enqueueInitialMessage({
        agent_id: "host_grant_expiry_rotation", room_id: entry.room_id,
        source_message_id: "blocked-cursor-turn", source_message: { text: "failed turn" }, activation: {},
      });
      await internals.supervisedInbox.transition(head.inbox_item_id, "dispatching");
      await internals.supervisedInbox.transition(head.inbox_item_id, "blocked", { last_error: "Provider turn failed." });
    }
    clock += 61_000;
    if (rotationFailures) {
      internals.providerExecution.request("host_grant_expiry_rotation");
      await internals.providerExecution.drainConvergence();
      let recoveryPasses = 0;
      while (mintCalls <= rotationFailures + 1) {
        const blocked = await internals.store.getEntry("host_grant_expiry_rotation");
        assert.equal(blocked?.desired_state, "running");
        assert.equal(blocked?.observed_state, "recovering");
        assert.equal(blocked?.condition, "coordination_blocked");
        assert.match(blocked?.last_error ?? "", new RegExp(`HTTP ${rotationStatus}`));
        if (rotationStatus === 403 && mintCalls === 4) {
          assert.equal(await internals.workerBindings.get("host_grant_expiry_rotation"), null);
          assert.equal(await internals.workerBindings.credentialFor(firstBinding), null);
          assert.equal(internals.providerExecution.recoveryTimers.has("host_grant_expiry_rotation"), false);
          clock += 120_000;
          const views = (await daemonRequest(paths.socketPath, "manifest.list")).result as Parameters<typeof mapEntry>[0][];
          const desktopEntry = mapEntry(views.find(view => view.id === "host_grant_expiry_rotation")!);
          assert.equal(desktopEntry.desiredState, "running");
          assert.equal(desktopEntry.roomAgentState?.inbox.state, "waiting_for_desktop_credentials");
          assert.equal(desktopEntry.roomAgentState?.ingress.state, "stopped");
          assert.equal(canReconnectRoomAgent(desktopEntry), true, "actual desktop projection offers credential-only recovery");
          assert.equal(mintCalls, 4, "definitive rejection does not retry indefinitely");
          assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
            ...installedGrant, credential_only: true,
          })).ok, true);
          await internals.providerExecution.drainConvergence();
          break;
        }
        assert.match(blocked?.last_error ?? "", /Retrying automatically/);
        assert.equal(blocked?.reconciliation_notices?.at(-1)?.kind, "coordination_escalation");
        if (clock >= Date.parse("2026-07-21T12:02:00.000Z")) {
          assert.equal(await internals.workerBindings.get("host_grant_expiry_rotation"), null,
            "expired authority cannot keep delivering room work");
          assert.equal(await internals.workerBindings.credentialFor(firstBinding), null);
        }
        const timer = internals.providerExecution.recoveryTimers.get("host_grant_expiry_rotation");
        assert.ok(timer, "a transient outage must not exhaust automatic recovery");
        const pending = pendingTimers.get(timer);
        assert.ok(pending);
        assert.ok(pending.delay <= 60_000);
        clock += pending.delay;
        pendingTimers.delete(timer);
        clearTimeout(timer);
        pending.callback();
        await internals.providerExecution.drainConvergence();
        assert.ok(++recoveryPasses <= 7, "rotation must eventually recover");
      }
      if (rotationFailures > 3) {
        assert.ok(recoveryPasses > 3, "the outage survives the former three-attempt budget");
        const audit = await readFile(paths.auditPath, "utf8");
        assert.match(audit, /HTTP 500/);
        assert.doesNotMatch(audit, /first-rotating-bearer|rotation-grant/);
      }
    }
    await eventually(async () => {
      const current = await internals.workerBindings.get("host_grant_expiry_rotation");
      return mintCalls === rotationFailures + 2 && current?.credential_ref === "second-rotating-bearer-id";
    }, "automatic host worker bearer rotation");
    const rotated = await internals.workerBindings.get("host_grant_expiry_rotation");
    assert(rotated);
    assert.equal(await internals.workerBindings.credentialFor(rotated), "second-rotating-bearer");
    const credentialVault = (internals.workerBindings as unknown as { credentials: Map<string, unknown> }).credentials;
    assert.equal(credentialVault.has("first-rotating-bearer-id"), false, "the replaced bearer is revoked from the in-memory vault");
    await internals.providerExecution.drainConvergence();
    const recovered = await internals.store.getEntry("host_grant_expiry_rotation");
    assert.equal(recovered?.desired_state, "running");
    assert.equal(recovered?.condition, "none");
    assert.equal(recovered?.last_error, null);
    assert.deepEqual(recovered?.provider_ref, initial?.provider_ref);
    assert.equal(recovered?.work_attempt_id, initial?.work_attempt_id);
    assert.equal(rotated.agent_session_id, firstBinding.agent_session_id);
    if (providerName === "cursor") {
      const views = (await daemonRequest(paths.socketPath, "manifest.list")).result as Parameters<typeof mapEntry>[0][];
      const desktopEntry = mapEntry(views.find(view => view.id === "host_grant_expiry_rotation")!);
      assert.equal(desktopEntry.observedState, "idle", "credential-only recovery preserves the idle wrapper");
      assert.equal(desktopEntry.roomAgentState?.inbox.state, "blocked", "credential recovery retains the blocked work");
      assert.equal(canRecoverSavedRoomAgent(desktopEntry), true, "blocked idle Cursor still offers runtime recovery");
    }
    assert.equal(stops, 0);
    assert.equal(spawns, 1, "bearer rotation must not restart the provider");
  } finally {
    await daemon.stop().catch(() => undefined);
    for (const timer of pendingTimers.keys()) clearTimeout(timer);
    await env.cleanup();
  }
});
