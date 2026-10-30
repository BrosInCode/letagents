import "./isolated-home.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CURSOR_NO_ROOM_REPLY_SENTINEL,
  CursorProviderAdapter,
  type CursorProviderAdapterDependencies,
} from "../main/agents/cursor-provider-adapter.js";
import type { NativeExecutionObservation } from "../main/agents/provider-adapter.js";
import {
  argValue,
  wrapperHostedMcpFixture,
  createHarness,
  daemonSpawnRequest,
  supervisedAdapter,
  spawnDaemonLane,
  roomTurnRequest,
  flush,
  waitFor,
  withLoopAlive,
} from "./cursor-provider-adapter.fixture.js";

test("daemon-owned Cursor re-attests effective MCP authority before every native launch", async () => {
  const harness = createHarness({
    mcpAttestationError: new Error("Supervised Cursor requires exactly one effective MCP entry."),
  });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);

  await assert.rejects(
    adapter.runRoomTurn(handle, roomTurnRequest()),
    /exactly one effective MCP entry/,
  );
  assert.equal(harness.mcpAttestations.length, 1);
  assert.equal(harness.launches.length, 0, "a child never launches after failed attestation");
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("a project MCP added after the final reseal gains no blanket approval or permission policy", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "letagents-cursor-project-mcp-race-"));
  try {
    let insertedAtLaunch = false;
    const harness = createHarness({
      beforeLaunch(input) {
        mkdirSync(join(workspace, ".cursor"), { recursive: true });
        writeFileSync(join(workspace, ".cursor", "mcp.json"), JSON.stringify({
          mcpServers: {
            project_extra: {
              command: process.execPath,
              args: ["-e", "throw new Error('must never be auto-approved')"],
            },
          },
        }));
        insertedAtLaunch = true;
        assert.notEqual(input.cwd, workspace, "native launch does not inherit an ambient repository cwd");
        assert.equal(argValue(input.args, "--workspace"), workspace, "repo access still uses Cursor's explicit workspace");
        // --approve-mcps is required to load the sealed HOME letagents MCP at
        // all (cursor-agent has no headless per-server approval). This adversarial
        // project mcp.json still gains nothing: the native sandbox denies reading
        // any workspace .cursor/mcp.json, so it can never be read, let alone
        // approved (that deny-read is asserted in cursor-managed-profile.test.ts).
        assert.equal(input.args.includes("--approve-mcps"), true, "the sealed HOME letagents MCP is approved so complete_room_turn loads");
        assert.equal(input.args.includes("--disable-project-configs"), true, "late project permissions stay disabled");
      },
    });
    const adapter = supervisedAdapter(harness);
    const handle = await spawnDaemonLane(adapter, harness, daemonSpawnRequest({ cwd: workspace }));
    const turn = adapter.runRoomTurn(handle, roomTurnRequest());
    await waitFor(() => harness.children[0]?.isReleased === true);

    assert.equal(insertedAtLaunch, true, "the adversarial config appears only after the last reseal");
    harness.children[0]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: "isolated", session_id: "sess-cursor-1",
    });
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await flush();
    assert.equal((await turn).text, "isolated");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("daemon-owned Cursor blocks launch when the packaged bridge fails after safe enumeration", async () => {
  const harness = createHarness({
    mcpBridgeAttestationError: new Error("Cursor failed while inspecting the effective supervised MCP registry (ENOENT)."),
  });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);

  await assert.rejects(
    adapter.runRoomTurn(handle, roomTurnRequest()),
    /ENOENT/,
  );
  assert.equal(harness.mcpAttestations.length, 2);
  assert.deepEqual(
    harness.mcpAttestations[1]!.requiredReadableRoots,
    ["/Applications/LetAgents.app/runtime/letagents"],
  );
  assert.equal(harness.launches.length, 0, "a broken real bridge never reaches native launch");
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("Cursor turn control cancels an in-flight MCP attestation before any wrapper can launch", async () => {
  const harness = createHarness({ mcpAttestationWaitForAbort: true });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest());
  while (harness.mcpAttestations.length === 0) await flush();

  let controlCheckpointed = false;
  let targetTurnId = "";
  const control = await adapter.controlTurn(handle, null, {
    checkpointTurnStarted: async (turnId) => { targetTurnId = turnId; },
    markDispatched: async () => { controlCheckpointed = true; },
  });

  assert.equal(controlCheckpointed, true);
  assert.match(targetTurnId, /^cursor:/, "pre-native cancellation checkpoints the exact bounded turn before abort");
  assert.equal(control.interrupted, true);
  assert.equal(control.resumed, false);
  await assert.rejects(roomTurn, /attestation was interrupted/);
  assert.equal(harness.launches.length, 0);
  assert.equal(handle.pid, null);
});

