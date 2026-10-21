import "./isolated-home.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CursorProviderAdapter, defaultLaunchTurn, type CursorProviderAdapterDependencies } from "../main/agents/cursor-provider-adapter.js";
import type {
  ProviderSpawnRequest,
  ProviderStreamEvent,
  ProviderTerminalPayload,
  NativeExecutionObservation,
} from "../main/agents/provider-adapter.js";
import {
  birthIdentity,
  argValue,
  wrapperHostedMcpFixture,
  createHarness,
  spawnRequest,
  daemonSpawnRequest,
  supervisedAdapter,
  spawnDaemonLane,
  roomTurnRequest,
  flush,
  waitFor,
  withLoopAlive,
} from "./cursor-provider-adapter.fixture.js";

test("daemon Cursor correction refuses an unjournaled side turn and native resume itself launches no bootstrap", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const request = daemonSpawnRequest();
  const handle = await adapter.resume({
    workAttemptId: request.workAttemptId,
    providerContinuationId: "sess-cursor-existing",
    providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
  }, request);
  assert.equal(harness.launches.length, 0, "successor recovery cannot race an orphan with a bootstrap side turn");
  assert.equal(handle.observedState(), "idle");
  await assert.rejects(
    () => adapter.controlTurn(handle, "Do this instead"),
    /cannot start an unjournaled correction turn/,
  );
  assert.equal(harness.launches.length, 0);

  const turn = adapter.runRoomTurn(handle, roomTurnRequest());
  await waitFor(() => harness.children[0]?.isReleased === true);
  assert.equal(argValue(harness.launches[0]!.args, "--resume"), "sess-cursor-existing");
  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "continued safely", session_id: "sess-cursor-existing",
  });
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal((await turn).text, "continued safely");
});

test("daemon Cursor restart-resume preserves exact write authority and sandbox flags", async () => {
  for (const [permissionProfileId, sandbox] of [
    ["sandboxed_write", "enabled"],
    ["full_access", "disabled"],
  ] as const) {
    const harness = createHarness();
    const adapter = supervisedAdapter(harness);
    const request = daemonSpawnRequest({
      workAttemptId: `wa-restart-${permissionProfileId}`,
      permissionProfileId,
      launchPolicy: { force: true, sandbox },
    });
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: `sess-restart-${permissionProfileId}`,
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    assert.equal(harness.launches.length, 0, "restart recovery stays idle until a journaled inbox turn");

    const turn = adapter.runRoomTurn(handle, roomTurnRequest({
      inboxItemId: `inbox-restart-${permissionProfileId}`,
    }));
    for (let index = 0; index < 100 && !harness.children[0]?.isReleased; index += 1) await flush();
    const launch = harness.launches[0]!;
    assert.equal(argValue(launch.args, "--resume"), `sess-restart-${permissionProfileId}`);
    assert.equal(launch.args.includes("--force"), true);
    assert.equal(argValue(launch.args, "--sandbox"), sandbox);
    assert.equal(launch.mcpRuntimeEnv?.LETAGENTS_PERMISSION_PROFILE_ID, permissionProfileId);
    assert.equal(launch.fullAccess === true, permissionProfileId === "full_access");
    if (permissionProfileId === "full_access") assert.equal(argValue(launch.args, "--workspace"), request.cwd);
    assert.equal(Boolean(launch.workspaceGenerationManifestPath), permissionProfileId !== "full_access");
    assert.equal(harness.profilePreparations.at(-1)?.permissionProfileId, permissionProfileId);

    harness.children[0]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: `${permissionProfileId} resumed`, session_id: `sess-restart-${permissionProfileId}`,
    });
    await flush();
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await flush();
    assert.equal((await turn).text, `${permissionProfileId} resumed`);
  }
});

