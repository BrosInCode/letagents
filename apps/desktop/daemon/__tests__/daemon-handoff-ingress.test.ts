import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ManifestStore } from "../manifest-store.js";
import { DaemonAlreadyRunningError, DaemonFenceLostError } from "../singleton.js";
import { type DaemonActivityEvent, type DaemonManifestEntry } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { WorkerRuntimeCustody } from "../worker-runtime-custody.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { unavailableLifecycleProjectionDiagnostics } from "../lifecycle-projection-ledger.js";
import { connectDaemon } from "../../../../shared/daemon-endpoint.mjs";
import {
  SupervisorDaemon,
  noWorkLeaseHttp,
  fixture,
  within,
  daemonRequest,
  appendNativeActivity,
  entry, testDaemonEndpoint } from "./helpers/daemon-fixture.js";

test("handoff aborts a hung pre-observation room bootstrap without creating a cursor", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    ...noWorkLeaseHttp,
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    ...noWorkLeaseHttp,
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
      ...noWorkLeaseHttp,
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
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
    ...noWorkLeaseHttp,
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
    ...testDaemonEndpoint(env.root),
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
  let heldSocket: ReturnType<typeof connectDaemon> | null = null;
  try {
    await first.start();
    const store = (first as unknown as { store: ManifestStore }).store;
    const originalWrite = store.write.bind(store);
    store.write = (expected, entries, commitFence) => originalWrite(expected, entries, async (commit) => {
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

    heldSocket = connectDaemon(paths.socketPath);
    // A connection that nobody reads never reports that the daemon closed it on Windows.
    heldSocket.resume();
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
  const paths = { lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
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
    const event: DaemonActivityEvent = { observed_at: "2026-01-01T00:00:01.000Z", sequence: 1, provider: "codex", kind: "turn_lifecycle", method: "turn/started", summary: "Working on the task", status: "working", payload: {}, payload_truncated: false, payload_redacted: true, durable_payload_ref: null };
    await appendNativeActivity(daemon, entry.id, event);
    // The stored axes, not the read model's: an event this old reads back as stale, as the next lines show.
    const inspection = new ManifestStore(paths.manifestPath);
    try {
      const active = (await inspection.getEntry(entry.id))!;
      assert.equal(active.observed_state, "working");
      assert.equal(active.native_liveness?.state, "active");
    } finally { await inspection.close(); }
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

test("daemon stop writes admitted activity before it releases authority, then refuses more", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const { manifestAdministration } = daemon as unknown as {
    manifestAdministration: { appendNativeActivity(id: string, event: DaemonActivityEvent, activityOnly: boolean): Promise<void> };
  };
  const activity = (sequence: number): DaemonActivityEvent => ({ observed_at: new Date().toISOString(), sequence, provider: "codex", kind: "turn_lifecycle", method: "turn/started", summary: `step ${sequence}`, status: "working", payload: {}, payload_truncated: false, payload_redacted: false, durable_payload_ref: null });
  let stopped = false;
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: { ...entry, workspace_path: "/tmp/work" } });
    // Admitted, still inside the batch window: not yet committed.
    await manifestAdministration.appendNativeActivity(entry.id, activity(1), false);
    await manifestAdministration.appendNativeActivity(entry.id, activity(2), false);
    await daemon.stop();
    stopped = true;
    const inspection = new ManifestStore(paths.manifestPath);
    try {
      const saved = (await inspection.getEntry(entry.id))!;
      assert.deepEqual(saved.activity?.map((event) => event.sequence), [1, 2], "clean stop drops no admitted activity");
      assert.equal(saved.observed_state, "working");
    } finally { await inspection.close(); }
    await assert.rejects(manifestAdministration.appendNativeActivity(entry.id, activity(3), false), /fence|closed/);
  } finally {
    if (!stopped) await daemon.stop();
    await env.cleanup();
  }
});

test("a handoff fence refuses new activity but still writes activity admitted before it", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const internals = daemon as unknown as {
    handoffScheduled: boolean;
    activityWrites: { flush(): Promise<void>; size: number };
    manifestAdministration: { appendNativeActivity(id: string, event: DaemonActivityEvent, activityOnly: boolean): Promise<void> };
  };
  const activity = (sequence: number): DaemonActivityEvent => ({ observed_at: new Date().toISOString(), sequence, provider: "codex", kind: "turn_lifecycle", method: "turn/started", summary: `step ${sequence}`, status: "working", payload: {}, payload_truncated: false, payload_redacted: false, durable_payload_ref: null });
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: { ...entry, workspace_path: "/tmp/work" } });
    await internals.manifestAdministration.appendNativeActivity(entry.id, activity(1), false);
    internals.handoffScheduled = true;
    await assert.rejects(internals.manifestAdministration.appendNativeActivity(entry.id, activity(2), false), DaemonFenceLostError);
    assert.equal(internals.activityWrites.size, 1);
    await internals.activityWrites.flush();
    const inspection = new ManifestStore(paths.manifestPath);
    try {
      assert.deepEqual((await inspection.getEntry(entry.id))!.activity?.map((event) => event.sequence), [1],
        "admitted activity commits under the admitted-state fence while the singleton is still owned");
    } finally { await inspection.close(); }
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("a batch waiting for the commit lane when a handoff starts still commits its admitted events", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const internals = daemon as unknown as {
    handoffScheduled: boolean;
    authority: { serializeManifestCommit<T>(operation: () => Promise<T>): Promise<T> };
    activityWrites: { flush(): Promise<void>; size: number };
    manifestAdministration: { appendNativeActivity(id: string, event: DaemonActivityEvent, activityOnly: boolean): Promise<void> };
  };
  const idle: DaemonActivityEvent = { observed_at: new Date().toISOString(), sequence: 1, provider: "codex", kind: "turn_lifecycle", method: "turn/completed", summary: "Turn ended", status: "idle", payload: {}, payload_truncated: false, payload_redacted: false, durable_payload_ref: null };
  let releaseLane!: () => void;
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: { ...entry, observed_state: "working", workspace_path: "/tmp/work" } });
    await internals.manifestAdministration.appendNativeActivity(entry.id, idle, false);
    // Hold the commit lane so the batch waits inside it, then start a handoff.
    let laneHeld!: () => void;
    const held = new Promise<void>((resolve) => { laneHeld = resolve; });
    const lane = internals.authority.serializeManifestCommit(() => new Promise<void>((resolve) => { releaseLane = resolve; laneHeld(); }));
    await held;
    const flushed = internals.activityWrites.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    internals.handoffScheduled = true;
    releaseLane();
    await lane;
    await flushed;
    const inspection = new ManifestStore(paths.manifestPath);
    try {
      const saved = (await inspection.getEntry(entry.id))!;
      assert.deepEqual(saved.activity?.map((event) => event.sequence), [1], "the pre-fence event was not dropped");
      assert.equal(saved.observed_state, "idle", "the successor does not start from a stale working state");
    } finally { await inspection.close(); }
  } finally {
    releaseLane?.();
    await daemon.stop();
    await env.cleanup();
  }
});

test("daemon ingress redacts provider credentials before manifest, DTO, and audit persistence", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const canary = "canary-not-a-real-credential-123456789";
  const workerBearer = `lasb_${"A".repeat(43)}`;
  const hostGrant = `lashg_${"b".repeat(43)}`;
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: { ...entry, id: "credential_firewall" } });
    await appendNativeActivity(daemon, "credential_firewall", {
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
    });
    const listed = await daemonRequest(paths.socketPath, "manifest.list");
    assert.equal(listed.ok, true, listed.error);
    const dto = (listed.result as DaemonManifestEntry[]).find((candidate) => candidate.id === "credential_firewall")!;
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
  const paths = { lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
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
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("distinct supervised Codex entries coexist in one room", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
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
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});
