import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AuditLog } from "../audit-log.js";
import { ProviderExecutionObserver } from "../../electron/main/agents/provider-execution-observer.js";
import { DaemonControlSocket } from "../control-socket.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import { DaemonLifecycleLog, daemonLifecycleErrorDetail } from "../lifecycle-log.js";
import { serializeDaemonDeploymentId } from "../manifest-entry-projection.js";
import { DaemonAlreadyRunningError, DaemonFenceLostError, DaemonSingleton } from "../singleton.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonManifestEntry } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { WorkerRuntimeCustody } from "../worker-runtime-custody.js";
import { SupervisedAgentDelivery, type SupervisedIngressAgent } from "../supervised-agent-delivery.js";
import type { ProviderActionHandle, ProviderActionPort } from "../provider-action-port.js";
import type { HostApprovalChallenge, HostApprovalOperation } from "../../shared/host-approval-auth.js";
import { ProviderActionPortRouter, type NativeProviderAdapter } from "../provider-action-port-router.js";
import { STOP_CALLBACKS_DEADLINE_MS } from "../provider-stream-coordinator.js";
import {
  SupervisorDaemon,
  noWorkLeaseHttp,
  fixture,
  within,
  eventually,
  daemonRequest,
  entry,
  observationDaemonFixture,
} from "./helpers/daemon-fixture.js";

// A handoff teardown or a replacement start awaits only local socket, file and
// SQLite work, never the retiring daemon or a provider. A start takes ~100 ms on
// an idle laptop but has exceeded 1 s on loaded CI runners, so this bound only
// catches a hang. It stays below the stop path's callback deadline, so a
// handoff that waited for wedged callbacks still fails the guard.
const DAEMON_LIFECYCLE_HANG_GUARD_MS = STOP_CALLBACKS_DEADLINE_MS / 2;

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

test("daemon lifecycle diagnostics rotate repeated samples within one process", async () => {
  const env = await fixture();
  const path = join(env.root, "daemon-lifecycle.jsonl");
  const log = new DaemonLifecycleLog(path, 1);
  try {
    for (let i = 0; i < 20; i++) log.append({ event: "room_latency", detail: `sample ${i}` });
    const files = (await readdir(env.root)).filter(name => name.startsWith("daemon-lifecycle.jsonl")).sort();
    assert.deepEqual(files, ["daemon-lifecycle.jsonl", "daemon-lifecycle.jsonl.previous"]);
    assert.equal(JSON.parse((await readFile(path, "utf8")).trim()).detail, "sample 19");
    assert.equal(JSON.parse((await readFile(`${path}.previous`, "utf8")).trim()).detail, "sample 18");
    for (const name of files) assert.equal((await stat(join(env.root, name))).mode & 0o777, 0o600);
  } finally { log.close(); await env.cleanup(); }
});