test("daemon Cursor rejects missing supervisor coordinates and preserves selected write authority", async () => {
  const missingHarness = createHarness();
  const missingAdapter = supervisedAdapter(missingHarness);
  await assert.rejects(
    () => missingAdapter.spawn(daemonSpawnRequest({ supervisorSocketPath: undefined })),
    /requires exact supervisor coordinates/,
  );
  assert.equal(missingHarness.launches.length, 0);
  await assert.rejects(
    () => missingAdapter.spawn(daemonSpawnRequest({
      workAttemptId: "wa-missing-permission-profile",
      permissionProfileId: null,
    })),
    /requires an exact permission profile/,
  );
  await assert.rejects(
    () => missingAdapter.spawn(daemonSpawnRequest({
      workAttemptId: "wa-unknown-permission-profile",
      permissionProfileId: "unknown" as ProviderSpawnRequest["permissionProfileId"],
    })),
    /Unknown permission profile/,
  );
  await assert.rejects(
    () => missingAdapter.spawn(daemonSpawnRequest({
      workAttemptId: "wa-gated-permission-profile",
      permissionProfileId: "ask_before_write",
    })),
    /not available for cursor/,
  );
  assert.equal(missingHarness.launches.length, 0);

  const readOnlyHarness = createHarness();
  const readOnlyAdapter = supervisedAdapter(readOnlyHarness);
  const readOnlyHandle = await readOnlyAdapter.spawn(daemonSpawnRequest({
    workAttemptId: "wa-read-only-model-collision",
    model: "--sandbox",
  }));
  const readOnlyTurn = readOnlyAdapter.runRoomTurn(readOnlyHandle, roomTurnRequest({
    inboxItemId: "inbox-read-only-model-collision",
  }));
  for (let index = 0; index < 100 && readOnlyHarness.launches.length === 0; index += 1) await flush();
  const readOnlyArgs = readOnlyHarness.launches[0]!.args;
  assert.equal(readOnlyArgs.some((arg, index) => arg === "--sandbox" && readOnlyArgs[index + 1] === "enabled"), true);
  for (let index = 0; index < 100 && !readOnlyHarness.children[0]?.isReleased; index += 1) await flush();
  readOnlyHarness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "read_only completed", session_id: readOnlyHandle.providerContinuationId,
  });
  await flush();
  readOnlyHarness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal((await readOnlyTurn).text, "read_only completed");

  for (const [permissionProfileId, sandbox] of [
    ["sandboxed_write", "enabled"],
    ["full_access", "disabled"],
  ] as const) {
    const harness = createHarness();
    const adapter = supervisedAdapter(harness);
    const handle = await adapter.spawn(daemonSpawnRequest({
      workAttemptId: `wa-${permissionProfileId}`,
      permissionProfileId,
      launchPolicy: { force: true, sandbox },
    }));
    const turn = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: `inbox-${permissionProfileId}` }));
    for (let index = 0; index < 100 && harness.launches.length === 0; index += 1) await flush();
    assert.ok(harness.launches[0]?.args.includes("--force"));
    assert.equal(argValue(harness.launches[0]!.args, "--sandbox"), sandbox);
    assert.match(harness.launches[0]!.args.at(-1) ?? "", /You may edit files and run local commands/);
    if (permissionProfileId === "full_access") {
      assert.match(harness.launches[0]!.args.at(-1) ?? "", /filesystem and network operations outside the working directory/);
      assert.match(harness.launches[0]!.args.at(-1) ?? "", /create commits, push branches, and open pull requests/);
      assert.doesNotMatch(harness.launches[0]!.args.at(-1) ?? "", /Do not create commits/);
    }
    for (let index = 0; index < 100 && !harness.children[0]?.isReleased; index += 1) await flush();
    assert.equal(harness.children[0]?.isReleased, true);
    harness.children[0]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: `${permissionProfileId} completed`, session_id: handle.providerContinuationId,
    });
    await flush();
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await flush();
    assert.equal((await turn).text, `${permissionProfileId} completed`);
  }
});

test("a successful result is TURN-terminal: the lane goes idle with NO claimed process and is not attempt-terminal", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  const child = harness.children[0]!;
  child.emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "sess-cursor-1" });
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();

  assert.equal(handle.observedState(), "idle");
  assert.deepEqual(terminals, [], "a finished turn never becomes attempt-terminal evidence");
  // The honest idle cell: no process is claimed between turns.
  assert.equal(handle.pid, null);
  assert.deepEqual(handle.providerConnection, { kind: "cursor_cli", pid: null, processIdentity: null });
  assert.equal(handle.providerContinuationId, "sess-cursor-1", "the session id is the only continuation state");
});

test("Cursor missing wrapper cwd proves no native child was acquired", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: { ...harness.dependencies, launchTurn: input => {
    const child = defaultLaunchTurn({ ...input, deferStart: true });
    // Join the alternate readiness rejection too: this case deliberately
    // fails before a wrapper exists or can receive its start IPC message.
    void child.prepared?.catch(() => {});
    return child;
  } } });
  await assert.rejects(adapter.spawn(spawnRequest({ cwd: "/nonexistent-letagents-test/cursor-cwd" })), /did not expose a process id/);
  assert.equal(adapter.runtimeCustody("wa-cursor-1"), "absent");
  assert.deepEqual(harness.signals, []);
});

test("Cursor legacy poke retains custody while preparing a child before liveTurn installation", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  harness.children[0]!.emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "sess-cursor-1" });
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal(adapter.runtimeCustody(handle.workAttemptId), "absent");
  const launch = harness.dependencies.launchTurn;
  let release!: () => void;
  const prepared = new Promise<void>(resolve => { release = resolve; });
  // Early birth lookup may be unavailable before wrapper readiness. Custody
  // recording must not move the existing launch validation before prepared.
  const liveDeps = (adapter as unknown as { deps: CursorProviderAdapterDependencies }).deps;
  liveDeps.launchTurn = input => {
    const child = launch(input);
    harness.identities.set(child.pid!, undefined);
    Object.defineProperty(child, "prepared", { value: prepared.then(() => {
      harness.identities.set(child.pid!, birthIdentity(child.pid!));
    }) });
    return child;
  };
  const pending = adapter.poke(handle, "next message");
  await flush();
  assert.equal(handle.pid, null, "no public liveTurn is installed during preparation");
  assert.equal(adapter.runtimeCustody(handle.workAttemptId), "unknown");
  release();
  await pending;
  harness.children[1]!.emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "sess-cursor-1" });
  harness.children[1]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal(adapter.runtimeCustody(handle.workAttemptId), "absent");
});

test("a turn child that dies WITHOUT its result event is attempt-terminal (crashed) and attach reports absent", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  harness.identities.set(5200, null);
  harness.children[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]!.terminalCause, "crashed");
  assert.equal(handle.observedState(), "failed");
  assert.equal(await adapter.attach({
    workAttemptId: "wa-cursor-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: { kind: "cursor_cli", pid: 5200, processIdentity: birthIdentity(5200) },
  }), null);
});

