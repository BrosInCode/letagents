import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { ManifestStore } from "../manifest-store.js";
import { SupervisorGrantRequestError } from "../cloud-http.js";
import {
  listActiveRoomMoveEffectsForAgent,
  listEffectsForAgent,
  ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND,
  ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
  ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND,
} from "../effect-journal/index.js";
import type { DaemonStateDatabase } from "../daemon-state-database.js";
import { type DaemonManifestEntry, type DaemonManifestEntryView, type DaemonRoomMoveRecord } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { WorkerRuntimeCustody, type InstalledHostGrant } from "../worker-runtime-custody.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { type SupervisedDeliveryHttp } from "../supervised-agent-delivery.js";
import type { ProviderActionPort } from "../provider-action-port.js";
import {
  runtimeReadySubscription,
  SupervisorDaemon,
  execFileAsync,
  noWorkLeaseHttp,
  fixture,
  within,
  eventually,
  daemonRequest,
  flushActivity,
  entry, testDaemonEndpoint } from "./helpers/daemon-fixture.js";
import { testNamedDaemonEndpoint, assertOwnerPrivate } from "../../electron/__tests__/platform.js";

test("generation handoff reattaches the same provider and publishes its supervised native stream to the exact worker endpoint", async () => {
  const env = await fixture();
  const nativeRequests: Array<{ headers: import("node:http").IncomingHttpHeaders; body: any }> = [];
  let rejectNativeActivity = false;
  const nativeServer = createHttpServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { raw += chunk; });
    request.on("end", async () => {
      const body = JSON.parse(raw);
      nativeRequests.push({ headers: request.headers, body });
      if (body.method === "turn/same-millisecond-a") await new Promise((resolve) => setTimeout(resolve, 30));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: !rejectNativeActivity, presence: { status: "working" }, lease_heartbeats: rejectNativeActivity ? [] : [{ id: "lease_exact", epoch: 7 }] }));
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
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  let child: ChildProcess | null = null;
  const continuation = "thread-durable";
  let deliveryPolls = 0;
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
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (request) => {
      workAttemptId = request.workAttemptId;
      launchChild();
      return { ...handle(), workAttemptId };
    },
    attach: async (ref) => child?.pid && ref.providerContinuationId === continuation
      ? { ...handle(), workAttemptId: ref.workAttemptId }
      : null,
    attachAction: async () => ({ state: "absent" }),
    resume: async (ref) => {
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
    onExecution: (providerHandle, listener) => runtimeReadySubscription(providerHandle, listener),
    runRoomTurn: async () => ({ turnId: "unused-room-turn", outcome: "no_reply", text: null }),
  });
  const deliveryHttp: SupervisedDeliveryHttp = {
    latest: async () => ({ messages: [] }),
    poll: ({ signal }) => new Promise((resolve) => {
      deliveryPolls += 1;
      if (signal.aborted) resolve({ messages: [] });
      else signal.addEventListener("abort", () => resolve({ messages: [] }), { once: true });
    }),
    publish: async () => {},
  };
  const grantHttp = {
    ...noWorkLeaseHttp,
    createWorkerSession: async () => ({
      sessionId: "agent_session_exact",
      bearer: "session-secret",
      bearerId: "bearer_id_exact",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
  };
  const installGrant = async (bootstrap = true) => {
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_key: "owner/supervised_handoff",
      grant_id: `grant_handoff_${generation}`, supervisor_grant: "grant-secret-handoff",
      grant_generation: generation, api_url: apiUrl, daemon_generation: generation,
      host_id: "host-test", installation_id: "installation-test", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    if (bootstrap) {
      assert.equal((await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
        entry_id: "supervised_handoff", daemon_generation: generation,
      })).ok, true);
    }
  };

  const first = new SupervisorDaemon(paths, "darwin", port(), true, 2_000, undefined, {}, deliveryHttp, grantHttp);
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "supervised_handoff", room_id: "focus_37", provider: "codex", observed_state: "absent",
      source_repo_path: source, workspace_path: null, work_attempt_id: null,
      provider_launch_policy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    } });
    await installGrant(true);
    try {
      await eventually(async () => {
        const current = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]);
        return current?.observed_state === "idle"
          && current.worker_binding?.agent_session_id === "agent_session_exact"
          && current.last_worker_binding?.agent_session_id === "agent_session_exact";
      }, "daemon-owned provider start", 8_000);
    } catch (error) {
      const state = (await daemonRequest(paths.socketPath, "manifest.list")).result;
      throw new Error(`${(error as Error).message}: ${JSON.stringify(state)}`);
    }
    const before = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    const originalPid = before.provider_ref?.provider_connection?.pid;
    const executionGenerationId = before.provider_ref?.execution_generation_id!;
    assert.equal(originalPid, child?.pid);
    assert.equal(before.worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(before.worker_binding?.work_attempt_id, workAttemptId);
    assert.equal(before.worker_binding?.execution_generation_id, executionGenerationId);
    assert.equal(before.last_worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(before.workplace_liveness?.state, "reachable", "fresh exact binding marks the MCP workplace reachable");
    assert.doesNotMatch(JSON.stringify(before), /session-secret|api_url/, "renderer projection never exposes worker authority");
    await daemonRequest(paths.socketPath, "manifest.update_workplace_liveness", {
      id: "supervised_handoff",
      state: "reachable",
      detail: "original bind timestamp",
      observed_at: "2026-01-01T00:00:00.000Z",
    });
    const heartbeatProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(heartbeatProjection.workplace_liveness?.state, "reachable", "fresh exact binding outranks the old manifest bind timestamp");
    assert.equal(heartbeatProjection.workplace_liveness?.observed_at, heartbeatProjection.worker_binding?.updated_at);
    await eventually(async () => nativeRequests.some((request) => request.body.method === "native_harness.bound"), "initial daemon worker binding activity");
    const initialBindingPublication = nativeRequests.find((request) => request.body.method === "native_harness.bound")!;
    assert.equal(initialBindingPublication.headers.authorization, "Bearer session-secret");
    assert.equal(initialBindingPublication.body.agent_session_id, undefined);
    assert.equal(initialBindingPublication.body.agent_session_token, undefined,
      "the scoped bearer travels only in the Authorization header");

    const deliveryRecoveryInternals = first as unknown as {
      supervisedDelivery: { stop: (entryId: string) => Promise<void> };
    };
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
      return current.condition === "none";
    }, "credential handoff latch self-heal");
    const recoveredFromStaleHandoff = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(recoveredFromStaleHandoff.condition, "none");
    assert.equal(recoveredFromStaleHandoff.last_error ?? null, null);
    assert.equal(recoveredFromStaleHandoff.workplace_liveness?.detail, "scoped worker bearer verified");
    assert.ok(recoveredFromStaleHandoff.ready_reached_at);
    await eventually(async () => deliveryPolls > 0, "credential recovery resumes daemon inbox polling");
    await deliveryRecoveryInternals.supervisedDelivery.stop("supervised_handoff");
    const firstBindReader = new ManifestStore(paths.manifestPath);
    const manifestAfterFirstBind = await firstBindReader.load();
    await firstBindReader.close();
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
    const repeatedBindReader = new ManifestStore(paths.manifestPath);
    const manifestAfterRepeatedBind = await repeatedBindReader.load();
    await repeatedBindReader.close();
    assert.equal(
      manifestAfterRepeatedBind.versions["supervised_handoff"],
      manifestAfterFirstBind.versions["supervised_handoff"],
      "an unchanged exact binding performs no full manifest commit",
    );
    assert.equal(
      manifestAfterRepeatedBind.entries.find((candidate) => candidate.id === "supervised_handoff")?.workplace_liveness?.observed_at,
      workplaceObservedAtAfterFirstBind,
      "an unchanged exact binding does not refresh manifest liveness or request another manifest write",
    );
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
    const formalCursorAttempt = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: Array<{ room_cursor: string | null }> };
    assert.equal(formalCursorAttempt.checkpoints.at(-1)?.room_cursor, "msg_2820", "durable attempt progress follows the same serialized no-regression order");
    const checkpointsBeforeNoop = formalCursorAttempt.checkpoints.length;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_2820",
    })).ok, true);
    const checkpointsAfterNoop = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: unknown[] }).checkpoints.length;
    assert.equal(checkpointsAfterNoop, checkpointsBeforeNoop, "an unchanged poll cursor appends no durability checkpoint");
    await assertOwnerPrivate(paths.manifestPath, "file");
    await assert.rejects(() => readFile(paths.workerBindingsPath, "utf8"), { code: "ENOENT" });
    assert.doesNotMatch(JSON.stringify((await daemonRequest(paths.socketPath, "manifest.list")).result), /session-secret/);
    const nativeCanary = "canary-not-a-real-native-secret-123456789";
    const nativeInternals = first as unknown as {
      publishNativeActivity: (entryId: string, method: string, status: "working" | "idle", observedAt?: string) => Promise<boolean>;
    };
    await nativeInternals.publishNativeActivity("supervised_handoff", `tool Authorization: Bearer ${nativeCanary}`, "working");
    const canaryPublication = nativeRequests.at(-1)!;
    assert.doesNotMatch(JSON.stringify(canaryPublication.body), new RegExp(nativeCanary));
    assert.match(canaryPublication.body.method, /REDACTED/);

    const sameObservedAt = new Date().toISOString();
    await nativeInternals.publishNativeActivity("supervised_handoff", "turn/same-millisecond-a", "working", sameObservedAt);
    await nativeInternals.publishNativeActivity("supervised_handoff", "turn/same-millisecond-b", "working", sameObservedAt);
    await nativeInternals.publishNativeActivity("supervised_handoff", "turn/reordered-older", "working", new Date(Date.parse(sameObservedAt) - 60_000).toISOString());
    const orderedPublications = ["turn/same-millisecond-a", "turn/same-millisecond-b", "turn/reordered-older"]
      .map((method) => nativeRequests.find((request) => request.body.method === method)!.body);
    for (let index = 1; index < orderedPublications.length; index += 1) {
      assert.ok(orderedPublications[index]!.sequence > orderedPublications[index - 1]!.sequence);
      assert.ok(Date.parse(orderedPublications[index]!.observed_at) > Date.parse(orderedPublications[index - 1]!.observed_at));
    }
    const lastFirstSequence = orderedPublications.at(-1)!.sequence;

    await first.stop();
    assert.doesNotThrow(() => process.kill(originalPid!, 0), "provider survives daemon handoff");
    second = new SupervisorDaemon(paths, "darwin", port(), true, 2_000, undefined, {}, deliveryHttp, grantHttp);
    await second.start();
    const replacementDaemonGeneration = Number(((await daemonRequest(paths.socketPath, "daemon.negotiate")).result as { generation: number }).generation);
    const retiredCredential = await daemonRequest(paths.socketPath, "supervisor.borrow_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId,
      daemon_generation: replacementDaemonGeneration, api_url: apiUrl,
    });
    assert.deepEqual(retiredCredential.result, { status: "deferred" },
      "the replacement retains the exact public route but cannot borrow the retired daemon's credential");
    const installedCredential = await daemonRequest(paths.socketPath, "supervisor.install_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      agent_session_token: "desktop-delivered-successor-secret", daemon_generation: replacementDaemonGeneration,
    });
    assert.equal((installedCredential.result as { status: string }).status, "installed");
    const borrowedCredential = await daemonRequest(paths.socketPath, "supervisor.borrow_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      daemon_generation: replacementDaemonGeneration, api_url: apiUrl,
    });
    assert.deepEqual(borrowedCredential.result, { status: "available", credential: "desktop-delivered-successor-secret" });
    const crossOriginBorrow = await daemonRequest(paths.socketPath, "supervisor.borrow_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      daemon_generation: replacementDaemonGeneration, api_url: "https://attacker.invalid",
    });
    assert.deepEqual(crossOriginBorrow.result, { status: "stale" }, "credential borrowing is bound to the registered API origin");

    await installGrant(false);
    await eventually(async () => streamListeners.size === 1, "replacement native stream subscription");
    await daemonRequest(paths.socketPath, "manifest.update_workplace_liveness", {
      id: "supervised_handoff",
      state: "unknown",
      detail: "replacement daemon awaiting exact persisted bind",
      observed_at: new Date().toISOString(),
    });

    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    })).ok, true);
    const after = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(after.provider_ref?.provider_connection?.pid, originalPid);
    assert.equal(after.provider_ref?.provider_continuation_id, continuation);
    assert.equal(after.work_attempt_id, workAttemptId);
    assert.equal(after.provider_ref?.execution_generation_id, executionGenerationId,
      "handoff reattaches the same live execution generation instead of minting a replacement");
    assert.equal(after.worker_binding?.agent_session_id, "agent_session_exact", "daemon handoff preserves the public exact-session projection");
    assert.equal(after.workplace_liveness?.state, "reachable", "idempotent persisted bind restores workplace reachability after daemon replacement");

    const secondNativeInternals = second as unknown as {
      publishNativeActivity: (entryId: string, method: string, status: "working" | "idle") => Promise<boolean>;
      transition: (entryId: string, observed: "recovering", condition: "coordination_blocked", cause: string, actor: string) => Promise<void>;
    };
    await secondNativeInternals.publishNativeActivity("supervised_handoff", "turn/after-handoff", "idle");
    const afterHandoffPub = nativeRequests.find((request) => request.body.method === "turn/after-handoff")!;
    assert.ok(afterHandoffPub.body.sequence > lastFirstSequence, "durable publisher sequence survives daemon generation handoff");

    rejectNativeActivity = true;
    await assert.rejects(
      () => secondNativeInternals.publishNativeActivity("supervised_handoff", "turn/rejected-for-successor", "working"),
      /stale daemon observation/,
    );
    await eventually(async () => (await new WorkerBindingStore(paths.workerBindingsPath, undefined, paths.manifestPath).get("supervised_handoff")) === null, "stale worker binding removal");
    const requestsAfterFence = nativeRequests.length;
    await secondNativeInternals.publishNativeActivity("supervised_handoff", "turn/must-not-publish-after-fence", "working");
    assert.equal(nativeRequests.length, requestsAfterFence, "successor rejection fences later native publications");

    await secondNativeInternals.transition("supervised_handoff", "recovering", "coordination_blocked", "lost current worker binding during exact-generation recovery", "test-recovery");
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

    rejectNativeActivity = false;
    const wrongAttemptBind = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_unrelated",
      work_attempt_id: randomUUID(), execution_generation_id: executionGenerationId,
      agent_session_token: "unrelated-secret", api_url: apiUrl,
    });
    assert.equal(wrongAttemptBind.ok, false, "another work attempt cannot bind through a copied stable context");
    assert.match(wrongAttemptBind.error ?? "", /work attempt/);
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    })).ok, true);
    const recoveredProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(recoveredProjection.condition, "none", "exact worker rebind clears the coordination latch");
    assert.equal(recoveredProjection.worker_binding?.execution_generation_id, executionGenerationId);

    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "stopped" });
    await eventually(async () => !child?.pid || (() => { try { process.kill(child.pid!, 0); return false; } catch { return true; } })(), "daemon stop authority");
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "stopped"), "intentional stop");
    const stoppedProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(stoppedProjection.worker_binding, null, "stopped terminal generation is not projected as live worker authority");
    assert.equal(stoppedProjection.last_worker_binding?.agent_session_id, "agent_session_exact", "stop preserves the non-secret exact control route");
    const staleBind = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_stale",
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId,
      agent_session_token: "stale-secret", api_url: apiUrl,
    });
    assert.equal(staleBind.ok, false, "a terminal predecessor generation cannot bind a worker session");
    assert.match(staleBind.error ?? "", /terminal|active supervised manifest entry/);
  } finally {
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
    ...testNamedDaemonEndpoint(env.root, "room-move-lost-response"),
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
  let now = Date.parse("2026-08-27T09:00:00.000Z");
  const clock = { nowMs: () => now };
  const daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, clock, deliveryHttp);
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

    // Durable retry backoff blocks immediate replay before the retry deadline.
    move = await internals.reconcileRoomMove(move);
    assert.equal(joinAttempts, 1);
    assert.equal(move.phase, "joining_destination");

    now += 1_000;
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
    ...testNamedDaemonEndpoint(env.root, "move-handoff"),
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
    ...testNamedDaemonEndpoint(env.root, "queued-move"),
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
    ...testNamedDaemonEndpoint(env.root, "ambiguous"),
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
    ...testNamedDaemonEndpoint(env.root, "room-move-alias"),
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
    ...testNamedDaemonEndpoint(env.root, "room-move"),
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
  let now = Date.parse("2026-08-27T09:30:00.000Z");
  const clock = { nowMs: () => now };
  let daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, clock, deliveryHttp);
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
    daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, clock, deliveryHttp);
    await daemon.start();
    internals = daemon as unknown as Internals;
    assert.equal((await internals.store.getRoomMove("move_rollback"))?.phase, "rollback_required");
    await bind(daemon, "destination-room");
    rejectSourceJoin = false;

    // Durable retry deadline survives daemon restart and prevents immediate replay at the same timestamp.
    await internals.reconcileRoomMove((await internals.store.getRoomMove("move_rollback"))!);
    assert.equal(joinCalls, 1);
    now += 1_000;

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