test("daemon lifecycle diagnostics fail open when live rotation fails", async () => {
  const env = await fixture();
  const path = join(env.root, "daemon-lifecycle.jsonl");
  const log = new DaemonLifecycleLog(path, 1);
  try {
    log.append({ event: "daemon_starting" });
    await mkdir(`${path}.previous`);
    assert.doesNotThrow(() => log.append({ event: "room_latency", detail: "rotation blocked" }));
    assert.doesNotThrow(() => log.append({ event: "daemon_ready" }));
    assert.match(await readFile(path, "utf8"), /daemon_starting/);
    assert.doesNotMatch(await readFile(path, "utf8"), /rotation blocked|daemon_ready/);
  } finally { log.close(); await env.cleanup(); }
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

test("provider-aware handoff seals capture before retirement and keeps ownership after a failed seal", async () => {
  const observer = new ProviderExecutionObserver(() => new Date().toISOString());
  const env = await observationDaemonFixture((_handle, listener) => observer.subscribe(listener), "codex");
  const internal = env.daemon as unknown as { handoffDraining: boolean; handoffScheduled: boolean };
  const db = new DatabaseSync(env.paths.manifestPath);
  try {
    await env.internals.providerStreams.install(env.id, env.handle, env.generation);
    const ready = { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" } as const;
    const emit = () => observer.emit(ready, "observed-birth", 7123);
    emit();
    await eventually(async () => Number(db.prepare("SELECT COUNT(*) n FROM execution_facts WHERE agent_id=?").get(env.id)!.n) === 1,
      "initial capture is durable");
    db.exec("CREATE TRIGGER reject_handoff_tail BEFORE INSERT ON execution_facts BEGIN SELECT RAISE(ABORT,'synthetic capture failure'); END");
    const capture = env.internals.executionCapture!;
    const seal = capture.sealForPlannedHandoff.bind(capture);
    let queueTail = true;
    capture.sealForPlannedHandoff = () => {
      if (queueTail) { queueTail = false; emit(); }
      seal();
      emit(); // synchronous cleanup callback after sealing must not advance the frozen frontier
    };
    const rejected = await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff");
    assert.equal(rejected.ok, false); assert.match(rejected.error ?? "", /Update deferred/);
    assert.equal(internal.handoffScheduled, false); assert.equal(internal.handoffDraining, false);
    assert.equal(env.internals.liveHandles.get(env.id), env.handle);
    assert.equal((await daemonRequest(env.paths.socketPath, "daemon.status")).ok, true);
    db.exec("DROP TRIGGER reject_handoff_tail");
    const accepted = await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff");
    assert.equal(accepted.ok, true, accepted.error);
    await within(env.daemon.waitForHandoff(), "sealed handoff completes");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts WHERE agent_id=?").get(env.id)!.n, 2);
    assert.deepEqual({ ...db.prepare("SELECT last_source_sequence,max_observed_sequence FROM execution_observers WHERE agent_id=?").get(env.id) },
      { last_source_sequence: 2, max_observed_sequence: 2 });
  } finally { db.close(); await env.cleanup(); }
});

for (const terminalFirst of [false, true]) test(`handoff defers native configuration stop with terminal ${terminalFirst ? "saved" : "pending"}`, async () => {
  let onExit: ((terminal: ProviderActionTerminal) => void) | undefined, finishStop!: (terminal: ProviderActionTerminal) => void;
  const nativeStop = new Promise<ProviderActionTerminal>(resolve => { finishStop = resolve; });
  const env = await observationDaemonFixture(async () => ({ sourceId: "replacement-retirement",
    position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose() {},
  }), "codex", { onExit: async (_handle, listener) => { onExit = listener; return () => {}; } });
  const internal = env.daemon as unknown as { handoffScheduled: boolean;
    providerTerminals: import("../provider-terminal-coordinator.js").ProviderTerminalCoordinator };
  const terminal: ProviderActionTerminal = { endedAt: new Date().toISOString(), exitCode: 0, signal: null,
    terminalCause: "stopped", providerContinuationId: env.handle.providerContinuationId! };
  try {
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    const token = env.internals.providerStreams.currentInstallation(env.id)!;
    const replacement = internal.providerTerminals.replaceConfiguration(token, () => nativeStop);
    void replacement.catch(() => undefined);
    if (terminalFirst) {
      onExit!(terminal);
      await eventually(async () => Boolean((await env.internals.store.getEntry(env.id))?.reconciliation?.last_terminal),
        "terminal bookkeeping completes before native stop returns");
    }
    const response = await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff");
    assert.equal(response.ok, false);
    assert.match(response.error ?? "", /configuration replacement/);
    assert.equal(internal.handoffScheduled, false, "an unfinished native stop remains a reversible update deferral");
    assert.throws(() => internal.providerTerminals.beginRetirement(), /configuration replacement/);
    const stopped = env.daemon.stop();
    await assert.rejects(within(replacement, "emergency stop cancels replacement caller", 1000), /replacement closed/);
    await within(stopped, "emergency stop is not held by the native stop result");
    finishStop(terminal);
    await assert.rejects(replacement, /replacement closed/);
  } finally { finishStop(terminal); await env.cleanup(); }
});

test("retained terminal approval failures retry locally without scheduling provider recovery", async () => {
  let onExit: ((terminal: ProviderActionTerminal) => void) | undefined;
  const env = await observationDaemonFixture(async () => ({ sourceId: "approval-terminal",
    position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose() {},
  }), "codex", { onExit: async (_handle, listener) => { onExit = listener; return () => {}; } });
  const internal = env.daemon as unknown as { scheduleRecoveryConvergence(id: string, delay: number): void };
  let recoveryWakes = 0, settlements = 0;
  internal.scheduleRecoveryConvergence = () => { recoveryWakes++; };
  const settle = env.internals.store.settleWitnessedRuntimeApprovalClosures.bind(env.internals.store);
  env.internals.store.settleWitnessedRuntimeApprovalClosures = async (...args) => {
    if (++settlements === 1) throw new Error("fixture approval persistence unavailable");
    return settle(...args);
  };
  try {
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    recoveryWakes = 0;
    onExit!({ endedAt: new Date().toISOString(), exitCode: 0, signal: null,
      terminalCause: "exited", providerContinuationId: env.handle.providerContinuationId! });
    await eventually(async () => Boolean((await env.internals.store.getEntry(env.id))?.reconciliation?.last_terminal),
      "the terminal owner completes its original approval and projection work automatically");
    assert.ok(settlements >= 2);
    assert.equal(recoveryWakes, 0, "a local approval write failure must not wake native recovery");
  } finally { await env.cleanup(); }
});

for (const failure of ["none", "before-seal", "after-seal", "before-seal, cleared within the bound", "post-seal-timeout"] as const) test(`handoff retains exact terminal settlement across ${failure}`, async t => {
  let expire!: () => void, unblock!: () => void;
  const realSetTimeout = globalThis.setTimeout;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  if (failure === "post-seal-timeout") t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 30_000) {
      expire = () => callback(...args);
      return realSetTimeout(() => {}, delay);
    }
    return realSetTimeout(callback, delay, ...args);
  });
  let onExit: ((terminal: ProviderActionTerminal) => void) | undefined;
  let fire!: () => void;
  let disposeCalls = 0;
  const env = await observationDaemonFixture(async () => ({
    sourceId: "terminal-at-seal", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }),
    dispose: () => { disposeCalls++; if (failure !== "before-seal") fire(); },
  }), "codex", { onExit: async (_handle, listener) => { onExit = listener; return () => {}; } });
  const internal = env.daemon as unknown as { handoffScheduled: boolean;
    providerTerminals: { drain(): Promise<void>; bounds: { settleMs: number; lastAttemptMs: number; recordMs: number } } };
  // An exit that cannot be saved holds the handoff no longer than its bound: fifteen, eight and four seconds outside tests.
  const unsaved = failure === "before-seal" || failure === "after-seal";
  if (failure !== "post-seal-timeout") internal.providerTerminals.bounds = { settleMs: 600, lastAttemptMs: 400, recordMs: 200 };
  const inspection = new DatabaseSync(env.paths.manifestPath, { readOnly: true });
  const record = env.internals.durability.recordTerminal.bind(env.internals.durability);
  let rejectWrites = failure !== "none", recordAttempts = 0;
  env.internals.durability.recordTerminal = async (...args) => {
    recordAttempts++;
    if (failure === "post-seal-timeout") await blocked;
    else if (rejectWrites) {
      if (failure === "before-seal, cleared within the bound") rejectWrites = false;
      throw new Error("fixture terminal storage unavailable");
    }
    return record(...args);
  };
  try {
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    fire = () => onExit!({ endedAt: new Date().toISOString(), exitCode: 0, signal: null,
      terminalCause: "exited", providerContinuationId: env.handle.providerContinuationId! });
    assert.ok(onExit, "real stream terminal callback is installed");
    if (failure.startsWith("before-seal")) {
      fire();
      await eventually(async () => recordAttempts > 0, "first terminal attempts persistence before handoff");
    }
    const preparing = daemonRequest(env.paths.socketPath, "daemon.prepare_handoff");
    if (failure === "post-seal-timeout") {
      await eventually(async () => recordAttempts === 1, "post-seal terminal reached its blocked storage call");
      expire();
    }
    const response = await preparing;
    if (failure === "post-seal-timeout") {
      assert.equal(response.ok, false, "unsettled terminal never authorizes a successful handoff");
      assert.match(response.error ?? "", /exit evidence is still being saved/);
      assert.equal(internal.handoffScheduled, true, "only the pre-seal failure remains reversible");
      assert.equal((await daemonRequest(env.paths.socketPath, "daemon.status")).ok, true);
      rejectWrites = false;
      const retried = daemonRequest(env.paths.socketPath, "daemon.prepare_handoff");
      if (failure === "post-seal-timeout") {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(recordAttempts, 1, "a timed-out preparation keeps the original in-flight retirement");
        unblock();
      }
      const retry = await retried;
      assert.equal(retry.ok, true, retry.error);
    } else assert.equal(response.ok, true, unsaved
      ? `an exit whose terminal cannot be saved holds the handoff only until its bound ends, before or after the seal: ${response.error}`
      : response.error);
    await within(env.daemon.waitForHandoff(), "retained terminal finishes before stores close");
    const saved = inspection.prepare("SELECT terminal_json FROM work_attempt_executions WHERE execution_generation_id=?").get(env.generation)!;
    if (unsaved) assert.equal(saved.terminal_json, null, "what could not be saved is not invented; the successor finds the process gone");
    else assert.equal(JSON.parse(String(saved.terminal_json)).terminal_cause, "exited", "a terminal saved within the bound is the exact one");
    assert.equal(disposeCalls, 1, "capture seal and terminal removal share one disposer");
    assert.ok(recordAttempts >= (unsaved || failure === "before-seal, cleared within the bound" ? 2 : 1), "a failed save is tried again within the bound");
  } finally { unblock(); inspection.close(); await env.cleanup(); }
});