test("stop during a live turn orders SIGTERM before the observed terminal and escalates to SIGKILL after grace", async () => {
  const graceful = createHarness();
  const gracefulAdapter = new CursorProviderAdapter({ dependencies: graceful.dependencies, stopGraceMs: 200 });
  const gracefulHandle = await gracefulAdapter.spawn(spawnRequest());
  const stopped = await gracefulAdapter.stop(gracefulHandle);
  assert.deepEqual(graceful.signals.map((entry) => entry.signal), ["SIGTERM"]);
  assert.equal(stopped.terminalCause, "stopped");

  const stubborn = createHarness({ dieOnSigterm: false });
  const stubbornAdapter = new CursorProviderAdapter({ dependencies: stubborn.dependencies, stopGraceMs: 30 });
  const stubbornHandle = await stubbornAdapter.spawn(spawnRequest());
  const killed = await withLoopAlive(stubbornAdapter.stop(stubbornHandle));
  assert.deepEqual(stubborn.signals.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
  assert.equal(killed.terminalCause, "killed");
});

test("live Cursor stop never signals a recycled wrapper PID or process group", async () => {
  const harness = createHarness({ dieOnSigterm: false });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 10 });
  const handle = await adapter.spawn(spawnRequest());
  harness.identities.set(handle.pid!, "unrelated-recycled-birth");

  const stopped = await adapter.stop(handle);

  assert.deepEqual(harness.signals, []);
  assert.equal(stopped.terminalCause, "stopped");
  assert.equal(handle.pid, null);
});

test("Cursor Stop joins the bounded turn settlement barrier before retiring its exact child birth", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  let enterSettlement!: () => void;
  const settlementEntered = new Promise<void>((resolve) => { enterSettlement = resolve; });
  let releaseSettlement!: () => void;
  const settlementRelease = new Promise<void>((resolve) => { releaseSettlement = resolve; });
  const retiredConnections: unknown[] = [];
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointPreparedTurn: async () => {},
    checkpointProviderState: async (state) => { retiredConnections.push(state.providerConnection); },
    settleLifecycleBeforeIdle: async () => {
      enterSettlement();
      await settlementRelease;
    },
  });
  for (let index = 0; index < 100 && !harness.children[0]?.isReleased; index += 1) await flush();
  const child = harness.children[0]!;
  assert.notEqual(child.pid, null);
  child.emit({ type: "result", subtype: "success", is_error: false, result: "settled", session_id: "sess-cursor-1" });
  harness.identities.set(child.pid!, null);
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await settlementEntered;

  let stopSettled = false;
  const stopping = adapter.stop(handle).finally(() => { stopSettled = true; });
  await flush();
  assert.equal(stopSettled, false, "Stop cannot fire onExit while the exact child effect is unsettled");
  assert.equal(handle.providerConnection?.processIdentity, birthIdentity(child.pid!));

  releaseSettlement();
  const [result, stopped] = await Promise.all([roomTurn, stopping]);
  assert.equal(result.text, "settled");
  assert.equal(stopped.terminalCause, "stopped");
  assert.deepEqual(retiredConnections.at(-1), { kind: "cursor_cli", pid: null, processIdentity: null });
  assert.equal(handle.pid, null);
});