async function createLiveRoomMoveRetryDaemon(options: {
  id: string;
  joinRoom: NonNullable<SupervisedDeliveryHttp["joinRoom"]>;
  latest?: SupervisedDeliveryHttp["latest"];
  createWorkerSession?: (input: { roomId: string }) => Promise<{
    sessionId: string;
    bearer: string;
    bearerId: string;
    expiresAt: string;
  }>;
}) {
  const env = await fixture();
  const nativeServer = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true, presence: { status: "idle" }, lease_heartbeats: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    nativeServer.once("error", reject);
    nativeServer.listen(0, "127.0.0.1", resolve);
  });
  const apiUrl = `http://127.0.0.1:${(nativeServer.address() as AddressInfo).port}`;
  const source = join(env.root, "source");
  await mkdir(source);
  await execFileAsync("git", ["init", source]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
  await writeFile(join(source, "README.md"), "room-move-retry\n");
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", source, "remote", "add", "origin", source]);

  const paths = {
    lockPath: join(env.root, `${options.id}.lock`),
    ...testNamedDaemonEndpoint(env.root, options.id),
    manifestPath: join(env.root, `${options.id}.sqlite`),
    auditPath: join(env.root, `${options.id}-audit.jsonl`),
    attemptsPath: join(env.root, `${options.id}-attempts.json`),
    attemptsRoot: join(env.root, `${options.id}-attempt-data`),
    workspaceRoot: env.root,
    workerBindingsPath: join(env.root, `${options.id}-bindings.json`),
  };

  let handle: import("../provider-action-port.js").ProviderActionHandle | null = null;
  const exitListeners = new Set<(terminal: import("../provider-action-port.js").ProviderActionTerminal) => void>();
  const port: ProviderActionPort = {
    capabilities: async () => ({
      resume: true,
      midTurnInjection: false,
      transcriptAccess: true,
      permissionPromptBridging: false,
      survivesRestart: true,
    }),
    spawn: async (req) => {
      handle = {
        workAttemptId: req.workAttemptId,
        pid: process.pid,
        providerContinuationId: `cont-${options.id}`,
        providerConnection: {
          kind: "codex_app_server",
          url: "ws://127.0.0.1:65534",
          pid: process.pid,
          processIdentity: `fixture:${options.id}:${process.pid}`,
        },
        appliedConfigurationRevision: req.configurationRevision,
        observedState: "idle",
      };
      return handle;
    },
    attach: async () => handle,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => handle!,
    poke: async () => {},
    stop: async () => {
      const terminal = {
        endedAt: new Date().toISOString(),
        exitCode: 0,
        signal: null,
        terminalCause: "stopped" as const,
        providerContinuationId: `cont-${options.id}`,
      };
      handle = null;
      for (const listener of exitListeners) listener(terminal);
      return terminal;
    },
    onExit: async (_providerHandle, listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    onStream: async () => () => {},
    onExecution: (providerHandle, listener) => runtimeReadySubscription(providerHandle, listener),
    runRoomTurn: async () => ({ turnId: "unused-turn", outcome: "no_reply", text: null }),
  };

  const deliveryHttp: SupervisedDeliveryHttp = {
    latest: options.latest ?? (async () => ({ messages: [] })),
    poll: ({ signal }) => new Promise((resolve) => {
      if (signal.aborted) resolve({ messages: [] });
      else signal.addEventListener("abort", () => resolve({ messages: [] }), { once: true });
    }),
    publish: async () => {},
    joinRoom: options.joinRoom,
  };

  const grantHttp = {
    ...noWorkLeaseHttp,
    createWorkerSession: options.createWorkerSession
      ?? (async ({ roomId }: { roomId: string }) => ({
        sessionId: `session_${roomId}`,
        bearer: `bearer_${roomId}`,
        bearerId: `bearer_id_${roomId}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      })),
  };

  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 60_000, undefined, {}, deliveryHttp, grantHttp);
  await daemon.start();
  const generation = Number(((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation);
  assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
    entry: {
      ...entry,
      id: options.id,
      room_id: "source-room",
      provider: "codex",
      observed_state: "absent",
      source_repo_path: source,
      workspace_path: null,
      work_attempt_id: null,
      provider_launch_policy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    },
  })).ok, true);
  assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
    entry_id: options.id,
    room_id: "source-room",
    agent_key: `owner/${options.id}`,
    grant_id: `grant_${options.id}_source`,
    supervisor_grant: "grant-secret-source",
    grant_generation: 1,
    api_url: apiUrl,
    daemon_generation: generation,
    host_id: "host-test",
    installation_id: "installation-test",
    grant_expires_at: "2099-01-01T00:00:00.000Z",
  })).ok, true);
  assert.equal((await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
    entry_id: options.id,
    daemon_generation: generation,
  })).ok, true);
  await eventually(async () => {
    const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0];
    return current?.observed_state === "idle" && current.worker_binding?.agent_session_id === "session_source-room";
  }, `${options.id} ready`, 8_000);

  return {
    daemon,
    paths,
    apiUrl,
    generation,
    internals: daemon as unknown as {
      stateDatabase: DaemonStateDatabase;
      store: ManifestStore;
      supervisedInbox: SupervisedAgentInboxStore;
      providerExecution: {
        request: (entryId: string, kind?: "owned" | "rehydration") => void;
        drainConvergence: () => Promise<void>;
      };
    },
    cleanup: async () => {
      await daemon.stop().catch(() => undefined);
      await new Promise<void>((resolve) => nativeServer.close(() => resolve()));
      await env.cleanup();
    },
  };
}

test("transient 503 destination join retries automatically with zero external requests, rolls back on 403 retry, and purges cleanly (task_23)", async () => {
  const joinEvents: Array<{ roomId: string; status: number }> = [];
  let destAttempts = 0;
  const live = await createLiveRoomMoveRetryDaemon({
    id: "room_move_503_403_purge",
    joinRoom: async ({ roomId }) => {
      if (roomId === "destination-room") {
        destAttempts += 1;
        if (destAttempts === 1) {
          joinEvents.push({ roomId, status: 503 });
          throw new SupervisorGrantRequestError(503, "join room");
        }
        joinEvents.push({ roomId, status: 403 });
        throw new SupervisorGrantRequestError(403, "join room");
      }
      joinEvents.push({ roomId, status: 200 });
      return { roomId };
    },
  });
  try {
    await live.internals.providerExecution.drainConvergence();
    const prep = await daemonRequest(live.paths.socketPath, "supervisor.prepare_room_move", {
      entry_id: "room_move_503_403_purge",
      destination_room_id: "destination-room",
      request_id: "req-503-403",
      daemon_generation: live.generation,
    });
    assert.equal(prep.ok, true, prep.error);
    const operationId = (prep.result as DaemonRoomMoveRecord).operation_id;

    const first = await daemonRequest(live.paths.socketPath, "supervisor.commit_room_move", {
      operation_id: operationId,
      entry_id: "room_move_503_403_purge",
      daemon_generation: live.generation,
    });
    assert.equal(first.ok, true, first.error);
    assert.equal((first.result as DaemonRoomMoveRecord).phase, "joining_destination");
    assert.deepEqual(joinEvents, [{ roomId: "destination-room", status: 503 }]);

    // Zero external requests to the agent: observe only the durable DB directly
    // until the scheduled retry fires (403 -> rollback_required) and automatic
    // source compensation finishes (source-room 200 -> failed).
    const db = live.internals.stateDatabase.connection;
    const [joinBeforeRetry] = listEffectsForAgent(db, "room_move_503_403_purge", {
      kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
    });
    assert.equal(joinBeforeRetry?.state, "prepared");
    assert.ok(joinBeforeRetry?.next_attempt_at_ms !== null);

    await eventually(async () => {
      const move = await live.internals.store.getRoomMove(operationId);
      return move?.phase === "failed";
    }, "automatic 503 -> 403 -> rollback_required -> failed without external requests", 8_000);

    assert.deepEqual(joinEvents, [
      { roomId: "destination-room", status: 503 },
      { roomId: "destination-room", status: 403 },
      { roomId: "source-room", status: 200 },
    ]);
    assert.equal(listActiveRoomMoveEffectsForAgent(db, "room_move_503_403_purge").length, 0);
    const [joinAfter] = listEffectsForAgent(db, "room_move_503_403_purge", {
      kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
    });
    const [rollbackAfter] = listEffectsForAgent(db, "room_move_503_403_purge", {
      kind: ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND,
    });
    assert.equal(joinAfter?.state, "failed");
    assert.equal(rollbackAfter?.state, "completed");
    assert.equal((await live.internals.store.getEntry("room_move_503_403_purge"))?.room_id, "source-room");

    // Stop, retire (2-phase), and purge (2-phase) with zero post-purge joins.
    const joinsBeforePurge = joinEvents.length;
    assert.equal((await daemonRequest(live.paths.socketPath, "manifest.set_desired_state", {
      id: "room_move_503_403_purge",
      desired_state: "stopped",
    })).ok, true);
    await eventually(async () => {
      const current = (await live.internals.store.getEntry("room_move_503_403_purge"))?.observed_state;
      return current === "stopped";
    }, "agent stopped before retire/purge", 5_000);

    const retire1 = await daemonRequest(live.paths.socketPath, "supervisor.retire_agent", {
      entry_id: "room_move_503_403_purge",
      daemon_generation: live.generation,
    });
    assert.equal(retire1.ok, true, retire1.error);
    const retireSessionId = (retire1.result as { agent_session_id?: string }).agent_session_id;
    assert.equal(retireSessionId, "session_source-room");
    const retire2 = await daemonRequest(live.paths.socketPath, "supervisor.retire_agent", {
      entry_id: "room_move_503_403_purge",
      daemon_generation: live.generation,
      revoked_agent_session_id: retireSessionId,
    });
    assert.equal(retire2.ok, true, retire2.error);
    assert.equal((retire2.result as { outcome?: string }).outcome, "retired");

    const purge1 = await daemonRequest(live.paths.socketPath, "supervisor.purge_agent", {
      entry_id: "room_move_503_403_purge",
      daemon_generation: live.generation,
    });
    assert.equal(purge1.ok, true, purge1.error);
    const purgeResult1 = purge1.result as { outcome: string; revocation_kind?: string; agent_session_id?: string };
    const purge2 = purgeResult1.outcome === "purged"
      ? purge1
      : await daemonRequest(live.paths.socketPath, "supervisor.purge_agent", {
        entry_id: "room_move_503_403_purge",
        daemon_generation: live.generation,
        ...(purgeResult1.agent_session_id
          ? { revoked_agent_session_id: purgeResult1.agent_session_id }
          : { grant_revoked_without_worker_session: true }),
      });
    assert.equal(purge2.ok, true, purge2.error);
    assert.equal((purge2.result as { outcome?: string }).outcome, "purged");
    assert.equal(listEffectsForAgent(db, "room_move_503_403_purge").length, 0);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(joinEvents.length, joinsBeforePurge, "purged agent must emit zero post-purge room joins");
  } finally {
    await live.cleanup();
  }
});

test("supervisor.rollback_room_move and install_host_grant do not stall during 503 backoff or credential_only rotation, and tail bootstrap retries automatically (task_23)", async () => {
  // Part A: During 503 retry backoff + concurrent convergence, install_host_grant and rollback_room_move never stall.
  {
    let destAttempts = 0;
    const live = await createLiveRoomMoveRetryDaemon({
      id: "room_move_concurrent_rpcs",
      joinRoom: async ({ roomId }) => {
        if (roomId === "destination-room") {
          destAttempts += 1;
          throw new SupervisorGrantRequestError(503, "join room");
        }
        return { roomId };
      },
    });
    try {
      await live.internals.providerExecution.drainConvergence();
      const prep = await daemonRequest(live.paths.socketPath, "supervisor.prepare_room_move", {
        entry_id: "room_move_concurrent_rpcs",
        destination_room_id: "destination-room",
        request_id: "req-concurrent",
        daemon_generation: live.generation,
      });
      const operationId = (prep.result as DaemonRoomMoveRecord).operation_id;
      const committed = await daemonRequest(live.paths.socketPath, "supervisor.commit_room_move", {
        operation_id: operationId,
        entry_id: "room_move_concurrent_rpcs",
        daemon_generation: live.generation,
      });
      assert.equal(committed.ok, true, committed.error);
      assert.equal((committed.result as DaemonRoomMoveRecord).phase, "joining_destination");
      assert.equal(destAttempts, 1);

      // Explicitly fire provider convergence while the move is in backoff — this
      // previously self-deadlocked EntryConcurrencyGate.run(entryId) via delivery.start.
      live.internals.providerExecution.request("room_move_concurrent_rpcs");
      await within(
        live.internals.providerExecution.drainConvergence(),
        "convergence during pending room move backoff must not deadlock",
        3_000,
      );

      // Both install_host_grant and rollback_room_move must respond promptly.
      const hostGrantRes = await within(
        daemonRequest(live.paths.socketPath, "supervisor.install_host_grant", {
          entry_id: "room_move_concurrent_rpcs",
          room_id: "source-room",
          agent_key: "owner/room_move_concurrent_rpcs",
          grant_id: "grant_room_move_concurrent_rpcs_source",
          supervisor_grant: "grant-secret-source-2",
          grant_generation: 2,
          api_url: live.apiUrl,
          daemon_generation: live.generation,
          host_id: "host-test",
          installation_id: "installation-test",
          grant_expires_at: "2099-01-01T00:00:00.000Z",
        }),
        "install_host_grant during room-move backoff",
        3_000,
      );
      assert.equal(hostGrantRes.ok, true, hostGrantRes.error);

      const rollbackRes = await within(
        daemonRequest(live.paths.socketPath, "supervisor.rollback_room_move", {
          operation_id: operationId,
          entry_id: "room_move_concurrent_rpcs",
          error: "operator rollback during 503 backoff",
          daemon_generation: live.generation,
        }),
        "rollback_room_move during room-move backoff",
        3_000,
      );
      assert.equal(rollbackRes.ok, true, rollbackRes.error);
      assert.equal((rollbackRes.result as DaemonRoomMoveRecord).phase, "rollback_required");

      // Dedicated room-move timer finishes compensation automatically.
      await eventually(async () => {
        const move = await live.internals.store.getRoomMove(operationId);
        return move?.phase === "failed";
      }, "rollback completes automatically after operator rollback_room_move", 5_000);
    } finally {
      await live.cleanup();
    }
  }

  // Part B: 503 -> 200 auto-retry reaches rotating_credentials, credential_only install_host_grant does not deadlock,
  // and bootstrapping_destination_tail 503 -> 200 auto-retries to active even while cursor.room_id !== entry.room_id.
  {
    let destJoinAttempts = 0;
    let destTailAttempts = 0;
    const live = await createLiveRoomMoveRetryDaemon({
      id: "room_move_503_to_active",
      joinRoom: async ({ roomId }) => {
        if (roomId === "destination-room") {
          destJoinAttempts += 1;
          if (destJoinAttempts === 1) throw new SupervisorGrantRequestError(503, "join room");
        }
        return { roomId };
      },
      latest: async ({ roomId }) => {
        if (roomId === "destination-room") {
          destTailAttempts += 1;
          if (destTailAttempts === 1) throw new SupervisorGrantRequestError(503, "tail read");
          return { messages: [{ id: "msg_9" }] };
        }
        return { messages: [] };
      },
    });
    try {
      await live.internals.providerExecution.drainConvergence();
      const prep = await daemonRequest(live.paths.socketPath, "supervisor.prepare_room_move", {
        entry_id: "room_move_503_to_active",
        destination_room_id: "destination-room",
        request_id: "req-503-active",
        daemon_generation: live.generation,
      });
      const operationId = (prep.result as DaemonRoomMoveRecord).operation_id;
      const first = await daemonRequest(live.paths.socketPath, "supervisor.commit_room_move", {
        operation_id: operationId,
        entry_id: "room_move_503_to_active",
        daemon_generation: live.generation,
      });
      assert.equal((first.result as DaemonRoomMoveRecord).phase, "joining_destination");

      // Automatic retry at +1s advances to rotating_credentials with zero external requests.
      await eventually(async () => {
        const move = await live.internals.store.getRoomMove(operationId);
        return move?.phase === "rotating_credentials";
      }, "503 -> 200 automatic progression to rotating_credentials", 5_000);
      assert.equal(destJoinAttempts, 2);
      assert.equal((await live.internals.store.getEntry("room_move_503_to_active"))?.room_id, "destination-room");

      // Electron acknowledges source revocation and installs destination host grant with credential_only: true.
      const ack = await daemonRequest(live.paths.socketPath, "supervisor.acknowledge_room_move_source_revocation", {
        operation_id: operationId,
        entry_id: "room_move_503_to_active",
        source_agent_session_id: "session_source-room",
        daemon_generation: live.generation,
      });
      assert.equal(ack.ok, true, ack.error);
      const destGrant = await within(
        daemonRequest(live.paths.socketPath, "supervisor.install_host_grant", {
          entry_id: "room_move_503_to_active",
          room_id: "destination-room",
          agent_key: "owner/room_move_503_to_active",
          grant_id: "grant_room_move_503_to_active_dest",
          supervisor_grant: "grant-secret-dest",
          grant_generation: 2,
          api_url: live.apiUrl,
          daemon_generation: live.generation,
          host_id: "host-test",
          installation_id: "installation-test",
          grant_expires_at: "2099-01-01T00:00:00.000Z",
          credential_only: true,
        }),
        "credential_only install_host_grant during rotating_credentials must not deadlock",
        3_000,
      );
      assert.equal(destGrant.ok, true, destGrant.error);
      assert.equal((destGrant.result as { status?: string }).status, "installed");

      // Even with cursor still on source-room while entry.room_id is destination-room,
      // the dedicated room-move timer retries bootstrapping_destination_tail automatically.
      await eventually(async () => {
        const move = await live.internals.store.getRoomMove(operationId);
        return move?.phase === "active";
      }, "bootstrapping_destination_tail 503 -> 200 automatic progression to active", 6_000);
      assert.equal(destTailAttempts, 2);
      const finalMove = await live.internals.store.getRoomMove(operationId);
      assert.equal(finalMove?.destination_cursor, "msg_9");
      assert.equal((await live.internals.supervisedInbox.cursor("room_move_503_to_active"))?.room_id, "destination-room");
      assert.equal((await live.internals.supervisedInbox.cursor("room_move_503_to_active"))?.last_observed_message_id, "msg_9");
      const [tailEffect] = listEffectsForAgent(live.internals.stateDatabase.connection, "room_move_503_to_active", {
        kind: ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND,
      });
      assert.equal(tailEffect?.state, "completed");
    } finally {
      await live.cleanup();
    }
  }
});