for (const { provider, defer } of [{ provider: "claude-code", defer: false }, { provider: "claude-code", defer: true }, { provider: "cursor", defer: false }] as const) test(`provider-aware ${provider} handoff ${defer ? "defers without interrupting work on timeout" : "drains the exact turn while approvals remain available"}`, { timeout: 10_000 }, async (t) => {
  let expireHandoff!: () => void;
  const realSetTimeout = globalThis.setTimeout;
  if (defer) t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 30_000) {
      expireHandoff = () => callback(...args);
      return realSetTimeout(() => {}, delay);
    }
    return realSetTimeout(callback, delay, ...args);
  });
  let approve!: () => void;
  const approval = new Promise<void>(resolve => { approve = resolve; });
  let finish!: () => void;
  const final = new Promise<void>(resolve => { finish = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let toolDone!: () => void;
  const toolCompleted = new Promise<void>(resolve => { toolDone = resolve; });
  let calls = 0;
  let detached = false;
  const env = await observationDaemonFixture((_handle, listener) => new ProviderExecutionObserver(() => new Date().toISOString()).subscribe(listener), provider, {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: true, survivesRestart: false }),
    runRoomTurn: async (handle, _request, options) => {
      const turnId = `handoff-turn-${++calls}`;
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.(turnId);
      if (calls === 1) {
        options?.detachSignal?.addEventListener("abort", () => { detached = true; });
        entered();
        await approval;
        toolDone();
        await final;
      }
      if (provider === "cursor") await env.internals.supervisedInbox.prepareEffect({
        agent_id: env.id, room_id: "room_1", execution_generation_id: env.generation,
        provider_turn_id: turnId, work_attempt_id: handle.workAttemptId,
        current_execution_generation_id: env.generation, provider_continuation_id: handle.providerContinuationId!,
        mcp_request_id: `complete:${turnId}`, tool_name: "complete_room_turn", request: { outcome: "no_reply" }, mutation: true,
      });
      handle.observedState = "idle";
      return { turnId, outcome: "no_reply", text: null, evidence: "stream" };
    },
  });
  const internal = env.daemon as unknown as {
    supervisedDelivery: SupervisedAgentDelivery;
    handoffDraining: boolean;
    hostApprovals: { enroll: (storage: { getHostApprovalPublicKey: () => Promise<string> }) => Promise<void>; decide: (input: unknown) => Promise<string> };
  };
  const host = generateKeyPairSync("ed25519");
  await internal.hostApprovals.enroll({ getHostApprovalPublicKey: async () => host.publicKey.export({ format: "der", type: "spki" }).toString("base64") });
  internal.hostApprovals.decide = async () => { approve(); return "resolved"; };
  await env.internals.providerStreams.install(env.id, env.handle, env.generation);
  const delivery = new SupervisedAgentDelivery(env.internals.supervisedInbox, env.port, {
    poll: async () => ({ messages: [] }), publish: async () => { throw new Error("no reply expected"); },
  }, async () => true);
  internal.supervisedDelivery = delivery;
  const agent: SupervisedIngressAgent = { agentId: env.id, roomId: "room_1", provider, deliveryMode: "daemon_inbox",
    apiUrl: "https://letagents.example", agentSessionId: "handoff-worker", bearer: "test-only", handle: env.handle,
    workAttemptId: env.handle.workAttemptId, providerContinuationId: env.handle.providerContinuationId,
    providerConnection: env.handle.providerConnection!, executionGenerationId: env.generation, daemonGeneration: 1 };
  let operation: Promise<void> | null = null;
  try {
    const [first, second] = await env.internals.supervisedInbox.ingestPoll({ agent_id: env.id, room_id: "room_1", last_observed_message_id: "2",
      messages: [1, 2].map(id => ({ source_message_id: String(id), source_message: { text: "do work" }, activation: {} })) });
    operation = delivery.pump(agent);
    await within(started, "Claude turn starts");
    let acknowledged = false;
    const prepare = daemonRequest(env.paths.socketPath, "daemon.prepare_handoff").then(value => { acknowledged = true; return value; });
    await eventually(async () => internal.handoffDraining || acknowledged, "handoff begins");
    assert.equal(acknowledged, false, "active approval must keep the daemon alive");
    const repeatedPrepare = daemonRequest(env.paths.socketPath, "daemon.prepare_handoff");
    const challengeResponse = await daemonRequest(env.paths.socketPath, "supervisor.host_approval_challenge");
    assert.equal(challengeResponse.ok, true, challengeResponse.error);
    const challenge = challengeResponse.result as HostApprovalChallenge;
    const signed = (operation: HostApprovalOperation, input: unknown) => {
      const issuedAt = Date.now();
      const payload = JSON.stringify({ domain: "letagents.host-approval", version: 1, ...challenge, operation, input, issuedAt, expiresAt: issuedAt + 30_000 });
      return { payload, signature: sign(null, Buffer.from(payload), host.privateKey).toString("base64") };
    };
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.host_approval_request", signed("list", { roomId: "room_1" }))).ok, true);
    if (!defer) {
      const lateLaunch = await daemonRequest(env.paths.socketPath, "manifest.put", { entry: { ...entry, id: "late-launch" } });
      assert.equal(lateLaunch.ok, false);
      assert.match(lateLaunch.error ?? "", /waiting for current agent work/);
    }
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.host_approval_request", signed("decide", { actorId: `host-${challenge.keyFingerprint}` }))).ok, true);
    await within(toolCompleted, "current tool continues after approval");
    assert.equal(detached, false, "permission and completion observations are not aborted");
    if (defer) {
      expireHandoff();
      const response = await prepare;
      assert.equal(response.ok, false);
      assert.match(response.error ?? "", /Update deferred/);
      assert.equal((await repeatedPrepare).ok, false, "concurrent requests share one deferred drain");
      assert.equal((await daemonRequest(env.paths.socketPath, "daemon.status")).ok, true);
      const firstAfter = await env.internals.supervisedInbox.get(first!.inbox_item_id);
      assert.equal(firstAfter?.provider_turn_id, "handoff-turn-1");
      assert.equal(firstAfter?.outcome, null, "timeout must not fabricate completion");
      assert.equal(calls, 1);
      finish();
      await within(operation, "original turn and queued successor finish");
      assert.equal(calls, 2, "deferred admission resumes once without rerunning the old turn");
      assert.equal(internal.handoffDraining, false);
      assert.equal((await daemonRequest(env.paths.socketPath, "daemon.status")).ok, true, "late completion cannot trigger retired timeout teardown");
    } else {
      assert.equal(acknowledged, false, "tool completion is not turn completion");
      assert.equal(calls, 1);
      assert.equal((await env.internals.supervisedInbox.get(second!.inbox_item_id))?.state, "pending");
      finish();
      assert.equal((await prepare).ok, true);
      assert.equal((await repeatedPrepare).ok, true, "concurrent requests share one handoff");
      await within(operation, "durable terminal boundary");
      assert.equal((await env.internals.supervisedInbox.get(first!.inbox_item_id))?.state, "acknowledged_no_reply");
      assert.equal(calls, 1, "handoff must not dispatch the queued successor");
      await within(env.daemon.waitForHandoff(), "safe handoff completion");
    }
  } finally {
    approve(); finish();
    await operation?.catch(() => undefined);
    await env.cleanup();
  }
});