test("Cursor releases native custody after failed checkpoint only when exact workspace retirement is saved", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-retired-custody-"));
  const harness = createHarness({ ownsDescendantReaping: true });
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const adapter = new CursorProviderAdapter({
      dependencies: {
        ...harness.dependencies,
        prepareTurnState(path) { writeFileSync(path, "", { flag: "wx", mode: 0o600 }); },
        launchTurn(input) {
          const child = harness.dependencies.launchTurn(input);
          Object.defineProperty(child, "requiresDurableTerminalEvidence", { value: true });
          return child;
        },
      },
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: join(root, "home"), NPM_CONFIG_CACHE: join(root, "npm-cache") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await spawnDaemonLane(adapter, harness, daemonSpawnRequest({
      cwd: root, permissionProfileId: "sandboxed_write", launchPolicy: { force: true, sandbox: "enabled" },
    }));
    let turnId = "";
    let checkpoints = 0;
    let resultCheckpoints = 0;
    let releaseCheckpoint!: () => void;
    const checkpointGate = new Promise<void>(resolve => { releaseCheckpoint = resolve; });
    let enteredCheckpoint!: () => void;
    const checkpointEntered = new Promise<void>(resolve => { enteredCheckpoint = resolve; });
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, terminal => terminals.push(terminal));
    const pending = adapter.runRoomTurn(handle, roomTurnRequest(), {
      checkpointTurnStarted: async id => { turnId = id; },
      checkpointProviderState: async state => {
        if (state.providerContinuationId !== "sess-cursor-1") return;
        checkpoints++;
        if (checkpoints === 1) {
          const launch = harness.launches[0]!;
          const init = { type: "system", subtype: "init", session_id: "sess-cursor-1" };
          const result = { type: "result", subtype: "success", is_error: false, session_id: "sess-cursor-1", result: "saved reply" };
          writeFileSync(launch.statePath!, [JSON.stringify(init), JSON.stringify(result), ""].join("\n"));
          writeFileSync(`${launch.statePath}.terminal.json`, JSON.stringify({
            type: "exit", code: 0, signal: null, init, result,
            native_process_group_reaped: true, reap_scope: "native_process_group", remote_authority_revoked: true,
            turn_contract_version: 1, session_contract_valid: true, stream_contract_complete: true,
            workspace_generation_manifest_path: launch.workspaceGenerationManifestPath,
          }));
          harness.children[0]!.emit(result);
          harness.identities.set(harness.children[0]!.pid!, null);
          harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
        } else {
          // Recovery has retired native/filesystem authority, but still owns
          // this checkpoint until the callback settles.
          assert.equal(adapter.runtimeCustody(handle.workAttemptId), "unknown");
          enteredCheckpoint();
          await checkpointGate;
        }
        throw new Error("Execution evidence rejected: identity_mismatch.");
      },
      settleLifecycleBeforeIdle: async () => {},
      checkpointTerminalResult: async () => { resultCheckpoints++; },
    });
    const rejected = assert.rejects(withLoopAlive(pending), /terminal recovery.*identity_mismatch/);
    await checkpointEntered;
    assert.equal(adapter.runtimeCustody(handle.workAttemptId), "unknown", "in-flight settlement still fences update");
    releaseCheckpoint();
    await rejected;
    const retainedConnection = { ...handle.providerConnection };
    assert.equal(adapter.runtimeCustody(handle.workAttemptId), "absent", "retained failed evidence owns no native work");
    assert.deepEqual(handle.providerConnection, retainedConnection, "custody observation must not clear failed identity");
    assert.ok("pid" in retainedConnection);
    assert.equal(retainedConnection.pid, harness.children[0]!.pid);
    assert.equal(resultCheckpoints, 0, "failed turn is not promoted to successful delivery");
    assert.equal(terminals.length, 0, "failed attempt is not falsely closed");
    const terminalPath = `${harness.launches[0]!.statePath}.terminal.json`;
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    assert.equal(terminal.workspace_generation_settlement.phase, "cleaned");
    assert.equal(terminal.workspace_generation_settlement.provider_continuation_id, "sess-cursor-1");
    assert.equal(existsSync(harness.launches[0]!.statePath!), true, "exact turn stream stays recoverable");
    assert.equal(harness.launches.length, 1);
    assert.deepEqual(harness.signals, [], "no live or repeated turn is needed to retire custody");
    assert.match(turnId, /^cursor:/);
    let finishRecovery!: () => void;
    const recoveryGate = new Promise<void>(resolve => { finishRecovery = resolve; });
    const recovering = adapter.recoverRoomTurn(handle, { inboxItemId: "retry-checkpoint-only", providerTurnId: turnId }, {
      checkpointProviderState: async () => {
        await recoveryGate;
        throw new Error("still blocked");
      },
    });
    const rejectedRecovery = assert.rejects(recovering, /still blocked/);
    assert.equal(adapter.runtimeCustody(handle.workAttemptId), "unknown", "direct recovery owns settlement before its first await");
    finishRecovery();
    await rejectedRecovery;
    assert.equal(adapter.runtimeCustody(handle.workAttemptId), "absent", "failed direct recovery releases only its operation hold");
    assert.deepEqual(handle.providerConnection, retainedConnection);
    assert.equal(harness.launches.length, 1, "recovery does not redispatch the native turn");
    assert.equal(readFileSync(terminalPath, "utf8"), JSON.stringify(terminal));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor Stop and turn control retain the exact child when bounded settlement fails", async () => {
  for (const operation of ["stop", "control"] as const) {
    const harness = createHarness();
    const adapter = supervisedAdapter(harness);
    const handle = await spawnDaemonLane(adapter, harness);
    const execution: NativeExecutionObservation[] = [];
    adapter.onExecution(handle, event => execution.push(event));
    let enterSettlement!: () => void;
    const settlementEntered = new Promise<void>((resolve) => { enterSettlement = resolve; });
    let releaseSettlement!: () => void;
    const settlementRelease = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, terminal => terminals.push(terminal));
    const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest({
      inboxItemId: `failed-settlement-${operation}`,
      actionId: `failed-settlement-${operation}`,
    }), {
      checkpointPreparedTurn: async () => {},
      checkpointProviderState: async () => {},
      settleLifecycleBeforeIdle: async () => {
        enterSettlement();
        await settlementRelease;
        throw new Error("injected bounded settlement failure");
      },
    });
    while (!harness.children[0]?.isReleased) await flush();
    const child = harness.children[0]!;
    child.emit({ type: "result", subtype: "success", is_error: false, result: "settled", session_id: "sess-cursor-1" });
    child.resolveExit({ type: "exit", code: 0, signal: null });
    await settlementEntered;

    const control = operation === "stop" ? adapter.stop(handle) : adapter.controlTurn(handle, null);
    releaseSettlement();
    await assert.rejects(roomTurn, /injected bounded settlement failure/);
    await assert.rejects(control, /recover/);
    assert.equal(handle.providerConnection?.processIdentity, birthIdentity(child.pid!));
    assert.equal(terminals.length, 0, `${operation} cannot emit attempt exit after settlement failure`);
    const settledPosition = execution.length;
    assert.deepEqual(await adapter.probeControl(handle), { state: "unprobeable" });
    assert.equal(execution.length, settledPosition,
      "failed settlement retains identity for recovery, not renewed control observations");
  }
});

test("stop while idle needs no signal: nothing is running, the attempt ends immediately as stopped", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  child.emit({ type: "result", subtype: "success", is_error: false, session_id: "sess-cursor-1" });
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal(handle.observedState(), "idle");

  const stopped = await adapter.stop(handle);
  assert.equal(stopped.terminalCause, "stopped");
  assert.deepEqual(harness.signals, [], "no process existed, so nothing was signalled");
  assert.equal(handle.observedState(), "stopped");
});

test("poke delivers at the boundary: refused mid-turn, runs a --resume turn when idle", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());

  await assert.rejects(adapter.poke(handle, "mid-turn message"), /no channel into a running turn/);

  const first = harness.children[0]!;
  first.emit({ type: "result", subtype: "success", is_error: false, session_id: "sess-cursor-1" });
  first.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal(handle.observedState(), "idle");

  await adapter.poke(handle, "next room event");
  assert.equal(harness.launches.length, 2, "boundary delivery runs a fresh per-turn child");
  const args = harness.launches[1]!.args;
  assert.ok(args.includes("--resume=sess-cursor-1"), "the next turn continues the recorded session without an option-alias ambiguity");
  assert.equal(args[args.length - 1], "next room event");
  assert.equal(handle.observedState(), "working");
  assert.equal(handle.pid, 5201, "the new turn's live pid is claimed while it runs");
});