test("stopping Cursor during MCP attestation aborts preparation and cannot launch afterward", async () => {
  const harness = createHarness({ mcpAttestationWaitForAbort: true });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest());
  while (harness.mcpAttestations.length === 0) await flush();

  const terminal = await adapter.stop(handle);

  assert.equal(terminal.terminalCause, "stopped");
  await assert.rejects(roomTurn, /attestation was interrupted/);
  assert.equal(harness.launches.length, 0);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "stopped");
});

test("stopping Cursor during the packaged bridge pass cannot fall through to native launch", async () => {
  const harness = createHarness({
    mcpAttestationWaitForAbort: true,
    mcpAttestationWaitForAbortAt: 2,
  });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest());
  while (harness.mcpAttestations.length < 2) await flush();

  const terminal = await adapter.stop(handle);

  assert.equal(terminal.terminalCause, "stopped");
  await assert.rejects(roomTurn, /attestation was interrupted/);
  assert.deepEqual(
    harness.mcpAttestations[1]!.requiredReadableRoots,
    ["/Applications/LetAgents.app/runtime/letagents"],
  );
  assert.equal(harness.launches.length, 0);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "stopped");
});

test("Cursor handoff aborts pre-native MCP attestation and cannot leave an unjournaled launch", async () => {
  const harness = createHarness({ mcpAttestationWaitForAbort: true });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const detach = new AbortController();
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
    detachSignal: detach.signal,
  });
  while (harness.mcpAttestations.length === 0) await flush();

  detach.abort();

  await assert.rejects(roomTurn, (error: unknown) =>
    error instanceof Error
    && /attestation was interrupted/.test(error.message)
    && (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched");
  assert.equal(harness.launches.length, 0);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("Cursor handoff stays cancellation-linked until both turn id and wrapper birth are durable", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const detach = new AbortController();
  let releaseProviderCheckpoint!: () => void;
  const providerCheckpointRelease = new Promise<void>((resolve) => { releaseProviderCheckpoint = resolve; });
  let enterProviderCheckpoint!: () => void;
  const providerCheckpointEntered = new Promise<void>((resolve) => { enterProviderCheckpoint = resolve; });
  let durableBoundaryReached = false;
  let persistedTurnId = "";
  const retiredConnections: unknown[] = [];
  const execution: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, event => execution.push(event));
  let lifecycleSettlements = 0;
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointPreparedTurn: async (state) => {
      persistedTurnId = state.providerTurnId;
      assert.equal(state.providerConnection.kind, "cursor_cli");
      assert.notEqual(state.providerConnection.pid, null);
      assert.ok(state.providerConnection.processIdentity);
      enterProviderCheckpoint();
      await providerCheckpointRelease;
    },
    checkpointProviderState: async (state) => { retiredConnections.push(state.providerConnection); },
    settleLifecycleBeforeIdle: async () => {
      lifecycleSettlements++;
      assert.ok(handle.providerConnection?.processIdentity, "the committed wrapper birth remains installed at settlement");
      assert.ok(execution.some(({ fact }) => fact.domain === "runtime" && fact.state === "exited"));
    },
    markDurableTurnStarted: () => { durableBoundaryReached = true; },
    detachSignal: detach.signal,
  });
  await providerCheckpointEntered;
  const child = harness.children[0]!;

  detach.abort();
  releaseProviderCheckpoint();

  await assert.rejects(roomTurn, (error: unknown) =>
    error instanceof Error
    && (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched");
  assert.match(persistedTurnId, /^cursor:/);
  assert.equal(durableBoundaryReached, false);
  assert.equal(child.isReleased, false, "native Cursor stays paused before the combined durability boundary");
  assert.equal(lifecycleSettlements, 1);
  assert.deepEqual(retiredConnections, [{ kind: "cursor_cli", pid: null, processIdentity: null }]);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("a failed atomic prepared-turn checkpoint reaps the wrapper before native Cursor is released", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  let durableBoundaryReached = false;

  await assert.rejects(
    withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
      checkpointPreparedTurn: async () => { throw new Error("prepared turn checkpoint unavailable"); },
      markDurableTurnStarted: () => { durableBoundaryReached = true; },
    })),
    /prepared turn checkpoint unavailable/,
  );

  const child = harness.children[0]!;
  assert.equal(durableBoundaryReached, false);
  assert.equal(child.isReleased, false, "native Cursor remains paused when the turn id is not durable");
  assert.equal(child.alive, false, "the exact prepared wrapper is reaped before the failure returns");
  assert.deepEqual(harness.signals, [{ pid: child.pid, signal: "SIGTERM" }]);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("a failed prepared-wrapper idle checkpoint recovers before the inbox item becomes retryable", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-prepared-retirement-"));
  const harness = createHarness();
  try {
    const dependencies: CursorProviderAdapterDependencies = {
      ...harness.dependencies,
      prepareTurnState(path) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      },
      launchTurn(input) {
        const child = harness.dependencies.launchTurn(input);
        if (input.statePath) {
          writeFileSync(`${input.statePath}.terminal.json`, JSON.stringify({
            type: "not_started",
            native_process_group_reaped: true,
            reap_scope: "native_process_group",
            remote_authority_revoked: true,
          }));
        }
        return child;
      },
    };
    const adapter = new CursorProviderAdapter({
      dependencies,
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir: join(root, "config"),
        dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: join(root, "home") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const detach = new AbortController();
    let idleCheckpoints = 0;
    let settlements = 0;
    const firstTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
      checkpointPreparedTurn: async () => { detach.abort(); },
      checkpointProviderState: async (state) => {
        assert.equal(state.providerConnection.processIdentity, null);
        idleCheckpoints += 1;
        if (idleCheckpoints === 1) throw new Error("transient prepared idle checkpoint failure");
      },
      settleLifecycleBeforeIdle: async () => { settlements += 1; },
      detachSignal: detach.signal,
    });
    await assert.rejects(firstTurn, (error: unknown) =>
      (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched");
    assert.equal(idleCheckpoints, 2, "exact-turn recovery retries the failed live-to-idle checkpoint");
    assert.equal(settlements, 2, "typed settlement remains idempotent across compensation retry");
    assert.equal(handle.pid, null);
    assert.equal(handle.observedState(), "idle");

    const secondTurn = adapter.runRoomTurn(handle, roomTurnRequest({
      inboxItemId: "prepared-retirement-successor",
      actionId: "prepared-retirement-successor",
    }), {
      checkpointPreparedTurn: async () => {},
      checkpointProviderState: async () => {},
      settleLifecycleBeforeIdle: async () => {},
    });
    while (!harness.children[1]?.isReleased) await flush();
    harness.children[1]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: "successor ran once", session_id: "sess-cursor-1",
    });
    harness.children[1]!.resolveExit({ type: "exit", code: 0, signal: null });
    assert.equal((await secondTurn).text, "successor ran once");
    assert.equal(harness.children.length, 2, "compensation does not redispatch the first inbox item");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor control during a blocked provider checkpoint can never release deferred native work", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  let releaseProviderCheckpoint!: () => void;
  const providerCheckpointRelease = new Promise<void>((resolve) => { releaseProviderCheckpoint = resolve; });
  let enterProviderCheckpoint!: () => void;
  const providerCheckpointEntered = new Promise<void>((resolve) => { enterProviderCheckpoint = resolve; });
  let releaseIdleRetirement!: () => void;
  const idleRetirementRelease = new Promise<void>((resolve) => { releaseIdleRetirement = resolve; });
  let enterIdleRetirement!: () => void;
  const idleRetirementEntered = new Promise<void>((resolve) => { enterIdleRetirement = resolve; });
  let durableBoundaryReached = false;
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointPreparedTurn: async () => {
      enterProviderCheckpoint();
      await providerCheckpointRelease;
    },
    checkpointProviderState: async (state) => {
      assert.deepEqual(state.providerConnection, { kind: "cursor_cli", pid: null, processIdentity: null });
      enterIdleRetirement();
      await idleRetirementRelease;
    },
    markDurableTurnStarted: () => { durableBoundaryReached = true; },
  });
  await providerCheckpointEntered;
  const child = harness.children[0]!;

  const control = adapter.controlTurn(handle, null);
  let controlSettled = false;
  void control.finally(() => { controlSettled = true; });
  while (harness.signals.length === 0) await flush();
  assert.deepEqual(harness.signals, [{ pid: child.pid, signal: "SIGTERM" }]);
  assert.equal(child.isReleased, false);
  releaseProviderCheckpoint();
  await idleRetirementEntered;
  await flush();
  assert.equal(controlSettled, false, "Stop cannot return before exact live-to-idle retirement commits");
  releaseIdleRetirement();

  await assert.rejects(roomTurn, (error: unknown) =>
    error instanceof Error
    && (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched");
  await control;
  assert.equal(durableBoundaryReached, false);
  assert.equal(child.isReleased, false, "an interrupt edge wins permanently over deferred native release");
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("Cursor Stop after native release but before init preserves the lane and permits the next turn", async () => {
  const bounded = async <T>(work: Promise<T>, stage: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out during ${stage}.`)), 500);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const harness = createHarness({ silent: true });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const retiredConnections: unknown[] = [];
  const firstTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointPreparedTurn: async () => {},
    checkpointProviderState: async (state) => { retiredConnections.push(state.providerConnection); },
    markDurableTurnStarted: () => {},
  });
  firstTurn.catch(() => {});
  while (!harness.children[0]?.isReleased) await flush();

  const control = await bounded(adapter.controlTurn(handle, null, {
    markDispatched: async () => {},
  }), "pre-init Stop");
  await bounded(assert.rejects(firstTurn, (error: unknown) =>
    error instanceof Error
    && (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "ambiguous"), "first turn rejection");
  assert.equal(harness.children[0]!.isReleased, true, "absence of init does not make an admitted turn safe to redispatch");
  assert.equal(harness.children[0]!.alive, false, "the exact released child is reaped before Stop completes");
  assert.equal(harness.children.length, 1, "post-release interruption does not launch a replacement turn");
  assert.equal(control.interrupted, true);
  assert.equal(control.state, "idle");
  assert.equal(handle.observedState(), "idle", "a normal turn Stop does not terminalize the Cursor attempt");
  assert.deepEqual(retiredConnections, [{ kind: "cursor_cli", pid: null, processIdentity: null }]);

  const secondTurn = adapter.runRoomTurn(handle, roomTurnRequest({
    inboxItemId: "inbox_cursor_2",
    actionId: "action_cursor_2",
  }), {
    checkpointPreparedTurn: async () => {},
    checkpointProviderState: async () => {},
    markDurableTurnStarted: () => {},
  });
  while (!harness.children[1]?.isReleased) await flush();
  harness.children[1]!.emit({ type: "system", subtype: "init", session_id: "sess-cursor-after-stop" });
  harness.children[1]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "continued", session_id: "sess-cursor-after-stop",
  });
  harness.children[1]!.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await bounded(secondTurn, "successor turn")).text, "continued", "the preserved lane can execute the next bounded turn");
});

test("Cursor handoff SIGKILLs and reaps a TERM-resistant prepared wrapper before retiring", async () => {
  const harness = createHarness({ dieOnSigterm: false, ownsDescendantReaping: true });
  const adapter = supervisedAdapter(harness, 10);
  const handle = await spawnDaemonLane(adapter, harness);
  const detach = new AbortController();
  let releaseProviderCheckpoint!: () => void;
  const providerCheckpointRelease = new Promise<void>((resolve) => { releaseProviderCheckpoint = resolve; });
  let enterProviderCheckpoint!: () => void;
  const providerCheckpointEntered = new Promise<void>((resolve) => { enterProviderCheckpoint = resolve; });
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointTurnStarted: async () => {},
    checkpointProviderState: async () => {
      enterProviderCheckpoint();
      await providerCheckpointRelease;
    },
    detachSignal: detach.signal,
  });
  await providerCheckpointEntered;
  const child = harness.children[0]!;

  detach.abort();
  releaseProviderCheckpoint();

  await withLoopAlive(assert.rejects(roomTurn, (error: unknown) =>
    error instanceof Error
    && (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched"));
  assert.deepEqual(harness.signals, [
    { pid: child.pid, signal: "SIGTERM" },
    { pid: child.pid, signal: "SIGKILL" },
  ]);
  assert.equal(child.isReleased, false, "native Cursor was never released from the prepared wrapper");
  assert.equal(child.alive, false, "handoff waits until the exact prepared wrapper is reaped");
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("Cursor handoff never escalates a prepared wrapper after its PID birth is recycled", async () => {
  const harness = createHarness({ dieOnSigterm: false, ownsDescendantReaping: true });
  const adapter = supervisedAdapter(harness, 10);
  const handle = await spawnDaemonLane(adapter, harness);
  const detach = new AbortController();
  let releaseProviderCheckpoint!: () => void;
  const providerCheckpointRelease = new Promise<void>((resolve) => { releaseProviderCheckpoint = resolve; });
  let enterProviderCheckpoint!: () => void;
  const providerCheckpointEntered = new Promise<void>((resolve) => { enterProviderCheckpoint = resolve; });
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointTurnStarted: async () => {},
    checkpointProviderState: async () => {
      enterProviderCheckpoint();
      await providerCheckpointRelease;
    },
    detachSignal: detach.signal,
  });
  await providerCheckpointEntered;
  const child = harness.children[0]!;
  const runtimeDataDir = harness.launches[0]!.env?.CURSOR_DATA_DIR;
  assert.ok(runtimeDataDir);
  harness.identities.set(child.pid!, "unrelated-recycled-birth");

  detach.abort();
  releaseProviderCheckpoint();

  await assert.rejects(roomTurn, (error: unknown) =>
    error instanceof Error
    && (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched");
  assert.deepEqual(harness.signals, [], "neither TERM nor KILL may target the recycled PID");
  assert.equal(child.isReleased, false);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");

  // PID recycling proves that the original process has exited even if its
  // exit notification reaches the adapter later. The delayed observation
  // must retire its private worker namespace without ever signalling the
  // recycled PID.
  child.resolveExit({ type: "exit", code: null, signal: null });
  await flush();
  assert.equal(existsSync(runtimeDataDir), false);
});

test("Cursor handoff never adopts a later PID birth when the prepared wrapper birth was unverifiable", async () => {
  const harness = createHarness({ dieOnSigterm: false, ownsDescendantReaping: true });
  let identityReads = 0;
  const adapter = new CursorProviderAdapter({
    dependencies: {
      ...harness.dependencies,
      getProcessIdentity() {
        identityReads += 1;
        return identityReads === 1 ? undefined : "unrelated-recycled-birth";
      },
    },
    stopGraceMs: 10,
    supervisedProfileFactory: ({ workAttemptId }) => ({
      homeDir: `/private/cursor/${workAttemptId}/home`,
      configDir: `/private/cursor/${workAttemptId}/config`,
      dataDir: `/private/cursor/${workAttemptId}/data`,
      cacheDir: `/private/cursor/${workAttemptId}/cache`,
      env: {
        HOME: `/private/cursor/${workAttemptId}/home`,
        CURSOR_CONFIG_DIR: `/private/cursor/${workAttemptId}/config/cursor`,
        NPM_CONFIG_CACHE: `/private/cursor/${workAttemptId}/npm-cache`,
      },
      ...wrapperHostedMcpFixture(`/private/cursor/${workAttemptId}`),
    }),
  });
  const handle = await spawnDaemonLane(adapter, harness);
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest());
  roomTurn.catch(() => {});
  await waitFor(() => identityReads >= 1);
  const child = harness.children[0]!;

  assert.equal(identityReads, 1, "cleanup may not re-read and adopt a later PID birth");
  assert.deepEqual(harness.signals, [], "an uncaptured birth never authorizes TERM or KILL");
  child.resolveExit({ type: "exit", code: null, signal: null });
  await assert.rejects(roomTurn, /process identity could not be verified/);
  assert.equal(child.isReleased, false);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "failed");
});

test("daemon-owned Cursor runs one exact bounded room turn and checkpoints before native launch", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  assert.equal(adapter.runtimeCustody(handle.workAttemptId), "absent");
  const order: string[] = [];
  let persistedTurnId = "";
  const pending = adapter.runRoomTurn(handle, roomTurnRequest(), {
    beforeNativeDispatch: async () => {
      assert.equal(adapter.runtimeCustody(handle.workAttemptId), "unknown", "admitted preparation is owned before child creation");
      order.push("dispatch_intent");
    },
    checkpointTurnStarted: async (turnId) => {
      persistedTurnId = turnId;
      order.push("turn_started");
      assert.equal(harness.launches.length, 1, "the paused wrapper exists before the turn id becomes durable");
      assert.equal(harness.children[0]?.isReleased, false, "native Cursor is not released before its exact turn id is durable");
    },
    markDurableTurnStarted: () => {
      order.push("durable");
      assert.equal(harness.children[0]?.isReleased, false, "the durable milestone precedes native release");
    },
    checkpointTerminalResult: async () => {
      assert.equal(adapter.runtimeCustody(handle.workAttemptId), "unknown", "native death does not skip in-flight terminal settlement");
      order.push("terminal");
    },
  });
  await waitFor(() => harness.children[0]?.isReleased === true);

  assert.match(persistedTurnId, /^cursor:/);
  assert.equal(harness.launches.length, 1);
  const launch = harness.launches[0]!;
  assert.equal(argValue(launch.args, "--resume"), null);
  assert.equal(launch.args.at(-1)?.includes(`Turn id: ${persistedTurnId}`), true);
  assert.equal(launch.args.at(-1)?.includes("Please fix it"), true);
  assert.equal(launch.args.at(-1)?.includes("call complete_room_turn exactly once"), true);
  assert.match(launch.args.at(-1)!, /chat reply publication does not publish code or create PRs/);
  assert.match(launch.args.at(-1)!, /standing merge approval/);
  assert.match(launch.args.at(-1)!, /only LetAgents MCP tools and no browser\/computer-use integration/);
  assert.match(launch.args.at(-1)!, /Browser QA is unavailable here/);
  assert.match(launch.args.at(-1)!, /even when Cursor's own sandbox is disabled/);
  assert.match(launch.args.at(-1)!, /report the specific gap once and continue independent feasible work/);
  assert.match(launch.args.at(-1)!, /leave affected verification incomplete/);
  assert.match(launch.args.at(-1)!, /Still respond to explicit user instructions and new questions/);
  assert.match(launch.args.at(-1)!, /acknowledgment-only closing messages.*no-reply completion/);
  assert.match(launch.args.at(-1)!, /outcome: "no_reply"/, "quiet completion still uses Cursor's existing structured proposal");
  const child = harness.children[0]!;
  child.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "  Reply from Cursor  ",
    request_id: "cursor-request-native-1",
    session_id: "sess-cursor-1",
  });
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();

  assert.deepEqual(await pending, {
    turnId: persistedTurnId,
    outcome: "reply",
    text: "Reply from Cursor",
    evidence: "stream",
    publicationContract: "structured_room_turn_v1",
  });
  assert.deepEqual(order, ["dispatch_intent", "turn_started", "durable", "terminal"]);
  assert.equal(handle.observedState(), "idle");
  assert.equal(adapter.runtimeCustody(handle.workAttemptId), "absent");
});

test("Cursor checkpoints a proven native provider failure and reuses its exact session", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const checkpoints: unknown[] = [];
  const pending = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointTerminalResult: async result => { checkpoints.push(result); },
  });
  await waitFor(() => harness.children[0]?.isReleased === true);
  const child = harness.children[0]!;
  child.emit({ type: "result", subtype: "error_during_execution", is_error: true,
    result: "HTTP 503 service unavailable", session_id: "sess-cursor-1" });
  child.resolveExit({ type: "exit", code: 0, signal: null });
  const failure = await pending;
  assert.equal(failure.outcome, "failed");
  assert.equal("providerContinuationId" in failure && failure.providerContinuationId, "sess-cursor-1");
  assert.equal("error" in failure && failure.error, "HTTP 503 service unavailable");
  assert.deepEqual(checkpoints, [failure]);
  assert.equal(handle.observedState(), "idle");
  const next = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "continuation" }));
  await waitFor(() => harness.children[1]?.isReleased === true);
  assert.equal(argValue(harness.launches[1]!.args, "--resume"), "sess-cursor-1");
  harness.children[1]!.emit({ type: "result", subtype: "success", is_error: false,
    result: "finished", session_id: "sess-cursor-1" });
  harness.children[1]!.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await next).text, "finished");
});

test("writable Cursor turns launch only in their private generation and retire it before publication", async () => {
  const harness = createHarness();
  const createGeneration = harness.dependencies.createWorkspaceGeneration;
  harness.dependencies.createWorkspaceGeneration = async (input) => ({
    ...(await createGeneration(input)),
    liveSourceRoot: "/private/letagents-generation/live",
    liveWorkspace: "/private/letagents-generation/live/project",
    readOnlyRoots: [{
      sourcePath: "/private/source/.git/objects",
      generationPath: null,
      purpose: "git-objects" as const,
    }],
  });
  const adapter = supervisedAdapter(harness);
  const handle = await adapter.spawn(daemonSpawnRequest({
    permissionProfileId: "sandboxed_write",
    launchPolicy: { force: true, sandbox: "enabled" },
  }));
  const terminalOrder: string[] = [];
  const pending = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointTerminalResult: async () => { terminalOrder.push("terminal"); },
  });
  await waitFor(() => harness.children[0]?.isReleased === true);

  const launch = harness.launches[0]!;
  assert.equal(argValue(launch.args, "--workspace"), "/private/letagents-generation/live/project");
  assert.equal(launch.mcpRuntimeCwd, "/private/letagents-generation/live/project");
  assert.equal(launch.allowedReadSubpaths?.includes("/private/source/.git/objects"), true);
  assert.equal(launch.allowedWriteSubpaths?.includes("/tmp/wa-cursor-1"), false);
  assert.match(launch.workspaceGenerationManifestPath ?? "", /^\/tmp\/letagents-test-generation-/);

  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "generation reply", session_id: "sess-cursor-1",
  });
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await withLoopAlive(pending)).text, "generation reply");
  assert.deepEqual(harness.workspaceGenerationEvents.map((event) => event.kind), ["create", "retire", "remove"]);
  assert.deepEqual(terminalOrder, ["terminal"]);
});

test("room scratch Cursor turns use their exact workspace without Git generation", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const scratchWorkspace = "/private/letagents-daemon/room-only/2bbffeb2-a7ad-4cf0-bdac-114c6b37cb39";
  const handle = await adapter.spawn(daemonSpawnRequest({
    supervisorEntryId: "supervised_agent_1",
    workspaceKind: "room_scratch",
    cwd: scratchWorkspace,
    permissionProfileId: "sandboxed_write",
    launchPolicy: { force: true, sandbox: "enabled" },
  }));

  const pending = adapter.runRoomTurn(handle, roomTurnRequest());
  await waitFor(() => harness.children[0]?.isReleased === true);

  const launch = harness.launches[0]!;
  assert.equal(argValue(launch.args, "--workspace"), scratchWorkspace);
  assert.equal(argValue(launch.args, "--sandbox"), "enabled");
  assert.equal(launch.mcpRuntimeCwd, scratchWorkspace);
  assert.equal(launch.workspaceGenerationManifestPath, undefined);
  assert.deepEqual(harness.workspaceGenerationEvents, []);

  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "room-only reply", session_id: "sess-cursor-1",
  });
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await withLoopAlive(pending)).text, "room-only reply");
  assert.deepEqual(harness.workspaceGenerationEvents, []);
});

test("an ambiguous native release failure reconciles instead of abandoning or redispatching the generation", async () => {
  const harness = createHarness({ releaseError: new Error("IPC release acknowledgement failed") });
  const adapter = supervisedAdapter(harness);
  const handle = await adapter.spawn(daemonSpawnRequest({
    permissionProfileId: "sandboxed_write",
    launchPolicy: { force: true, sandbox: "enabled" },
  }));

  await assert.rejects(
    withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest())),
    /cannot prove the persisted exact turn reached a terminal boundary/i,
  );
  assert.equal(harness.launches.length, 1, "the ambiguous exact turn is never redispatched");
  assert.deepEqual(harness.workspaceGenerationEvents.map((event) => event.kind), ["create", "retire"]);
  assert.deepEqual(harness.signals, [{ pid: 5200, signal: "SIGTERM" }]);
});

test("Cursor bounded turns classify only the exact no-reply sentinel and preserve unreadable completion", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);

  const noReply = adapter.runRoomTurn(handle, roomTurnRequest({ actionId: "action_no_reply" }));
  await waitFor(() => harness.children[0]?.isReleased === true);
  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: CURSOR_NO_ROOM_REPLY_SENTINEL, session_id: "sess-cursor-1",
  });
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  const noReplyResult = await noReply;
  assert.deepEqual(noReplyResult, {
    turnId: noReplyResult.turnId,
    outcome: "no_reply",
    text: null,
    evidence: "stream",
    publicationContract: "structured_room_turn_v1",
  });

  const unreadable = adapter.runRoomTurn(handle, roomTurnRequest({ actionId: "action_unreadable" }));
  await waitFor(() => harness.children[1]?.isReleased === true);
  harness.children[1]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: null, session_id: "sess-cursor-1",
  });
  harness.children[1]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  const unreadableResult = await unreadable;
  assert.equal(unreadableResult.outcome, "unreadable");
  assert.equal(unreadableResult.text, null);
  assert.equal(unreadableResult.evidence, "none");

  const extraText = adapter.runRoomTurn(handle, roomTurnRequest({ actionId: "action_extra_text" }));
  await waitFor(() => harness.children[2]?.isReleased === true);
  harness.children[2]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: `${CURSOR_NO_ROOM_REPLY_SENTINEL} because this is extra`, session_id: "sess-cursor-1",
  });
  harness.children[2]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal((await extraText).outcome, "reply", "sentinel inference is exact, never substring-based");

  const launchCount = harness.launches.length;
  assert.deepEqual(await adapter.recoverRoomTurn(handle, {
    inboxItemId: "inbox_cursor_1",
    providerTurnId: unreadableResult.turnId,
  }), unreadableResult, "result recovery re-reads retained terminal evidence for the exact same turn");
  assert.equal(harness.launches.length, launchCount, "unreadable recovery never reruns Cursor");
});

test("Cursor handoff detaches observation while the same in-memory exact turn remains recoverable without redispatch", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const abort = new AbortController();
  let turnId = "";
  const pending = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointTurnStarted: async (value) => { turnId = value; },
    detachSignal: abort.signal,
  });
  await waitFor(() => harness.children[0]?.isReleased === true);
  abort.abort();
  await assert.rejects(pending, /observation detached/);

  const child = harness.children[0]!;
  child.emit({
    type: "result", subtype: "success", is_error: false,
    result: "Recovered exact reply", session_id: "sess-cursor-1",
  });
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  const launchCount = harness.launches.length;
  const recovered = await adapter.recoverRoomTurn(handle, {
    inboxItemId: "inbox_cursor_1",
    providerTurnId: turnId,
  });
  assert.equal(recovered.text, "Recovered exact reply");
  assert.equal(harness.launches.length, launchCount, "recovery reads only retained exact evidence");
  await assert.rejects(
    () => adapter.recoverRoomTurn(handle, { inboxItemId: "inbox_cursor_1", providerTurnId: "cursor:unknown" }),
    /refusing to rerun/,
  );
});

test("Cursor retains terminal stream evidence when checkpointing fails and recovery never launches again", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  let turnId = "";
  const pending = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointTurnStarted: async (value) => { turnId = value; },
    checkpointTerminalResult: async () => { throw new Error("database unavailable"); },
  });
  const rejected = assert.rejects(pending, /database unavailable/);
  await waitFor(() => harness.children[0]?.isReleased === true);
  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "Durable after retry", session_id: "sess-cursor-1",
  });
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  await rejected;
  const launchCount = harness.launches.length;
  const recovered = await adapter.recoverRoomTurn(handle, {
    inboxItemId: "inbox_cursor_1",
    providerTurnId: turnId,
  });
  assert.equal(recovered.text, "Durable after retry");
  assert.equal(harness.launches.length, launchCount);
});

test("Cursor cleanup follows the daemon-accepted structured result rather than the raw aggregate", async () => {
  const acceptedHarness = createHarness();
  const acceptedAdapter = supervisedAdapter(acceptedHarness);
  const acceptedHandle = await spawnDaemonLane(acceptedAdapter, acceptedHarness);
  let acceptedTurnId = "";
  const accepted = acceptedAdapter.runRoomTurn(acceptedHandle, roomTurnRequest({ actionId: "accepted-structured" }), {
    checkpointTurnStarted: async (turnId) => { acceptedTurnId = turnId; },
    checkpointTerminalResult: async (raw) => {
      assert.equal(raw.outcome, "unreadable");
      return {
        acceptedResult: {
          turnId: raw.turnId, outcome: "reply", text: "structured proposal", evidence: "stream",
          publicationContract: "structured_room_turn_v1",
        },
        cleanupRecoveryEvidence: true,
      };
    },
  });
  await waitFor(() => acceptedHarness.children[0]?.isReleased === true);
  acceptedHarness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false, result: null, session_id: "sess-cursor-1",
  });
  acceptedHarness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await accepted).text, "structured proposal");
  await assert.rejects(
    () => acceptedAdapter.recoverRoomTurn(acceptedHandle, { inboxItemId: "accepted-structured", providerTurnId: acceptedTurnId }),
    /refusing to rerun/,
    "accepted structured publication authorizes cleanup even when Cursor's raw aggregate was empty",
  );

  const rejectedHarness = createHarness();
  const rejectedAdapter = supervisedAdapter(rejectedHarness);
  const rejectedHandle = await spawnDaemonLane(rejectedAdapter, rejectedHarness);
  let rejectedTurnId = "";
  const rejected = rejectedAdapter.runRoomTurn(rejectedHandle, roomTurnRequest({ actionId: "missing-structured" }), {
    checkpointTurnStarted: async (turnId) => { rejectedTurnId = turnId; },
    checkpointTerminalResult: async (raw) => ({
      acceptedResult: {
        turnId: raw.turnId, outcome: "unreadable", text: null, evidence: "none",
        publicationContract: "structured_room_turn_v1",
      },
      cleanupRecoveryEvidence: false,
    }),
  });
  await waitFor(() => rejectedHarness.children[0]?.isReleased === true);
  rejectedHarness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false, result: "raw aggregate only", session_id: "sess-cursor-1",
  });
  rejectedHarness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await rejected).outcome, "unreadable");
  assert.equal((await rejectedAdapter.recoverRoomTurn(rejectedHandle, {
    inboxItemId: "missing-structured", providerTurnId: rejectedTurnId,
  })).text, "raw aggregate only", "missing structured publication retains exact recovery evidence");
});