for (const mode of ["idle", "surviving", "missing_turn_id", "missing_terminal", "unreadable_terminal"] as const) test(`provider-aware handoff ${mode}`, async () => {
  const survivesRestart = mode === "surviving";
  const unresolved = mode !== "idle" && mode !== "surviving";
  const env = await observationDaemonFixture((_handle, listener) => new ProviderExecutionObserver(() => new Date().toISOString()).subscribe(listener), "claude-code", {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: true, survivesRestart }),
  });
  await env.internals.providerStreams.install(env.id, env.handle, env.generation);
  env.handle.observedState = survivesRestart ? "working" : "idle";
  try {
    if (unresolved) {
      const [item] = await env.internals.supervisedInbox.ingestPoll({ agent_id: env.id, room_id: "room_1", last_observed_message_id: "1",
        messages: [{ source_message_id: "1", source_message: { text: "original work" }, activation: {} }] });
      assert.equal((await env.internals.supervisedInbox.claimHead(env.id))?.inbox_item_id, item!.inbox_item_id);
      await env.internals.supervisedInbox.checkpointDispatchIntent(item!.inbox_item_id);
      if (mode !== "missing_turn_id") await env.internals.supervisedInbox.checkpointTurnStarted(item!.inbox_item_id, "unresolved-turn", {
        work_attempt_id: env.handle.workAttemptId, origin_execution_generation_id: env.generation,
        provider_continuation_id: env.handle.providerContinuationId!,
      });
      if (mode === "unreadable_terminal") await env.internals.supervisedInbox.checkpointNormalizedTerminal({
        inbox_item_id: item!.inbox_item_id, agent_id: env.id, execution_generation_id: env.generation,
        provider_turn_id: "unresolved-turn", outcome: "unreadable", text: null, evidence: "none", terminal_evidence: {},
      });
      await env.internals.supervisedInbox.transition(item!.inbox_item_id, "blocked", { last_error: "native completion is unknown" });
      if (mode === "missing_turn_id") {
        const ambiguous = await env.internals.supervisedInbox.get(item!.inbox_item_id);
        assert.equal(ambiguous?.provider_turn_id, null);
        assert.equal(ambiguous?.attempt_count, 0, "unacknowledged dispatch has not counted a model turn");
      }
    }
    const result = await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff");
    if (unresolved) {
      assert.equal(result.ok, false, "idle/bootstrap observation cannot replace exact turn completion");
      assert.match(result.error ?? "", /no confirmed completion/);
      assert.equal((await env.internals.supervisedInbox.head(env.id))?.state, "blocked");
      assert.equal((await daemonRequest(env.paths.socketPath, "daemon.status")).ok, true);
    } else {
      assert.equal(result.ok, true, result.error);
      await within(env.daemon.waitForHandoff(), "compatible handoff");
    }
  } finally { await env.cleanup(); }
});