test("Cursor turn control fences only the live turn child and resumes the same session without attempt terminal", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));
  let exactTurnA = "";

  const result = await withLoopAlive(adapter.controlTurn!(handle, "Apply the corrected direction.", {
    checkpointTurnStarted: async (turnId) => { exactTurnA = turnId; },
    markDispatched: async () => {},
  }));

  assert.deepEqual(result, {
    capability: "restart_resume",
    interrupted: true,
    resumed: true,
    state: "working",
  });
  assert.deepEqual(harness.signals, [{ pid: 5200, signal: "SIGTERM" }]);
  assert.deepEqual(terminals, [], "turn-child interruption never becomes attempt-terminal evidence");
  assert.equal(harness.launches.length, 2);
  assert.ok(harness.launches[1]!.args.includes("--resume=sess-cursor-1"));
  assert.equal(harness.launches[1]!.args.at(-1), "Apply the corrected direction.");
  assert.equal(handle.providerContinuationId, "sess-cursor-1");
  assert.equal(handle.observedState(), "working");
  assert.ok(exactTurnA, "legacy A receives a durable control identity before its signal");

  const staleRetry = await adapter.controlTurn!(handle, null, {
    targetTurnId: exactTurnA,
    checkpointTurnStarted: async () => { throw new Error("retry must not adopt B"); },
    markDispatched: async () => { throw new Error("retry must not signal B"); },
  });
  assert.deepEqual(staleRetry, {
    capability: "restart_resume", interrupted: false, resumed: false, state: "working",
  });
  assert.deepEqual(harness.signals, [{ pid: 5200, signal: "SIGTERM" }], "stale retry leaves successor B untouched");
});

test("resume presents the recorded session and a stranger session id mid-stream is a protocol violation", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.resume(
    { workAttemptId: "wa-cursor-1", providerContinuationId: "sess-old" },
    spawnRequest(),
  );
  assert.ok(harness.launches[0]!.args.includes("--resume=sess-old"));
  assert.equal(handle.providerContinuationId, "sess-old", "the SAME session continues");

  // A stranger session id in the init itself must not silently become the
  // continuation: the launch is REJECTED and the fenced turn child terminated.
  const wrong = createHarness({ sessionId: "sess-stranger" });
  const wrongAdapter = new CursorProviderAdapter({ dependencies: wrong.dependencies });
  await assert.rejects(wrongAdapter.resume(
    { workAttemptId: "wa-cursor-2", providerContinuationId: "sess-old" },
    spawnRequest({ workAttemptId: "wa-cursor-2" }),
  ), /violated the session contract/);
  assert.deepEqual(wrong.signals.map((entry) => entry.signal), ["SIGTERM"], "the mismatched turn child was fenced");
  assert.equal(wrong.children[0]!.alive, false);

  const aliasHarness = createHarness();
  const aliasAdapter = new CursorProviderAdapter({ dependencies: aliasHarness.dependencies });
  await assert.rejects(aliasAdapter.resume(
    { workAttemptId: "wa-cursor-alias", providerContinuationId: "--yolo" },
    spawnRequest({ workAttemptId: "wa-cursor-alias" }),
  ), /not a valid Cursor session identity/);
  assert.equal(aliasHarness.launches.length, 0, "an option-shaped session id never reaches argv");
});

test("startup gates on a valid init, not arbitrary stdout bytes (msg_1758)", async () => {
  // Raw diagnostics BEFORE init are published as evidence but do not start the
  // turn; the handle only returns once init supplies the session identity.
  const harness = createHarness({ silent: true });
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
    turnStartTimeoutMs: 500,
  });
  const spawning = adapter.spawn(spawnRequest());
  await waitFor(() => harness.children[0]?.isReleased === true);
  const child = harness.children[0]!;
  child.emitRaw("cursor-agent: warming up model cache");
  await flush();
  child.emit({ type: "system", subtype: "init", session_id: "sess-late-init" });
  const handle = await spawning;
  assert.equal(handle.providerContinuationId, "sess-late-init", "init, not raw bytes, supplies the continuation");
  assert.ok(streamEvents.some((event) => event.method === "stdout/raw"), "pre-init diagnostics still published");

  // Raw-only output that never becomes an init times out and fences the child.
  const rawOnly = createHarness({ silent: true });
  const rawOnlyAdapter = new CursorProviderAdapter({ dependencies: rawOnly.dependencies, turnStartTimeoutMs: 60, stopGraceMs: 30 });
  const rawSpawning = rawOnlyAdapter.spawn(spawnRequest({ workAttemptId: "wa-cursor-7" }));
  rawSpawning.catch(() => {});
  await waitFor(() => rawOnly.children[0]?.isReleased === true);
  rawOnly.children[0]!.emitRaw("just noise, never an init");
  await assert.rejects(rawSpawning, /no stream-json init within the startup bound/);
  assert.equal(rawOnly.children[0]!.alive, false, "the unobservable child was terminated and awaited");
});

test("only a genuine system/init with a session id satisfies readiness — other system events do not (msg_1807)", async () => {
  const harness = createHarness({ silent: true });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, turnStartTimeoutMs: 500 });
  const spawning = adapter.spawn(spawnRequest());
  await waitFor(() => harness.children[0]?.isReleased === true);
  const child = harness.children[0]!;

  // A non-init system event — even one carrying a session id — must not start
  // the turn or become the continuation identity for readiness.
  child.emit({ type: "system", subtype: "status", session_id: "sess-early" });
  await flush();

  child.emit({ type: "system", subtype: "init", session_id: "sess-real-init" });
  const handle = await spawning;
  assert.equal(handle.observedState(), "working", "readiness resolved only after the real init");
  assert.equal(handle.providerContinuationId, "sess-real-init");
});

