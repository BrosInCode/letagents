import "./isolated-home.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  CURSOR_NO_ROOM_REPLY_SENTINEL,
  CursorProviderAdapter,
  type CursorProviderAdapterDependencies,
} from "#provider-runtime/agents/cursor-provider-adapter.js";
import type { NativeExecutionObservation } from "#provider-runtime/agents/provider-adapter.js";
import { expectedCursorSandbox } from "./platform.js";
import { removeTestDirectory } from "./harness.js";
import {
  argValue,
  wrapperHostedMcpFixture,
  createHarness,
  FakeCursorChild,
  daemonSpawnRequest,
  supervisedAdapter,
  spawnDaemonLane,
  roomTurnRequest,
  flush,
  waitFor,
  withLoopAlive,
  WA_CURSOR_CWD,
  cursorTmp,
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

test("a prepared wrapper whose retirement keeps failing reports every earlier cause (task_21)", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-prepared-retirement-causes-"));
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
            error: "Cursor wrapper startup failed: probe startup cause",
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
    let settlements = 0;
    const turn = adapter.runRoomTurn(handle, roomTurnRequest(), {
      checkpointPreparedTurn: async () => { detach.abort(); },
      checkpointProviderState: async () => {},
      // Both retirements (the launch path, then exact-turn recovery) fail, as the capture flush did on Windows.
      settleLifecycleBeforeIdle: async () => {
        settlements += 1;
        throw new Error(`Execution evidence rejected: identity_mismatch (settlement ${settlements}).`);
      },
      detachSignal: detach.signal,
    });
    await assert.rejects(turn, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // Recovery retirement failure, with the not-dispatched cause it was retiring.
      assert.match(message, /could not retire its exact child birth: Execution evidence rejected: identity_mismatch \(settlement 2\)/);
      assert.match(message, /original cause: Cursor's prepared wrapper exited before native dispatch/);
      assert.match(message, /Wrapper cause: Cursor wrapper startup failed: probe startup cause/);
      // The first (launch-path) retirement failure and its own cause are kept too.
      assert.match(message, /after launch failure: Cursor prepared wrapper was reaped, but its durable idle-state retirement failed: Execution evidence rejected: identity_mismatch \(settlement 1\)/);
      assert.match(message, /\(settlement 1\)\. \(original cause: Cursor turn preparation was interrupted before native dispatch\.\)/);
      const stack = String((error as Error).stack ?? "");
      assert.equal(message.split("after launch failure:").length - 1, 1, "the launch failure appears once in the message");
      assert.equal(stack.split("after launch failure:").length - 1, 1, "a logged stack shows the launch failure exactly once");
      return true;
    });
    assert.equal(settlements, 2);
    assert.equal(harness.children.length, 1, "a failed retirement never redispatches the inbox item");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two pre-init not_started Cursor turns recover atomically across resumed handles, permit Stop, and deliver the next turn (task_21)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { DaemonStateSchema } = await import(new URL("../../daemon/daemon-state-database.ts", import.meta.url).href);
  const { ManifestStore } = await import(new URL("../../daemon/manifest-store.ts", import.meta.url).href);
  const { SupervisedAgentInboxStore } = await import(new URL("../../daemon/supervised-agent-inbox-store.ts", import.meta.url).href);
  const { ExecutionCaptureCoordinator } = await import(new URL("../../daemon/execution-capture-coordinator.ts", import.meta.url).href);
  const { executionRuntimeStorageIdentity } = await import(new URL("../../daemon/execution-shadow-store.ts", import.meta.url).href);
  const { serializeDaemonDeploymentId } = await import(new URL("../../daemon/manifest-entry-projection.ts", import.meta.url).href);
  const { exitedRuntimesToArchive } = await import(new URL("../../daemon/runtime-recovery-journal.ts", import.meta.url).href);

  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-two-turn-cr8-"));
  const dbPath = join(root, "daemon-state.sqlite");
  const at = "2026-08-31T00:00:00.000Z";
  const agentId = "cursor-cr8-agent";
  const roomId = "room-cr8";
  const workAttemptId = "wa-cursor-1";
  const sessionId = "agent-session-cr8";
  const credentialRef = "cred-cr8";
  const apiUrl = "https://letagents.test";

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON");
  new DaemonStateSchema().createSchema(db);
  const manifest = new ManifestStore(dbPath);
  manifest.attachDatabase(db);
  let onInboxMutation: () => void = () => undefined;
  const inbox = new SupervisedAgentInboxStore(dbPath, () => at, () => onInboxMutation());
  inbox.attachDatabase(db);

  const harness = createHarness({ silent: true });
  let launchCount = 0;
  let releaseTurn3Completion!: () => void;
  const turn3Ready = new Promise<void>((resolve) => { releaseTurn3Completion = resolve; });
  let signalTurn3Init!: () => void;
  const turn3InitObserved = new Promise<void>((resolve) => { signalTurn3Init = resolve; });

  const dependencies: CursorProviderAdapterDependencies = {
    ...harness.dependencies,
    prepareTurnState(path) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    },
    launchTurn(input) {
      launchCount += 1;
      const attempt = launchCount;
      const child = harness.dependencies.launchTurn(input) as FakeCursorChild;
      if (attempt <= 2 && input.statePath) {
        writeFileSync(`${input.statePath}.terminal.json`, JSON.stringify({
          type: "not_started",
          error: `Cursor wrapper startup failed: probe startup cause #${attempt}`,
          native_process_group_reaped: true,
          reap_scope: "native_process_group",
          remote_authority_revoked: true,
        }));
      }
      const originalRelease = child.release.bind(child);
      child.release = () => {
        originalRelease();
        if (attempt <= 2) {
          queueMicrotask(() => {
            child.resolveExit({ type: "exit", code: 1, signal: null });
          });
        } else {
          queueMicrotask(() => {
            child.emit({ type: "system", subtype: "init", session_id: "sess-cursor-turn3", model: "cursor-fast" });
            signalTurn3Init();
            void turn3Ready.then(() => {
              child.emit({
                type: "assistant",
                message: { role: "assistant", content: [{ type: "text", text: "Turn 3 delivered after undispatched recovery" }] },
              });
              child.emit({
                type: "result",
                subtype: "success",
                is_error: false,
                result: "Turn 3 delivered after undispatched recovery",
                session_id: "sess-cursor-turn3",
              });
              child.resolveExit({ type: "exit", code: 0, signal: null });
            });
          });
        }
      };
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

  const diagnostics: string[] = [];
  let currentHandle: Awaited<ReturnType<typeof adapter.spawn>> | undefined;
  let currentGeneration = "gen-1";
  let currentInstallation: {
    nonce: symbol;
    listenerLeaseNonce: symbol;
    entryId: string;
    handle: NonNullable<typeof currentHandle>;
    executionGenerationId: string;
    workAttemptId: string;
    providerContinuationId: string;
    providerConnection: { kind: "cursor_cli"; pid: number | null; processIdentity: string | null };
    configurationRevision: number;
    authorityMode: "typed" | null;
  } | null = null;

  const capture = new ExecutionCaptureCoordinator(db, {
    provider: {
      onExecution: (handle: object, listener: (event: NativeExecutionObservation) => void) =>
        adapter.onExecution(handle as Parameters<typeof adapter.onExecution>[0], listener),
    },
    currentHandle: () => currentHandle,
    daemonGeneration: () => 1,
    diagnostic: (_id: string, code: string) => diagnostics.push(code),
  });
  onInboxMutation = () => capture.refresh(agentId);

  const readVersion = () => Number((db.prepare("SELECT version FROM agents WHERE agent_id=?").get(agentId) as { version: number }).version);
  const readObservedState = () => String((db.prepare("SELECT observed_state FROM agents WHERE agent_id=?").get(agentId) as { observed_state: string }).observed_state);

  const installHandle = (handle: NonNullable<typeof currentHandle>, generationId: string) => {
    currentHandle = handle;
    currentGeneration = generationId;
    const leaseNonce = Symbol(`lease-${generationId}`);
    currentInstallation = Object.freeze({
      nonce: Symbol(`inst-${generationId}-idle`),
      listenerLeaseNonce: leaseNonce,
      entryId: agentId,
      handle,
      executionGenerationId: generationId,
      workAttemptId,
      providerContinuationId: handle.providerContinuationId!,
      providerConnection: { kind: "cursor_cli" as const, pid: null, processIdentity: null },
      configurationRevision: 1,
      authorityMode: null,
    });
    capture.install(currentInstallation as unknown as Parameters<typeof capture.install>[0]);
  };

  const advanceHandle = (
    handle: NonNullable<typeof currentHandle>,
    providerContinuationId: string,
    providerConnection: { kind: "cursor_cli"; pid: number | null; processIdentity: string | null },
    authorityMode: "typed" | null,
  ) => {
    currentInstallation = Object.freeze({
      nonce: Symbol(`inst-${currentGeneration}-${providerConnection.pid ?? "idle"}`),
      listenerLeaseNonce: currentInstallation!.listenerLeaseNonce,
      entryId: agentId,
      handle,
      executionGenerationId: currentGeneration,
      workAttemptId,
      providerContinuationId,
      providerConnection: { ...providerConnection },
      configurationRevision: 1,
      authorityMode,
    });
    capture.advance(currentInstallation as unknown as Parameters<typeof capture.advance>[0]);
    if (authorityMode === "typed" && providerConnection.pid !== null && providerConnection.processIdentity) {
      capture.prepared({
        agentId,
        executionGenerationId: currentGeneration,
        handle,
        connection: { ...providerConnection },
        configurationRevision: 1,
      });
    }
  };

  const turnCallbacks = (
    handle: NonNullable<typeof currentHandle>,
    inboxItemId: string,
    generationId: string,
    state: { turnId: string | null; continuation: string; connection: { kind: "cursor_cli"; pid: number | null; processIdentity: string | null }; versions: number[] },
  ) => ({
    checkpointPreparedTurn: async (checkpoint: {
      providerTurnId: string;
      providerContinuationId: string;
      providerConnection: { kind: string; pid: number | null; processIdentity?: string | null };
    }) => {
      const loaded = await manifest.getEntryWithVersion(agentId);
      assert.ok(loaded);
      const nextConnection = {
        kind: "cursor_cli" as const,
        pid: checkpoint.providerConnection.pid,
        processIdentity: checkpoint.providerConnection.processIdentity ?? null,
      };
      const result = await manifest.checkpointCursorPreparedTurn(loaded.version, {
        agentId,
        roomId,
        inboxItemId,
        providerTurnId: checkpoint.providerTurnId,
        providerContinuationId: checkpoint.providerContinuationId,
        workAttemptId,
        executionGenerationId: generationId,
        agentSessionId: sessionId,
        credentialRef,
        apiUrl,
        expectedProviderContinuationId: state.continuation,
        expectedProviderConnection: state.connection,
        providerConnection: nextConnection,
        configurationRevision: 1,
        observedAt: at,
      });
      state.turnId = checkpoint.providerTurnId;
      state.continuation = checkpoint.providerContinuationId;
      state.connection = nextConnection;
      state.versions.push(result.version);
      advanceHandle(handle, state.continuation, nextConnection, "typed");
    },
    checkpointProviderState: async (checkpoint: {
      providerContinuationId: string;
      providerConnection: { kind: string; pid: number | null; processIdentity?: string | null };
    }) => {
      const loaded = await manifest.getEntryWithVersion(agentId);
      assert.ok(loaded);
      const nextConnection = {
        kind: "cursor_cli" as const,
        pid: checkpoint.providerConnection.pid,
        processIdentity: checkpoint.providerConnection.processIdentity ?? null,
      };
      const result = await manifest.checkpointCursorProviderState(loaded.version, {
        agentId,
        roomId,
        inboxItemId,
        providerTurnId: state.turnId!,
        workAttemptId,
        executionGenerationId: generationId,
        agentSessionId: sessionId,
        credentialRef,
        apiUrl,
        expectedProviderContinuationId: state.continuation,
        expectedProviderConnection: state.connection,
        providerContinuationId: checkpoint.providerContinuationId,
        providerConnection: nextConnection,
        observedAt: at,
      });
      state.continuation = checkpoint.providerContinuationId;
      state.connection = nextConnection;
      state.versions.push(result.version);
      advanceHandle(handle, state.continuation, nextConnection, nextConnection.pid === null ? null : "typed");
    },
    settleLifecycleBeforeIdle: async () => {
      capture.flush(currentInstallation as unknown as Parameters<typeof capture.flush>[0]);
      state.versions.push(readVersion());
    },
  });

  let turn3Promise: Promise<unknown> | null = null;
  try {
    const idleConnection = { kind: "cursor_cli" as const, pid: null, processIdentity: null };
    const handle1 = await adapter.spawn(daemonSpawnRequest({ cwd: root, workAttemptId }));
    const initialContinuation = handle1.providerContinuationId!;

    db.prepare(`INSERT INTO work_attempts(work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
      VALUES(?,?,?,1,?,'repo','remote','rev','/private/bare','active',?)`)
      .run(workAttemptId, agentId, agentId, root, at);
    db.prepare("INSERT INTO work_attempt_executions VALUES(?,?,?,'test',1,NULL)").run("gen-1", workAttemptId, at);
    db.prepare(`INSERT INTO agents(agent_id,sort_order,version,created_by,created_at,display_name,room_id,provider,charter,config_revision,runtime_configuration_revision,desired_state,observed_state,condition,deployment_id,run_id,work_attempt_id,provider_work_attempt_id,provider_continuation_id,provider_execution_generation_id,provider_connection_json)
      VALUES(?,0,6,'owner',?,'Cursor CR8',?,'cursor','charter',1,1,'running','idle','none',?,?,?,?,?,?,?)`)
      .run(agentId, at, roomId, serializeDaemonDeploymentId(agentId, "gen-1"), "gen-1", workAttemptId, workAttemptId, initialContinuation, "gen-1", JSON.stringify(idleConnection));
    db.prepare(`INSERT INTO worker_session_bindings(entry_id,room_id,work_attempt_id,execution_generation_id,agent_session_id,credential_ref,api_url,room_cursor,last_sequence,last_observed_at_ms,binding_epoch,updated_at)
      VALUES(?,?,?,?,?,?,?,NULL,0,?,1,?)`)
      .run(agentId, roomId, workAttemptId, "gen-1", sessionId, credentialRef, apiUrl, Date.parse(at), at);

    const [item] = await inbox.ingestPoll({
      agent_id: agentId,
      room_id: roomId,
      last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { id: "1", text: "hello" }, activation: { for_current_agent: { decision: "activate" } } }],
    });
    assert.ok(item);
    await inbox.claimHead(agentId);
    await inbox.checkpointDispatchIntent(item.inbox_item_id);

    installHandle(handle1, "gen-1");
    await flush();

    // --- Turn 1 (handle1, gen-1): exits pre-init (not_started #1), leaving runs(T1, R1, state='lost') and R1 exited ---
    assert.equal(readVersion(), 6);
    const turn1State = { turnId: null as string | null, continuation: initialContinuation, connection: { ...idleConnection }, versions: [] as number[] };
    await assert.rejects(
      adapter.runRoomTurn(handle1, roomTurnRequest({ inboxItemId: item.inbox_item_id, actionId: "action-1" }), turnCallbacks(handle1, item.inbox_item_id, "gen-1", turn1State)),
      /exited before reporting its stream-json init/,
    );
    assert.ok(turn1State.turnId);
    // Exact version gap from msg_3018:
    // 6 -> 7 (checkpointCursorPreparedTurn), 7 -> 8 (projectLifecycleToAgent turn/lost -> failed), 8 -> 9 (checkpointCursorProviderState -> idle).
    assert.deepEqual(turn1State.versions, [7, 8, 9],
      "Turn 1 accounts for every version increment without audit rows: prepared(7), lifecycle turn/lost(8), idle checkpoint(9)");
    assert.equal(readVersion(), 9);
    assert.equal(readObservedState(), "failed", "Turn 1 turn/lost projected observed_state='failed' directly onto agents");

    const child1 = harness.children[0]!;
    const runtime1 = executionRuntimeStorageIdentity(agentId, "gen-1", "cursor_cli", child1.pid!, harness.dependencies.getProcessIdentity(child1.pid!)!);
    const run1 = db.prepare("SELECT state,side_effects,runtime_generation_id FROM runs WHERE agent_id=? AND provider_turn_id=?")
      .get(agentId, turn1State.turnId) as { state: string; side_effects: string; runtime_generation_id: string };
    assert.deepEqual({ ...run1 }, { state: "lost", side_effects: "none", runtime_generation_id: runtime1 });
    assert.equal((db.prepare("SELECT runtime_state FROM execution_runtime_generations WHERE runtime_generation_id=?").get(runtime1) as { runtime_state: string }).runtime_state, "exited");

    // Delivery records result_recovery for Turn 1 and transitions back to pending for resume recovery.
    await inbox.recordRetryFailure(item.inbox_item_id, { domain: "result_recovery", error: "startup failed" });
    await inbox.transition(item.inbox_item_id, "pending");
    await inbox.claimHead(agentId);

    // Resume on a fresh handle2 (gen-2, fresh ProviderExecutionObserver sourceId).
    db.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='gen-1'")
      .run(JSON.stringify({ ended_at: at, exit_code: 1, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "crashed", actor: "test", generation: 1, provider_continuation_id: initialContinuation }));
    db.prepare("INSERT INTO work_attempt_executions VALUES(?,?,?,'test',2,NULL)").run("gen-2", workAttemptId, at);
    db.prepare("UPDATE agents SET observed_state='idle',deployment_id=?,run_id='gen-2',provider_execution_generation_id='gen-2',provider_connection_json=?,version=version+1 WHERE agent_id=?")
      .run(serializeDaemonDeploymentId(agentId, "gen-2"), JSON.stringify(idleConnection), agentId);
    db.prepare("UPDATE worker_session_bindings SET execution_generation_id='gen-2' WHERE entry_id=?").run(agentId);
    const versionAfterResume = readVersion();
    assert.equal(versionAfterResume, 10);

    // exitedRuntimesToArchive skips R1 while the inbox item is still active (the exact cr8 precondition).
    const resumedEntry = await manifest.getEntry(agentId);
    assert.deepEqual(exitedRuntimesToArchive(db, resumedEntry), [], "active inbox item keeps R1 out of generic exited-runtime archival");

    const handle2 = await adapter.resume(
      { workAttemptId, providerContinuationId: initialContinuation, providerConnection: idleConnection },
      daemonSpawnRequest({ cwd: root, workAttemptId }),
    );
    installHandle(handle2, "gen-2");
    await flush();

    // Recover Turn 1 on handle2 -> not_dispatched -> recordRetryFailure atomically archives R1 + resets inbox to pending.
    await assert.rejects(
      adapter.recoverRoomTurn(handle2, { inboxItemId: item.inbox_item_id, providerTurnId: turn1State.turnId }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal((error as { roomTurnRecoveryOutcome?: unknown })?.roomTurnRecoveryOutcome, "not_dispatched", message);
        assert.match(message, /probe startup cause #1/);
        return true;
      },
    );
    const reset1 = await inbox.recordRetryFailure(item.inbox_item_id, {
      domain: "pre_dispatch",
      error: "Cursor's prepared wrapper exited before native dispatch",
      resetUndispatchedTurnId: turn1State.turnId,
    });
    assert.equal(reset1.item.state, "pending");
    assert.equal(reset1.item.provider_turn_id, null);
    assert.equal(reset1.item.attempt_count, 0);
    assert.equal(await inbox.providerTurnBinding(item.inbox_item_id), null);

    // --- Turn 2 (handle2, gen-2): exits pre-init (not_started #2), retires cleanly without identity_mismatch, clears handle.liveTurn, and permits Stop ---
    await inbox.claimHead(agentId);
    await inbox.checkpointDispatchIntent(item.inbox_item_id);
    const turn2State = { turnId: null as string | null, continuation: initialContinuation, connection: { ...idleConnection }, versions: [] as number[] };
    let turn2Error: unknown;
    try {
      await adapter.runRoomTurn(handle2, roomTurnRequest({ inboxItemId: item.inbox_item_id, actionId: "action-2" }), turnCallbacks(handle2, item.inbox_item_id, "gen-2", turn2State));
    } catch (error) {
      turn2Error = error;
    }
    await flush();
    assert.ok(turn2State.turnId);
    if (handle2.pid !== null) {
      // Unfixed base leaves R1 unarchived, so Turn 2's flush throws invalid_transition
      // and strands handle2.liveTurn. The delivery retry refresh then drains lane2,
      // suspends it with invalid_observation, and exact-turn recovery fails with the
      // exact cr8 field error ("could not retire its exact child birth: ... identity_mismatch").
      capture.refresh(agentId);
      await flush();
      await adapter.recoverRoomTurn(handle2, { inboxItemId: item.inbox_item_id, providerTurnId: turn2State.turnId }, {
        settleLifecycleBeforeIdle: async () => {
          capture.flush(currentInstallation as unknown as Parameters<typeof capture.flush>[0]);
        },
      });
    }
    assert.match(turn2Error instanceof Error ? turn2Error.message : String(turn2Error), /exited before reporting its stream-json init/);
    const recovery1 = db.prepare("SELECT phase,runtime_generation_id FROM agent_runtime_recoveries WHERE agent_id=? AND runtime_generation_id=?")
      .get(agentId, runtime1) as { phase: string; runtime_generation_id: string } | undefined;
    assert.deepEqual(recovery1 ? { ...recovery1 } : undefined, { phase: "complete", runtime_generation_id: runtime1 },
      "undispatched reset atomically archived R1 in agent_runtime_recoveries");
    assert.deepEqual(turn2State.versions, [11, 12, 13],
      "Turn 2 also advances cleanly through prepared(11), lifecycle turn/lost(12), idle checkpoint(13)");
    assert.equal(handle2.pid, null, "Turn 2 retired and cleared its retained liveTurn birth");
    assert.equal(handle2.observedState(), "failed", "Turn 2 reached finishAttempt cleanly instead of stranding handle2 in working");
    assert.equal(diagnostics.includes("invalid_observation"), false, `unexpected capture diagnostics: ${diagnostics.join(",")}`);

    // Resume on handle3 (gen-3) after Turn 2's clean finishAttempt; Stop succeeds immediately (idle),
    // Turn 2 recovers cleanly as not_dispatched (no identity_mismatch), and Turn 3 delivers on the SAME agent.
    await inbox.recordRetryFailure(item.inbox_item_id, { domain: "result_recovery", error: "startup failed #2" });
    await inbox.transition(item.inbox_item_id, "pending");
    await inbox.claimHead(agentId);

    db.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='gen-2'")
      .run(JSON.stringify({ ended_at: at, exit_code: 1, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "crashed", actor: "test", generation: 2, provider_continuation_id: initialContinuation }));
    db.prepare("INSERT INTO work_attempt_executions VALUES(?,?,?,'test',3,NULL)").run("gen-3", workAttemptId, at);
    db.prepare("UPDATE agents SET observed_state='idle',deployment_id=?,run_id='gen-3',provider_execution_generation_id='gen-3',provider_connection_json=?,version=version+1 WHERE agent_id=?")
      .run(serializeDaemonDeploymentId(agentId, "gen-3"), JSON.stringify(idleConnection), agentId);
    db.prepare("UPDATE worker_session_bindings SET execution_generation_id='gen-3' WHERE entry_id=?").run(agentId);

    const handle3 = await adapter.resume(
      { workAttemptId, providerContinuationId: initialContinuation, providerConnection: idleConnection },
      daemonSpawnRequest({ cwd: root, workAttemptId }),
    );
    installHandle(handle3, "gen-3");
    await flush();

    // Stop must succeed cleanly with idle state (never "no active settlement owner").
    const stoppedAfterTurn2 = await adapter.controlTurn(handle3, null);
    assert.equal(stoppedAfterTurn2.state, "idle");
    assert.equal(stoppedAfterTurn2.interrupted, false);

    // Recover Turn 2 -> clean not_dispatched (never "could not retire its exact child birth: ... identity_mismatch").
    await assert.rejects(
      adapter.recoverRoomTurn(handle3, { inboxItemId: item.inbox_item_id, providerTurnId: turn2State.turnId }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal((error as { roomTurnRecoveryOutcome?: unknown })?.roomTurnRecoveryOutcome, "not_dispatched", message);
        assert.match(message, /probe startup cause #2/);
        assert.doesNotMatch(message, /could not retire|identity_mismatch/);
        return true;
      },
    );
    const reset2 = await inbox.recordRetryFailure(item.inbox_item_id, {
      domain: "pre_dispatch",
      error: "Cursor's prepared wrapper exited before native dispatch (#2)",
      resetUndispatchedTurnId: turn2State.turnId,
    });
    assert.equal(reset2.item.state, "pending");
    assert.equal(reset2.item.provider_turn_id, null);

    // --- Turn 3 (handle3, gen-3): next turn is delivered on the SAME agent with captureAdmission='ready' and recordBlock=null ---

    await inbox.claimHead(agentId);
    await inbox.checkpointDispatchIntent(item.inbox_item_id);
    const turn3State = { turnId: null as string | null, continuation: initialContinuation, connection: { ...idleConnection }, versions: [] as number[] };
    const activeTurn3 = adapter.runRoomTurn(
      handle3,
      roomTurnRequest({ inboxItemId: item.inbox_item_id, actionId: "action-3" }),
      turnCallbacks(handle3, item.inbox_item_id, "gen-3", turn3State),
    );
    turn3Promise = activeTurn3;
    await turn3InitObserved;
    await flush();
    assert.equal(
      capture.captureAdmission(currentInstallation as unknown as Parameters<typeof capture.captureAdmission>[0]),
      "ready",
      "Turn 3 captureAdmission must be ready on the same agent after Turn 2 retirement",
    );
    assert.equal(
      capture.recordBlock(currentInstallation as unknown as Parameters<typeof capture.recordBlock>[0]),
      null,
      "Turn 3 recordBlock must be null on the same agent after Turn 2 retirement",
    );
    releaseTurn3Completion();
    const turn3Result = await activeTurn3;
    turn3Promise = null;
    assert.equal(turn3Result.outcome, "reply");
    assert.equal(turn3Result.text, "Turn 3 delivered after undispatched recovery");
    assert.equal(handle3.pid, null);
    assert.equal(handle3.observedState(), "idle");
    assert.equal(diagnostics.includes("invalid_observation"), false);
    assert.equal(diagnostics.includes("source_gap"), false);

    await inbox.checkpointNormalizedTerminal({
      inbox_item_id: item.inbox_item_id,
      agent_id: agentId,
      execution_generation_id: "gen-3",
      provider_turn_id: turn3State.turnId!,
      outcome: "reply",
      text: turn3Result.text,
      evidence: "stream",
      terminal_evidence: turn3Result,
    });
    await inbox.transition(item.inbox_item_id, "awaiting_result");
    await inbox.transition(item.inbox_item_id, "publishing");
    const ack = await inbox.checkpointPublication({
      inbox_item_id: item.inbox_item_id,
      room_id: roomId,
      canonical_message_id: "msg_reply_turn3",
    });
    assert.equal(ack.state, "acknowledged");
  } finally {
    releaseTurn3Completion();
    await turn3Promise?.catch(() => undefined);
    capture.close();
    await inbox.close();
    await manifest.close();
    if (db.isOpen) db.close();
    await removeTestDirectory(root);
  }
});

test("a reused Cursor handle delivers the next turn on the same capture source after an undispatched lost turn is archived (task_21)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { DaemonStateSchema } = await import(new URL("../../daemon/daemon-state-database.ts", import.meta.url).href);
  const { ManifestStore } = await import(new URL("../../daemon/manifest-store.ts", import.meta.url).href);
  const { SupervisedAgentInboxStore } = await import(new URL("../../daemon/supervised-agent-inbox-store.ts", import.meta.url).href);
  const { ExecutionCaptureCoordinator } = await import(new URL("../../daemon/execution-capture-coordinator.ts", import.meta.url).href);
  const { serializeDaemonDeploymentId } = await import(new URL("../../daemon/manifest-entry-projection.ts", import.meta.url).href);

  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-reused-handle-"));
  const dbPath = join(root, "daemon-state.sqlite");
  const at = "2026-08-31T00:00:00.000Z";
  const agentId = "cursor-reused-agent";
  const roomId = "room-reused";
  const workAttemptId = "wa-cursor-1";
  const generationId = "gen-reused-1";
  const sessionId = "agent-session-reused";
  const credentialRef = "cred-reused";
  const apiUrl = "https://letagents.test";

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON");
  new DaemonStateSchema().createSchema(db);
  const manifest = new ManifestStore(dbPath);
  manifest.attachDatabase(db);
  let onInboxMutation: () => void = () => undefined;
  const inbox = new SupervisedAgentInboxStore(dbPath, () => at, () => onInboxMutation());
  inbox.attachDatabase(db);

  const harness = createHarness({ silent: true });
  let launchCount = 0;
  let releaseTurn2!: () => void;
  const turn2Gate = new Promise<void>((resolve) => { releaseTurn2 = resolve; });
  let signalTurn2Init!: () => void;
  const turn2Init = new Promise<void>((resolve) => { signalTurn2Init = resolve; });

  const dependencies: CursorProviderAdapterDependencies = {
    ...harness.dependencies,
    prepareTurnState(path) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    },
    launchTurn(input) {
      launchCount += 1;
      const attempt = launchCount;
      const child = harness.dependencies.launchTurn(input) as FakeCursorChild;
      if (attempt === 1 && input.statePath) {
        writeFileSync(`${input.statePath}.terminal.json`, JSON.stringify({
          type: "not_started",
          error: "Cursor wrapper IPC channel closed before dispatch",
          native_process_group_reaped: true,
          reap_scope: "native_process_group",
          remote_authority_revoked: true,
        }));
      }
      const originalRelease = child.release.bind(child);
      child.release = () => {
        originalRelease();
        if (attempt === 1) {
          throw new Error("EPIPE sending release");
        }
        queueMicrotask(() => {
          child.emit({ type: "system", subtype: "init", session_id: "sess-cursor-reused-2", model: "cursor-fast" });
          signalTurn2Init();
          void turn2Gate.then(() => {
            child.emit({
              type: "result",
              subtype: "success",
              is_error: false,
              result: "Reused handle turn 2 succeeded",
              session_id: "sess-cursor-reused-2",
            });
            child.resolveExit({ type: "exit", code: 0, signal: null });
          });
        });
      };
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

  const diagnostics: string[] = [];
  let handle!: Awaited<ReturnType<typeof adapter.spawn>>;
  let installation: {
    nonce: symbol;
    listenerLeaseNonce: symbol;
    entryId: string;
    handle: typeof handle;
    executionGenerationId: string;
    workAttemptId: string;
    providerContinuationId: string;
    providerConnection: { kind: "cursor_cli"; pid: number | null; processIdentity: string | null };
    configurationRevision: number;
    authorityMode: "typed" | null;
  } | null = null;

  const capture = new ExecutionCaptureCoordinator(db, {
    provider: {
      onExecution: (h: object, listener: (event: NativeExecutionObservation) => void) =>
        adapter.onExecution(h as Parameters<typeof adapter.onExecution>[0], listener),
    },
    currentHandle: () => handle,
    daemonGeneration: () => 1,
    diagnostic: (_id: string, code: string) => diagnostics.push(code),
  });
  onInboxMutation = () => capture.refresh(agentId);

  let turn2Promise: Promise<unknown> | null = null;
  try {
    const idleConnection: { kind: "cursor_cli"; pid: number | null; processIdentity: string | null } = {
      kind: "cursor_cli", pid: null, processIdentity: null,
    };
    handle = await adapter.spawn(daemonSpawnRequest({ cwd: root, workAttemptId }));
    const initialContinuation = handle.providerContinuationId!;

    db.prepare(`INSERT INTO work_attempts(work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
      VALUES(?,?,?,1,?,'repo','remote','rev','/private/bare','active',?)`)
      .run(workAttemptId, agentId, agentId, root, at);
    db.prepare("INSERT INTO work_attempt_executions VALUES(?,?,?,'test',1,NULL)").run(generationId, workAttemptId, at);
    db.prepare(`INSERT INTO agents(agent_id,sort_order,version,created_by,created_at,display_name,room_id,provider,charter,config_revision,runtime_configuration_revision,desired_state,observed_state,condition,deployment_id,run_id,work_attempt_id,provider_work_attempt_id,provider_continuation_id,provider_execution_generation_id,provider_connection_json)
      VALUES(?,0,1,'owner',?,'Cursor Reused',?,'cursor','charter',1,1,'running','idle','none',?,?,?,?,?,?,?)`)
      .run(agentId, at, roomId, serializeDaemonDeploymentId(agentId, generationId), generationId, workAttemptId, workAttemptId, initialContinuation, generationId, JSON.stringify(idleConnection));
    db.prepare(`INSERT INTO worker_session_bindings(entry_id,room_id,work_attempt_id,execution_generation_id,agent_session_id,credential_ref,api_url,room_cursor,last_sequence,last_observed_at_ms,binding_epoch,updated_at)
      VALUES(?,?,?,?,?,?,?,NULL,0,?,1,?)`)
      .run(agentId, roomId, workAttemptId, generationId, sessionId, credentialRef, apiUrl, Date.parse(at), at);

    const leaseNonce = Symbol("lease-reused");
    installation = Object.freeze({
      nonce: Symbol("inst-reused-idle"),
      listenerLeaseNonce: leaseNonce,
      entryId: agentId,
      handle,
      executionGenerationId: generationId,
      workAttemptId,
      providerContinuationId: initialContinuation,
      providerConnection: { ...idleConnection },
      configurationRevision: 1,
      authorityMode: null,
    });
    capture.install(installation as unknown as Parameters<typeof capture.install>[0]);
    await flush();

    const [item] = await inbox.ingestPoll({
      agent_id: agentId,
      room_id: roomId,
      last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { id: "1", text: "hello" }, activation: { for_current_agent: { decision: "activate" } } }],
    });
    assert.ok(item);

    const state = { turnId: null as string | null, continuation: initialContinuation, connection: { ...idleConnection } };
    const callbacks = {
      checkpointPreparedTurn: async (checkpoint: {
        providerTurnId: string;
        providerContinuationId: string;
        providerConnection: { kind: string; pid: number | null; processIdentity?: string | null };
      }) => {
        const loaded = await manifest.getEntryWithVersion(agentId);
        const nextConnection = {
          kind: "cursor_cli" as const,
          pid: checkpoint.providerConnection.pid,
          processIdentity: checkpoint.providerConnection.processIdentity ?? null,
        };
        await manifest.checkpointCursorPreparedTurn(loaded!.version, {
          agentId, roomId, inboxItemId: item.inbox_item_id, providerTurnId: checkpoint.providerTurnId,
          providerContinuationId: checkpoint.providerContinuationId, workAttemptId, executionGenerationId: generationId,
          agentSessionId: sessionId, credentialRef, apiUrl,
          expectedProviderContinuationId: state.continuation, expectedProviderConnection: state.connection,
          providerConnection: nextConnection, configurationRevision: 1, observedAt: at,
        });
        state.turnId = checkpoint.providerTurnId;
        state.continuation = checkpoint.providerContinuationId;
        state.connection = nextConnection;
        installation = Object.freeze({
          nonce: Symbol("inst-live"), listenerLeaseNonce: leaseNonce, entryId: agentId, handle,
          executionGenerationId: generationId, workAttemptId, providerContinuationId: state.continuation,
          providerConnection: { ...nextConnection }, configurationRevision: 1, authorityMode: "typed" as const,
        });
        capture.advance(installation as unknown as Parameters<typeof capture.advance>[0]);
        capture.prepared({
          agentId, executionGenerationId: generationId,
          handle,
          connection: { ...nextConnection }, configurationRevision: 1,
        });
      },
      checkpointProviderState: async (checkpoint: {
        providerContinuationId: string;
        providerConnection: { kind: string; pid: number | null; processIdentity?: string | null };
      }) => {
        const loaded = await manifest.getEntryWithVersion(agentId);
        const nextConnection = {
          kind: "cursor_cli" as const,
          pid: checkpoint.providerConnection.pid,
          processIdentity: checkpoint.providerConnection.processIdentity ?? null,
        };
        await manifest.checkpointCursorProviderState(loaded!.version, {
          agentId, roomId, inboxItemId: item.inbox_item_id, providerTurnId: state.turnId!,
          workAttemptId, executionGenerationId: generationId, agentSessionId: sessionId, credentialRef, apiUrl,
          expectedProviderContinuationId: state.continuation, expectedProviderConnection: state.connection,
          providerContinuationId: checkpoint.providerContinuationId, providerConnection: nextConnection, observedAt: at,
        });
        state.continuation = checkpoint.providerContinuationId;
        state.connection = nextConnection;
        installation = Object.freeze({
          nonce: Symbol("inst-state"), listenerLeaseNonce: leaseNonce, entryId: agentId, handle,
          executionGenerationId: generationId, workAttemptId, providerContinuationId: state.continuation,
          providerConnection: { ...nextConnection }, configurationRevision: 1,
          authorityMode: nextConnection.pid === null ? null : "typed" as const,
        });
        capture.advance(installation as unknown as Parameters<typeof capture.advance>[0]);
      },
      settleLifecycleBeforeIdle: async () => {
        capture.flush(installation as unknown as Parameters<typeof capture.flush>[0]);
      },
    };

    // Turn 1 throws on release -> settles lost/exited -> inline recoverRoomTurn returns not_dispatched on the SAME handle.
    await inbox.claimHead(agentId);
    await inbox.checkpointDispatchIntent(item.inbox_item_id);
    await assert.rejects(
      adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: item.inbox_item_id, actionId: "reused-1" }), callbacks),
      (error: unknown) => (error as { roomTurnRecoveryOutcome?: unknown })?.roomTurnRecoveryOutcome === "not_dispatched",
    );
    const reset = await inbox.recordRetryFailure(item.inbox_item_id, {
      domain: "pre_dispatch", error: "wrapper release failed before dispatch", resetUndispatchedTurnId: state.turnId!,
    });
    assert.equal(reset.item.state, "pending");
    assert.equal(handle.pid, null);
    assert.equal(handle.observedState(), "idle");
    const stopped = await adapter.controlTurn(handle, null);
    assert.equal(stopped.state, "idle");
    assert.equal(stopped.interrupted, false);

    // Turn 2 runs on the EXACT SAME handle and capture source, advancing past the archived Turn 1 observer epoch.
    await inbox.claimHead(agentId);
    await inbox.checkpointDispatchIntent(item.inbox_item_id);
    const activeTurn2 = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: item.inbox_item_id, actionId: "reused-2" }), callbacks);
    turn2Promise = activeTurn2;
    await turn2Init;
    await flush();
    assert.equal(capture.captureAdmission(installation as unknown as Parameters<typeof capture.captureAdmission>[0]), "ready");
    assert.equal(capture.recordBlock(installation as unknown as Parameters<typeof capture.recordBlock>[0]), null);
    releaseTurn2();
    const result2 = await activeTurn2;
    turn2Promise = null;
    assert.equal(result2.outcome, "reply");
    assert.equal(result2.text, "Reused handle turn 2 succeeded");
    assert.equal(diagnostics.includes("invalid_observation"), false);
  } finally {
    releaseTurn2();
    await turn2Promise?.catch(() => undefined);
    capture.close();
    await inbox.close();
    await manifest.close();
    if (db.isOpen) db.close();
    await removeTestDirectory(root);
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
  assert.equal(launch.allowedReadSubpaths?.includes(resolve("/private/source/.git/objects")), true, "the sandbox path is absolute for this platform");
  assert.equal(launch.allowedWriteSubpaths?.includes(WA_CURSOR_CWD), false);
  assert.ok((launch.workspaceGenerationManifestPath ?? "").startsWith(join(cursorTmp, "letagents-test-generation-")));

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
  assert.equal(argValue(launch.args, "--sandbox"), expectedCursorSandbox("enabled"));
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