/**
 * The head of an agent's queue is a follow-up that was made blocked, because the last automatic attempt failed: it waits
 * for its owner, and nothing was ever sent to a provider for it. An update must not wait for its owner. One that its
 * owner retried may have been sent, and an acknowledgement may have been lost, so that one still holds the update.
 */
for (const retried of [false, true]) test(`provider-aware handoff ${retried ? "is deferred by a blocked follow-up that was retried" : "goes on past a blocked follow-up that never reached a provider"}`, async () => {
  const env = await observationDaemonFixture((_handle, listener) => new ProviderExecutionObserver(() => new Date().toISOString()).subscribe(listener), "claude-code", {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: true, survivesRestart: false }),
  });
  await env.internals.providerStreams.install(env.id, env.handle, env.generation);
  env.handle.observedState = "idle";
  try {
    const store = env.internals.supervisedInbox;
    const [item] = await store.ingestPoll({ agent_id: env.id, room_id: "room_1", last_observed_message_id: "1",
      messages: [{ source_message_id: "task-continuation:parent", source_message: { text: "continue the task" }, activation: {} }] });
    // Exactly what the daemon saves for a follow-up that it makes blocked.
    const db = new DatabaseSync(env.paths.manifestPath);
    db.prepare("UPDATE supervised_agent_inbox SET state='blocked',last_error='All three automatic attempts failed.' WHERE inbox_item_id=?").run(item!.inbox_item_id);
    db.prepare("INSERT INTO supervised_agent_inbox_events VALUES(?,3,'task-continuation:0','blocked',?,NULL)").run(item!.inbox_item_id, new Date().toISOString());
    db.close();
    assert.equal(await store.isUntouchedBlockedFollowUp(item!.inbox_item_id), true);
    if (retried) {
      // Its owner used Retry, and it blocked again with no turn id: the same shape as a lost acknowledgement.
      await store.transition(item!.inbox_item_id, "pending");
      await store.transition(item!.inbox_item_id, "blocked", { last_error: "native completion is unknown" });
      assert.equal(await store.isUntouchedBlockedFollowUp(item!.inbox_item_id), false);
    }
    assert.equal((await store.head(env.id))?.state, "blocked");
    const result = await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff");
    if (retried) {
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /no confirmed completion/);
      assert.equal((await store.head(env.id))?.state, "blocked");
    } else {
      assert.equal(result.ok, true, result.error);
      assert.equal((await store.get(item!.inbox_item_id))?.state, "blocked", "and it still waits for its owner");
      await within(env.daemon.waitForHandoff(), "compatible handoff");
    }
  } finally { await env.cleanup(); }
});