test("an init that carries no session id is fenced immediately as a session-contract violation (msg_1807)", async () => {
  const harness = createHarness({ silent: true });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, turnStartTimeoutMs: 500 });
  const spawning = adapter.spawn(spawnRequest());
  spawning.catch(() => {});
  await waitFor(() => harness.children[0]?.isReleased === true);
  harness.children[0]!.emit({ type: "system", subtype: "init" });
  await assert.rejects(spawning, /violated the session contract/);
  assert.deepEqual(harness.signals.map((entry) => entry.signal), ["SIGTERM"], "the sessionless child was fenced, not awaited to timeout");
  assert.equal(harness.children[0]!.alive, false);
});

test("a late Cursor protocol callback never signals a recycled wrapper PID", async () => {
  const harness = createHarness({ silent: true, dieOnSigterm: false });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, turnStartTimeoutMs: 500 });
  const spawning = adapter.spawn(spawnRequest());
  spawning.catch(() => {});
  await waitFor(() => harness.children[0]?.isReleased === true);
  harness.identities.set(5200, "unrelated-recycled-birth");

  harness.children[0]!.emit({ type: "system", subtype: "init" });

  assert.deepEqual(harness.signals, [], "the late stream callback is fenced by exact process birth");
  harness.children[0]!.resolveExit({ type: "exit", code: 1, signal: null });
  await assert.rejects(spawning, /violated the session contract/);
});

test("a child that exits before init rejects the launch and records terminal evidence", async () => {
  const harness = createHarness({ silent: true });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, turnStartTimeoutMs: 500 });
  const spawning = adapter.spawn(spawnRequest());
  spawning.catch(() => {});
  await waitFor(() => harness.children[0]?.isReleased === true);
  harness.identities.set(5200, null);
  harness.children[0]!.resolveExit({ type: "exit", code: 1, signal: null });
  await assert.rejects(spawning, /exited before reporting its stream-json init/);
});

test("a streaming-but-quiet turn stays working; a completely silent turn is fenced with no orphan", async () => {
  const streaming = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: streaming.dependencies, turnStartTimeoutMs: 40 });
  const handle = await adapter.spawn(spawnRequest());
  await flush();
  await flush();
  assert.equal(handle.observedState(), "working", "long quiet turns are not dead");
  assert.equal(streaming.signals.length, 0);

  const silent = createHarness({ silent: true });
  const silentAdapter = new CursorProviderAdapter({ dependencies: silent.dependencies, turnStartTimeoutMs: 40, stopGraceMs: 30 });
  await assert.rejects(silentAdapter.spawn(spawnRequest({ workAttemptId: "wa-cursor-3" })), /no stream-json init within the startup bound/);
  assert.equal(silent.children[0]!.alive, false, "the unobservable child was terminated and awaited");
});

test("post-release Cursor startup cleanup never signals a recycled wrapper PID", async () => {
  const harness = createHarness({ silent: true, dieOnSigterm: false });
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    turnStartTimeoutMs: 30,
    stopGraceMs: 10,
  });
  const spawning = adapter.spawn(spawnRequest());
  spawning.catch(() => {});
  await waitFor(() => harness.children[0]?.isReleased === true);
  harness.identities.set(5200, "unrelated-recycled-birth");

  await assert.rejects(spawning, /no stream-json init within the startup bound/);
  assert.deepEqual(harness.signals, [], "timeout cleanup revalidates the exact process birth before TERM");
});

test("a recycled pid can neither authenticate an attach nor be signalled; unverifiable identity stays ambiguous", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  harness.identities.set(7777, "some-other-birth");
  assert.equal(await adapter.attach({
    workAttemptId: "wa-x",
    providerContinuationId: "sess-x",
    providerConnection: { kind: "cursor_cli", pid: 7777, processIdentity: "recorded-birth" },
  }), null, "recorded turn child proven absent");
  assert.deepEqual(harness.signals, [], "the recycled pid was never signalled");

  harness.identities.set(8888, undefined);
  await assert.rejects(adapter.attach({
    workAttemptId: "wa-y",
    providerContinuationId: "sess-y",
    providerConnection: { kind: "cursor_cli", pid: 8888, processIdentity: "birth-y" },
  }), /ambiguous/);

  // An idle lane records no pid: its absence is exact, not ambiguous.
  assert.equal(await adapter.attach({
    workAttemptId: "wa-z",
    providerContinuationId: "sess-z",
    providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
  }), null);
});

test("attach to a live checkpointed Cursor wrapper returns promptly without signalling or launching beside it", async () => {
  const harness = createHarness({ dieOnSigterm: false });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 30 });
  const handle = await adapter.spawn(spawnRequest());

  const fresh = new CursorProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 30 });
  await assert.rejects(fresh.attach({
    workAttemptId: "wa-cursor-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: { kind: "cursor_cli", pid: 5200, processIdentity: birthIdentity(5200) },
  }), /still running/);
  assert.deepEqual(harness.signals, [], "a successor never interrupts the exact checkpointed writer");
  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "durably completed", session_id: handle.providerContinuationId,
  });
  harness.identities.set(5200, null);
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  const attached = await fresh.attach({
    workAttemptId: "wa-cursor-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: { kind: "cursor_cli", pid: 5200, processIdentity: birthIdentity(5200) },
  });

  assert.equal(attached, null, "after natural terminal evidence, the lane is provably absent for bounded resume");
  assert.deepEqual(harness.signals, []);
  assert.equal(harness.launches.length, 1, "attach never launches a second writer");
});

test("exact-reference stop signals only the verified Cursor wrapper birth", async () => {
  const harness = createHarness();
  const fresh = new CursorProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 100 });
  harness.identities.set(6100, birthIdentity(6100));
  const exact = fresh.stopRef!({
    workAttemptId: "wa-stop-ref",
    providerContinuationId: "sess-stop-ref",
    providerConnection: { kind: "cursor_cli", pid: 6100, processIdentity: birthIdentity(6100) },
  });
  await flush();
  harness.identities.set(6100, null);
  const terminal = await exact;
  assert.equal(terminal.terminalCause, "stopped");
  assert.deepEqual(harness.signals, [{ pid: 6100, signal: "SIGTERM" }]);

  harness.identities.set(6200, "reused-birth");
  await fresh.stopRef!({
    workAttemptId: "wa-reused-ref",
    providerContinuationId: "sess-reused-ref",
    providerConnection: { kind: "cursor_cli", pid: 6200, processIdentity: "recorded-birth" },
  });
  assert.equal(harness.signals.some((entry) => entry.pid === 6200), false, "a recycled pid is never signalled");
});

test("a result line delivered after exit resolution still counts: the lane goes idle, never falsely terminal (msg_1780)", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  // Simulate the drain race: exit evidence resolves first, the buffered final
  // result line lands one microtask later (as a still-flushing pipe would).
  const child = harness.children[0]!;
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await Promise.resolve();
  child.emit({ type: "result", subtype: "success", is_error: false, session_id: "sess-cursor-1" });
  await flush();

  assert.deepEqual(terminals, [], "a cleanly completed turn is never misread as a crash");
  assert.equal(handle.observedState(), "idle");
});

test("the proven usage-limit signature classifies as provider_quota, not crashed (msg_1708)", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  // init + user emitted normally, then the stream stops with NO result, the
  // ActionRequiredError lands on stderr, and the process exits 1.
  const child = harness.children[0]!;
  child.emit({ type: "user", session_id: "sess-cursor-1" });
  child.stderr = "ActionRequiredError: You've hit your usage limit. Switch to a different model or set a Spend Limit.";
  child.resolveExit({ type: "exit", code: 1, signal: null });
  await flush();

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]!.terminalCause, "provider_quota", "an account condition is never recorded as a crash");
  assert.equal(terminals[0]!.exitCode, 1);
  assert.equal(handle.observedState(), "failed");

  // The same no-result death WITHOUT the quota signature stays a crash.
  const crash = createHarness();
  const crashAdapter = new CursorProviderAdapter({ dependencies: crash.dependencies });
  const crashHandle = await crashAdapter.spawn(spawnRequest({ workAttemptId: "wa-cursor-9" }));
  const crashTerminals: ProviderTerminalPayload[] = [];
  crashAdapter.onExit(crashHandle, (terminal) => crashTerminals.push(terminal));
  crash.children[0]!.stderr = "segfault or something else entirely";
  crash.children[0]!.resolveExit({ type: "exit", code: 1, signal: null });
  await flush();
  assert.equal(crashTerminals[0]!.terminalCause, "crashed");
});

test("stream evidence is bounded, redacted, and ordered; non-JSON output keeps method identity", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
  });
  await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;

  child.emit({ type: "assistant", session_id: "sess-cursor-1", message: { role: "assistant", content: [{ type: "text", text: "hi room" }] }, api_key: "sk-nope" });
  child.emit({ type: "system", subtype: "init", session_id: "sess-cursor-1" });
  child.emitRaw("cursor-agent plain diagnostics line");
  await flush();

  const assistant = streamEvents.find((event) => event.method === "assistant");
  assert.ok(assistant);
  assert.equal(assistant!.payloadRedacted, true);
  assert.equal((assistant!.payload as { api_key?: unknown }).api_key, "[REDACTED]");
  const display = streamEvents.find((event) => event.method === "item/agentMessage/delta");
  assert.equal((display?.payload as { delta?: unknown } | undefined)?.delta, "hi room");
  assert.match(String((display?.payload as { partId?: unknown } | undefined)?.partId), /^cursor:[0-9a-f-]+:assistant:\d+$/);
  assert.ok(streamEvents.some((event) => event.method === "stdout/raw"), "non-JSON output preserved as bounded evidence");
  assert.equal(streamEvents.filter((event) => event.method === "system/init_duplicate").length, 1,
    "a duplicate same-session init remains diagnostics and cannot reset the display generation");
  const sequences = streamEvents.map((event) => event.sequence);
  assert.deepEqual([...sequences].sort((a, b) => a - b), sequences, "stream sequence is ordered");
});

test("a Cursor result terminalizes any tool card that never emitted its own completion", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
  });
  await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  child.emit({
    type: "tool_call", subtype: "started", call_id: "tool-open",
    tool_call: { readToolCall: { args: { path: "README.md" } } },
    session_id: "sess-cursor-1",
  });
  child.emit({
    type: "result", subtype: "success", is_error: false, result: "done",
    session_id: "sess-cursor-1",
  });
  await flush();
  const toolStatuses = streamEvents
    .filter((event) => event.method === "item/toolCall/updated")
    .map((event) => (event.payload as { status?: unknown }).status);
  assert.deepEqual(toolStatuses, ["running", "interrupted"]);
});