for (const scenario of [
  { name: "stopped absent", desired: "stopped", custody: "absent", installed: false, allowed: true },
  { name: "paused absent", desired: "paused", custody: "absent", installed: false, allowed: true },
  { name: "stopped owned", desired: "stopped", custody: "owned", installed: true, allowed: false },
  { name: "paused owned", desired: "paused", custody: "owned", installed: true, allowed: false },
  { name: "unknown custody", desired: "stopped", custody: "unknown", installed: false, allowed: false },
  { name: "failed installation", desired: "stopped", custody: "owned", installed: false, allowed: false },
  { name: "mismatched custody", desired: "stopped", custody: "mismatched", installed: true, allowed: false },
  { name: "recovering absent", desired: "running", observed: "recovering", custody: "absent", installed: false, allowed: true },
  { name: "working absent", desired: "running", observed: "working", custody: "absent", installed: false, allowed: true },
  { name: "recovering retired", desired: "running", observed: "recovering", custody: "retired", installed: false, allowed: true },
  { name: "working retired handle", desired: "running", observed: "working", custody: "retired", installed: true, allowed: true },
  { name: "working owned", desired: "running", observed: "working", custody: "owned", installed: true, allowed: false },
  { name: "recovering unknown", desired: "running", observed: "recovering", custody: "unknown", installed: false, allowed: false },
  { name: "recovering mismatched retired", desired: "running", observed: "recovering", custody: "mismatched_retired", installed: false, allowed: false },
  { name: "working absent with installed handle", desired: "running", observed: "working", custody: "absent", installed: true, allowed: false },
  { name: "cleared ref retired", desired: "running", observed: "starting", custody: "retired", installed: false, clearedRef: true, allowed: true },
  { name: "cleared ref wrong retired attempt", desired: "running", custody: "wrong_attempt_retired", installed: false, clearedRef: true, allowed: false },
  { name: "cleared ref retired with handle", desired: "running", custody: "retired", installed: true, clearedRef: true, allowed: false },
  { name: "cleared ref retired with stale observation", desired: "running", custody: "retired", installed: true, clearedRef: true, staleObservation: true, allowed: true },
  { name: "cleared ref owned", desired: "running", custody: "owned", installed: false, clearedRef: true, allowed: false },
  { name: "cleared ref unknown", desired: "running", custody: "unknown", installed: false, clearedRef: true, allowed: false },
] as const) test(`provider-aware handoff preserves historical Cursor ambiguity: ${scenario.name}`, async () => {
  const env = await observationDaemonFixture((_handle, listener) => new ProviderExecutionObserver(() => new Date().toISOString()).subscribe(listener), "cursor", {
    runtimeCustody: () => scenario.custody === "wrong_attempt_retired"
      ? { state: "retired", handle: { ...env.handle, workAttemptId: "another-attempt" } }
      : scenario.custody === "mismatched" || scenario.custody === "mismatched_retired"
      ? { state: scenario.custody === "mismatched" ? "owned" : "retired", handle: { ...env.handle, providerContinuationId: "another-continuation" } }
      : scenario.custody === "owned" || scenario.custody === "retired" ? { state: scenario.custody, handle: env.handle } : { state: scenario.custody },
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
  });
  try {
    const current = (await env.internals.store.getEntry(env.id))!;
    assert.equal((await daemonRequest(env.paths.socketPath, "manifest.put", { entry: {
      ...current, desired_state: scenario.desired, observed_state: "observed" in scenario ? scenario.observed : scenario.desired,
    } })).ok, true);
    env.handle.observedState = "observed" in scenario ? scenario.observed : "idle";
    if (scenario.installed) await env.internals.providerStreams.install(env.id, env.handle, env.generation);
    const [item] = await env.internals.supervisedInbox.ingestPoll({ agent_id: env.id, room_id: "room_1", last_observed_message_id: "31",
      messages: [{ source_message_id: "31", source_message: { text: "historical work" }, activation: {} }] });
    await env.internals.supervisedInbox.claimHead(env.id);
    await env.internals.supervisedInbox.checkpointDispatchIntent(item!.inbox_item_id);
    await env.internals.supervisedInbox.transition(item!.inbox_item_id, "blocked", { last_error: "historical dispatch is unknown" });
    await env.internals.durability.recordTerminal(env.handle.workAttemptId, env.generation, {
      actor: "daemon-provider", generation: 1, ended_at: new Date().toISOString(), exit_code: 0, signal: null,
      stdio_archive_ref: null, stdio_tail: "", terminal_cause: "stopped", provider_continuation_id: env.handle.providerContinuationId,
    });
    assert.equal(current.provider_ref?.provider_connection?.pid, null);
    const before = await env.internals.supervisedInbox.get(item!.inbox_item_id);
    assert.equal(before?.provider_turn_id, null);
    assert.equal(before?.attempt_count, 0);
    assert.equal(await env.internals.supervisedInbox.providerTurnBinding(item!.inbox_item_id), null);
    const readHistory = () => {
      const db = new DatabaseSync(env.paths.manifestPath, { readOnly: true });
      try { return db.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(item!.inbox_item_id); }
      finally { db.close(); }
    };
    const history = readHistory();
    if ("observed" in scenario) {
      await (env.daemon as unknown as { updateManifestEntry(id: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry): Promise<unknown> })
        .updateManifestEntry(env.id, value => ({ ...value, observed_state: scenario.observed }));
      assert.equal((await env.internals.store.getEntry(env.id))?.observed_state, scenario.observed);
    }
    if ("clearedRef" in scenario) {
      await (env.daemon as unknown as { updateManifestEntry(id: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry): Promise<unknown> })
        .updateManifestEntry(env.id, value => ({ ...value, provider_ref: null, run_id: null, deployment_id: null }));
    }
    if ("staleObservation" in scenario) {
      env.internals.liveHandles.delete(env.id);
      assert.equal(env.internals.providerStreams.currentInstallation(env.id), undefined,
        "a retained observation without its live handle is not a current installation");
    }
    const result = await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff");
    assert.equal(result.ok, scenario.allowed, result.error);
    if (scenario.allowed) await within(env.daemon.waitForHandoff(), "retirement with historical work preserved");
    else {
      assert.match(result.error ?? "", /Update deferred/);
      assert.ok(result.error?.includes(env.id), "refusal identifies the exact entry");
      assert.ok(result.error?.includes(current.display_name), "refusal names the agent");
      if (scenario.custody === "unknown") assert.match(result.error ?? "", /custody: unknown/);
      if (scenario.name === "working owned") assert.match(result.error ?? "", /state: working/);
      assert.equal((await daemonRequest(env.paths.socketPath, "daemon.status")).ok, true);
      assert.equal((env.daemon as unknown as { handoffDraining: boolean }).handoffDraining, false);
    }
    assert.deepEqual(readHistory(), history, "handoff never settles or rewrites the historical uncertainty");
  } finally { await env.cleanup(); }
});

for (const stage of ["before_native_attach", "native_attach", "attach_error"] as const) test(`provider-aware handoff fences direct attachment: ${stage}`, async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  let acquired = false;
  const env = await observationDaemonFixture((_handle, listener) => new ProviderExecutionObserver(() => new Date().toISOString()).subscribe(listener), "claude-code", {
    runtimeCustody: () => acquired ? { state: "owned", handle: env.handle } : { state: "absent" },
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
    attach: async () => {
      calls++;
      entered(); await gate;
      if (stage === "attach_error") throw new Error("attachment unavailable");
      acquired = true;
      return env.handle;
    },
  });
  const internal = env.daemon as unknown as {
    handoffDraining: boolean;
    providerExecution: { attachLiveProvider(entry: DaemonManifestEntry): Promise<ProviderActionHandle | null> };
  };
  let attaching: Promise<ProviderActionHandle | null> | undefined;
  try {
    const current = (await env.internals.store.getEntry(env.id))!;
    if (stage === "before_native_attach") {
      const original = env.internals.store.unresolvedDeliveryDrain.bind(env.internals.store);
      env.internals.store.unresolvedDeliveryDrain = async id => { entered(); await gate; return original(id); };
    }
    attaching = internal.providerExecution.attachLiveProvider(current);
    void attaching.catch(() => undefined);
    await within(started, "direct attachment admitted");
    let settled = false;
    const handoff = daemonRequest(env.paths.socketPath, "daemon.prepare_handoff").then(result => { settled = true; return result; });
    await eventually(async () => internal.handoffDraining || settled, "handoff admission closes");
    assert.equal(settled, false, "retirement waits for already-admitted attachment");
    assert.equal(await internal.providerExecution.attachLiveProvider(current), null, "new direct attachment is fenced");
    assert.equal(calls, stage === "before_native_attach" ? 0 : 1);
    release();
    if (stage === "attach_error") await assert.rejects(attaching, /attachment unavailable/);
    else assert.equal(await attaching, stage === "before_native_attach" ? null : env.handle);
    const result = await handoff;
    if (stage === "native_attach") {
      assert.equal(result.ok, false, "an acquired working connection keeps its daemon alive");
      assert.equal(internal.handoffDraining, false);
      env.handle.observedState = "idle";
      assert.equal((await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff")).ok, true, "deferral reopens and a later idle boundary can retire");
    } else assert.equal(result.ok, true, result.error);
    await within(env.daemon.waitForHandoff(), "attachment boundary handoff");
    assert.equal(calls, stage === "before_native_attach" ? 0 : 1);
  } finally { release(); await attaching?.catch(() => undefined); await env.cleanup(); }
});

for (const kind of ["lifecycle", "turn_control"] as const) for (const custody of ["absent", "retired"] as const) test(`provider-aware handoff preserves admitted ${kind} with ${custody} custody`, async () => {
  let custodyReads = 0;
  const env = await observationDaemonFixture((_handle, listener) => new ProviderExecutionObserver(() => new Date().toISOString()).subscribe(listener), "cursor", {
    runtimeCustody: () => { custodyReads++; return custody === "absent" ? { state: "absent" } : { state: "retired", handle: env.handle }; },
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
  });
  const gate = (env.daemon as unknown as { entryConcurrency: { beginLifecycle(id: string): () => void; beginTurnControl(id: string): () => void } }).entryConcurrency;
  const release = kind === "lifecycle" ? gate.beginLifecycle(env.id) : gate.beginTurnControl(env.id);
  try {
    const result = await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /active native control operation/);
    assert.ok(result.error?.includes(env.id));
    assert.equal(custodyReads, 0, "admitted native control remains authoritative before a custody snapshot");
    release();
    assert.equal((await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff")).ok, true);
    await within(env.daemon.waitForHandoff(), "admitted control finishes");
  } finally { release(); await env.cleanup(); }
});

test("provider-aware handoff defers when both handle caches predate the manifest generation", async () => {
  const env = await observationDaemonFixture((_handle, listener) => new ProviderExecutionObserver(() => new Date().toISOString()).subscribe(listener), "claude-code", {
    runtimeCustody: () => ({ state: "owned", handle: env.handle }),
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
  });
  try {
    env.handle.observedState = "idle";
    await env.internals.providerStreams.install(env.id, env.handle, env.generation);
    const current = (await env.internals.store.getEntry(env.id))!;
    const [item] = await env.internals.supervisedInbox.ingestPoll({ agent_id: env.id, room_id: "room_1", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "older turn" }, activation: {} }] });
    await env.internals.supervisedInbox.claimHead(env.id);
    await env.internals.supervisedInbox.checkpointTurnStarted(item!.inbox_item_id, "old-turn", {
      work_attempt_id: env.handle.workAttemptId, origin_execution_generation_id: env.generation,
      provider_continuation_id: env.handle.providerContinuationId!,
    });
    await env.internals.supervisedInbox.transition(item!.inbox_item_id, "blocked", { last_error: "unknown old turn" });
    await env.internals.durability.recordTerminal(env.handle.workAttemptId, env.generation, {
      actor: "daemon-provider", generation: 1, ended_at: new Date().toISOString(), exit_code: 0, signal: null,
      stdio_archive_ref: null, stdio_tail: "", terminal_cause: "stopped", provider_continuation_id: env.handle.providerContinuationId,
    });
    const successor = await env.internals.durability.startGeneration(env.handle.workAttemptId, "daemon-provider", 2);
    await (env.daemon as unknown as { updateManifestEntry(id: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry): Promise<unknown> })
      .updateManifestEntry(env.id, value => ({ ...value, run_id: successor.execution_generation_id,
        deployment_id: serializeDaemonDeploymentId(env.id, successor.execution_generation_id),
        provider_ref: { ...value.provider_ref!, execution_generation_id: successor.execution_generation_id } }));
    assert.equal((await env.internals.store.getEntry(env.id))?.provider_ref?.execution_generation_id, successor.execution_generation_id);
    const result = await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff");
    assert.equal(result.ok, false, "matching stale caches cannot authorize retirement using the successor's generation");
    assert.match(result.error ?? "", /native connection could not be confirmed/);
    assert.equal((await env.internals.supervisedInbox.get(item!.inbox_item_id))?.state, "blocked");
  } finally { await env.cleanup(); }
});