test("Cursor live display refuses a mismatched native tool terminal", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
  });
  const handle = await adapter.spawn(spawnRequest());
  const executionEvents: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => executionEvents.push(event));
  const child = harness.children[0]!;

  child.emit({
    type: "tool_call", subtype: "started", call_id: "tool-mismatch",
    tool_call: { readToolCall: { args: { path: "README.md" } } },
    session_id: "sess-cursor-1",
  });
  child.emit({
    type: "tool_call", subtype: "started", call_id: "tool-mismatch",
    tool_call: { writeToolCall: { args: { path: "other.ts" } } },
    session_id: "sess-cursor-1",
  });
  child.emit({
    type: "tool_call", subtype: "completed", call_id: "tool-mismatch",
    tool_call: { writeToolCall: { result: { success: {} } } },
    session_id: "sess-cursor-1",
  });
  child.emit({
    type: "result", subtype: "success", is_error: false, result: "done",
    session_id: "sess-cursor-1",
  });
  await flush();

  const toolUpdates = streamEvents
    .filter((event) => event.method === "item/toolCall/updated")
    .map((event) => ({
      tool: (event.payload as { tool?: unknown }).tool,
      status: (event.payload as { status?: unknown }).status,
    }));
  assert.deepEqual(toolUpdates, [
    { tool: "readToolCall", status: "running" },
    { tool: "readToolCall", status: "interrupted" },
  ], "an uncorrelated terminal cannot complete or erase the exact running tool card");
  assert.equal(executionEvents.some(({ fact }) => fact.domain === "execution"
    && fact.executionId === "tool-mismatch" && fact.kind === "completed"), false,
  "the visual and typed projections both reject the mismatched terminal");
});

test("Cursor live display leaves invalid native terminals open until the turn result interrupts them", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
  });
  const handle = await adapter.spawn(spawnRequest());
  const executionEvents: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => executionEvents.push(event));
  const child = harness.children[0]!;
  const session_id = "sess-cursor-1";

  child.emit({
    type: "tool_call", subtype: "started", call_id: "contradictory-read", session_id,
    tool_call: { readToolCall: { args: { path: "README.md" } } },
  });
  child.emit({
    type: "tool_call", subtype: "completed", call_id: "contradictory-read", session_id,
    tool_call: { readToolCall: { result: { success: {}, failure: { errorMessage: "boom" } } } },
  });
  child.emit({
    type: "tool_call", subtype: "started", call_id: "background-shell", session_id,
    tool_call: { shellToolCall: { args: { command: "long-running-command" } } },
  });
  child.emit({
    type: "tool_call", subtype: "completed", call_id: "background-shell", session_id,
    tool_call: { shellToolCall: { result: { success: { exitCode: 0, shellId: 7 }, isBackground: true } } },
  });
  child.emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id });
  await flush();

  assert.deepEqual(streamEvents
    .filter((event) => event.method === "item/toolCall/updated")
    .map((event) => ({
      tool: (event.payload as { tool?: unknown }).tool,
      status: (event.payload as { status?: unknown }).status,
    })), [
    { tool: "readToolCall", status: "running" },
    { tool: "shellToolCall", status: "running" },
    { tool: "readToolCall", status: "interrupted" },
    { tool: "shellToolCall", status: "interrupted" },
  ], "invalid terminals cannot visually complete a card that typed execution keeps open");
  assert.equal(executionEvents.some(({ fact }) => fact.domain === "execution"
    && ["contradictory-read", "background-shell"].includes(fact.executionId)
    && fact.kind === "completed"), false,
  "the same shared terminal contract rejects both typed completions");
});

test("a Cursor turn that exits without result still terminalizes every running tool card", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
  });
  await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  child.emit({
    type: "tool_call", subtype: "started", call_id: "tool-no-result",
    tool_call: { shellToolCall: { args: { command: "false" } } },
    session_id: "sess-cursor-1",
  });
  child.resolveExit({ type: "exit", code: 1, signal: null });
  await flush();
  const toolStatuses = streamEvents
    .filter((event) => event.method === "item/toolCall/updated")
    .map((event) => (event.payload as { status?: unknown }).status);
  assert.deepEqual(toolStatuses, ["running", "interrupted"],
    "a result-less crash cannot leave a cross-turn Inspector card stuck running");
});

test("a post-init provider checkpoint failure terminalizes tools started while the checkpoint was pending", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
    supervisedProfileFactory: (input) => {
      const root = input.profileRoot ?? `/private/cursor/${input.workAttemptId}`;
      return {
        homeDir: `${root}/home`, configDir: `${root}/config`, dataDir: `${root}/data`, cacheDir: `${root}/cache`,
        env: { HOME: `${root}/home` },
        ...wrapperHostedMcpFixture(root),
      };
    },
  });
  const handle = await spawnDaemonLane(adapter, harness);
  await assert.rejects(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "checkpoint-tool-terminal" }), {
    checkpointTurnStarted: async () => {},
    checkpointProviderState: async (state) => {
      if (state.providerContinuationId !== "sess-cursor-1") return;
      harness.children[0]!.emit({
        type: "tool_call", subtype: "started", call_id: "tool-during-checkpoint",
        tool_call: { readToolCall: { args: { path: "README.md" } } },
        session_id: "sess-cursor-1",
      });
      throw new Error("injected post-init checkpoint failure");
    },
  }), /checkpoint.*failure/i);
  const toolStatuses = streamEvents
    .filter((event) => event.method === "item/toolCall/updated")
    .map((event) => (event.payload as { status?: unknown }).status);
  assert.deepEqual(toolStatuses, ["running", "interrupted"],
    "checkpoint teardown cannot strand a running tool outside completeTurn");
});