test("provider-aware handoff retains router custody after stream installation fails and recovers after repair", async () => {
  const adapter = {
    capabilities: () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
    attach: async () => ({ workAttemptId: env.handle.workAttemptId, pid: env.handle.pid,
      providerContinuationId: env.handle.providerContinuationId, providerConnection: env.handle.providerConnection,
      observedState: () => env.handle.observedState }),
  } as unknown as NativeProviderAdapter;
  const router = new ProviderActionPortRouter({ "claude-code": async () => adapter });
  const env = await observationDaemonFixture((_handle, listener) => new ProviderExecutionObserver(() => new Date().toISOString()).subscribe(listener), "claude-code", {
    capabilities: router.capabilities.bind(router), runtimeCustody: router.runtimeCustody.bind(router), attach: router.attach.bind(router),
    onStream: async () => { throw new Error("stream installation failed"); },
  });
  const internal = env.daemon as unknown as { providerExecution: { attachLiveProvider(entry: DaemonManifestEntry): Promise<ProviderActionHandle | null> }; handoffDraining: boolean };
  try {
    env.handle.observedState = "idle";
    const current = (await env.internals.store.getEntry(env.id))!;
    await assert.rejects(internal.providerExecution.attachLiveProvider(current), /stream installation failed/);
    assert.equal(env.internals.liveHandles.has(env.id), false);
    assert.equal(router.runtimeCustody(env.handle.workAttemptId, "claude-code").state, "owned");
    const result = await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff");
    assert.equal(result.ok, false, "failed stream setup cannot hide native custody");
    assert.match(result.error ?? "", /native connection could not be confirmed/);
    assert.equal(internal.handoffDraining, false);
    env.port.onStream = async () => () => {};
    assert.ok(await internal.providerExecution.attachLiveProvider(current));
    assert.equal((await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff")).ok, true);
    await within(env.daemon.waitForHandoff(), "repaired custody retires without a poisoned dispatch reservation");
  } finally { await env.cleanup(); }
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
    await within(handoff, "handoff completion after authority cleanup", DAEMON_LIFECYCLE_HANG_GUARD_MS);
    assert.equal(internals.providerStreams.callbacks.size, 0, "handoff detaches wedged callbacks instead of waiting for them");
    second = new SupervisorDaemon(paths, "darwin");
    await within((async () => {
      while (true) {
        try { await second!.start(); return; }
        catch (error) {
          if (!(error instanceof DaemonAlreadyRunningError)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    })(), "replacement daemon authority after handoff", DAEMON_LIFECYCLE_HANG_GUARD_MS);
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
    await assert.rejects(within(handoff, "failed handoff completion", DAEMON_LIFECYCLE_HANG_GUARD_MS), /handoff cleanup did not complete cleanly/i);

    // Check each authority directly once the failed handoff settles, rather
    // than inferring release from how quickly a replacement daemon starts.
    assert.throws(() => (first as unknown as { singleton: DaemonSingleton }).singleton.currentGeneration, DaemonFenceLostError);
    await assert.rejects(stat(paths.socketPath), { code: "ENOENT" });
    const probe = new DatabaseSync(paths.manifestPath);
    try {
      // Without a busy wait, a write lock still held by the failed daemon fails here at once.
      probe.exec("PRAGMA busy_timeout = 0");
      assert.doesNotThrow(() => probe.exec("BEGIN IMMEDIATE"), "the failed daemon released the SQLite write lock");
      probe.exec("ROLLBACK");
    } finally { probe.close(); }

    second = new SupervisorDaemon(paths, "darwin");
    await within(second.start(), "replacement authority after failed observer cleanup", DAEMON_LIFECYCLE_HANG_GUARD_MS);
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
    // The entrypoint loads through tsx, which nears 2 s while the other
    // daemon test files start in parallel.
    await eventually(async () => {
      try {
        return (await daemonRequest(socketPath, "daemon.status")).ok;
      } catch {
        // The entrypoint is still acquiring its singleton and SQLite state.
        return false;
      }
    }, "daemon entrypoint startup", 10_000);
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
  const waitForMessage = (type: string, timeoutMs = 2_000) => within(new Promise<Record<string, unknown>>((resolve) => {
    const listener = (message: unknown) => {
      if ((message as { type?: string })?.type !== type) return;
      child.off("message", listener);
      resolve(message as Record<string, unknown>);
    };
    child.on("message", listener);
  }), `child message ${type}`, timeoutMs);
  try {
    // The child loads the daemon through tsx before it reports ready. That
    // cold start nears 2 s while the other daemon test files start in
    // parallel, so the bound only catches a child that never starts.
    const ready = await waitForMessage("ready", 10_000);
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
    await within(handoff, "barrier-fenced handoff", DAEMON_LIFECYCLE_HANG_GUARD_MS);

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
    await within(handoff, "host approval handoff", DAEMON_LIFECYCLE_HANG_GUARD_MS);
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
    ...noWorkLeaseHttp,
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
  const calls = { attach: 0, spawn: 0, resume: 0, stop: 0, converge: 0, delegationSync: 0 };
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
      executionDelegations: { request(entryId: string): void };
    };
    internals.requestConvergence = () => { calls.converge += 1; };
    internals.executionDelegations.request = (entryId) => {
      assert.equal(entryId, "recovery_authority_dead_provider");
      calls.delegationSync += 1;
    };
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
    assert.deepEqual(calls, { attach: 0, spawn: 0, resume: 0, stop: 0, converge: 0, delegationSync: 1 });
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});
